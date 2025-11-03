const wsPattern   = new URLPattern({ pathname: "/ws/:roomId" });
const infoPattern = new URLPattern({ pathname: "/rooms/:roomId/info" });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const wsMatch = wsPattern.exec(url);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const roomId = decodeURIComponent(wsMatch.pathname.groups.roomId);
      const id = env.GAME_ROOMS.idFromName(roomId);
      return env.GAME_ROOMS.get(id).fetch(request);
    }

    const infoMatch = infoPattern.exec(url);
    if (infoMatch) {
      const roomId = decodeURIComponent(infoMatch.pathname.groups.roomId);
      const id = env.GAME_ROOMS.idFromName(roomId);
      const req = new Request(request, { headers: new Headers(request.headers) });
      req.headers.set("X-Room-Id", roomId);
      return env.GAME_ROOMS.get(id).fetch(req);
    }

    return new Response("Not found", { status: 404 });
  },
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;

    this.GRACE_MS = parseInt(env.ROOM_GRACE_MS ?? "15000", 10);
    this.KEY_TTL_MS = parseInt(env.PRODUCER_KEY_TTL_SEC ?? "86400", 10) * 1000;
    this.REQUIRE_KEY = (env.REQUIRE_KEY_IN_MESSAGES ?? "false") === "true";
    this.MAX_BUFFER = parseInt(env.MAX_BUFFER_BYTES ?? "1048576", 10); // 1 MiB

    this.DEFAULT_SETTINGS = { buffer_messages: false, compress_messages: false, compress_messages_binary: false };
    this.settings = { ...this.DEFAULT_SETTINGS };

    this.state.blockConcurrencyWhile(async () => {
      const rec = await this.storage.get("producer");
      this.producerKey = rec?.key ?? null;
      this.keyExpiresAt = rec?.expiresAt ?? null;

      const savedSettings = await this.storage.get("settings");
      if (savedSettings && typeof savedSettings === "object") {
        this.settings = { ...this.DEFAULT_SETTINGS, ...savedSettings };
      }

      try { this.state.setWebSocketAutoResponse({ request: "ping", response: "pong" }); } catch {}
    });
  }

  _now() { return Date.now(); }
  _sockets(tag) { return this.state.getWebSockets(tag); }
  _hasProducer() { return this._sockets("producer").length > 0; }
  _roomId(url, headers) {
    const h = headers.get("X-Room-Id");
    if (h) return h;
    const p = new URL(url).pathname;
    const m = p.match(/^\/(?:ws|rooms)\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  _isKeyValid(k) {
    return !!k && !!this.producerKey && k === this.producerKey && this._now() < (this.keyExpiresAt ?? 0);
  }
  _sendJson(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  _broadcast(tag, data) {
    const payload = typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    for (const ws of this._sockets(tag)) {
      if (this.MAX_BUFFER && ws.bufferedAmount > this.MAX_BUFFER) {
        try { ws.close(4002, "Backpressure"); } catch {}
        continue;
      }
      try { ws.send(payload); } catch {}
    }
  }
  _parseBool(v, fallback = null) {
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (["1","true","t","yes","y","on"].includes(s)) return true;
    if (["0","false","f","no","n","off"].includes(s)) return false;
    return fallback;
  }
  async _setSettings(partial) {
    const merged = { ...this.DEFAULT_SETTINGS, ...this.settings, ...partial };
    if ("buffer_messages" in merged) merged.buffer_messages = !!merged.buffer_messages;
    if ("compress_messages" in merged) merged.compress_messages = !!merged.compress_messages;
    if ("compress_messages_binary" in merged) merged.compress_messages_binary = !!merged.compress_messages_binary;

    this.settings = merged;
    await this.storage.put("settings", this.settings);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      if (request.method === "GET" && url.pathname.endsWith("/info")) {
        const info = {
          room: this._roomId(url, request.headers),
          consumers: this._sockets("consumer").length,
          producers: this._sockets("producer").length,
          producerKeyExpiresAt: this.keyExpiresAt ?? null,
          hasProducer: this._hasProducer(),
          settings: this.settings,
        };
        return new Response(JSON.stringify(info), { headers: { "content-type": "application/json" } });
      }
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const role = (url.searchParams.get("role") ?? "consumer").toLowerCase();
    const authHeader = request.headers.get("Authorization");
    const presentedKey = url.searchParams.get("key") ||
      (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

    // producer
    if (role === "producer") {
      const existing = this._sockets("producer");
      if (existing.length && !this._isKeyValid(presentedKey)) {
        return new Response("Producer already connected", { status: 409 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const qBuffer = this._parseBool(url.searchParams.get("buffer_messages"));
      const qCompress = this._parseBool(url.searchParams.get("compress_messages"));
      const qCompressBinary = this._parseBool(url.searchParams.get("compress_messages_binary"));
      if (qBuffer !== null || qCompress !== null || qCompressBinary !== null) {
        await this._setSettings({
          ...(qBuffer !== null ? { buffer_messages: qBuffer } : {}),
          ...(qCompress !== null ? { compress_messages: qCompress } : {}),
          ...(qCompressBinary !== null ? { compress_messages_binary: qCompressBinary } : {}),
        });
      }

      server.serializeAttachment({
        role: "producer",
        connectedAt: this._now(),
        settings: this.settings,
      });
      this.state.acceptWebSocket(server, ["producer"]);

      for (const w of existing) { try { w.close(4001, "Producer replaced"); } catch {} }

      if (!this._isKeyValid(this.producerKey)) {
        this.producerKey = crypto.randomUUID();
      }
      this.keyExpiresAt = this._now() + this.KEY_TTL_MS;
      await this.storage.put("producer", { key: this.producerKey, expiresAt: this.keyExpiresAt });
      await this.storage.deleteAlarm();

      this._sendJson(server, {
        type: "welcome", role: "producer",
        roomId: this._roomId(url, request.headers),
        producerKey: this.producerKey, expiresAt: this.keyExpiresAt,
        settings: this.settings,
      });
      this._broadcast("consumer", { type: "producer_joined", settings: this.settings, at: this._now() });

      return new Response(null, { status: 101, webSocket: client });
    }

    // consumer
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role: "consumer", connectedAt: this._now() });
    this.state.acceptWebSocket(server, ["consumer"]);
    this._sendJson(server, {
      type: "welcome", role: "consumer",
      roomId: this._roomId(url, request.headers),
      hasProducer: this._hasProducer(),
      settings: this.settings,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.role !== "producer") return;

    let obj = undefined;
    let original = message;

    if (typeof message === "string") {
      try { obj = JSON.parse(message); } catch { }
    }

    if (this.REQUIRE_KEY) {
      if (typeof message !== "string" || typeof obj !== "object" || obj === null) {
        this._sendJson(ws, { type: "error", code: "BAD_FORMAT" });
        return;
      }
      if (!this._isKeyValid(obj.key)) { this._sendJson(ws, { type: "error", code: "BAD_KEY" }); return; }
      delete obj.key;
      original = JSON.stringify(obj);
    }

    if (obj && obj.type === "settings") {
      const next = {
        ...(obj.buffer_messages !== undefined ? { buffer_messages: !!obj.buffer_messages } : {}),
        ...(obj.compress_messages !== undefined ? { compress_messages: !!obj.compress_messages } : {}),
        ...(obj.compress_messages_binary !== undefined ? { compress_messages_binary: !!obj.compress_messages_binary } : {}),
      };
      if (Object.keys(next).length === 0) {
        this._sendJson(ws, { type: "error", code: "EMPTY_SETTINGS" });
        return;
      }
      await this._setSettings(next);
      try { ws.serializeAttachment({ ...meta, settings: this.settings }); } catch {}
      this._sendJson(ws, { type: "settings_ok", settings: this.settings });
      this._broadcast("consumer", { type: "settings_updated", settings: this.settings, at: this._now() });
      return;
    }

    this._broadcast("consumer", original);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (this.state.getWebSockets("producer").length === 0) {
      if (!this.pendingCloseAt) {
        this.pendingCloseAt = Date.now() + this.GRACE_MS;
        this._broadcast("consumer", JSON.stringify({
          type: "producer_left",
          at: Date.now(),
          willCloseInMs: this.GRACE_MS,
        }));
        await this.storage.setAlarm(new Date(this.pendingCloseAt));
      }
    }
  }

  async alarm() {
    if (this.state.getWebSockets("producer").length === 0) {
      this._broadcast("consumer", JSON.stringify({ type: "room_closed", at: Date.now() }));
      await new Promise(r => setTimeout(r, 5));

      for (const ws of this.state.getWebSockets("consumer")) {
        try { ws.close(4000, "Room closed"); } catch {}
      }
      if (!this.keyExpiresAt || Date.now() > this.keyExpiresAt) {
        this.producerKey = null;
        this.keyExpiresAt = null;
        await this.storage.delete("producer");
      }
      this.pendingCloseAt = null;
    }
  }
}
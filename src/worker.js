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

    this.state.blockConcurrencyWhile(async () => {
      const rec = await this.storage.get("producer");
      this.producerKey = rec?.key ?? null;
      this.keyExpiresAt = rec?.expiresAt ?? null;
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
      server.serializeAttachment({ role: "producer", connectedAt: this._now() });
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
      });
      this._broadcast("consumer", { type: "producer_joined", at: this._now() });

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
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.role !== "producer") return;
    if (this.REQUIRE_KEY) {
      if (typeof message !== "string") {
        this._sendJson(ws, { type: "error", code: "BAD_FORMAT" });
        return;
      }
      let obj;
      try { obj = JSON.parse(message); } catch { this._sendJson(ws, { type: "error", code: "BAD_FORMAT" }); return; }
      if (!this._isKeyValid(obj.key)) { this._sendJson(ws, { type: "error", code: "BAD_KEY" }); return; }
      delete obj.key;
      message = JSON.stringify(obj);
    }
    this._broadcast("consumer", message);
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
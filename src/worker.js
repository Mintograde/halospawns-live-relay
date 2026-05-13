const wsPattern   = new URLPattern({ pathname: "/ws/:roomId" });
const infoPattern = new URLPattern({ pathname: "/rooms/:roomId/info" });

const API_CLIENT_DEFAULT = "live-relay";
const API_STATUS_INTERVAL_MS_DEFAULT = 10000;
const LIVE_STATUS_TYPE = "live_status";
const LIVE_STATUS_VALUES = new Set(["waiting", "live", "postgame", "ended", "stale"]);
const TERMINAL_LIVE_STATUS_VALUES = new Set(["postgame", "ended", "stale"]);

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
      return env.GAME_ROOMS.get(id).fetch(request);
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
    this.API_STATUS_INTERVAL_MS = positiveInt(
      env.LIVE_STATUS_UPDATE_INTERVAL_MS,
      API_STATUS_INTERVAL_MS_DEFAULT,
    );

    this.DEFAULT_SETTINGS = { buffer_messages: false, compress_messages: false, compress_messages_binary: false };
    this.settings = { ...this.DEFAULT_SETTINGS };
    this.room = null;
    this.liveSession = null;
    this.latestLiveStatus = null;
    this.pendingCloseAt = null;
    this.nextStatusSyncAt = null;
    this.lastStatusSyncAt = null;
    this.apiConfigWarningLogged = false;

    this.state.blockConcurrencyWhile(async () => {
      const rec = await this.storage.get("producer");
      this.producerKey = rec?.key ?? null;
      this.keyExpiresAt = rec?.expiresAt ?? null;

      const savedSettings = await this.storage.get("settings");
      if (savedSettings && typeof savedSettings === "object") {
        this.settings = { ...this.DEFAULT_SETTINGS, ...savedSettings };
      }

      this.room = (await this.storage.get("room")) ?? null;
      this.liveSession = (await this.storage.get("liveSession")) ?? null;
      this.latestLiveStatus = (await this.storage.get("latestLiveStatus")) ?? null;

      const scheduler = (await this.storage.get("scheduler")) ?? {};
      this.pendingCloseAt = scheduler.pendingCloseAt ?? null;
      this.nextStatusSyncAt = scheduler.nextStatusSyncAt ?? null;
      this.lastStatusSyncAt = scheduler.lastStatusSyncAt ?? null;

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
  _apiConfigured() {
    const configured = !!this.env.APP_API_BASE_URL && !!this.env.APP_API_HMAC_SECRET;
    if (!configured && !this.apiConfigWarningLogged) {
      console.warn("App API live status sync is disabled because API base URL or HMAC secret is missing");
      this.apiConfigWarningLogged = true;
    }
    return configured;
  }
  async _setRoomInfo(roomId, url) {
    this.room = {
      roomId,
      websocketUrl: websocketUrlForRoom(url, roomId, this.env.RELAY_WEBSOCKET_BASE_URL),
    };
    await this.storage.put("room", this.room);
  }
  async _ensureLiveSession() {
    if (this.liveSession) return this.liveSession;

    const nowIso = new Date(this._now()).toISOString();
    this.liveSession = {
      sourceLiveId: crypto.randomUUID(),
      sourceExternalId: null,
      apiLiveGameId: null,
      startedAt: nowIso,
    };
    await this.storage.put("liveSession", this.liveSession);
    return this.liveSession;
  }
  async _saveLiveSession() {
    if (this.liveSession) await this.storage.put("liveSession", this.liveSession);
    else await this.storage.delete("liveSession");
  }
  async _setLatestLiveStatus(update) {
    this.latestLiveStatus = {
      ...(this.latestLiveStatus ?? {}),
      ...update,
      updated_at: new Date(this._now()).toISOString(),
    };
    await this.storage.put("latestLiveStatus", this.latestLiveStatus);
  }
  async _saveScheduler() {
    await this.storage.put("scheduler", {
      pendingCloseAt: this.pendingCloseAt ?? null,
      nextStatusSyncAt: this.nextStatusSyncAt ?? null,
      lastStatusSyncAt: this.lastStatusSyncAt ?? null,
    });
  }
  async _scheduleNextAlarm() {
    await this._saveScheduler();

    const candidates = [this.pendingCloseAt, this.nextStatusSyncAt]
      .filter((value) => Number.isFinite(value));

    if (candidates.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }

    const nextAlarmAt = Math.min(...candidates);
    await this.storage.setAlarm(new Date(nextAlarmAt));
  }
  async _queueStatusSync({ immediate = false } = {}) {
    if (!this.liveSession) return;
    if (!this._apiConfigured()) {
      this.nextStatusSyncAt = null;
      await this._scheduleNextAlarm();
      return;
    }

    const now = this._now();
    const requestedAt = immediate ? now : now + this.API_STATUS_INTERVAL_MS;
    if (!this.nextStatusSyncAt || requestedAt < this.nextStatusSyncAt) {
      this.nextStatusSyncAt = requestedAt;
    }
    await this._scheduleNextAlarm();
  }
  _statusForCurrentRoom({ overrideStatus = null } = {}) {
    if (overrideStatus) return overrideStatus;
    const candidate = normalizeLiveStatus(this.latestLiveStatus?.status);
    if (candidate) return candidate;
    return this._hasProducer() ? "live" : "waiting";
  }
  _buildStatusPayload({ reason = "periodic", overrideStatus = null } = {}) {
    const liveSession = this.liveSession;
    const room = this.room;
    const latest = this.latestLiveStatus ?? {};
    if (!liveSession || !room?.roomId) return null;

    const rawStatus = objectOrDefault(latest.raw_status, {});
    return {
      source: "live_relay",
      source_live_id: liveSession.sourceLiveId,
      source_external_id: optionalString(latest.source_external_id) ?? liveSession.sourceExternalId ?? liveSession.sourceLiveId,
      relay_id: optionalString(latest.relay_id) ?? optionalString(this.env.RELAY_ID),
      server_id: optionalString(latest.server_id) ?? optionalString(this.env.SERVER_ID),
      relay_room_id: room.roomId,
      websocket_url: optionalString(latest.websocket_url) ?? room.websocketUrl ?? null,
      status: this._statusForCurrentRoom({ overrideStatus }),
      map_id: optionalString(latest.map_id) ?? null,
      game_type: optionalString(latest.game_type) ?? null,
      variant_name: optionalString(latest.variant_name) ?? null,
      started_at: optionalString(latest.started_at) ?? liveSession.startedAt,
      observed_at: new Date(this._now()).toISOString(),
      current_game_time_seconds: optionalNumber(latest.current_game_time_seconds),
      current_tick: optionalInteger(latest.current_tick),
      player_summary: arrayOfObjects(latest.player_summary),
      team_summary: arrayOfObjects(latest.team_summary),
      raw_status: {
        ...rawStatus,
        relay: {
          room_id: room.roomId,
          consumers: this._sockets("consumer").length,
          producers: this._sockets("producer").length,
          settings: this.settings,
          sync_reason: reason,
        },
      },
      game_metadata: {
        ...objectOrDefault(latest.game_metadata, {}),
        live_relay: {
          room_id: room.roomId,
          session_started_at: liveSession.startedAt,
        },
      },
    };
  }
  async _sendLiveStatus({ reason = "periodic", overrideStatus = null } = {}) {
    if (!this.liveSession || !this._apiConfigured()) return false;

    const payload = this._buildStatusPayload({ reason, overrideStatus });
    if (!payload) return false;

    try {
      const result = await signedApiJsonFetch(
        this.env,
        "POST",
        "/v1/ingest/live-games/status",
        payload,
      );
      if (!result.ok) {
        console.warn(`App API live status sync failed with HTTP ${result.status}`);
        return false;
      }

      const liveGameId = optionalString(result.json?.data?.id);
      if (liveGameId && this.liveSession.apiLiveGameId !== liveGameId) {
        this.liveSession = { ...this.liveSession, apiLiveGameId: liveGameId };
        await this._saveLiveSession();
      }

      this.lastStatusSyncAt = this._now();
      this.nextStatusSyncAt = this.lastStatusSyncAt + this.API_STATUS_INTERVAL_MS;
      await this._scheduleNextAlarm();
      return true;
    } catch (err) {
      console.warn(`App API live status sync failed: ${err?.message ?? err}`);
      this.nextStatusSyncAt = this._now() + this.API_STATUS_INTERVAL_MS;
      await this._scheduleNextAlarm();
      return false;
    }
  }
  async _finishLiveGame({ status = "stale", gameStatus = "disputed", reason = "room_closed" } = {}) {
    if (!this.liveSession || !this._apiConfigured()) return false;

    if (!this.liveSession.apiLiveGameId) {
      await this._sendLiveStatus({ reason, overrideStatus: status });
    }

    const liveGameId = this.liveSession?.apiLiveGameId;
    if (!liveGameId) return false;

    const latest = this.latestLiveStatus ?? {};
    try {
      const result = await signedApiJsonFetch(
        this.env,
        "POST",
        `/v1/ingest/live-games/${encodeURIComponent(liveGameId)}/finish`,
        {
          status,
          game_status: gameStatus,
          ended_at: new Date(this._now()).toISOString(),
          duration_seconds: optionalInteger(latest.duration_seconds),
          winning_team_index: optionalInteger(latest.winning_team_index),
          current_game_time_seconds: optionalNumber(latest.current_game_time_seconds),
          current_tick: optionalInteger(latest.current_tick),
          raw_status: {
            ...objectOrDefault(latest.raw_status, {}),
            relay: {
              room_id: this.room?.roomId ?? null,
              finish_reason: reason,
            },
          },
          game_metadata: objectOrDefault(latest.game_metadata, {}),
        },
      );

      if (!result.ok) {
        console.warn(`App API live finish failed with HTTP ${result.status}`);
        return false;
      }

      return true;
    } catch (err) {
      console.warn(`App API live finish failed: ${err?.message ?? err}`);
      return false;
    }
  }
  async _clearLiveSession() {
    this.liveSession = null;
    this.latestLiveStatus = null;
    this.nextStatusSyncAt = null;
    this.lastStatusSyncAt = null;
    await Promise.all([
      this.storage.delete("liveSession"),
      this.storage.delete("latestLiveStatus"),
    ]);
  }
  async _handleLiveStatusMessage(obj) {
    await this._ensureLiveSession();

    const nextStatus = {};
    for (const field of [
      "source_external_id",
      "relay_id",
      "server_id",
      "websocket_url",
      "map_id",
      "game_type",
      "variant_name",
      "started_at",
      "duration_seconds",
      "winning_team_index",
      "current_game_time_seconds",
      "current_tick",
    ]) {
      if (obj[field] !== undefined) nextStatus[field] = obj[field];
    }

    const status = normalizeLiveStatus(obj.status);
    if (status) nextStatus.status = status;
    if (Array.isArray(obj.player_summary)) nextStatus.player_summary = obj.player_summary;
    if (Array.isArray(obj.team_summary)) nextStatus.team_summary = obj.team_summary;
    if (obj.raw_status && typeof obj.raw_status === "object") nextStatus.raw_status = obj.raw_status;
    if (obj.game_metadata && typeof obj.game_metadata === "object") nextStatus.game_metadata = obj.game_metadata;

    await this._setLatestLiveStatus(nextStatus);

    if (status && TERMINAL_LIVE_STATUS_VALUES.has(status)) {
      const gameStatus = optionalString(obj.game_status) ?? (status === "stale" ? "disputed" : "completed");
      await this._finishLiveGame({ status, gameStatus, reason: "producer_status" });
      await this._clearLiveSession();
      await this._scheduleNextAlarm();
    } else if (!this.liveSession.apiLiveGameId) {
      await this._queueStatusSync({ immediate: true });
    } else {
      await this._queueStatusSync();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = this._roomId(url, request.headers);
    if (roomId) await this._setRoomInfo(roomId, url);

    if (request.headers.get("Upgrade") !== "websocket") {
      if (request.method === "GET" && url.pathname.endsWith("/info")) {
        const info = {
          room: roomId,
          consumers: this._sockets("consumer").length,
          producers: this._sockets("producer").length,
          producerKeyExpiresAt: this.keyExpiresAt ?? null,
          hasProducer: this._hasProducer(),
          settings: this.settings,
          liveSession: this.liveSession ? {
            sourceLiveId: this.liveSession.sourceLiveId,
            apiLiveGameId: this.liveSession.apiLiveGameId ?? null,
            startedAt: this.liveSession.startedAt ?? null,
            lastStatusSyncAt: this.lastStatusSyncAt ?? null,
            nextStatusSyncAt: this.nextStatusSyncAt ?? null,
          } : null,
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
      this.pendingCloseAt = null;
      await this._ensureLiveSession();
      await this._queueStatusSync({ immediate: true });

      this._sendJson(server, {
        type: "welcome", role: "producer",
        roomId,
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
      roomId,
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
      if (this.REQUIRE_KEY || shouldParseProducerMessage(message)) {
        try { obj = JSON.parse(message); } catch { }
      }
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

    if (obj && obj.type === LIVE_STATUS_TYPE) {
      await this._handleLiveStatusMessage(obj);
      this._sendJson(ws, { type: "live_status_ok", at: this._now() });
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
        await this._scheduleNextAlarm();
      }
    }
  }

  async alarm() {
    const now = Date.now();

    if (this.nextStatusSyncAt && now >= this.nextStatusSyncAt && this.liveSession) {
      await this._sendLiveStatus({ reason: "periodic" });
    }

    if (this.state.getWebSockets("producer").length === 0) {
      if (this.pendingCloseAt && now < this.pendingCloseAt) {
        await this._scheduleNextAlarm();
        return;
      }

      this._broadcast("consumer", JSON.stringify({ type: "room_closed", at: now }));
      await new Promise(r => setTimeout(r, 5));

      for (const ws of this.state.getWebSockets("consumer")) {
        try { ws.close(4000, "Room closed"); } catch {}
      }
      if (this.liveSession) {
        await this._finishLiveGame({ status: "stale", gameStatus: "disputed", reason: "room_closed" });
        await this._clearLiveSession();
      }
      if (!this.keyExpiresAt || Date.now() > this.keyExpiresAt) {
        this.producerKey = null;
        this.keyExpiresAt = null;
        await this.storage.delete("producer");
      }
      this.pendingCloseAt = null;
    }

    await this._scheduleNextAlarm();
  }
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalInteger(value) {
  const parsed = optionalNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function objectOrDefault(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function arrayOfObjects(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function normalizeLiveStatus(value) {
  const normalized = optionalString(value);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  return LIVE_STATUS_VALUES.has(lower) ? lower : null;
}

function shouldParseProducerMessage(message) {
  if (message.length < 2048) return true;
  const sample = message.slice(0, 512);
  return /"type"\s*:\s*"(?:live_status|settings)"/.test(sample);
}

function websocketUrlForRoom(requestUrl, roomId, configuredBaseUrl) {
  const base = configuredBaseUrl ? new URL(configuredBaseUrl) : new URL(requestUrl.origin);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = `/ws/${encodeURIComponent(roomId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

async function signedApiJsonFetch(env, method, path, bodyObject) {
  const baseUrl = optionalString(env.APP_API_BASE_URL);
  const secret = optionalString(env.APP_API_HMAC_SECRET);
  if (!baseUrl || !secret) throw new Error("App API HMAC config is missing");

  const client = optionalString(env.APP_API_HMAC_CLIENT) ?? API_CLIENT_DEFAULT;
  const url = new URL(path, baseUrl);
  const body = JSON.stringify(bodyObject);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signApiRequest(secret, {
    client,
    timestamp,
    method,
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith("?") ? url.search.slice(1) : "",
    body,
  });

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "content-type": "application/json",
      "x-halospawns-client": client,
      "x-halospawns-timestamp": timestamp,
      "x-halospawns-signature": `sha256=${signature}`,
    },
    body,
  });

  let json = null;
  try { json = await response.json(); } catch {}
  return { ok: response.ok, status: response.status, json };
}

async function signApiRequest(secret, request) {
  const bodyHash = await sha256Hex(request.body);
  const canonical = [
    "HALOSPAWNS-HMAC-SHA256",
    request.client,
    request.timestamp,
    request.method.toUpperCase(),
    request.rawPath,
    request.rawQueryString,
    bodyHash,
  ].join("\n");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return hex(new Uint8Array(signature));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

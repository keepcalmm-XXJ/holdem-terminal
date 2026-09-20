import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RoomStore, GameError } from "./rooms.mjs";

export function createGameServer({
  store = new RoomStore(),
  allowedHosts = [],
  streamHeartbeatMs = 20_000,
  streamAuthenticationMs = 5000,
} = {}) {
  const counts = new Map();
  const clients = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  function checkOrigin(req) {
    const host = req.headers.host?.split(":")[0];
    if (!["localhost", "127.0.0.1", ...allowedHosts].includes(host))
      throw new GameError("Host is not allowed", 403);
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.host !== req.headers.host
      )
        throw new GameError("Cross-origin requests are not allowed", 403);
    }
  }

  function sendState(ws, force = false) {
    const client = clients.get(ws);
    if (!client?.token || ws.readyState !== WebSocket.OPEN) return;
    const session = store.sessions.get(client.token);
    if (!session) return ws.close(4001, "Session expired");
    const room = store.rooms.get(session.room);
    const signature = `${session.room}:${room?.revision}`;
    if (!force && client.signature === signature) return;
    if (ws.bufferedAmount > 256 * 1024) return ws.close(1013, "Slow client");
    const state = room
      ? store.snapshot(session, room)
      : { room: null, serverTime: store.now() };
    ws.send(JSON.stringify({ type: "state", state }));
    client.signature = signature;
  }
  const broadcast = () => {
    for (const ws of clients.keys()) sendState(ws);
  };
  store.on("change", broadcast);
  const storageError = () => {
    for (const ws of clients.keys())
      ws.close(1011, "Storage recovery required");
  };
  store.on("storage-error", storageError);

  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      checkOrigin(req);
      const address = req.socket.remoteAddress;
      const now = Date.now();
      let rate = counts.get(address);
      if (!rate || now - rate.at > 60_000) {
        rate = { at: now, count: 0, sessions: 0 };
        counts.set(address, rate);
      }
      if (++rate.count > 1800) throw new GameError("请求过于频繁", 429);
      if (req.method === "GET" && url.pathname === "/health") {
        if (store.storageFault)
          return send(503, {
            service: "codex-holdem",
            version: "0.2.0",
            status: "storage-recovery-required",
          });
        return send(200, { service: "codex-holdem", version: "0.2.0" });
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Holdem Terminal Server\n");
      }
      if (req.method !== "POST" || !/^\/api\/[a-z_]+$/.test(url.pathname)) {
        throw new GameError("Not found", 404);
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        throw new GameError("Expected application/json", 415);
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 8192) {
          req.resume();
          throw new GameError("请求内容过大", 413);
        }
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new GameError("Invalid JSON", 400);
      }
      const operation = url.pathname.slice(5);
      if (operation === "session") {
        if (++rate.sessions > 60) throw new GameError("创建玩家过于频繁", 429);
        return send(201, store.createSession());
      }
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
        req.headers.authorization || "",
      )?.[1];
      send(200, store.execute(token, operation, input));
    } catch (error) {
      const status = error.status || (error.code === "ENOENT" ? 503 : 400);
      send(status, {
        error:
          error.code === "ENOENT"
            ? "请先运行 npm run build"
            : error.message || "请求失败",
      });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      checkOrigin(req);
      if (req.url !== "/api/events") throw new Error("Unknown stream");
      const address = req.socket.remoteAddress;
      if (
        clients.size >= 2000 ||
        [...clients.values()].filter((c) => c.address === address).length >= 30
      )
        throw new Error("Too many connections");
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { address, token: null, lastMessage: 0, alive: true };
        clients.set(ws, client);
        const authTimeout = setTimeout(
          () => ws.close(4008, "Authentication timed out; retry"),
          streamAuthenticationMs,
        );
        authTimeout.unref();
        ws.on("pong", () => {
          client.alive = true;
        });
        ws.on("error", () => ws.terminate());
        ws.on("close", () => {
          clearTimeout(authTimeout);
          clients.delete(ws);
        });
        ws.on("message", (buffer) => {
          try {
            const now = Date.now();
            if (now - client.lastMessage < 1000)
              return ws.close(1008, "Too many messages");
            client.lastMessage = now;
            const message = JSON.parse(buffer.toString());
            if (!client.token) {
              if (
                message.type !== "authenticate" ||
                !/^[A-Za-z0-9_-]{43}$/.test(message.token)
              )
                return ws.close(4001, "Invalid authentication");
              store.execute(message.token, "get_table_state");
              if (
                [...clients.values()].filter((c) => c.token === message.token)
                  .length >= 4
              )
                return ws.close(1008, "Too many player connections");
              client.token = message.token;
              clearTimeout(authTimeout);
            } else {
              if (message.type !== "ping")
                return ws.close(1008, "Read-only stream");
              store.execute(client.token, "get_table_state");
            }
            sendState(ws, true);
          } catch (error) {
            ws.close(
              error.status === 401 ? 4001 : 1011,
              "Stream unavailable; refresh session",
            );
          }
        });
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const streamHeartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, streamHeartbeatMs);
  streamHeartbeat.unref();
  const timer = setInterval(() => {
    try {
      store.tick();
    } catch (error) {
      console.error(
        "牌局更新未保存，请检查本地存储：",
        error.code || "storage error",
      );
    }
  }, 250);
  const cleanup = setInterval(() => {
    try {
      store.cleanup();
    } catch (error) {
      console.error("清理未保存：", error.code || "storage error");
    }
    counts.clear();
  }, 60_000);
  timer.unref();
  cleanup.unref();
  server.on("close", () => {
    clearInterval(timer);
    clearInterval(cleanup);
    clearInterval(streamHeartbeat);
    store.off("change", broadcast);
    store.off("storage-error", storageError);
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
    store.close();
  });
  // HTTP server.close does not itself close upgraded WebSocket connections.
  const close = server.close.bind(server);
  server.close = (...args) => {
    for (const ws of clients.keys()) ws.terminate();
    return close(...args);
  };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.HOLDEM_PORT || 4318);
  const host = process.env.HOLDEM_HOST || "127.0.0.1";
  const allowedHosts = (process.env.HOLDEM_ALLOWED_HOSTS || "")
    .split(",")
    .filter(Boolean);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid HOLDEM_PORT");
  const inviteBaseUrl = process.env.HOLDEM_PUBLIC_URL || null;
  if (inviteBaseUrl) {
    const url = new URL(inviteBaseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("HOLDEM_PUBLIC_URL must be a plain HTTP(S) origin");
  }
  const storagePath =
    process.env.HOLDEM_EPHEMERAL === "1"
      ? undefined
      : resolve(
          process.env.HOLDEM_DATA_DIR ||
            fileURLToPath(new URL("../data/", import.meta.url)),
          "state.json",
        );
  const store = new RoomStore({ storagePath, inviteBaseUrl });
  const server = createGameServer({ allowedHosts, store });
  server.on("error", (error) => {
    console.error(`无法启动游戏服务：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Codex Holdem ready: http://${host}:${port}`);
    console.log(
      storagePath
        ? "Virtual chips only. Local recovery is enabled."
        : "Virtual chips only. Ephemeral test server.",
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close());
  }
}

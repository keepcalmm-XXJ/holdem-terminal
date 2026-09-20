import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createGameServer } from "../server/http.mjs";
import { RoomStore } from "../server/rooms.mjs";

async function fixture(t, options = {}) {
  const store = new RoomStore();
  const token = store.createSession().token;
  const { room } = store.execute(token, "create_room", {
    name: "Returning player",
    requestId: randomUUID(),
  });
  const server = createGameServer({
    store,
    streamHeartbeatMs: 100,
    streamAuthenticationMs: 1000,
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  async function connect(options = {}) {
    const socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/api/events`,
      { origin, ...options },
    );
    sockets.add(socket);
    socket.on("error", () => {});
    const closed = new Promise((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    await once(socket, "open");
    return {
      socket,
      closed,
      async authenticate() {
        const message = once(socket, "message", {
          signal: AbortSignal.timeout(2000),
        });
        socket.send(JSON.stringify({ type: "authenticate", token }));
        const [buffer] = await message;
        return JSON.parse(buffer.toString()).state;
      },
    };
  }
  return { store, token, room, origin, connect };
}

test(
  "stream authentication timeout is retryable and preserves the original room identity",
  { timeout: 5000 },
  async (t) => {
    const { token, room, origin, connect } = await fixture(t, {
      streamAuthenticationMs: 80,
    });
    const delayed = await connect();
    assert.equal(await delayed.closed, 4008);
    const response = await fetch(`${origin}/api/get_table_state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const restored = await response.json();
    assert.equal(restored.room, room);
    assert.equal(restored.me, 0);
    assert.equal(restored.players[0].name, "Returning player");
    const retry = await connect();
    assert.equal((await retry.authenticate()).room, room);
  },
);

test(
  "server terminates dead authenticated streams and frees all player connection slots",
  { timeout: 5000 },
  async (t) => {
    const { room, connect } = await fixture(t);
    const dead = await Promise.all(
      Array.from({ length: 4 }, () => connect({ autoPong: false })),
    );
    const states = await Promise.all(
      dead.map((client) => client.authenticate()),
    );
    assert.ok(states.every((state) => state.room === room && state.me === 0));
    assert.deepEqual(
      await Promise.all(dead.map((client) => client.closed)),
      [1006, 1006, 1006, 1006],
    );
    const replacements = await Promise.all(
      Array.from({ length: 4 }, () => connect()),
    );
    const restored = await Promise.all(
      replacements.map((client) => client.authenticate()),
    );
    assert.ok(restored.every((state) => state.room === room && state.me === 0));
  },
);

test(
  "normal pong responses keep an authenticated stream alive across heartbeat cycles",
  { timeout: 5000 },
  async (t) => {
    const { room, connect } = await fixture(t);
    const client = await connect();
    let pings = 0;
    const healthy = new Promise((resolve) => {
      client.socket.on("ping", () => {
        if (++pings === 3) resolve();
      });
    });
    assert.equal((await client.authenticate()).room, room);
    await healthy;
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    assert.equal(pings, 3);
  },
);

test(
  "health returns unavailable when persistent commit outcome is uncertain",
  { timeout: 5000 },
  async (t) => {
    const { store, origin } = await fixture(t);
    store.storageFault = true;
    try {
      const response = await fetch(`${origin}/health`);
      assert.equal(response.status, 503);
    } finally {
      store.storageFault = false;
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createGameServer } from "../server/http.mjs";
import { RoomStore } from "../server/rooms.mjs";

async function fixture(t) {
  const store = new RoomStore();
  const server = createGameServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin.replace("http:", "ws:")}/api/events`;
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  function command(token, operation, data = {}) {
    const state = store.execute(token, "get_table_state");
    return store.execute(token, operation, {
      revision: state.revision,
      requestId: randomUUID(),
      ...data,
    });
  }
  const first = store.createSession().token;
  const second = store.createSession().token;
  const { room } = command(first, "create_room", { name: "Alice" });
  command(second, "join_room", { name: "Bob", room });

  async function connect(options = {}) {
    const socket = new WebSocket(url, { origin, ...options });
    sockets.add(socket);
    const messages = [];
    socket.on("message", (buffer) => {
      messages.push(JSON.parse(buffer.toString()));
    });
    // Expected policy closures are asserted via close codes, never logged.
    socket.on("error", () => {});
    const closed = new Promise((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    await once(socket, "open");
    function nextState(predicate = () => true) {
      function matching() {
        const index = messages.findIndex(
          (message) => message.type === "state" && predicate(message.state),
        );
        return index < 0 ? undefined : messages.splice(index, 1)[0].state;
      }
      const already = matching();
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off("message", handle);
          reject(new Error("Timed out waiting for a matching player state"));
        }, 2000);
        function handle() {
          const state = matching();
          if (!state) return;
          clearTimeout(timer);
          socket.off("message", handle);
          resolve(state);
        }
        socket.on("message", handle);
      });
    }
    return {
      socket,
      messages,
      closed,
      nextState,
      authenticate: (token, extra = {}) =>
        socket.send(JSON.stringify({ type: "authenticate", token, ...extra })),
    };
  }
  return { store, server, url, origin, first, second, room, command, connect };
}

async function rejectedUpgrade(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Expected an HTTP rejection before WebSocket upgrade"));
    }, 2000);
    socket.on("error", () => {});
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("Unexpectedly accepted a forbidden WebSocket upgrade"));
    });
  });
}

function cardObjects(value) {
  if (!value || typeof value !== "object") return [];
  if ("rank" in value && "suit" in value) return [value];
  return Object.values(value).flatMap(cardObjects);
}

test("realtime rejects missing/invalid authentication and sends no unauthenticated state", async (t) => {
  const { connect } = await fixture(t);
  for (const message of [
    { type: "ping" },
    { type: "authenticate", token: "invalid" },
    { type: "authenticate", token: "z".repeat(43) },
  ]) {
    const client = await connect();
    client.socket.send(JSON.stringify(message));
    assert.equal(await client.closed, 4001);
    assert.equal(client.messages.length, 0);
  }
});

test("realtime rejects forged Origin/Host and any credential-bearing query before upgrade", async (t) => {
  const { url, origin } = await fixture(t);
  for (const [target, options] of [
    [url, { origin: "https://evil.example" }],
    [url, { origin: "null" }],
    [url, { headers: { Host: "evil.example" } }],
    [url, { origin: `${origin}0` }],
    [`${url}?token=not-a-real-credential`, { origin }],
    [`${url}?room=FFFFFFFF`, { origin }],
    [url.replace("/api/events", "/api/unknown"), { origin }],
  ]) {
    assert.equal(await rejectedUpgrade(target, options), 403);
  }
});

test("realtime pushes per-player private cards, revisions and legal actor after another player's action", async (t) => {
  const { store, first, second, room, command, connect } = await fixture(t);
  command(first, "set_ready", { ready: true });
  command(second, "set_ready", { ready: true });
  const initial = command(first, "start_game");
  const alice = await connect();
  const bob = await connect();
  alice.authenticate(first);
  bob.authenticate(second);
  let [a, b] = await Promise.all([alice.nextState(), bob.nextState()]);
  function assertPrivate(state, token, seat) {
    const expected = store.execute(token, "get_table_state");
    assert.equal(state.room, room);
    assert.equal(state.me, seat);
    assert.deepEqual(state.holeCards, expected.holeCards);
    assert.deepEqual(cardObjects(state), [...state.board, ...state.holeCards]);
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes(first), false);
    assert.equal(serialized.includes(second), false);
    assert.equal(serialized.includes('"deck"'), false);
    assert.equal(serialized.includes('"checkpoint"'), false);
  }
  assertPrivate(a, first, 0);
  assertPrivate(b, second, 1);
  assert.equal(a.revision, initial.revision);
  assert.equal(b.revision, initial.revision);
  assert.equal(a.actor, 0);
  assert.ok(a.legal.actions.includes("call"));
  assert.deepEqual(b.legal, { actions: [] });

  let changed = command(first, "player_action", { action: "call" });
  [a, b] = await Promise.all([
    alice.nextState((state) => state.revision === changed.revision),
    bob.nextState((state) => state.revision === changed.revision),
  ]);
  assert.equal(a.actor, 1);
  assert.equal(b.actor, 1);
  assert.deepEqual(a.legal, { actions: [] });
  assert.ok(b.legal.actions.includes("check"));
  assertPrivate(a, first, 0);
  assertPrivate(b, second, 1);

  changed = command(second, "player_action", { action: "check" });
  [a, b] = await Promise.all([
    alice.nextState((state) => state.revision === changed.revision),
    bob.nextState((state) => state.revision === changed.revision),
  ]);
  assert.equal(a.phase, "flop");
  assert.equal(a.board.length, 3);
  assertPrivate(a, first, 0);
  assertPrivate(b, second, 1);
});

test("realtime room/seat/token overrides cannot change authenticated player or subscription", async (t) => {
  const { store, first, second, room, command, connect } = await fixture(t);
  const stranger = store.createSession().token;
  const otherRoom = command(stranger, "create_room", { name: "Charlie" }).room;
  const client = await connect();
  client.authenticate(first, { room: otherRoom, seat: 1 });
  let state = await client.nextState();
  assert.equal(state.room, room);
  assert.equal(state.me, 0);
  assert.deepEqual(
    state.players.map((player) => player.name),
    ["Alice", "Bob"],
  );
  await delay(1050);
  client.socket.send(
    JSON.stringify({
      type: "ping",
      token: second,
      room: otherRoom,
      seat: 1,
    }),
  );
  state = await client.nextState();
  assert.equal(state.room, room);
  assert.equal(state.me, 0);
  await delay(1050);
  client.socket.send(
    JSON.stringify({ type: "subscribe", room: otherRoom, seat: 0 }),
  );
  assert.equal(await client.closed, 1008);
});

test("realtime broadcasts chat without changing the action revision or deadline", async (t) => {
  const { first, second, command, connect } = await fixture(t);
  command(first, "set_ready", { ready: true });
  command(second, "set_ready", { ready: true });
  command(first, "start_game");
  const client = await connect();
  client.authenticate(first);
  const before = await client.nextState();
  const sent = command(second, "send_chat", { text: "hello" });
  const after = await client.nextState(
    (state) => state.chatRevision === before.chatRevision + 1,
  );
  assert.equal(after.revision, before.revision);
  assert.equal(after.deadline, before.deadline);
  assert.deepEqual(after.chat, sent.chat);
  assert.equal(after.chat[0].name, "Bob");
});

test("realtime heartbeat refreshes presence but action messages are read-only and cannot mutate a hand", async (t) => {
  const { store, first, second, room, command, connect } = await fixture(t);
  command(first, "set_ready", { ready: true });
  command(second, "set_ready", { ready: true });
  command(first, "start_game");
  const client = await connect();
  client.authenticate(first);
  const initial = await client.nextState();
  const seenAt = store.sessions.get(first).seenAt;
  await delay(1050);
  client.socket.send(JSON.stringify({ type: "ping" }));
  const heartbeat = await client.nextState();
  assert.equal(heartbeat.revision, initial.revision);
  assert.ok(store.sessions.get(first).seenAt > seenAt);
  await delay(1050);
  client.socket.send(
    JSON.stringify({
      type: "player_action",
      room,
      action: "fold",
      revision: initial.revision,
      requestId: randomUUID(),
    }),
  );
  assert.equal(await client.closed, 1008);
  const after = store.execute(first, "get_table_state");
  assert.equal(after.revision, initial.revision);
  assert.equal(after.actor, initial.actor);
  assert.equal(after.inProgress, true);
});

test("realtime close frees player connection slots and server close removes subscriptions", async (t) => {
  const { store, server, first, connect } = await fixture(t);
  const clients = [];
  for (let index = 0; index < 4; index++) {
    const client = await connect();
    client.authenticate(first);
    await client.nextState();
    clients.push(client);
  }
  const blocked = await connect();
  blocked.authenticate(first);
  assert.equal(await blocked.closed, 1008);
  clients[0].socket.close();
  await clients[0].closed;
  const replacement = await connect();
  replacement.authenticate(first);
  assert.equal((await replacement.nextState()).me, 0);
  assert.equal(store.listenerCount("change"), 1);
  assert.equal(store.listenerCount("storage-error"), 1);
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([
    ...clients.slice(1).map((client) => client.closed),
    replacement.closed,
  ]);
  assert.equal(store.listenerCount("change"), 0);
  assert.equal(store.listenerCount("storage-error"), 0);
});

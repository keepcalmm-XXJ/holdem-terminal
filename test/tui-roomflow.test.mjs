import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/rooms.mjs";
import { TerminalClient } from "../bin/holdem-client.mjs";
import { formatTable } from "../bin/holdem-lib.mjs";

function setup() {
  const store = new RoomStore({ now: () => 1000 });
  const alice = store.createSession().token;
  const bob = store.createSession().token;
  const execute = (token, operation, extras = {}) => {
    const current = store.execute(token, "get_table_state");
    return store.execute(token, operation, {
      ...(current.room
        ? { room: current.room, revision: current.revision }
        : {}),
      ...extras,
      requestId: randomUUID(),
    });
  };
  const { room } = execute(alice, "create_room", { name: "Alice" });
  execute(bob, "join_room", { room, name: "Bob" });
  execute(alice, "set_ready", { ready: true });
  execute(bob, "set_ready", { ready: true });
  execute(alice, "start_game");
  const session = (token) => ({
    token,
    state: async () => store.execute(token, "get_table_state"),
    mutate: async (operation, state, extras, id) =>
      store.execute(token, operation, {
        room: state.room,
        revision: state.revision,
        ...extras,
        requestId: id,
      }),
  });
  return { store, alice, bob, execute, session };
}

test("client + room flow: chat arriving between typing and submission does not reject a call", async () => {
  const { store, alice, bob, session } = setup();
  const client = new TerminalClient({
    session: session(alice),
    now: () => 1000,
  });
  const chatter = new TerminalClient({
    session: session(bob),
    now: () => 1000,
  });
  await client.refresh();
  await chatter.refresh();
  const context = client.context();
  const revision = client.state.revision;
  const deadline = client.state.deadline;
  await chatter.mutate("send_chat", { text: "hello" });
  await client.mutate("player_action", { action: "call" }, context);
  assert.equal(client.state.revision, revision + 1);
  assert.equal(client.state.chatRevision, 1);
  assert.equal(client.state.deadline, deadline);
  const event = client.state.events.find((entry) => entry.action);
  assert.equal(event.name, "Alice");
  assert.equal(event.phase, "preflop");
  assert.equal(event.hand, 1);
  const display = formatTable(client.state, {
    columns: 80,
    rows: 20,
    now: 1000,
    historyExpanded: true,
  });
  assert.match(display, /Alice 跟注/);
  assert.match(display, /Bob：hello/);
  client.close();
  chatter.close();
  store.close();
});

test("lost response is reconciled by retrying the original action exactly once", async () => {
  const { store, alice, session } = setup();
  const transport = session(alice);
  const mutate = transport.mutate;
  let loseReply = true;
  transport.mutate = async (...args) => {
    const result = await mutate(...args);
    if (loseReply) {
      loseReply = false;
      throw new Error("simulated response loss after commit");
    }
    return result;
  };
  const client = new TerminalClient({ session: transport, now: () => 1000 });
  await client.refresh();
  const before = client.state.revision;
  await assert.rejects(
    client.mutate("player_action", { action: "call" }),
    /结果待确认/,
  );
  await client.refresh();
  assert.equal(client.state.revision, before + 1);
  assert.equal(client.state.events.filter((entry) => entry.action).length, 1);
  await client.retry();
  assert.equal(client.pending, null);
  assert.equal(client.state.revision, before + 1);
  assert.equal(client.state.events.filter((entry) => entry.action).length, 1);
  client.close();
  store.close();
});

test("real street transition rejects a drafted action and renders separated routes", async () => {
  const { store, alice, bob, execute, session } = setup();
  const client = new TerminalClient({ session: session(bob), now: () => 1000 });
  await client.refresh();
  const oldContext = client.context();
  execute(alice, "player_action", { action: "call" });
  execute(bob, "player_action", { action: "check" });
  await client.refresh();
  assert.equal(client.state.phase, "flop");
  await assert.rejects(
    client.mutate("player_action", { action: "check" }, oldContext),
    /牌局已变化/,
  );
  await client.mutate("player_action", { action: "check" }, client.context());
  const display = formatTable(client.state, {
    columns: 100,
    rows: 30,
    historyExpanded: true,
    now: 1000,
  });
  assert.match(display, /H1\/翻牌前.*Alice 跟注.*Bob 过牌/s);
  assert.match(display, /H1\/翻牌.*Bob 过牌/);
  client.close();
  store.close();
});

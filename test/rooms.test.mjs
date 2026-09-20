import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/rooms.mjs";

function setup(count = 2, options) {
  const store = new RoomStore(options);
  const tokens = Array.from(
    { length: count },
    () => store.createSession().token,
  );
  const run = (n, op, input = {}) => {
    const snapshot = store.execute(tokens[n], "get_table_state");
    return store.execute(tokens[n], op, {
      ...(snapshot.room ? { revision: snapshot.revision } : {}),
      requestId: randomUUID(),
      ...input,
    });
  };
  const room = run(0, "create_room", { name: "Alice" }).room;
  for (let i = 1; i < count; i++)
    run(i, "join_room", { name: `Player ${i}`, room });
  const view = (i = 0) => store.execute(tokens[i], "get_table_state");
  const start = () => {
    for (let i = 0; i < count; i++) run(i, "set_ready", { ready: true });
    return run(0, "start_game");
  };
  return { store, tokens, run, room, view, start };
}

test("room membership and host authorization; no arbitrary seat impersonation", () => {
  const g = setup();
  const outsider = g.store.createSession().token;
  assert.throws(
    () => g.store.execute(outsider, "get_table_state", { room: g.room }),
    /尚未加入/,
  );
  assert.throws(() => g.store.execute("fake", "get_table_state"), /失效/);
  assert.throws(() => g.run(1, "start_game"), /只有房主/);
  assert.throws(() => g.run(0, "start_game"), /等待所有/);
  g.start();
  const actor = g.view().actor;
  assert.throws(
    () => g.run(1 - actor, "player_action", { action: "fold", seat: actor }),
    /还没轮到/,
  );
});

test("private cards, snapshots and events never expose other private cards", () => {
  const g = setup(6);
  g.start();
  const hands = [];
  for (let i = 0; i < 6; i++) {
    const s = g.view(i);
    assert.equal(s.holeCards.length, 2);
    hands.push(...s.holeCards);
    assert.ok(!JSON.stringify(s).includes(g.tokens[i]));
    assert.ok(
      !JSON.stringify(s).includes(
        '"id":"' + g.store.sessions.get(g.tokens[i]).id + '"',
      ),
    );
    assert.equal(s.result, null);
    for (const player of s.players) {
      assert.ok(!Object.hasOwn(player, "cards"));
      assert.ok(!Object.hasOwn(player, "holeCards"));
    }
    if (s.actor !== i) assert.deepEqual(s.legal.actions, []);
  }
  assert.equal(new Set(hands.map((c) => JSON.stringify(c))).size, 12);
  const detached = g.view();
  detached.players[0].stack = 99999;
  assert.notEqual(g.view().players[0].stack, 99999);
});

test("retry is idempotent, request ID conflicts reject, stale actions reject", () => {
  const g = setup();
  g.start();
  const first = g.view();
  const actor = first.actor;
  const input = {
    action: "call",
    revision: first.revision,
    requestId: randomUUID(),
  };
  const a = g.store.execute(g.tokens[actor], "player_action", input);
  const duplicate = g.store.execute(g.tokens[actor], "player_action", input);
  assert.deepEqual(a, duplicate);
  assert.equal(
    a.players.find((player) => player.seat === actor).lastAction.action,
    "call",
  );
  assert.equal(
    a.players.find((player) => player.seat === actor).lastAction.amount,
    first.legal.call,
  );
  assert.equal(g.view().revision, first.revision + 1);
  assert.throws(
    () =>
      g.store.execute(g.tokens[actor], "player_action", {
        ...input,
        action: "fold",
      }),
    /不同操作/,
  );
  assert.throws(
    () =>
      g.run(a.actor, "player_action", {
        action: "check",
        revision: first.revision,
      }),
    /状态已变化/,
  );
  g.run(a.actor, "player_action", { action: "check" });
  assert.deepEqual(g.store.execute(g.tokens[actor], "player_action", input), a);
});

test("a fold returns the settled snapshot with the fold action preserved", () => {
  const g = setup();
  g.start();
  const actor = g.view().actor;
  const settled = g.run(actor, "player_action", { action: "fold" });
  const folded = settled.players.find((player) => player.seat === actor);
  assert.equal(settled.phase, "complete");
  assert.equal(folded.folded, true);
  assert.equal(folded.lastAction.action, "fold");
  assert.equal(settled.events.at(-2).action.action, "fold");
});

test("timer checks or folds, even when no client polls; reads never extend it", () => {
  let now = 100_000;
  const g = setup(2, { now: () => now, turnMs: 1000 });
  g.start();
  const before = g.view();
  now += 900;
  assert.equal(g.view().deadline, before.deadline);
  now += 101;
  g.store.tick();
  assert.equal(g.view().phase, "complete");
  assert.match(g.view().events.at(-2).text, /超时弃牌/);
  assert.equal(g.view().result.showdown.length, 0);
  assert.equal(
    g.view().players.reduce((sum, p) => sum + p.stack, 0),
    4000,
  );
});

test("timeout checks when free, and a replaced seat does not inherit folded status", () => {
  let now = 10;
  const g = setup(2, { now: () => now, turnMs: 1000 });
  g.start();
  g.run(g.view().actor, "player_action", { action: "call" });
  now += 1001;
  g.store.tick();
  assert.equal(g.view().phase, "flop");
  assert.match(g.view().events.at(-1).text, /超时过牌/);
  const folded = g.view().actor;
  g.run(folded, "player_action", { action: "fold" });
  g.run(folded, "leave_room");
  const next = g.run(folded, "join_room", {
    room: g.room.toLowerCase(),
    name: "New player",
  });
  assert.equal(next.players.find((p) => p.seat === next.me).folded, false);
  assert.deepEqual(next.holeCards, []);
  assert.equal(
    g.store.execute(g.tokens[folded], "get_table_state", {
      room: g.room.toLowerCase(),
    }).room,
    g.room,
  );
});

test("full hand, privacy after folds, history, readiness reset, rotation and leave", () => {
  const g = setup(3);
  g.start();
  const button = g.view().button;
  const foldedSeat = g.view().actor;
  g.run(foldedSeat, "player_action", { action: "fold" });
  let iterations = 0;
  while (g.view().inProgress) {
    const actor = g.view().actor;
    const s = g.view(actor);
    g.run(actor, "player_action", {
      action: s.legal.actions.includes("check") ? "check" : "call",
    });
    assert.ok(++iterations < 30);
  }
  const finished = g.view();
  assert.equal(finished.board.length, 5);
  assert.equal(finished.history.length, 1);
  assert.ok(!finished.result.showdown.some((p) => p.seat === foldedSeat));
  assert.ok(finished.players.every((p) => !p.ready));
  assert.equal(
    finished.players.reduce((sum, p) => sum + p.stack, 0),
    6000,
  );
  assert.notEqual(g.start().button, button);
  assert.throws(() => g.run(0, "leave_room"), /本手结束后/);
  while (g.view().inProgress)
    g.run(g.view().actor, "player_action", { action: "fold" });
  g.run(0, "leave_room");
  assert.equal(g.view().room, null);
  assert.equal(g.view(1).host, 1);
});

test("room capacity, names, malformed requests, duplicate joins and expiration", () => {
  let now = 10;
  const g = setup(6, { now: () => now });
  const extra = g.store.createSession().token;
  assert.throws(
    () =>
      g.store.execute(extra, "join_room", {
        requestId: randomUUID(),
        room: g.room,
        name: "Extra",
      }),
    /房间已满/,
  );
  assert.throws(() => g.run(0, "create_room", { name: "Elsewhere" }), /先离开/);
  assert.throws(
    () =>
      g.store.execute(extra, "create_room", {
        requestId: randomUUID(),
        name: "\u0000",
      }),
    /可见字符/,
  );
  assert.throws(
    () => g.store.execute(extra, "create_room", { name: "No ID" }),
    /requestId/,
  );
  now += 6 * 60 * 60 * 1000 + 1;
  g.store.cleanup();
  assert.equal(g.store.rooms.size, 0);
  assert.throws(() => g.view(), /会话已失效/);
});

test("inactive members park chips between hands and host transfers to an active player", () => {
  let now = 0;
  const g = setup(3, { now: () => now });
  now = 100_000;
  g.run(1, "set_ready", { ready: true });
  g.run(2, "set_ready", { ready: true });
  const before = g.view(1).revision;
  now = 120_001;
  g.store.tick();
  const after = g.view(1);
  assert.deepEqual(
    after.players.filter((p) => !p.away).map((p) => p.seat),
    [1, 2],
  );
  assert.equal(after.host, 1);
  assert.ok(after.revision > before);
  assert.equal(after.players.find((p) => p.seat === 0).stack, 2000);
  assert.equal(after.players.find((p) => p.seat === 0).connected, false);
  assert.equal(g.store.sessions.get(g.tokens[0]).room, g.room);
  assert.equal(g.run(1, "start_game").inProgress, true);
  assert.deepEqual(g.view(0).holeCards, []);
  assert.throws(() => g.run(0, "resume_seat"), /本手结束/);
  g.run(g.view(1).actor, "player_action", { action: "fold" });
  const resumed = g.run(0, "resume_seat");
  assert.equal(resumed.players.find((p) => p.seat === 0).away, false);
  assert.equal(resumed.players.find((p) => p.seat === 0).stack, 2000);
});

test("players can explicitly sit out and hosts can transfer control between hands", () => {
  const g = setup(3);
  let table = g.run(0, "transfer_host", { seat: 1 });
  assert.equal(table.host, 1);
  assert.throws(() => g.run(0, "transfer_host", { seat: 2 }), /只有房主能转移/);

  table = g.run(0, "set_away");
  const alice = table.players.find((p) => p.seat === 0);
  assert.equal(alice.away, true);
  assert.equal(alice.ready, false);
  assert.equal(alice.stack, 2000);
  assert.equal(table.host, 1);
  assert.throws(
    () => g.run(1, "transfer_host", { seat: 0 }),
    /暂离玩家不能成为房主/,
  );

  g.run(1, "set_ready", { ready: true });
  g.run(2, "set_ready", { ready: true });
  table = g.run(1, "start_game");
  assert.equal(table.inProgress, true);
  assert.deepEqual(g.view(0).holeCards, []);
  assert.throws(() => g.run(1, "set_away"), /请等待本手结束/);
  assert.throws(() => g.run(1, "transfer_host", { seat: 2 }), /请等待本手结束/);
});

test("inactive players are never removed during a hand; empty rooms are deleted", () => {
  let now = 0;
  const g = setup(2, { now: () => now, idleMs: 1000, turnMs: 5000 });
  g.start();
  now = 1001;
  g.store.tick();
  assert.equal(g.store.rooms.get(g.room).members.length, 2);
  now = 5001;
  g.store.tick();
  const room = g.store.rooms.get(g.room);
  assert.equal(room.engine.publicState().inProgress, false);
  assert.equal(room.members.length, 2);
  assert.equal(room.history.length, 1);
  assert.equal(
    room.engine.publicState().seats.reduce((n, p) => n + (p?.stack || 0), 0),
    4000,
  );
  g.store.tick();
  assert.equal(
    g.store.rooms.get(g.room).members.every((p) => p.away),
    true,
  );
  now = 30 * 60_000 + 1;
  g.store.tick();
  assert.equal(g.store.rooms.has(g.room), false);
  assert.ok(g.tokens.every((t) => g.store.sessions.get(t).room === null));
});

test("presence heartbeats never extend the action deadline", () => {
  let now = 0;
  const g = setup(2, { now: () => now, turnMs: 60_000, onlineMs: 1000 });
  g.start();
  const deadline = g.view().deadline;
  now = 1001;
  g.store.tick();
  assert.equal(g.view().deadline, deadline);
  assert.equal(g.view(1).deadline, deadline);
});

test("returning with zero chips does not silently refill the stack", () => {
  let now = 0;
  const g = setup(2, { now: () => now, idleMs: 1000 });
  // Reach a real busted seat by playing until a non-tied all-in.
  for (let attempt = 0; attempt < 100; attempt++) {
    g.start();
    g.run(g.view().actor, "player_action", { action: "all-in" });
    g.run(g.view().actor, "player_action", { action: "call" });
    if (g.view().players.some((p) => p.stack === 0)) break;
  }
  const empty = g.view().players.find((p) => p.stack === 0);
  assert.ok(empty, "all-in hands must reach the busted-seat branch");
  now = 1001;
  g.store.tick();
  const resumed = g.run(empty.seat, "resume_seat");
  assert.equal(resumed.players.find((p) => p.seat === empty.seat).stack, 0);
  assert.throws(
    () => g.run(empty.seat, "set_ready", { ready: true }),
    /筹码不足/,
  );
});

test("reused seats keep historical participant names and hide previous showdown on seats", () => {
  const g = setup();
  g.start();
  while (g.view().inProgress) {
    const actor = g.view().actor;
    const view = g.view(actor);
    g.run(actor, "player_action", {
      action: view.legal.actions.includes("check") ? "check" : "call",
    });
  }
  const finished = g.view();
  assert.equal(finished.showdownOnSeats, true);
  assert.equal(finished.result.showdown.length, 2);
  g.run(0, "leave_room");
  const replacement = g.run(0, "join_room", {
    room: g.room,
    name: "Replacement",
  });
  assert.equal(replacement.me, 0);
  assert.equal(replacement.showdownOnSeats, false);
  assert.deepEqual(replacement.holeCards, []);
  assert.equal(
    replacement.history[0].players.find((p) => p.seat === 0).name,
    "Alice",
  );
  assert.deepEqual(replacement.history, finished.history);
});

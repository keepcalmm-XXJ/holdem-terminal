import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RoomStore } from "../server/rooms.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "holdem-recovery-"));
  const storagePath = join(dir, "state.json");
  let now = 1000;
  let store = new RoomStore({ storagePath, now: () => now });
  const tokens = [store.createSession().token, store.createSession().token];
  const view = (i = 0) => store.execute(tokens[i], "get_table_state");
  const run = (i, op, input = {}) =>
    store.execute(tokens[i], op, {
      requestId: randomUUID(),
      revision: view(i).revision,
      ...input,
    });
  const room = run(0, "create_room", { name: "Host" }).room;
  run(1, "join_room", { room, name: "Guest" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    storagePath,
    tokens,
    view,
    run,
    restart() {
      store.close();
      now += 60_000;
      store = new RoomStore({ storagePath, now: () => now });
    },
  };
}

test("room recovery restores private cards, exact commitments and idempotency after restart", (t) => {
  const g = fixture(t);
  g.run(0, "set_ready", { ready: true });
  g.run(1, "set_ready", { ready: true });
  g.run(0, "start_game");
  const a = g.view();
  const b = g.view(1);
  const input = {
    requestId: randomUUID(),
    revision: a.revision,
    action: "call",
  };
  const response = g.store.execute(g.tokens[a.actor], "player_action", input);
  const after = g.view();
  g.restart();
  const restored = g.view();
  assert.deepEqual(restored.holeCards, a.holeCards);
  assert.deepEqual(g.view(1).holeCards, b.holeCards);
  assert.deepEqual(
    restored.players.map((p) => [p.stack, p.bet]),
    after.players.map((p) => [p.stack, p.bet]),
  );
  assert.equal(restored.actor, after.actor);
  assert.ok(restored.deadline > after.deadline);
  assert.deepEqual(
    g.store.execute(g.tokens[a.actor], "player_action", input),
    response,
  );
  assert.deepEqual(
    g.view().players.map((p) => p.stack),
    after.players.map((p) => p.stack),
  );
  while (g.view().inProgress) {
    const actor = g.view().actor;
    const state = g.view(actor);
    g.run(actor, "player_action", {
      action: state.legal.actions.includes("check") ? "check" : "call",
    });
  }
  assert.equal(
    g.view().players.reduce((n, p) => n + p.stack, 0),
    4000,
  );
  assert.equal(g.view().history.length, 1);
  const completed = g.view().result;
  g.restart();
  assert.deepEqual(g.view().result, completed);
  assert.equal(g.view().history.length, 1);
});

test("failed durable writes roll back readiness and do not broadcast uncommitted changes", (t) => {
  const g = fixture(t);
  const before = g.view();
  const disk = readFileSync(g.storagePath, "utf8");
  let broadcasts = 0;
  g.store.on("change", () => broadcasts++);
  const save = g.store.storage.save.bind(g.store.storage);
  g.store.storage.save = () => {
    throw new Error("test save failure");
  };
  assert.throws(
    () =>
      g.store.execute(g.tokens[0], "set_ready", {
        requestId: randomUUID(),
        revision: before.revision,
        ready: true,
      }),
    /test save failure/,
  );
  assert.equal(broadcasts, 0);
  assert.equal(g.store.rooms.get(before.room).revision, before.revision);
  assert.equal(g.store.rooms.get(before.room).members[0].ready, false);
  assert.equal(readFileSync(g.storagePath, "utf8"), disk);
  g.store.storage.save = save;
  assert.equal(g.run(0, "set_ready", { ready: true }).players[0].ready, true);
});

test("uncertain commit stops further operations instead of rolling back and continuing", (t) => {
  const g = fixture(t);
  const before = g.view();
  g.store.storage.save = () => {
    const error = new Error("commit uncertain");
    error.committed = true;
    throw error;
  };
  assert.throws(
    () =>
      g.store.execute(g.tokens[0], "set_ready", {
        requestId: randomUUID(),
        revision: before.revision,
        ready: true,
      }),
    /commit uncertain/,
  );
  assert.throws(() => g.view(), /重启服务/);
  assert.throws(() => g.store.tick(), /重启服务/);
});

test("invalid room snapshot fails closed without replacing the original file", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "holdem-invalid-"));
  const file = join(dir, "state.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = JSON.stringify({ version: 99, rooms: [], sessions: [] });
  writeFileSync(file, bad, { mode: 0o600 });
  assert.throws(() => new RoomStore({ storagePath: file }), /格式无效/);
  assert.equal(readFileSync(file, "utf8"), bad);
});

test("valid falsy JSON is not mistaken for a missing save", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "holdem-falsy-"));
  const file = join(dir, "state.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const bad of ["null", "false", "0", '""']) {
    writeFileSync(file, bad, { mode: 0o600 });
    assert.throws(() => new RoomStore({ storagePath: file }), /格式无效/);
    assert.equal(readFileSync(file, "utf8"), bad);
  }
});

test("dangling player-room references fail even with a valid checksum", (t) => {
  const g = fixture(t);
  g.store.close();
  const snapshot = JSON.parse(readFileSync(g.storagePath, "utf8"));
  snapshot.sessions[0][1].room = "ABCDEF12";
  delete snapshot.checksum;
  snapshot.checksum = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  const bad = JSON.stringify(snapshot);
  writeFileSync(g.storagePath, bad);
  assert.throws(
    () => new RoomStore({ storagePath: g.storagePath }),
    /引用无效/,
  );
  assert.equal(readFileSync(g.storagePath, "utf8"), bad);
});

import test from "node:test";
import assert from "node:assert/strict";
import { TerminalClient } from "../bin/holdem-client.mjs";
import { TerminalSession } from "../bin/holdem-lib.mjs";

const snapshot = (overrides = {}) => ({
  room: "ABCD1234",
  revision: 1,
  chatRevision: 0,
  hand: 1,
  phase: "preflop",
  actor: 0,
  me: 0,
  inProgress: true,
  deadline: 30_000,
  serverTime: 0,
  ...overrides,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  const session = {
    token: "identity",
    state: async () => snapshot(),
    mutate: async () => snapshot({ revision: 2 }),
    ...overrides,
  };
  const client = new TerminalClient({ session, now: () => 0 });
  return { client, session };
}

test("in-flight old polls cannot undo mutations, room changes, or connection state", async () => {
  for (const outcome of ["stale", "failure", "old-room"]) {
    const { client, session } = setup();
    await client.refresh();
    const read = deferred();
    session.state = () => read.promise;
    const poll = client.refresh();
    const result =
      outcome === "old-room"
        ? snapshot({ room: null })
        : snapshot({ revision: 4 });
    session.mutate = async () => result;
    await client.mutate("leave_room");
    if (outcome === "failure") read.reject(new Error("old network failure"));
    else read.resolve(snapshot({ revision: 3 }));
    await poll;
    assert.deepEqual(client.state, result);
    assert.equal(client.connection, "online");
  }
});

test("polling is single-flight and skipped while a mutation is running", async () => {
  const { client, session } = setup();
  const read = deferred();
  let reads = 0;
  session.state = () => {
    reads += 1;
    return read.promise;
  };
  const first = client.refresh();
  const second = client.refresh();
  assert.equal(reads, 1);
  read.resolve(snapshot());
  await Promise.all([first, second]);
  const action = deferred();
  session.mutate = () => action.promise;
  const pending = client.mutate("player_action", { action: "call" });
  await client.refresh();
  await assert.rejects(client.mutate("set_ready"), /尚未完成/);
  assert.equal(reads, 1);
  action.resolve(snapshot({ revision: 2 }));
  await pending;
});

test("never submit an action against an unseen game revision", async () => {
  const { client, session } = setup();
  let submitted = 0;
  session.mutate = async () => {
    submitted += 1;
    return snapshot({ revision: 3 });
  };
  await client.refresh();
  const typedAt = client.context();
  session.state = async () => snapshot({ revision: 2, phase: "flop" });
  await client.refresh();
  await assert.rejects(
    client.mutate("player_action", { action: "call" }, typedAt),
    /输入期间牌局已变化/,
  );
  assert.equal(submitted, 0);
  assert.equal(client.pending, null);
  assert.equal(client.busy, false);
});

test("chat-only updates do not invalidate action intent", async () => {
  const { client, session } = setup();
  await client.refresh();
  const typedAt = client.context();
  session.state = async () => snapshot({ chatRevision: 1 });
  await client.refresh();
  session.mutate = async () => snapshot({ revision: 2, chatRevision: 1 });
  await client.mutate("player_action", { action: "call" }, typedAt);
  assert.equal(client.state.revision, 2);
  assert.equal(client.state.chatRevision, 1);
});

test("reject older chat snapshots and maintain a server-adjusted clock", async () => {
  let now = 1000;
  const { session } = setup();
  const client = new TerminalClient({ session, now: () => now });
  client.accept(snapshot({ revision: 4, chatRevision: 3, serverTime: 6000 }));
  assert.equal(client.serverNow(), 6000);
  now = 2000;
  assert.equal(client.serverNow(), 7000);
  client.accept(snapshot({ revision: 4, chatRevision: 2, serverTime: 7000 }));
  assert.equal(client.state.chatRevision, 3);
  client.accept(snapshot({ revision: 3, chatRevision: 3, serverTime: 0 }));
  assert.equal(client.state.revision, 4);
  assert.equal(client.serverNow(), 7000);
});

test("background failures and recovery are visible even without revision changes", async () => {
  const { client, session } = setup();
  const changes = [];
  client.onChange = () => changes.push(client.connection);
  await client.refresh();
  session.state = async () => {
    throw new Error("disconnected");
  };
  await assert.rejects(client.refresh(), /disconnected/);
  assert.equal(client.connection, "offline");
  assert.equal(client.lastError, "disconnected");
  session.state = async () => snapshot();
  await client.refresh();
  assert.deepEqual(changes, ["online", "offline", "online"]);
});

test("uncertain actions are never automatically retried and explicit retries reuse exact arguments", async () => {
  const { client, session } = setup();
  const requests = [];
  session.mutate = async (...args) => {
    requests.push(structuredClone(args));
    if (requests.length === 1) throw new Error("response lost");
    return snapshot({ revision: 2 });
  };
  await client.refresh();
  await assert.rejects(
    client.mutate("player_action", { action: "call" }),
    /结果待确认/,
  );
  assert.equal(client.pending.uncertain, true);
  await client.refresh();
  assert.equal(requests.length, 1);
  await assert.rejects(
    client.mutate("player_action", { action: "fold" }),
    /retry/,
  );
  await client.retry();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(client.pending, null);
  assert.equal(client.state.revision, 2);
});

test("uncertain commit responses retain the original request until resolved", async () => {
  const { client, session } = setup();
  await client.refresh();
  session.mutate = async () => {
    const error = new Error("uncertain disk commit");
    error.status = 503;
    error.code = "COMMIT_UNCERTAIN";
    throw error;
  };
  await assert.rejects(
    client.mutate("set_ready", { ready: true }),
    /结果待确认/,
  );
  const id = client.pending.id;
  session.mutate = async () => {
    const error = new Error("storage unavailable");
    error.status = 503;
    error.code = "STORAGE_FAULT";
    throw error;
  };
  await assert.rejects(client.retry(), /结果待确认/);
  assert.equal(client.pending.id, id);
});

test("definitive rejections clear pending actions; expired identities clear stale state", async () => {
  for (const status of [400, 401, 409, 429]) {
    const { client, session } = setup();
    await client.refresh();
    session.mutate = async () => {
      const error = new Error("rejected");
      error.status = status;
      throw error;
    };
    await assert.rejects(
      client.mutate("player_action", { action: "call" }),
      /rejected/,
    );
    assert.equal(client.pending, null);
    if (status === 401) assert.equal(client.state, undefined);
  }
});

test("closing invalidates pending reads and calls transport cancellation", async () => {
  const read = deferred();
  let closed = false;
  const { client } = setup({
    state: () => read.promise,
    close: () => (closed = true),
  });
  const poll = client.refresh();
  client.close();
  read.resolve(snapshot());
  await poll;
  assert.equal(client.state, undefined);
  assert.equal(closed, true);
});

test("session transport preserves error codes and exact explicit retry IDs", async () => {
  const payloads = [];
  const session = new TerminalSession({
    base: new URL("http://127.0.0.1:4318"),
    statePath: "/unused",
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "uncertain", code: "COMMIT_UNCERTAIN" }),
      };
    },
  });
  session.token = "mock";
  for (let i = 0; i < 2; i += 1)
    await assert.rejects(
      session.mutate(
        "player_action",
        snapshot(),
        { action: "call" },
        "same-id",
      ),
      { status: 503, code: "COMMIT_UNCERTAIN" },
    );
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[0].requestId, "same-id");
  session.close();
});

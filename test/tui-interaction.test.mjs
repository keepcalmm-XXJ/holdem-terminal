import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { runTerminal } from "../bin/holdem.mjs";
import { cleanTerminalText } from "../bin/holdem-lib.mjs";

class TestTerminal extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(String(chunk));
    callback();
  }

  take() {
    return this.chunks.splice(0).join("");
  }
}

async function start(t) {
  let now = 0;
  let state = {
    room: "ABCD1234",
    revision: 1,
    chatRevision: 0,
    hand: 1,
    phase: "preflop",
    actor: 0,
    me: 0,
    host: 0,
    button: 0,
    pot: 30,
    board: [],
    holeCards: [
      { rank: "A", suit: "spades" },
      { rank: "K", suit: "hearts" },
    ],
    inProgress: true,
    deadline: 30_000,
    serverTime: 0,
    players: [
      { seat: 0, name: "Alice", stack: 1990, bet: 10, inHand: true },
      { seat: 1, name: "Bob", stack: 1980, bet: 20, inHand: true },
    ],
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 10,
      min: 40,
      max: 2000,
    },
    events: [],
    chat: [],
  };
  const calls = [];
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new TestTerminal();
  const session = {
    token: "mock",
    state: async () => structuredClone({ ...state, serverTime: now }),
    mutate: async (operation, current, extras, id) => {
      calls.push({ operation, current, extras, id });
      state = { ...state, revision: state.revision + 1 };
      return structuredClone(state);
    },
  };
  const terminal = await runTerminal({
    session,
    input,
    output,
    timers: false,
    now: () => now,
  });
  t.after(() => {
    terminal.close();
    input.destroy();
    output.destroy();
  });
  output.take();
  return {
    ...terminal,
    input,
    output,
    calls,
    session,
    update: (changes) => (state = { ...state, ...changes }),
    time: (value) => (now = value),
  };
}

test("real readline buffer and cursor survive a game update while typing", async (t) => {
  const app = await start(t);
  app.input.write("raise 100");
  app.rl.write(null, { name: "left" });
  const cursor = app.rl.cursor;
  app.update({ revision: 2, phase: "flop" });
  await app.client.refresh();
  assert.equal(app.rl.line, "raise 100");
  assert.equal(app.rl.cursor, cursor);
  const output = cleanTerminalText(app.output.take());
  assert.match(output, /翻牌/);
  assert.match(output, /牌局已变化/);
  app.input.write("\r");
  await setImmediate();
  assert.equal(app.calls.length, 0);
  assert.match(cleanTerminalText(app.output.take()), /重新输入动作/);
  app.input.write("call\r");
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].current.revision, 2);
});

test("chat updates repaint while typing without invalidating a wager", async (t) => {
  const app = await start(t);
  app.input.write("call");
  app.update({
    chatRevision: 1,
    chat: [{ name: "Bob", seat: 1, text: "hello", at: 0 }],
  });
  await app.client.refresh();
  assert.equal(app.rl.line, "call");
  assert.match(cleanTerminalText(app.output.take()), /hello/);
  app.input.write("\r");
  await setImmediate();
  assert.equal(app.calls.length, 1);
});

test("prompt follows the compact table without padding to the terminal bottom", async (t) => {
  const app = await start(t);
  app.input.write("raise 100");
  const cursor = app.rl.cursor;
  app.output.take();
  const rows = [];
  for (const count of [0, 1, 20]) {
    app.update({
      chatRevision: count,
      chat: Array.from({ length: count }, (_, index) => ({
        name: "Bob",
        text: `message ${index}`,
        at: index,
      })),
    });
    await app.client.refresh();
    const frame = app.output.take().split("\x1b[?25l\x1b[H\x1b[2J").at(-1);
    rows.push(frame.split("\n").length);
    assert.equal(app.rl.line, "raise 100");
    assert.equal(app.rl.cursor, cursor);
  }
  assert.ok(rows.every((count) => count < 23));
  assert.deepEqual(rows, Array(3).fill(rows[0]));
});

test("countdown and near-timeout warnings keep updating while input is nonempty", async (t) => {
  const app = await start(t);
  app.input.write("raise ");
  app.time(3500);
  app.render();
  assert.match(cleanTerminalText(app.output.take()), /27\s*(秒|s)/);
  app.time(21_000);
  app.render();
  assert.match(cleanTerminalText(app.output.take()), /仅剩 9s/);
  assert.equal(app.rl.line, "raise ");
});

test("disconnects, unchanged-revision recovery, and resize are rendered", async (t) => {
  const app = await start(t);
  const read = app.session.state;
  app.session.state = async () => {
    throw new Error("mock offline");
  };
  await assert.rejects(app.client.refresh(), /mock offline/);
  assert.match(cleanTerminalText(app.output.take()), /断线.*mock offline/);
  app.session.state = read;
  await app.client.refresh();
  assert.match(cleanTerminalText(app.output.take()), /已连接/);
  app.output.columns = 60;
  app.output.rows = 20;
  app.output.emit("resize");
  assert.match(cleanTerminalText(app.output.take()), /holdem>/);
});

test("typing a multiline-width Chinese chat retains its input across refreshes", async (t) => {
  const app = await start(t);
  const line = `say ${"你好".repeat(30)}`;
  app.input.write(line);
  const cursor = app.rl.cursor;
  await app.client.refresh();
  assert.equal(app.rl.line, line);
  assert.equal(app.rl.cursor, cursor);
  app.input.write("\r");
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].extras.text, "你好".repeat(30));
});

test("help and history/chat toggles are local, and malformed commands never mutate", async (t) => {
  const app = await start(t);
  for (const command of ["help", "help", "history", "chat", "clear"]) {
    app.input.write(`${command}\r`);
    await setImmediate();
  }
  assert.equal(app.calls.length, 0);
  app.input.write("raise 100 extra\r");
  await setImmediate();
  assert.match(cleanTerminalText(app.output.take()), /用法：raise/);
  app.input.write("call 40\r");
  await setImmediate();
  assert.match(cleanTerminalText(app.output.take()), /不需要金额参数/);
  app.input.write("constructor\r");
  await setImmediate();
  assert.match(cleanTerminalText(app.output.take()), /未知命令/);
  assert.equal(app.calls.length, 0);
});

test("history toggles all route details and retains its state after polling", async (t) => {
  const app = await start(t);
  app.update({
    events: [
      {
        hand: 1,
        phase: "preflop",
        name: "RouteActor",
        at: 0,
        action: { action: "raise", amount: 123 },
      },
    ],
  });
  await app.client.refresh();
  let output = cleanTerminalText(app.output.take());
  assert.match(output, /行动路线 ▸.*history 展开 \(1\)/);
  assert.doesNotMatch(output, /RouteActor/);
  for (const expanded of [true, false]) {
    app.input.write("history\r");
    await setImmediate();
    output = cleanTerminalText(app.output.take());
    assert.match(
      output,
      expanded ? /行动路线 ▾.*history 收起/ : /行动路线 ▸.*history 展开/,
    );
    assert.equal(output.includes("RouteActor 加注至 123"), expanded);
    await app.client.refresh();
    output = cleanTerminalText(app.output.take());
    assert.equal(output.includes("RouteActor 加注至 123"), expanded);
    assert.match(output, /下一步:.*fold.*call.*raise.*allin/);
  }
  assert.equal(app.calls.length, 0);
});

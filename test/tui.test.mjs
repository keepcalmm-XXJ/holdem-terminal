import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionText,
  cleanTerminalText,
  formatTable,
  parseCommand,
  serverUrlFromEnv,
  tablePositions,
  TerminalSession,
} from "../bin/holdem-lib.mjs";

test("terminal defaults to localhost and rejects other HTTP servers", () => {
  assert.equal(serverUrlFromEnv({}).origin, "http://127.0.0.1:4318");
  assert.throws(
    () => serverUrlFromEnv({ HOLDEM_SERVER_URL: "http://10.0.0.8:4318" }),
    /HOLDEM_ALLOW_INSECURE_LAN/,
  );
  assert.equal(
    serverUrlFromEnv({
      HOLDEM_SERVER_URL: "http://10.0.0.8:4318",
      HOLDEM_ALLOW_INSECURE_LAN: "1",
    }).origin,
    "http://10.0.0.8:4318",
  );
});

test("terminal command parser and renderer keep terminal output safe", () => {
  assert.deepEqual(parseCommand("  raise  160 "), {
    command: "raise",
    args: ["160"],
  });
  assert.equal(cleanTerminalText("A\u001b[2Jlice"), "Alice");
  assert.match(
    formatTable({
      room: "ABCD1234",
      hand: 1,
      phase: "preflop",
      pot: 30,
      me: 0,
      host: 0,
      actor: 0,
      board: [],
      holeCards: [
        { rank: "A", suit: "spades" },
        { rank: "T", suit: "hearts" },
      ],
      players: [
        {
          seat: 0,
          name: "A\u001b[2Jlice",
          stack: 1980,
          bet: 20,
          connected: true,
        },
      ],
      inProgress: true,
      legal: { actions: ["fold", "call"], call: 10 },
    }),
    /Alice.*1980/s,
  );
});

test("terminal dashboard uses aligned seats, poker positions and structured actions", () => {
  const state = {
    room: "ABCD1234",
    hand: 4,
    phase: "flop",
    pot: 180,
    button: 0,
    me: 0,
    host: 0,
    actor: 1,
    deadline: Date.now() + 10_000,
    board: [
      { rank: "A", suit: "spades" },
      { rank: "T", suit: "hearts" },
      { rank: "7", suit: "diamonds" },
    ],
    holeCards: [
      { rank: "K", suit: "clubs" },
      { rank: "Q", suit: "spades" },
    ],
    inProgress: true,
    legal: { actions: [] },
    players: [
      {
        seat: 0,
        name: "Alice",
        stack: 1920,
        bet: 60,
        inHand: true,
        ready: true,
        connected: true,
        lastAction: { action: "raise", amount: 60, at: Date.now() },
      },
      {
        seat: 1,
        name: "Bob",
        stack: 1940,
        bet: 60,
        inHand: true,
        ready: true,
        connected: true,
        lastAction: { action: "call", amount: 40, at: Date.now() },
      },
      {
        seat: 2,
        name: "Carol",
        stack: 2000,
        bet: 0,
        folded: true,
        inHand: false,
        ready: true,
        connected: true,
        lastAction: { action: "fold", amount: null, at: Date.now() },
      },
    ],
    events: [
      {
        id: "event",
        at: Date.now(),
        text: "Alice raise 60",
        seat: 0,
        action: { action: "raise", amount: 60, at: Date.now() },
      },
    ],
    chat: [
      {
        id: "chat",
        at: Date.now(),
        seat: 1,
        name: "Bob",
        text: "这手我跟。",
      },
    ],
  };
  assert.deepEqual(
    [...tablePositions(state)],
    [
      [0, "BTN"],
      [1, "SB"],
      [2, "BB"],
    ],
  );
  assert.equal(actionText({ action: "raise", amount: 120 }), "加注至 120");
  assert.equal(actionText({ action: "call", amount: 40 }), "跟注 40");
  const output = formatTable(state, { columns: 140 });
  const unsortedOutput = formatTable(
    {
      ...state,
      players: [state.players[2], state.players[0], state.players[1]],
    },
    { columns: 140 },
  ).split("\n动态")[0];
  assert.ok(unsortedOutput.indexOf("Alice") < unsortedOutput.indexOf("Bob"));
  assert.ok(unsortedOutput.indexOf("Bob") < unsortedOutput.indexOf("Carol"));
  assert.match(output, /席位  角色.*玩家.*最近动作.*状态/s);
  assert.doesNotMatch(output, /本轮下注/);
  assert.match(output, /BTN.*Alice.*加注至 60/s);
  assert.match(output, /SB.*Bob.*跟注 40/s);
  assert.match(output, /BB.*Carol.*弃牌/s);
  assert.match(
    output,
    /公共牌\s+A\s+10\s+7\s*\n\s+♠︎?\s+♥\s+♦︎?\s*\n\n你的底牌\s+K\s+Q\s*\n\s+♣︎?\s+♠︎?/s,
  );
  assert.doesNotMatch(output, /♥︎/);
  assert.match(output, /动态.*聊天.*Alice.*加注至 60.*Bob：这手我跟。/s);
  assert.doesNotMatch(output, /[┌┬┴│]/);
  assert.match(output, /等待 Bob 行动/s);
  const showdownOutput = formatTable(
    {
      ...state,
      inProgress: false,
      phase: "complete",
      actor: null,
      result: {
        pot: 180,
        winners: [0],
        payouts: [{ seat: 0, amount: 180 }],
        showdown: [
          {
            seat: 0,
            cards: [
              { rank: "A", suit: "spades" },
              { rank: "K", suit: "hearts" },
            ],
          },
          {
            seat: 1,
            cards: [
              { rank: "Q", suit: "clubs" },
              { rank: "J", suit: "diamonds" },
            ],
          },
        ],
      },
    },
    { columns: 140 },
  );
  assert.match(
    showdownOutput,
    /摊牌\s*\nAlice\s+A\s+K\s*\n\s+♠︎?\s+♥\s*\nBob\s+Q\s+J\s*\n\s+♣︎?\s+♦︎?/s,
  );
  const colored = formatTable(state, { theme: "dark", columns: 140 });
  assert.match(colored, /\x1b\[1;97m\s*♠︎?/);
  assert.match(colored, /\x1b\[1;91m\s*♥/);
  assert.match(colored, /\x1b\[1;94m\s*♣︎?/);
  assert.match(colored, /\x1b\[1;93m\s*♦︎?/);
  const light = formatTable(state, { theme: "light", columns: 140 });
  assert.match(light, /\x1b\[1;97;40m\s*♠︎?/);
  assert.match(light, /\x1b\[1;97;44m\s*♣︎?/);
  const narrow = formatTable(state, { columns: 100 });
  assert.match(narrow, /动态.*Alice.*加注至 60.*聊天.*Bob：这手我跟。/s);
});

test("terminal session saves a private reusable identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holdem-tui-"));
  const path = join(directory, "session.json");
  const session = new TerminalSession({
    base: new URL("http://127.0.0.1:4318"),
    statePath: path,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ token: "a".repeat(43) }),
    }),
  });
  await session.identity();
  assert.equal(session.token, "a".repeat(43));
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored, {
    server: "http://127.0.0.1:4318",
    token: "a".repeat(43),
  });
});

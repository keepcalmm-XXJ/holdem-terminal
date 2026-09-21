import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionText,
  cleanTerminalText,
  displayWidth,
  fitTerminalLine,
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

const NOW = 1_800_000_000_000;

function tableState(overrides = {}) {
  return {
    room: "ABCD1234",
    hand: 4,
    phase: "flop",
    pot: 180,
    button: 0,
    me: 0,
    host: 0,
    actor: 1,
    deadline: NOW + 10_000,
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
        lastAction: { action: "raise", amount: 60, hand: 4, phase: "preflop" },
      },
      {
        seat: 1,
        name: "Bob",
        stack: 1940,
        bet: 60,
        inHand: true,
        ready: true,
        connected: true,
        lastAction: { action: "call", amount: 40, hand: 4, phase: "flop" },
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
        lastAction: { action: "fold", amount: null, hand: 4, phase: "flop" },
      },
    ],
    events: [
      {
        id: "event",
        at: NOW,
        text: "Alice raise 60",
        seat: 0,
        hand: 4,
        phase: "preflop",
        name: "Alice",
        action: { action: "raise", amount: 60 },
      },
    ],
    chat: [
      {
        id: "chat",
        at: NOW,
        seat: 1,
        name: "Bob",
        text: "这手我跟。",
      },
    ],
    ...overrides,
  };
}

function sixPlayerState(overrides = {}) {
  const state = tableState();
  return {
    ...state,
    players: [
      ...state.players,
      ...["Dave", "Eve", "Frank"].map((name, index) => ({
        name,
        seat: index + 3,
        stack: 2000,
        bet: 0,
        inHand: true,
        ready: true,
        connected: true,
      })),
    ],
    ...overrides,
  };
}

function assertFits(output, columns, rows) {
  assert.ok(output.split("\n").length <= rows, output);
  for (const line of output.split("\n"))
    assert.ok(
      displayWidth(line) <= columns,
      `${displayWidth(line)} > ${columns}: ${line}`,
    );
}

test("terminal dashboard separates cards, aligned status and street-qualified past actions", () => {
  const state = tableState();
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
  const output = formatTable(state, { columns: 140, now: NOW });
  const unsortedOutput = formatTable(
    {
      ...state,
      players: [state.players[2], state.players[0], state.players[1]],
    },
    { columns: 140 },
  )
    .split("\n行动路线")[0]
    .split("\n席")[1];
  assert.ok(unsortedOutput.indexOf("Alice") < unsortedOutput.indexOf("Bob"));
  assert.ok(unsortedOutput.indexOf("Bob") < unsortedOutput.indexOf("Carol"));
  assert.match(output, /席\s+角色.*玩家.*筹码.*已投.*状态.*最近动作/);
  assert.match(output, /BTN.*Alice.*1920\s+60.*翻牌前 · 加注至 60/);
  assert.match(output, /SB.*Bob.*1940\s+60.*行动中.*跟注 40/);
  assert.match(output, /BB.*Carol.*弃牌/s);
  assert.match(output, /公共牌\s+你的底牌\n A♠︎?\s+10♥\s+7♦︎?.*K♣︎?\s+Q♠︎?/);
  assert.doesNotMatch(output, /♥︎/);
  assert.match(
    output,
    /行动路线 ▸.*history 展开 \(1\).*聊天.*Bob：这手我跟。/s,
  );
  assert.doesNotMatch(output, /[┌┬┴│]/);
  assert.match(output, /等待 Bob 行动 · 10s/);
  const legacy = structuredClone(state);
  legacy.players[0].lastAction = { action: "raise", amount: 60 };
  assert.match(
    formatTable(legacy, { columns: 140 }),
    /Alice.*旧记录\/未知轮次 加注至 60/,
  );
  const colored = formatTable(state, { theme: "dark", columns: 140 });
  assert.match(colored, /\x1b\[1;38;5;235;48;5;254m A♠/);
  assert.match(colored, /\x1b\[1;38;5;124;48;5;254m 10♥/);
  assert.match(colored, /\x1b\[1;38;5;25;48;5;254m K♣/);
  assert.match(colored, /\x1b\[1;38;5;130;48;5;254m 7♦/);
  const light = formatTable(state, { theme: "light", columns: 140 });
  assert.match(light, /\x1b\[1;38;5;235;48;5;252m A♠/);
  assert.match(light, /\x1b\[1;38;5;25;48;5;252m K♣/);
  const narrow = formatTable(state, { columns: 100, historyExpanded: true });
  assert.match(narrow, /行动路线.*Alice.*加注至 60.*聊天.*Bob：这手我跟。/s);
});

test("80x24 reserves four CLI rows and keeps all critical actions with expanded transcripts", () => {
  const state = sixPlayerState({
    actor: 0,
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 40,
      min: 160,
      max: 1980,
    },
    events: Array.from({ length: 24 }, (_, index) => ({
      hand: 4,
      phase: index < 12 ? "preflop" : "flop",
      name: `P${index}`,
      at: NOW + index,
      action: { action: "call", amount: 40 },
    })),
    chat: Array.from({ length: 50 }, (_, index) => ({
      name: "中文长姓名👩🏽‍💻".repeat(8),
      text: `${index} 中文长聊天🙂`.repeat(100),
    })),
  });
  for (const theme of [false, "dark", "light"]) {
    for (const historyExpanded of [false, true]) {
      for (const chatExpanded of [false, true]) {
        const output = formatTable(state, {
          theme,
          columns: 80,
          rows: 20,
          now: NOW,
          historyExpanded,
          chatExpanded,
        });
        assertFits(output, 80, 20);
        const plain = cleanTerminalText(
          output.replaceAll("\n", "\t"),
        ).replaceAll("\t", "");
        assert.match(plain, /翻牌 · 底池 180/);
        assert.match(plain, /你的底牌.*K♣︎?\s+Q♠︎?/);
        assert.match(plain, /轮到你行动 · 剩余 10s/);
        assert.match(plain, /你本轮已投 60 · 筹码 1920/);
        assert.match(plain, /call 补 40 → 本轮至 100/);
        assert.match(plain, /bet\/raise 本轮至 160–1980/);
        assert.match(plain, /下一步:.*fold.*call.*raise.*allin/);
        for (const name of ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank"])
          assert.ok(plain.includes(name), name);
        assert.ok(output.includes("history"));
        assert.ok(output.includes("chat"));
      }
    }
  }
});

test("narrow screens retain cards, actor, call and raise targets despite long Chinese names", () => {
  const state = sixPlayerState({
    actor: 0,
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 40,
      min: 160,
      max: 1980,
    },
  });
  state.players[1].name = "中文玩家名字很长👨‍👩‍👧‍👦".repeat(20);
  state.chat[0].text = "你好🙂".repeat(200);
  for (const columns of [32, 40, 60, 80]) {
    const output = formatTable(state, {
      columns,
      rows: 20,
      now: () => NOW,
      chatExpanded: true,
      historyExpanded: true,
    });
    assertFits(output, columns, 20);
    assert.match(output, /你的底牌[\s\S]*K♣︎?\s+Q♠︎?/);
    assert.match(output, /轮到你行动 · 剩余 10s/);
    assert.match(output, /call 补 40 → 本轮至 100/);
    assert.match(output, /bet\/raise 本轮至 160–1980/);
    assert.match(output, /fold[\s\S]*call[\s\S]*raise[\s\S]*allin/);
    const waiting = formatTable(
      { ...state, actor: 1 },
      { columns, rows: 20, now: NOW },
    );
    assertFits(waiting, columns, 20);
    assert.match(waiting, /等待 中文.*行动 · 10s/);
  }
});

test("80x24 expansion trades seat details for more history and chat records", () => {
  const state = sixPlayerState({
    actor: 0,
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 40,
      min: 160,
      max: 1980,
    },
    events: Array.from({ length: 30 }, (_, index) => ({
      hand: 4,
      phase: index < 18 ? "preflop" : "flop",
      name: `Route${String(index).padStart(2, "0")}`,
      at: NOW + index,
      action: { action: "raise", amount: 100 + index },
    })),
    chat: Array.from({ length: 30 }, (_, index) => ({
      name: "Bob",
      text: `Message${String(index).padStart(2, "0")} 中文长聊🙂`.repeat(8),
    })),
  });
  const render = (options = {}) => {
    const output = formatTable(state, {
      columns: 80,
      rows: 20,
      now: NOW,
      ...options,
    });
    assertFits(output, 80, 20);
    assert.match(output, /你的底牌[\s\S]*K♣︎?\s+Q♠︎?/);
    assert.match(output, /轮到你行动 · 剩余 10s/);
    assert.match(output, /你本轮已投 60 · 筹码 1920/);
    assert.match(output, /call 补 40 → 本轮至 100/);
    assert.match(output, /bet\/raise 本轮至 160–1980/);
    assert.match(output, /下一步:.*fold.*call.*raise.*allin/);
    return output;
  };
  const count = (output, pattern) => new Set(output.match(pattern) || []).size;
  const collapsed = render();
  const history = render({ historyExpanded: true });
  const chat = render({ chatExpanded: true });
  const both = render({ historyExpanded: true, chatExpanded: true });
  assert.ok(count(history, /Route\d+/g) > count(collapsed, /Route\d+/g));
  assert.ok(count(chat, /Message\d+/g) > count(collapsed, /Message\d+/g));
  assert.ok(count(both, /Route\d+/g) > count(collapsed, /Route\d+/g));
  assert.ok(count(both, /Message\d+/g) > count(collapsed, /Message\d+/g));
  for (const output of [history, chat, both]) {
    assert.match(output, /座位摘要.*Alice.*Bob.*Carol.*Dave.*Eve.*Frank/);
    assert.doesNotMatch(output, /状态\s+最近动作/);
  }
  assert.equal(render(), collapsed);
});

test("expanded history exposes every current-hand action for six players at 80x24", () => {
  const state = sixPlayerState({
    actor: 0,
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 40,
      min: 160,
      max: 1980,
    },
  });
  state.events = ["preflop", "flop"].flatMap((phase, round) =>
    state.players.map((player, index) => ({
      hand: 4,
      phase,
      name: player.name,
      at: NOW + round * 6 + index,
      action: { action: "raise", amount: 100 + round * 6 + index },
    })),
  );
  for (const chatExpanded of [false, true]) {
    const output = formatTable(state, {
      columns: 80,
      rows: 20,
      now: NOW,
      historyExpanded: true,
      chatExpanded,
    });
    assertFits(output, 80, 20);
    const history = output.split("行动路线")[1].split("聊天")[0];
    assert.equal((history.match(/加注至 \d+/g) || []).length, 12);
    assert.match(history, /H4\/翻牌前.*H4\/翻牌/s);
    for (let amount = 100; amount < 112; amount++)
      assert.ok(history.includes(`加注至 ${amount}`));
    assert.match(output, /下一步:.*fold.*call.*raise.*allin/);
  }
});

test("display helpers count graphemes and truncate ANSI without broken emoji or color leakage", () => {
  assert.equal(displayWidth("中A👩🏽‍💻🇨🇳1️⃣e\u0301"), 10);
  assert.equal(displayWidth("♠︎♥♣︎♦︎"), 4);
  assert.equal(displayWidth("♥️"), 2);
  assert.equal(displayWidth("한글"), 4);
  assert.equal(displayWidth("𠀀"), 2);
  assert.equal(displayWidth("\x1b[31m中文\x1b[0m"), 4);
  assert.equal(fitTerminalLine("中👩🏽‍💻A", 4), "中…");
  assert.equal(fitTerminalLine("👨‍👩‍👧‍👦XY", 3), "👨‍👩‍👧‍👦…");
  assert.equal(fitTerminalLine("e\u0301XYZ", 3), "e\u0301X…");
  assert.equal(fitTerminalLine("anything", 0), "");
  assert.equal(fitTerminalLine("中文", 1), "…");
  assert.equal(fitTerminalLine("\x1b[31m中文\x1b[0m", 3), "\x1b[31m中…\x1b[0m");
  assert.equal(
    fitTerminalLine("\x1b[31m中文\x1b[0m", 4),
    "\x1b[31m中文\x1b[0m",
  );
  assert.equal(fitTerminalLine("A\x1b[2JB\nC", 20), "ABC");
  assert.equal(cleanTerminalText("\x1b]0;bad title\x07Alice"), "Alice");
});

test("action area follows content with one blank line across transcript and turn changes", () => {
  const state = sixPlayerState({
    actor: 0,
    legal: {
      actions: ["fold", "call", "raise", "all-in"],
      call: 40,
      min: 160,
      max: 1980,
    },
  });
  for (const theme of [false, "dark", "light"]) {
    for (const columns of [40, 60, 80, 120]) {
      for (const options of [
        {},
        { historyExpanded: true },
        { chatExpanded: true },
        { historyExpanded: true, chatExpanded: true },
      ]) {
        const output = formatTable(state, {
          columns,
          rows: 20,
          now: NOW,
          theme,
          ...options,
        });
        const lines = output.split("\n").map(cleanTerminalText);
        assertFits(output, columns, 20);
        const actionRow = lines.findIndex((line) => line.startsWith("操作 "));
        assert.equal(lines[actionRow - 1], "");
        assert.notEqual(lines[actionRow - 2], "");
        assert.match(lines.at(-1), /allin/);
        assert.ok(
          lines.findIndex((line) => line.includes("轮到你行动")) >
            lines.findIndex((line) => line.includes("聊天")),
        );
        assert.doesNotMatch(output, /\x1b\[[^m]*(?:103|41)m/);
      }
    }
  }
  const waiting = formatTable(
    { ...state, actor: 1 },
    { columns: 80, rows: 20 },
  );
  assert.ok(waiting.split("\n").length < 20);
  assert.match(waiting.split("\n").at(-1), /下一步: 等待行动/);
});

test("seat status is aligned and does not repeat readiness during a hand", () => {
  const state = sixPlayerState();
  state.players[0].stack = 9;
  state.players[1].stack = 12345;
  state.players[3].stack = 0;
  state.players[4].connected = false;
  state.players[5].away = true;
  const output = formatTable(state, { columns: 80, rows: 20 });
  const seats = output.split("\n").filter((line) => /^[●○▶]\d/.test(line));
  assert.equal(seats.length, 6);
  const rightEdge = (line, text) =>
    displayWidth(line.slice(0, line.indexOf(text) + text.length));
  assert.equal(rightEdge(seats[0], "9"), rightEdge(seats[1], "12345"));
  assert.match(seats[1], /行动中\s+跟注 40/);
  assert.match(seats[2], /弃牌/);
  assert.match(seats[3], /全下/);
  assert.match(seats[4], /离线/);
  assert.match(seats[5], /暂离/);
  assert.doesNotMatch(seats.join("\n"), /准备|H4\/翻牌/);
  const prior = structuredClone(state);
  prior.players[0].lastAction.hand = 3;
  assert.match(formatTable(prior, { columns: 100 }), /Alice.*旧:H3\/翻牌前/);
});

test("card slots have fixed geometry and narrow seat summaries keep player names", () => {
  const state = sixPlayerState();
  const render = (theme) =>
    formatTable(state, {
      columns: 80,
      rows: 20,
      now: NOW,
      theme,
    })
      .split("\n")
      .map(cleanTerminalText);
  const compact = render("dark");
  assert.match(compact[2], /公共牌\s+你的底牌/);
  const holeColumn = displayWidth(
    compact[3].slice(0, compact[3].indexOf("K♣")),
  );
  state.board.push({ rank: "T", suit: "clubs" }, { rank: "Q", suit: "hearts" });
  for (const theme of [false, "dark", "light"]) {
    const full = render(theme);
    assert.equal(
      displayWidth(full[3].slice(0, full[3].indexOf("K♣"))),
      holeColumn,
    );
    assert.match(full[3], /A♠\s+10♥\s+7♦\s+10♣\s+Q♥/);
  }
  const narrow = formatTable(state, { columns: 60, rows: 16 });
  assertFits(narrow, 60, 16);
  const summary = narrow.split("座位摘要")[1].split("行动路线")[0];
  for (const player of state.players) assert.ok(summary.includes(player.name));
  const tall = formatTable(state, { columns: 120, rows: 28, theme: "dark" });
  assertFits(tall, 120, 28);
  assert.ok(tall.split("\n").length < 28);
  assert.equal(
    formatTable(state, { columns: 120, rows: 60, theme: "dark", now: NOW }),
    formatTable(state, { columns: 120, rows: 28, theme: "dark", now: NOW }),
  );
});

test("routes are chronological per hand and pre-action street, not global last four", () => {
  const event = (hand, phase, name, at) => ({
    hand,
    phase,
    name,
    at,
    seat: 0,
    action: { action: "check" },
  });
  const state = tableState({
    events: [
      event(4, "flop", "FlopB", 6),
      event(3, "river", "Prior", 1),
      event(4, "preflop", "PreA", 2),
      event(4, "preflop", "PreB", 3),
      event(4, "preflop", "PreC", 4),
      event(4, "flop", "FlopA", 5),
      event(4, "flop", "FlopC", 7),
    ],
  });
  const output = formatTable(state, { columns: 80, historyExpanded: true });
  const route = output.split("行动路线")[1].split("聊天")[0];
  assert.match(
    route,
    /H3\/河牌 Prior.*H4\/翻牌前 PreA.*PreB.*PreC.*H4\/翻牌 FlopA.*FlopB.*FlopC/s,
  );
  const compact = formatTable(state, {
    columns: 80,
    rows: 12,
    historyExpanded: true,
  });
  const limitedRoute = compact.split("行动路线")[1].split("聊天")[0];
  assert.match(limitedRoute, /H4\/翻牌 FlopA.*FlopB.*FlopC/);
  assert.doesNotMatch(limitedRoute, /Prior/);
  assertFits(compact, 80, 12);
});

test("legacy events and result snapshots never acquire the current occupant's name", () => {
  const state = tableState({
    inProgress: false,
    actor: null,
    phase: "complete",
    events: [
      {
        seat: 0,
        at: 1,
        text: "FormerAlice raise 60",
        action: { action: "raise", amount: 60 },
      },
      { seat: 0, at: 2, action: { action: "fold" } },
      {
        seat: 0,
        at: 3,
        hand: 4,
        phase: "flop",
        name: "FormerAlice",
        action: { action: "check" },
      },
    ],
    result: {
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
      ],
    },
    history: [{ hand: 4, players: [{ seat: 0, name: "OldAlice" }] }],
  });
  state.players[0].name = "NewOccupant";
  const output = formatTable(state, { columns: 120, historyExpanded: true });
  const resultAndHistory = output.split("本手结果")[1];
  assert.match(resultAndHistory, /OldAlice\s+分得 180\s+A♠︎? K♥/);
  assert.match(
    resultAndHistory,
    /旧记录\/未知轮次.*FormerAlice raise 60.*身份未知 弃牌/s,
  );
  assert.match(resultAndHistory, /H4\/翻牌 FormerAlice 过牌/);
  assert.doesNotMatch(resultAndHistory, /NewOccupant|\+180|净赢/);
  const unknown = formatTable(
    {
      ...state,
      history: [{ hand: 3, players: [{ seat: 0, name: "WrongHand" }] }],
    },
    { columns: 120 },
  );
  assert.match(unknown, /当时座位1\s+分得 180/);
  assert.doesNotMatch(unknown, /WrongHand/);
});

test("six-player settlement fits 20 rows and preserves payouts, cards and ready instruction", () => {
  const state = sixPlayerState({
    inProgress: false,
    phase: "complete",
    actor: null,
  });
  state.players.forEach((player) => {
    player.ready = false;
  });
  state.history = [
    {
      hand: 4,
      players: state.players.map(({ seat, name }) => ({ seat, name })),
    },
  ];
  state.result = {
    winners: [0, 1],
    payouts: [
      { seat: 0, amount: 120 },
      { seat: 1, amount: 60 },
    ],
    showdown: state.players.map(({ seat }) => ({
      seat,
      cards: state.holeCards,
    })),
  };
  const output = formatTable(state, {
    columns: 80,
    rows: 20,
    historyExpanded: true,
    chatExpanded: true,
  });
  assertFits(output, 80, 20);
  assert.match(output, /ready 重新准备/);
  assert.match(output, /等待未准备: Bob Carol Dave Eve Frank/);
  for (const [index, name] of [
    "Alice",
    "Bob",
    "Carol",
    "Dave",
    "Eve",
    "Frank",
  ].entries())
    assert.match(
      output,
      new RegExp(
        `${name}\\s+分得\\s+${index === 0 ? 120 : index === 1 ? 60 : 0}\\s+K♣︎? Q♠︎?`,
      ),
    );
  assert.doesNotMatch(output, /\+120|\+60|净赢/);
  state.players.forEach((player) => {
    player.name = `${player.seat}中文长姓名👨‍👩‍👧‍👦`.repeat(20);
  });
  const longNames = formatTable(state, {
    columns: 80,
    rows: 20,
    historyExpanded: true,
    chatExpanded: true,
  });
  assertFits(longNames, 80, 20);
  assert.match(longNames, /ready 重新准备/);
  assert.equal((longNames.match(/分得\s+\d+/g) || []).length, 6);
  assert.equal((longNames.match(/K♣︎?\s+Q♠︎?/g) || []).length, 7);
});

test("waiting prompts distinguish ready, start, named blockers, away and rebuy", () => {
  const render = (patch, playerPatch = {}) => {
    const state = tableState({
      inProgress: false,
      phase: "waiting",
      actor: null,
      ...patch,
    });
    Object.assign(state.players[0], playerPatch);
    const output = formatTable(state, { columns: 80, rows: 20 });
    assertFits(output, 80, 20);
    return output;
  };
  assert.match(render({}, { ready: false }), /下一步: ready 准备/);
  assert.match(render({}), /下一步: start 房主开局/);
  const state = tableState();
  state.players[1].ready = false;
  assert.match(render({ players: state.players }), /等待未准备: Bob/);
  assert.doesNotMatch(render({ players: state.players }), /下一步: start/);
  assert.match(render({ host: 1 }), /等待房主 Bob start 开局/);
  const longHost = tableState();
  longHost.players[1].name = "中文房主长昵称".repeat(30);
  assert.match(
    render({ host: 1, players: longHost.players }),
    /等待房主 .* start 开局/,
  );
  assert.match(render({}, { away: true }), /下一步: sit 恢复入座/);
  assert.doesNotMatch(render({}, { away: true }), /下一步: (ready|start)/);
  assert.match(render({}, { stack: 0 }), /下一步: rebuy 补充筹码/);
  assert.match(render({ players: [tableState().players[0]] }), /等待至少两名/);
  assert.match(render({ result: {} }, { ready: false }), /ready 重新准备/);
  const excluded = tableState();
  excluded.players[1].away = true;
  excluded.players[1].ready = false;
  assert.match(render({ players: excluded.players }), /start 房主开局/);
  excluded.players[1].away = false;
  excluded.players[1].stack = 0;
  assert.match(render({ players: excluded.players }), /start 房主开局/);
});

test("chat defaults to the last message and expansions stay within the same budget", () => {
  const state = tableState({
    chat: Array.from({ length: 12 }, (_, index) => ({
      name: "Bob",
      text: `message-${String(index).padStart(2, "0")}`,
    })),
  });
  const compact = formatTable(state, { columns: 80 });
  assert.match(compact, /message-11/);
  assert.doesNotMatch(compact, /message-00|message-10/);
  const expanded = formatTable(state, { columns: 80, chatExpanded: true });
  assert.match(expanded, /message-00.*message-10.*message-11/s);
  for (const rows of [0, 1, 5, 10, 20, 24]) {
    const output = formatTable(state, {
      columns: 40,
      rows,
      chatExpanded: true,
      historyExpanded: true,
    });
    if (rows === 0) assert.equal(output, "");
    else assertFits(output, 40, rows);
  }
  assertFits(formatTable(null, { columns: 12, rows: 3 }), 12, 3);
  assert.equal(formatTable(state, { columns: 0 }), "");
});

test("clock injection is deterministic, clamps expired deadlines and defaults to Date.now", () => {
  const state = tableState({ actor: 0 });
  assert.match(formatTable(state, { now: NOW + 9999 }), /剩余 1s/);
  assert.match(formatTable(state, { now: NOW + 20_000 }), /剩余 0s/);
  assert.match(
    formatTable({ ...state, deadline: null }, { now: NOW }),
    /剩余 \?s/,
  );
  assert.match(
    formatTable({ ...state, deadline: Date.now() + 60_000 }),
    /剩余 60s/,
  );
});

test("history expansion reveals older routes and repeated renders do not mutate snapshots", () => {
  const state = sixPlayerState({
    events: Array.from({ length: 20 }, (_, index) => ({
      hand: index < 15 ? 3 : 4,
      phase: "flop",
      name: `Earlier${String(index).padStart(2, "0")}`,
      at: NOW + index,
      action: { action: "call", amount: 40 },
    })),
  });
  const original = structuredClone(state);
  const compact = formatTable(state, { columns: 80 });
  const expanded = formatTable(state, { columns: 80, historyExpanded: true });
  assert.doesNotMatch(compact, /Earlier00/);
  assert.match(expanded, /H3\/翻牌 Earlier00.*H4\/翻牌 Earlier15/s);
  assert.ok(
    (expanded.match(/Earlier\d+/g) || []).length >
      (compact.match(/Earlier\d+/g) || []).length,
  );
  for (let index = 0; index < 20; index++) {
    const output = formatTable(state, {
      columns: 80,
      rows: 20,
      now: NOW + index * 1000,
      historyExpanded: true,
      chatExpanded: true,
    });
    assertFits(output, 80, 20);
    assert.match(output, /H4\/翻牌/);
  }
  assert.deepEqual(state, original);
});

test("collapsed history is one header with a count and never exposes route details", () => {
  for (const count of [0, 1, 100]) {
    const state = tableState({
      events: [
        { text: "non-action event" },
        ...Array.from({ length: count }, (_, index) => ({
          hand: 4,
          phase: "flop",
          name: `RouteOnly${index}`,
          at: NOW + index,
          action: { action: "check" },
        })),
      ],
    });
    for (const columns of [40, 60, 80, 120]) {
      const output = formatTable(state, { columns, rows: 20 });
      assertFits(output, columns, 20);
      assert.match(
        output,
        new RegExp(`行动路线 ▸.*history 展开 \\(${count}\\)`),
      );
      assert.doesNotMatch(output, /RouteOnly/);
      const route = output.split("行动路线")[1].split("聊天")[0].trim();
      assert.equal(route.split("\n").length, 1);
    }
    const expanded = formatTable(state, {
      columns: 80,
      rows: 20,
      historyExpanded: true,
    });
    assert.match(expanded, /行动路线 ▾.*history 收起/);
    if (count) assert.match(expanded, /RouteOnly/);
  }
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

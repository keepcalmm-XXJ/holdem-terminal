import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_LAN_SERVER_URL = "http://127.0.0.1:4318";

export function serverUrlFromEnv(env = process.env) {
  const base = new URL(env.HOLDEM_SERVER_URL || DEFAULT_LAN_SERVER_URL);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error("HOLDEM_SERVER_URL 必须是纯 HTTP(S) 服务地址");
  }
  const localHttp =
    ["localhost", "127.0.0.1"].includes(base.hostname) ||
    base.origin === DEFAULT_LAN_SERVER_URL;
  if (
    base.protocol === "http:" &&
    !localHttp &&
    env.HOLDEM_ALLOW_INSECURE_LAN !== "1"
  ) {
    throw new Error(
      "其他明文 HTTP 地址需要 HOLDEM_ALLOW_INSECURE_LAN=1；可信局域网外请使用 HTTPS。",
    );
  }
  return base;
}

export function tuiStatePath(env = process.env) {
  if (env.HOLDEM_TUI_STATE_PATH) return env.HOLDEM_TUI_STATE_PATH;
  const stateRoot = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateRoot, "codex-holdem", "terminal-session.json");
}

export function requestId() {
  return randomBytes(16).toString("base64url");
}

export function parseCommand(line) {
  const [command = "", ...args] = line.trim().split(/\s+/);
  return { command: command.toLowerCase(), args };
}

export function cleanTerminalText(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function cardText(card) {
  if (!card) return "??";
  return `${card.rank === "T" ? "10" : card.rank}${
    { spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦" }[card.suit] || "?"
  }`;
}

const palettes = {
  dark: {
    dim: "38;5;245",
    accent: "1;38;5;115",
    success: "38;5;115",
    warning: "38;5;222",
    danger: "1;31",
    text: "1;37",
    rank: "1;97",
    spades: "1;97",
    hearts: "1;91",
    clubs: "1;94",
    diamonds: "1;93",
    turn: "1;38;5;115",
    cardSpades: "1;38;5;235;48;5;254",
    cardHearts: "1;38;5;124;48;5;254",
    cardClubs: "1;38;5;25;48;5;254",
    cardDiamonds: "1;38;5;130;48;5;254",
  },
  light: {
    dim: "38;5;242",
    accent: "1;38;5;29",
    success: "38;5;29",
    warning: "38;5;130",
    danger: "1;31",
    text: "1;30",
    rank: "1;30",
    spades: "1;30",
    hearts: "1;31",
    clubs: "1;34",
    diamonds: "1;38;5;130",
    turn: "1;38;5;29",
    cardSpades: "1;38;5;235;48;5;252",
    cardHearts: "1;38;5;124;48;5;252",
    cardClubs: "1;38;5;25;48;5;252",
    cardDiamonds: "1;38;5;130;48;5;252",
  },
};

function paint(value, style, theme) {
  if (!theme) return value;
  return `\x1b[${palettes[theme][style]}m${value}\x1b[0m`;
}

function dim(value, theme) {
  return paint(value, "dim", theme);
}

function accent(value, theme) {
  return paint(value, "accent", theme);
}

function success(value, theme) {
  return paint(value, "success", theme);
}

const suitSymbols = {
  spades: "♠︎",
  hearts: "♥",
  clubs: "♣︎",
  diamonds: "♦︎",
};

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

function graphemeWidth(value) {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(value)) return 0;
  if (
    !value.includes("\ufe0e") &&
    /[\p{Emoji_Presentation}\u20e3]|\p{Extended_Pictographic}\ufe0f/u.test(
      value,
    )
  )
    return 2;
  return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(
    value,
  )
    ? 2
    : 1;
}

export function displayWidth(value) {
  return [...graphemes.segment(cleanTerminalText(value))].reduce(
    (width, { segment }) => width + graphemeWidth(segment),
    0,
  );
}

function dimension(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

// Preserve renderer SGR colors, but never terminal cursor/control sequences.
export function truncateTerminalText(value, columns = Infinity) {
  const width = dimension(columns, Infinity);
  const tokens = String(value ?? "").split(/(\x1b\[[0-9;]*m)/g);
  const styled = tokens
    .map((token) =>
      /^\x1b\[[0-9;]*m$/.test(token) ? token : cleanTerminalText(token),
    )
    .join("");
  if (width === 0) return "";
  if (displayWidth(styled) <= width) return styled;
  let output = "";
  let used = 0;
  let colored = false;
  for (const token of tokens) {
    if (/^\x1b\[[0-9;]*m$/.test(token)) {
      output += token;
      colored = true;
      continue;
    }
    for (const { segment } of graphemes.segment(cleanTerminalText(token))) {
      const size = graphemeWidth(segment);
      if (used + size > width - 1)
        return `${output}…${colored ? "\x1b[0m" : ""}`;
      output += segment;
      used += size;
    }
  }
  return output;
}

export function fitTerminalLine(value, width = Infinity) {
  return truncateTerminalText(value, width);
}

function cell(value, width, right = false) {
  const clipped = truncateTerminalText(cleanTerminalText(value), width);
  const padding = " ".repeat(Math.max(0, width - displayWidth(clipped)));
  return right ? padding + clipped : clipped + padding;
}

function spread(left, right, columns) {
  const gap = Math.max(2, columns - displayWidth(left) - displayWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function section(label, columns, theme, suffix = "") {
  const end = suffix ? ` ${suffix}` : "";
  const width = Math.max(0, columns - displayWidth(label + end) - 2);
  return dim(`${label} ${"─".repeat(width)}${end}`, theme);
}

function boardLines(state, columns, rows, theme) {
  if (columns < 72 || rows < 18)
    return [
      `${dim("公共牌", theme)} ${cardsText(state.board, theme, "尚未发牌")}`,
      `${dim("你的底牌", theme)} ${cardsText(state.holeCards, theme, "等待发牌")}`,
    ];
  const leftWidth = Math.floor(columns * 0.56);
  const combine = (left, right) =>
    `${left}${" ".repeat(Math.max(2, leftWidth - displayWidth(left)))}${right}`;
  const tile = (card, blank = false) => {
    if (!card) return dim(blank ? "     " : "  ·  ", theme);
    const suit = cleanTerminalText(card.suit || "");
    const style = `card${suit.charAt(0).toUpperCase()}${suit.slice(1)}`;
    return paint(
      blank ? "     " : ` ${cell(cardText(card), 3)} `,
      style in palettes.dark ? style : "cardSpades",
      theme,
    );
  };
  const board = Array.from({ length: 5 }, (_, index) => state.board?.[index]);
  const hole = Array.from(
    { length: 2 },
    (_, index) => state.holeCards?.[index],
  );
  const line = (cards, blank) =>
    cards.map((card) => tile(card, blank)).join(" ");
  const tall = Boolean(theme) && rows >= 26;
  return [
    combine(dim("公共牌", theme), dim("你的底牌", theme)),
    ...(tall ? [combine(line(board, true), line(hole, true))] : []),
    combine(line(board, false), line(hole, false)),
    ...(tall ? [combine(line(board, true), line(hole, true)), ""] : []),
  ];
}

function cardsText(cards, theme, empty) {
  if (!cards?.length) return dim(empty, theme);
  return cards
    .map(
      (card) =>
        paint(
          cleanTerminalText(card.rank === "T" ? "10" : card.rank),
          "rank",
          theme,
        ) +
        paint(
          suitSymbols[card.suit] || "?",
          card.suit in suitSymbols ? card.suit : "rank",
          theme,
        ),
    )
    .join(" ");
}

export function actionText(lastAction) {
  if (!lastAction?.action) return "—";
  const labels = {
    fold: "弃牌",
    check: "过牌",
    call: "跟注",
    bet: "下注至",
    raise: "加注至",
    "all-in": "全下",
  };
  const label =
    labels[lastAction.action] || cleanTerminalText(lastAction.action);
  const amount =
    Number.isInteger(lastAction.amount) &&
    ["call", "bet", "raise"].includes(lastAction.action)
      ? ` ${lastAction.amount}`
      : "";
  return `${lastAction.timeout ? "超时 · " : ""}${label}${amount}`;
}

export function tablePositions(state) {
  const players = state?.players || [];
  const eligible = players
    .filter(
      (player) =>
        !player.away &&
        (state.inProgress
          ? player.inHand || player.folded
          : Number(player.stack) > 0),
    )
    .map((player) => player.seat);
  if (!eligible.length || !Number.isInteger(state?.button)) return new Map();
  const ordered = Array.from(
    { length: 6 },
    (_, offset) => (state.button + offset) % 6,
  ).filter((seat) => eligible.includes(seat));
  if (!ordered.length) return new Map();
  const labels =
    ordered.length === 2
      ? ["BTN/SB", "BB"]
      : [
          "BTN",
          "SB",
          "BB",
          ...({ 3: [], 4: ["UTG"], 5: ["UTG", "CO"], 6: ["UTG", "MP", "CO"] }[
            ordered.length
          ] || []),
        ];
  return new Map(ordered.map((seat, index) => [seat, labels[index] || "—"]));
}

function playerStatus(player, state) {
  if (player.connected === false) return ["离线", "danger"];
  if (player.away) return ["暂离", "dim"];
  if (state.inProgress) {
    if (player.folded) return ["弃牌", "dim"];
    if (player.inHand && Number(player.stack) === 0) return ["全下", "warning"];
    if (player.seat === state.actor) return ["行动中", "accent"];
    return [player.inHand ? "在局" : "旁观", "dim"];
  }
  return player.ready ? ["已准备", "success"] : ["未准备", "dim"];
}

function turnCommands(legal) {
  return (legal.actions || []).map((action) => {
    if (["bet", "raise"].includes(action))
      return `${action} ${legal.min}–${legal.max}`;
    return action === "all-in" ? "allin" : action;
  });
}

const phaseLabels = {
  waiting: "等待开局",
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  complete: "本手结算",
};

function phaseText(phase) {
  return phaseLabels[phase] || cleanTerminalText(phase || "未知轮次");
}

function scopedAction(action, state) {
  if (!action?.action) return "—";
  if (action.hand == null || !action.phase)
    return `旧记录/未知轮次 ${actionText(action)}`;
  const current = action.hand === state.hand && action.phase === state.phase;
  if (current) return actionText(action);
  if (action.hand === state.hand)
    return `${phaseText(action.phase)} · ${actionText(action)}`;
  return `旧:H${action.hand}/${phaseText(action.phase)} ${actionText(action)}`;
}

function packParts(parts, columns, separator = " · ") {
  const lines = [];
  for (const part of parts) {
    const last = lines.length - 1;
    if (
      last >= 0 &&
      displayWidth(`${lines[last]}${separator}${part}`) <= columns
    )
      lines[last] += `${separator}${part}`;
    else lines.push(truncateTerminalText(part, columns));
  }
  return lines;
}

function nextSteps(state, players, me, columns) {
  if (state.inProgress) {
    if (state.actor === state.me)
      return packParts(
        ["下一步:", ...turnCommands(state.legal || {})],
        columns,
        "  ",
      );
    return [me?.folded ? "下一步: 已弃牌，等待本手结束" : "下一步: 等待行动"];
  }
  if (me?.away) return ["下一步: sit 恢复入座"];
  if (me && Number(me.stack) <= 0) return ["下一步: rebuy 补充筹码"];
  const funded = players.filter(
    (player) => !player.away && Number(player.stack) > 0,
  );
  const waiting = funded.filter(
    (player) => !player.ready && player.seat !== state.me,
  );
  const lines = [];
  if (me && !me.ready)
    lines.push(`下一步: ready ${state.result ? "重新准备" : "准备"}`);
  if (waiting.length)
    lines.push(
      ...packParts(
        [
          "等待未准备:",
          ...waiting.map((player) => {
            const name = cleanTerminalText(player.name);
            return displayWidth(name) > 12
              ? `${player.seat + 1}:${truncateTerminalText(name, 10)}`
              : name;
          }),
        ],
        columns,
        " ",
      ),
    );
  else if (funded.length < 2) lines.push("等待至少两名有筹码的在座玩家");
  else if (me?.ready) {
    if (state.me === state.host) lines.push("下一步: start 房主开局");
    else {
      const host = players.find((player) => player.seat === state.host);
      const name = truncateTerminalText(
        cleanTerminalText(host?.name || "未知"),
        Math.max(4, Math.min(12, columns - 21)),
      );
      lines.push(`等待房主 ${name} start 开局`);
    }
  }
  return lines;
}

function seatLines(state, players, theme, columns, summary = false) {
  if (summary) {
    return packParts(
      [
        `座位摘要(${players.length})`,
        ...players.map((player) => {
          const marker =
            player.seat === state.actor
              ? "▶"
              : player.seat === state.me
                ? "●"
                : "○";
          return `${marker}${player.seat + 1}:${truncateTerminalText(cleanTerminalText(player.name), 10)}`;
        }),
      ],
      columns,
      " ",
    ).map((line) => dim(line, theme));
  }
  const positions = tablePositions(state);
  const narrow = columns < 64;
  const fields = narrow
    ? [
        ["席", 3],
        ["玩家", 10],
        ["筹码", 6, true],
        ["已投", 5, true],
      ]
    : [
        ["席", 3],
        ["角色", 6],
        ["玩家", columns >= 100 ? 18 : 12],
        ["筹码", 7, true],
        ["已投", 6, true],
      ];
  const prefixWidth = fields.reduce((sum, [, width]) => sum + width + 1, 0);
  const statusWidth = 6;
  const actionWidth = Math.max(0, columns - prefixWidth - statusWidth - 3);
  return [
    dim(
      `${fields.map(([label, width, right]) => cell(label, width, right)).join(" ")} ${cell("状态", statusWidth)}   最近动作`,
      theme,
    ),
    ...players.map((player) => {
      const marker =
        player.seat === state.actor
          ? "▶"
          : player.seat === state.me
            ? "●"
            : "○";
      const values = narrow
        ? [
            `${marker}${player.seat + 1}`,
            player.name,
            player.stack,
            player.bet ?? 0,
          ]
        : [
            `${marker}${player.seat + 1}`,
            positions.get(player.seat) || "—",
            player.name,
            player.stack,
            player.bet ?? 0,
          ];
      const [status, style] = playerStatus(player, state);
      const prefix = values
        .map((value, index) => {
          const content = cell(value, fields[index][1], fields[index][2]);
          if (index === 0)
            return paint(
              content,
              player.seat === state.actor ? "accent" : "dim",
              theme,
            );
          if (index === (narrow ? 1 : 2))
            return paint(
              content,
              player.seat === state.me
                ? "accent"
                : player.folded
                  ? "dim"
                  : "text",
              theme,
            );
          return dim(content, theme);
        })
        .join(" ");
      return `${prefix} ${paint(cell(status, statusWidth), style, theme)}   ${dim(cell(scopedAction(player.lastAction, state), actionWidth), theme)}`;
    }),
  ];
}

function resultLines(state, theme, columns) {
  if (state.inProgress || !state.result) return [];
  const snapshot = (state.history || []).find(
    (entry) => entry.hand === state.hand,
  );
  const payouts = state.result.payouts || [];
  const amountWidth = Math.max(
    1,
    ...payouts.map((entry) => displayWidth(entry.amount)),
  );
  const showdown = state.result.showdown || [];
  const seats = [
    ...new Set([...payouts, ...showdown].map((entry) => entry.seat)),
  ].sort((a, b) => a - b);
  return [
    success(`本手结果 H${state.hand} · 分得筹码 / 摊牌`, theme),
    ...seats.map((seat) => {
      const payout = payouts.find((entry) => entry.seat === seat);
      const hand = showdown.find((entry) => entry.seat === seat);
      // Only a hand snapshot can name a historical seat; current occupants may differ.
      const player = snapshot?.players?.find((entry) => entry.seat === seat);
      const name =
        player?.name || hand?.name || payout?.name || `当时座位${seat + 1}`;
      return `${cell(name, Math.min(12, Math.max(4, columns - 28)))} 分得 ${cell(payout?.amount ?? 0, amountWidth, true)}  ${cardsText(hand?.cards, theme, "")}`;
    }),
  ];
}

function historyLines(state, columns, budget, expanded, theme) {
  if (budget <= 0) return [];
  const events = (state.events || []).filter((event) => event.action);
  if (!expanded || !events.length || budget === 1)
    return [
      section(
        `行动路线 ${expanded ? "▾" : "▸"}`,
        columns,
        theme,
        `history ${expanded ? "收起" : "展开"} (${events.length})${expanded && events.length && budget === 1 ? "（空间不足）" : ""}`,
      ),
    ];
  const groups = new Map();
  for (const [index, event] of events.entries()) {
    const known = event.hand != null && Boolean(event.phase);
    const key = known ? `${event.hand}/${event.phase}` : "legacy";
    if (!groups.has(key))
      groups.set(key, {
        hand: known ? event.hand : null,
        phase: known ? event.phase : null,
        events: [],
      });
    groups.get(key).events.push({ ...event, index });
  }
  const phaseOrder = [
    "waiting",
    "preflop",
    "flop",
    "turn",
    "river",
    "complete",
  ];
  const ordered = [...groups.values()].sort(
    (a, b) =>
      (a.hand ?? -1) - (b.hand ?? -1) ||
      phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase),
  );
  for (const group of ordered) {
    group.events.sort(
      (a, b) => (a.at ?? a.index) - (b.at ?? b.index) || a.index - b.index,
    );
    const label =
      group.hand == null
        ? "旧记录/未知轮次"
        : `H${group.hand}/${phaseText(group.phase)}`;
    const parts = group.events.map((event) => {
      if (group.hand == null)
        return cleanTerminalText(
          event.text || `身份未知 ${actionText(event.action)}`,
        );
      const name = truncateTerminalText(
        cleanTerminalText(event.name || `当时座位${event.seat + 1}`),
        12,
      );
      return `${name} ${actionText(event.action)}`;
    });
    const available = Math.max(1, columns - displayWidth(label) - 1);
    group.lines = packParts(parts, available, " → ").map(
      (line) => `${dim(label, theme)} ${line}`,
    );
    group.priority =
      group.hand === state.hand
        ? group.phase === state.phase
          ? 0
          : 1
        : group.hand == null
          ? 2
          : 3;
  }
  const preferred = [...ordered].sort(
    (a, b) => a.priority - b.priority || (b.hand ?? -1) - (a.hand ?? -1),
  );
  let remaining = Math.max(0, budget - 1);
  for (const group of preferred) {
    const count = Math.min(remaining, group.lines.length);
    group.visible = count ? group.lines.slice(-count) : [];
    remaining -= count;
  }
  const omitted = ordered.some(
    (group) => group.visible.length < group.lines.length,
  );
  return [
    section(
      "行动路线 ▾",
      columns,
      theme,
      `history 收起${omitted ? "（有省略）" : ""}`,
    ),
    ...ordered.flatMap((group) => group.visible),
  ];
}

function chatLines(state, columns, budget, expanded, theme) {
  if (budget <= 0) return [];
  const messages = state.chat || [];
  if (!messages.length) return [dim("聊天：暂无消息 · chat", theme)];
  const count = expanded ? Math.max(1, budget - 1) : 1;
  const selected = messages.slice(-count);
  const lines = selected.map((message) => {
    const name = truncateTerminalText(
      cleanTerminalText(message.name || `座位${message.seat + 1}`),
      12,
    );
    return `${name}：${cleanTerminalText(message.text)}`;
  });
  if (budget === 1 || !expanded)
    return [
      truncateTerminalText(
        `${dim(`聊天(${messages.length}) · chat`, theme)} ${lines.at(-1)}`,
        columns,
      ),
    ];
  return [
    section(
      "聊天",
      columns,
      theme,
      `chat 收起 (${selected.length}/${messages.length})`,
    ),
    ...lines,
  ];
}

export function formatTable(
  state,
  {
    theme = false,
    columns = Infinity,
    rows = Infinity,
    now = Date.now,
    historyExpanded = false,
    chatExpanded = false,
  } = {},
) {
  columns = dimension(columns, 100);
  rows = dimension(rows, Infinity);
  theme = theme in palettes ? theme : false;
  const finish = (lines) =>
    lines
      .slice(0, rows)
      .map((line) => truncateTerminalText(line, columns))
      .join("\n");
  if (!rows || !columns) return "";
  if (!state?.room)
    return finish([
      accent("♠ HOLDEM · 尚未入座", theme),
      "create <昵称> 创建牌桌",
      "join <房间号> <昵称> 加入牌桌",
      dim("help 查看命令", theme),
    ]);
  const players = [...(state.players || [])].sort((a, b) => a.seat - b.seat);
  const me = players.find((player) => player.seat === state.me);
  const actor = players.find((player) => player.seat === state.actor);
  const clock = typeof now === "function" ? now() : now;
  const seconds =
    state.deadline == null
      ? "?"
      : Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const host = players.find((player) => player.seat === state.host);
  const metadata = `你:${state.me == null ? "旁观" : state.me + 1} · 房主:${host ? host.seat + 1 : "—"}`;
  const title = accent(`HOLDEM ${cleanTerminalText(state.room)}`, theme);
  const hand = dim(`H${state.hand || 0}`, theme);
  const stats = `${accent(phaseText(state.phase), theme)} · 底池 ${paint(state.pot ?? 0, "text", theme)}`;
  const core = [
    spread(title, hand, columns),
    displayWidth(stats) + displayWidth(metadata) + 2 <= columns
      ? spread(stats, dim(metadata, theme), columns)
      : stats,
    ...boardLines(state, columns, rows, theme),
  ];
  const controls = [];
  if (state.inProgress) {
    const actorName = truncateTerminalText(
      cleanTerminalText(actor?.name || "未知玩家"),
      Math.max(4, columns - 26),
    );
    const turn =
      state.actor === state.me
        ? paint(
            `轮到你行动 · 剩余 ${seconds}s`,
            typeof seconds === "number" && seconds <= 10 ? "warning" : "turn",
            theme,
          )
        : dim(`等待 ${actorName} 行动 · ${seconds}s`, theme);
    const chips = dim(
      `你本轮已投 ${me?.bet ?? 0} · 筹码 ${me?.stack ?? 0}`,
      theme,
    );
    controls.push(
      ...(displayWidth(turn) + displayWidth(chips) + 2 <= columns
        ? [spread(turn, chips, columns)]
        : [turn, chips]),
    );
    const legal = state.legal || {};
    if (state.actor === state.me) {
      const targets = [];
      if (legal.actions?.includes("call"))
        targets.push(
          `call 补 ${legal.call} → 本轮至 ${(me?.bet ?? 0) + legal.call}`,
        );
      if (legal.actions?.some((action) => ["bet", "raise"].includes(action)))
        targets.push(`bet/raise 本轮至 ${legal.min}–${legal.max}`);
      controls.push(
        ...packParts(targets, columns).map((line) => dim(line, theme)),
      );
    }
  }
  const actionable = !state.inProgress || state.actor === state.me;
  controls.push(
    ...nextSteps(state, players, me, columns).map((line) =>
      actionable && line.startsWith("下一步:")
        ? accent(line, theme)
        : dim(line, theme),
    ),
  );
  const actions = [section("操作", columns, theme, "help"), ...controls];
  const results = resultLines(state, theme, columns);
  // Keep commands beside the input; transcripts and seat detail share the middle.
  const gap = core.length + actions.length < rows ? [""] : [];
  const budget = Math.max(0, rows - core.length - actions.length - gap.length);
  const compactSeats =
    historyExpanded ||
    chatExpanded ||
    players.length + 1 + results.length + 3 > budget;
  const seats = seatLines(state, players, theme, columns, compactSeats);
  let spare = budget;
  const resultBudget = Math.min(results.length, spare);
  spare -= resultBudget;
  const seatBudget = Math.min(seats.length, spare);
  spare -= seatBudget;
  let chatBudget = Math.min(1, spare);
  spare -= chatBudget;
  const historyBudget = Math.min(
    spare,
    chatExpanded
      ? historyExpanded
        ? Math.max(2, Math.ceil(spare / 2))
        : 2
      : spare,
  );
  const history = historyLines(
    state,
    columns,
    historyBudget,
    historyExpanded,
    theme,
  );
  spare -= history.length;
  if (chatExpanded) chatBudget += spare;
  const chat = chatLines(state, columns, chatBudget, chatExpanded, theme);
  const content = [
    ...seats.slice(0, seatBudget),
    ...results.slice(0, resultBudget),
    ...history,
    ...chat,
  ];
  // On very short screens retain the command area before adding table detail.
  if (core.length + actions.length > rows)
    return finish([
      ...core.slice(0, Math.max(0, rows - actions.length)),
      ...actions,
    ]);
  return finish([...core, ...content, ...gap, ...actions]);
}

export class TerminalSession {
  constructor({ base, statePath, fetchImpl = fetch }) {
    this.base = base;
    this.statePath = statePath;
    this.fetch = fetchImpl;
    this.token = undefined;
    this.identityPromise = null;
    this.abortController = new AbortController();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      if (
        saved.server === this.base.origin &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.token)
      )
        this.token = saved.token;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async reset() {
    this.token = undefined;
    await rm(this.statePath, { force: true });
  }

  async save() {
    if (!this.token) return;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ server: this.base.origin, token: this.token }),
      { mode: 0o600 },
    );
    await rename(temporary, this.statePath);
  }

  async request(operation, input = {}, authenticated = true) {
    const response = await this.fetch(new URL(`/api/${operation}`, this.base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.any([
        AbortSignal.timeout(8000),
        this.abortController.signal,
      ]),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) await this.reset();
      const error = new Error(data.error || "游戏服务请求失败");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  async identity() {
    if (this.token) return;
    if (!this.identityPromise) {
      this.identityPromise = (async () => {
        const identity = await this.request("session", {}, false);
        this.token = identity.token;
        await this.save();
      })().finally(() => {
        this.identityPromise = null;
      });
    }
    await this.identityPromise;
  }

  async state() {
    await this.identity();
    return this.request("get_table_state");
  }

  async mutate(operation, state, extras = {}, id = requestId()) {
    await this.identity();
    const input = {
      ...(state?.room ? { room: state.room, revision: state.revision } : {}),
      ...extras,
      requestId: id,
    };
    return this.request(operation, input);
  }

  close() {
    this.abortController.abort();
  }
}

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
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function cardText(card) {
  if (!card) return "??";
  return `${card.rank === "T" ? "10" : card.rank}${
    { spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦" }[card.suit] || "?"
  }`;
}

const palettes = {
  dark: {
    dim: "2;37",
    accent: "1;36",
    success: "1;32",
    warning: "1;33",
    danger: "1;31",
    text: "1;37",
    rank: "1;97",
    spades: "1;97",
    hearts: "1;91",
    clubs: "1;94",
    diamonds: "1;93",
    turn: "1;30;103",
  },
  light: {
    dim: "2;30",
    accent: "1;34",
    success: "1;32",
    warning: "1;31",
    danger: "1;31",
    text: "1;30",
    rank: "1;30",
    spades: "1;97;40",
    hearts: "1;31",
    clubs: "1;97;44",
    diamonds: "1;93;40",
    turn: "1;97;41",
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

function warning(value, theme) {
  return paint(value, "warning", theme);
}

function danger(value, theme) {
  return paint(value, "danger", theme);
}

const suitSymbols = {
  spades: "♠︎",
  hearts: "♥",
  clubs: "♣︎",
  diamonds: "♦︎",
};

function displayWidth(value) {
  return [...cleanTerminalText(value)].reduce(
    (width, char) =>
      width +
      (/[\ufe0e\ufe0f]/u.test(char)
        ? 0
        : /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(
              char,
            )
          ? 2
          : 1),
    0,
  );
}

function truncate(value, width) {
  const cleaned = cleanTerminalText(value);
  if (displayWidth(cleaned) <= width) return cleaned;
  let output = "";
  for (const char of cleaned) {
    if (displayWidth(output + char) > width - 1) return `${output}…`;
    output += char;
  }
  return output;
}

function cell(value, width) {
  const clipped = truncate(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function centered(value, width) {
  const padding = Math.max(0, width - displayWidth(value));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
}

function cardsLines(cards, theme, empty) {
  if (!cards?.length) return [dim(empty, theme), ""];
  return [
    cards
      .map((card) =>
        paint(centered(card.rank === "T" ? "10" : card.rank, 4), "rank", theme),
      )
      .join("  "),
    cards
      .map((card) =>
        paint(
          centered(suitSymbols[card.suit] || "?", 4),
          card.suit in suitSymbols ? card.suit : "rank",
          theme,
        ),
      )
      .join("  "),
  ];
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

function playerTags(player, state, color) {
  const tags = [];
  if (player.seat === state.me) tags.push(accent("你", color));
  if (player.seat === state.host) tags.push(warning("房主", color));
  if (player.seat === state.actor) tags.push(warning("行动中", color));
  if (player.away) tags.push(dim("暂离", color));
  if (player.ready) tags.push(success("准备", color));
  if (player.folded) tags.push(dim("弃牌", color));
  if (player.connected === false) tags.push(danger("离线", color));
  return tags.length
    ? ` ${dim("·", color)} ${tags.join(dim(" · ", color))}`
    : "";
}

function turnCommands(legal) {
  return (legal.actions || []).map((action) => {
    if (action === "call") return `call ${legal.call}`;
    if (["bet", "raise"].includes(action))
      return `${action} ${legal.min}–${legal.max}`;
    return action === "all-in" ? "allin" : action;
  });
}

export function formatTable(state, { theme = false, columns = Infinity } = {}) {
  if (!state?.room) {
    return [
      accent("♠  HOLDEM · 终端牌桌", theme),
      dim("尚未入座", theme),
      "",
      "create <昵称>             创建一张新牌桌",
      "join <房间号> <昵称>      加入朋友的房间",
      "",
      dim("输入 help 查看全部命令", theme),
    ].join("\n");
  }
  const players = [...(state.players || [])].sort((a, b) => a.seat - b.seat);
  const me = players.find((player) => player.seat === state.me);
  const phase =
    {
      waiting: "等待开局",
      preflop: "翻牌前",
      flop: "翻牌",
      turn: "转牌",
      river: "河牌",
      complete: "本手结算",
    }[state.phase] || state.phase;
  const seconds = state.deadline
    ? Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))
    : null;
  const board = cardsLines(state.board, theme, "尚未发牌");
  const holeCards = cardsLines(state.holeCards, theme, "等待发牌");
  const positions = tablePositions(state);
  const compact = columns < 104;
  const lines = [
    accent(`♠  HOLDEM   ROOM ${state.room}   HAND ${state.hand || 0}`, theme),
    `${accent(phase, theme)}${seconds === null ? "" : `  ${warning(`${seconds}s`, theme)}`}  ${dim("·", theme)}  底池 ${paint(state.pot ?? 0, "text", theme)}`,
    "",
    `${dim(cell("公共牌", 8), theme)} ${board[0]}`,
    `${" ".repeat(9)}${board[1]}`,
    "",
    `${dim(cell("你的底牌", 8), theme)} ${holeCards[0]}${
      me?.away ? `  ${dim("·", theme)} ${warning("暂离", theme)}` : ""
    }`,
    `${" ".repeat(9)}${holeCards[1]}`,
    "",
    accent("座位", theme),
  ];
  if (compact) {
    lines.push(dim("席位  角色     玩家 · 筹码 · 最近动作 · 状态", theme));
    for (const player of players) {
      const indicator =
        player.seat === state.actor
          ? warning("▶", theme)
          : player.seat === state.me
            ? accent("●", theme)
            : dim("○", theme);
      lines.push(
        `${indicator}  ${cell(String(player.seat + 1), 3)} ${cell(
          positions.get(player.seat) || "—",
          8,
        )} ${cleanTerminalText(player.name)} ${dim("·", theme)} ${paint(
          player.stack,
          "text",
          theme,
        )} ${dim("·", theme)} ${actionText(player.lastAction)}${playerTags(player, state, theme)}`,
      );
    }
  } else {
    const columns = [
      ["标记", 6],
      ["席位", 4],
      ["角色", 8],
      ["玩家", 16],
      ["筹码", 8],
      ["最近动作", 18],
    ];
    lines.push(
      `${dim(
        columns.map(([label, width]) => cell(label, width)).join("  "),
        theme,
      )}  ${dim("状态", theme)}`,
    );
    for (const player of players) {
      const marker =
        player.seat === state.actor
          ? "▶"
          : player.seat === state.me
            ? "●"
            : "○";
      const indicator =
        player.seat === state.actor
          ? warning(cell(marker, 6), theme)
          : player.seat === state.me
            ? accent(cell(marker, 6), theme)
            : dim(cell(marker, 6), theme);
      const status = playerTags(player, state, theme).trimStart();
      lines.push(
        `${indicator}  ${cell(String(player.seat + 1), 4)}  ${cell(
          positions.get(player.seat) || "—",
          8,
        )}  ${cell(cleanTerminalText(player.name), 16)}  ${cell(
          String(player.stack),
          8,
        )}  ${cell(actionText(player.lastAction), 18)}  ${status}`,
      );
    }
  }
  if (state.inProgress && state.actor === state.me) {
    const legal = state.legal || {};
    lines.push(
      "",
      paint(
        `  ⚠  轮到你行动 · 剩余 ${seconds ?? "?"} 秒  ${turnCommands(legal).join("  |  ")}`,
        "turn",
        theme,
      ),
    );
  } else if (state.inProgress) {
    const actor = state.players?.find((player) => player.seat === state.actor);
    lines.push(
      "",
      `${dim("等待", theme)} ${cleanTerminalText(actor?.name || "玩家")} 行动`,
    );
  } else if (state.result) {
    const winners = state.result.payouts
      ?.filter((payout) => state.result.winners?.includes(payout.seat))
      .map((payout) => {
        const player = state.players?.find(
          (entry) => entry.seat === payout.seat,
        );
        return `${cleanTerminalText(player?.name || `座位 ${payout.seat + 1}`)} +${
          payout.amount
        }`;
      });
    if (winners?.length)
      lines.push("", `${success("本手结果", theme)}  ${winners.join(" · ")}`);
    const showdown = [...(state.result.showdown || [])].sort(
      (a, b) => a.seat - b.seat,
    );
    if (showdown.length) {
      lines.push("", accent("摊牌", theme));
      for (const entry of showdown) {
        const player = players.find(
          (candidate) => candidate.seat === entry.seat,
        );
        const cards = cardsLines(entry.cards, theme, "");
        lines.push(
          `${cell(cleanTerminalText(player?.name || `座位 ${entry.seat + 1}`), 16)}  ${cards[0]}`,
          `${" ".repeat(18)}${cards[1]}`,
        );
      }
    }
  }
  const activity = (state.events || [])
    .filter((event) => event.action)
    .slice(-4)
    .reverse();
  if (activity.length) {
    lines.push("", accent("动态", theme));
    for (const event of activity) {
      const player = state.players?.find((entry) => entry.seat === event.seat);
      const time = new Date(event.at).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      lines.push(
        `${dim(time, theme)}  ${cleanTerminalText(player?.name || "玩家")}  ${actionText(event.action)}`,
      );
    }
  }
  lines.push("", dim("help 查看命令  ·  status 刷新  ·  quit 退出", theme));
  return lines.join("\n");
}

export class TerminalSession {
  constructor({ base, statePath, fetchImpl = fetch }) {
    this.base = base;
    this.statePath = statePath;
    this.fetch = fetchImpl;
    this.token = undefined;
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
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) await this.reset();
      throw new Error(data.error || "游戏服务请求失败");
    }
    return data;
  }

  async identity() {
    if (this.token) return;
    const identity = await this.request("session", {}, false);
    this.token = identity.token;
    await this.save();
  }

  async state() {
    await this.identity();
    return this.request("get_table_state");
  }

  async mutate(operation, state, extras = {}) {
    await this.identity();
    const input = {
      ...(state?.room ? { room: state.room, revision: state.revision } : {}),
      ...extras,
      requestId: requestId(),
    };
    return this.request(operation, input);
  }
}

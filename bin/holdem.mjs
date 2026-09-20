#!/usr/bin/env node
import readline from "node:readline";
import { argv, env, exit, stdin, stdout } from "node:process";
import {
  formatTable,
  parseCommand,
  serverUrlFromEnv,
  TerminalSession,
  tuiStatePath,
} from "./holdem-lib.mjs";

const help = `命令：
  create <昵称>             创建房间
  join <房间号> <昵称>      加入房间
  status                    刷新牌桌
  ready | unready            准备 / 取消准备
  start                     房主开始下一手
  away | sit                暂离 / 上桌
  host <座位号>             房主转移（座位号 1–6）
  fold | check | call | allin
  bet <总下注目标> | raise <总下注目标>
  rebuy | leave
  clear | help | quit

环境变量：
  HOLDEM_SERVER_URL          服务地址，默认 ${"http://127.0.0.1:4318"}
  HOLDEM_ALLOW_INSECURE_LAN=1  使用其他可信 LAN 的明文 HTTP 地址
  HOLDEM_TUI_STATE_PATH      自定义本机终端会话保存位置
  HOLDEM_TUI_THEME           dark（默认）或 light（白色终端）
`;

function usage() {
  stdout.write(
    `用法：holdem [--url <HTTP(S) 地址>] [--reset] [--no-color] [--light|--dark]\n\n${help}`,
  );
}

function parseOptions(values) {
  const options = { reset: false, noColor: false, theme: undefined };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--reset") {
      options.reset = true;
      continue;
    }
    if (value === "--no-color") {
      options.noColor = true;
      continue;
    }
    if (value === "--light" || value === "--dark") {
      options.theme = value.slice(2);
      continue;
    }
    if (value === "--url") {
      options.url = values[++index];
      if (!options.url) throw new Error("--url 需要一个服务地址");
      continue;
    }
    throw new Error(`未知参数：${value}`);
  }
  return options;
}

let options;
try {
  options = parseOptions(argv.slice(2));
  if (options.help) {
    usage();
    exit(0);
  }
} catch (error) {
  stdout.write(`${error.message}\n\n`);
  usage();
  exit(1);
}

let base;
try {
  base = serverUrlFromEnv({
    ...env,
    ...(options.url ? { HOLDEM_SERVER_URL: options.url } : {}),
  });
} catch (error) {
  stdout.write(`${error.message}\n`);
  exit(1);
}

const session = new TerminalSession({ base, statePath: tuiStatePath(env) });
await session.load();
if (options.reset) {
  await session.reset();
  stdout.write("已清除本机终端玩家身份。\n");
}

const interactive = stdout.isTTY;
const requestedTheme = options.theme || env.HOLDEM_TUI_THEME || "dark";
if (!["dark", "light"].includes(requestedTheme)) {
  stdout.write("HOLDEM_TUI_THEME 只能是 dark 或 light\n");
  exit(1);
}
const theme =
  interactive && !options.noColor && !env.NO_COLOR && env.TERM !== "dumb"
    ? requestedTheme
    : false;
const rl = readline.createInterface({
  input: stdin,
  output: stdout,
  prompt: "holdem> ",
});
let state;
let busy = false;
let closed = false;
let lastSignature = "";
let warnedTurn = "";

function render(force = false) {
  const signature = `${state?.room}:${state?.revision}`;
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  if (interactive) stdout.write("\x1b[2J\x1b[H");
  stdout.write(
    `${formatTable(state, { theme, columns: stdout.columns || Infinity })}\n\n`,
  );
}

function warnNearTimeout() {
  if (
    !state?.deadline ||
    state.actor !== state.me ||
    busy ||
    (interactive && rl.line)
  )
    return;
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  const key = `${state.room}:${state.hand}:${state.deadline}`;
  if (seconds > 10 || warnedTurn === key) return;
  warnedTurn = key;
  stdout.write(`⚠ 轮到你行动，仅剩 ${seconds} 秒。请尽快输入动作。\n`);
  if (interactive && !closed) rl.prompt(true);
}

async function refresh(force = false) {
  if (busy || closed) return;
  try {
    const next = await session.state();
    const changed =
      !state || next.room !== state.room || next.revision !== state.revision;
    state = next;
    if ((changed || force) && (!interactive || !rl.line)) {
      render(force);
      if (interactive && !closed && !force) rl.prompt(true);
    }
    warnNearTimeout();
  } catch (error) {
    if (force) stdout.write(`连接失败：${error.message}\n`);
  }
}

async function requireState() {
  if (!state) await refresh(true);
  return state;
}

async function mutate(operation, extras = {}) {
  const current = await requireState();
  busy = true;
  try {
    state = await session.mutate(operation, current, extras);
    render(true);
  } finally {
    busy = false;
  }
}

async function handle(line) {
  const { command, args } = parseCommand(line);
  if (!command) return;
  if (["quit", "exit", "q"].includes(command)) {
    closed = true;
    rl.close();
    return;
  }
  if (command === "help") {
    stdout.write(`\n${help}\n`);
    return;
  }
  if (command === "clear") {
    render(true);
    return;
  }
  if (command === "status") {
    await refresh(true);
    return;
  }
  if (command === "create") {
    if (!args.length) throw new Error("用法：create <昵称>");
    await mutate("create_room", { name: args.join(" ") });
    return;
  }
  if (command === "join") {
    if (args.length < 2) throw new Error("用法：join <房间号> <昵称>");
    await mutate("join_room", {
      room: args[0].toUpperCase(),
      name: args.slice(1).join(" "),
    });
    return;
  }
  if (command === "ready" || command === "unready") {
    await mutate("set_ready", { ready: command === "ready" });
    return;
  }
  if (command === "start") return mutate("start_game");
  if (command === "away") return mutate("set_away");
  if (command === "sit" || command === "up") return mutate("resume_seat");
  if (command === "rebuy") return mutate("rebuy");
  if (command === "leave") return mutate("leave_room");
  if (command === "host") {
    const seat = Number(args[0]);
    if (!Number.isInteger(seat) || seat < 1 || seat > 6)
      throw new Error("用法：host <1–6 的座位号>");
    return mutate("transfer_host", { seat: seat - 1 });
  }
  const action = command === "allin" ? "all-in" : command;
  if (["fold", "check", "call", "all-in"].includes(action))
    return mutate("player_action", { action });
  if (["bet", "raise"].includes(action)) {
    const amount = Number(args[0]);
    if (!Number.isInteger(amount) || amount <= 0)
      throw new Error(`用法：${action} <总下注目标>`);
    return mutate("player_action", { action, amount });
  }
  throw new Error(`未知命令：${command}（输入 help 查看命令）`);
}

rl.on("line", async (line) => {
  if (busy) {
    stdout.write("上一项操作尚未完成，请稍候。\n");
    rl.prompt();
    return;
  }
  try {
    await handle(line);
  } catch (error) {
    stdout.write(`操作失败：${error.message}\n`);
  }
  if (!closed) rl.prompt();
});
rl.on("close", () => {
  closed = true;
  stdout.write(
    "已离开终端牌桌。会话身份会保留 30 分钟，可重新运行 holdem 返回。\n",
  );
});

await refresh(true);
if (!closed) rl.prompt();
const refreshTimer = setInterval(() => refresh(), 1500);
refreshTimer.unref();

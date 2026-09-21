#!/usr/bin/env node
import readline from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { argv, env, stdin, stdout } from "node:process";
import {
  cleanTerminalText,
  displayWidth,
  fitTerminalLine,
  formatTable,
  parseCommand,
  serverUrlFromEnv,
  TerminalSession,
  tuiStatePath,
} from "./holdem-lib.mjs";
import { TerminalClient } from "./holdem-client.mjs";

const commands = [
  "create <昵称> / join <房间号> <昵称>",
  "ready / unready       准备 / 取消准备",
  "start                 房主开始下一手",
  "fold / check / call    弃牌 / 过牌 / 跟注",
  "bet <金额> / raise <金额>  本轮总下注目标",
  "allin                 全下",
  "away / sit            暂离 / 恢复上桌",
  "host <1–6>            转移房主",
  "rebuy / leave         补充筹码 / 离席",
  "say <内容>            房间聊天",
  "history / chat        展开或收起记录",
  "retry                 核实结果待确认的原请求",
  "status / clear        返回并刷新 / 返回牌桌",
  "help / quit           帮助 / 退出客户端",
];

function usage() {
  return `用法：holdem [--url <HTTP(S) 地址>] [--reset] [--no-color] [--light|--dark]

${commands.join("\n")}

环境变量：
  HOLDEM_SERVER_URL           默认 http://127.0.0.1:4318
  HOLDEM_ALLOW_INSECURE_LAN=1  使用可信 LAN 的明文 HTTP 地址
  HOLDEM_TUI_STATE_PATH       本机终端会话保存位置
  HOLDEM_TUI_THEME            dark（默认）或 light
`;
}

function parseOptions(values) {
  const options = { reset: false, noColor: false, theme: undefined };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--reset") options.reset = true;
    else if (value === "--no-color") options.noColor = true;
    else if (value === "--light" || value === "--dark")
      options.theme = value.slice(2);
    else if (value === "--url") {
      options.url = values[++index];
      if (!options.url) throw new Error("--url 需要一个服务地址");
    } else throw new Error(`未知参数：${value}`);
  }
  return options;
}

export async function runTerminal({
  session,
  input = stdin,
  output = stdout,
  theme = false,
  timers = true,
  now = Date.now,
}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  const rl = readline.createInterface({
    input,
    output,
    terminal: interactive,
    prompt: "holdem> ",
  });
  let closed = false;
  let inputContext;
  let notice = "";
  let helpVisible = false;
  let historyExpanded = false;
  let chatExpanded = false;
  let lastSignature = "";
  let lastInputRows = 1;
  let refreshTimer;
  let renderTimer;
  const client = new TerminalClient({ session, onChange: render, now });

  function inputRows() {
    const columns = Math.max(1, output.columns || 80);
    return Math.floor(displayWidth(`holdem> ${rl.line || ""}`) / columns) + 1;
  }

  function render() {
    if (closed) return;
    const columns = Math.max(1, output.columns || 80);
    const rows = interactive ? output.rows || 24 : Infinity;
    lastInputRows = inputRows();
    const available = Math.max(1, rows - lastInputRows - 3);
    const state = client.state;
    const seconds = state?.deadline
      ? Math.max(0, Math.ceil((state.deadline - client.serverNow()) / 1000))
      : null;
    const inputChanged =
      rl.line &&
      inputContext !== undefined &&
      JSON.stringify(inputContext) !== JSON.stringify(client.context());
    const age =
      client.lastSuccessAt === null
        ? null
        : Math.max(0, Math.floor((now() - client.lastSuccessAt) / 1000));
    const connection =
      client.connection === "online"
        ? "已连接"
        : client.connection === "connecting"
          ? "连接中"
          : `断线${age === null ? "" : ` · ${age}s 前同步`} · ${cleanTerminalText(client.lastError)}`;
    const header = `${connection}${client.busy ? " · 正在提交" : ""}${client.pending?.uncertain ? " · 结果待确认：retry" : ""}`;
    const footer = client.pending?.uncertain
      ? "操作结果待确认，输入 retry 核实原请求；不会自动重复下注"
      : inputChanged
        ? "牌局已变化，当前输入的动作需核对后重新输入"
        : state?.actor === state?.me && seconds !== null && seconds <= 10
          ? `轮到你，仅剩 ${seconds}s${notice ? ` · ${notice}` : ""}`
          : notice;
    let table = formatTable(state, {
      theme,
      columns,
      rows: available,
      now: client.serverNow(),
      historyExpanded,
      chatExpanded,
    });
    if (helpVisible) {
      const actor = state?.players?.find((p) => p.seat === state.actor);
      const live = state?.inProgress
        ? `${state.actor === state.me ? "轮到你" : `等待 ${actor?.name || "玩家"}`} · ${seconds ?? "?"}s`
        : "命令";
      table = [live, ...commands]
        .slice(0, available)
        .map((line) => fitTerminalLine(line, columns))
        .join("\n");
    }
    if (!interactive) {
      const signature = JSON.stringify([
        state?.room,
        state?.revision,
        state?.chatRevision,
        client.connection,
        client.busy,
        Boolean(client.pending?.uncertain),
        footer,
        helpVisible,
        historyExpanded,
        chatExpanded,
      ]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      output.write(`${header}\n${table}\n${footer}\nholdem> `);
      return;
    }
    const cursorRows = rl.getCursorPos().rows;
    output.write("\x1b[?25l\x1b[H\x1b[2J");
    output.write(
      `${fitTerminalLine(header, columns)}\n${table}\n${fitTerminalLine(footer, columns)}\n`,
    );
    // readline restores its editing buffer relative to the old cursor row.
    if (cursorRows) readline.moveCursor(output, 0, cursorRows);
    rl.prompt(true);
    output.write("\x1b[?25h");
  }

  async function handle(line, expected) {
    const { command, args } = parseCommand(line);
    if (!command) return;
    if (["quit", "exit", "q"].includes(command)) return rl.close();
    if (command === "help") {
      helpVisible = !helpVisible;
      return;
    }
    if (command === "history" || command === "chat") {
      helpVisible = false;
      if (command === "history") historyExpanded = !historyExpanded;
      else chatExpanded = !chatExpanded;
      return;
    }
    if (command === "clear" || command === "status") {
      helpVisible = false;
      notice = "";
      if (command === "status") await client.refresh();
      return;
    }
    if (command === "retry") {
      await client.retry();
      notice = "原操作已确认";
      await client.refresh();
      return;
    }
    let operation;
    let extras = {};
    if (command === "create") {
      if (!args.length) throw new Error("用法：create <昵称>");
      operation = "create_room";
      extras = { name: args.join(" ") };
    } else if (command === "join") {
      if (args.length < 2) throw new Error("用法：join <房间号> <昵称>");
      operation = "join_room";
      extras = { room: args[0].toUpperCase(), name: args.slice(1).join(" ") };
    } else if (command === "ready" || command === "unready") {
      operation = "set_ready";
      extras = { ready: command === "ready" };
    } else if (command === "host") {
      const seat = Number(args[0]);
      if (args.length !== 1 || !Number.isInteger(seat) || seat < 1 || seat > 6)
        throw new Error("用法：host <1–6 的座位号>");
      operation = "transfer_host";
      extras = { seat: seat - 1 };
    } else if (command === "say") {
      if (!args.length) throw new Error("用法：say <聊天内容>");
      operation = "send_chat";
      extras = { text: args.join(" ") };
    } else {
      const aliases = {
        start: "start_game",
        away: "set_away",
        sit: "resume_seat",
        up: "resume_seat",
        rebuy: "rebuy",
        leave: "leave_room",
      };
      operation = Object.hasOwn(aliases, command)
        ? aliases[command]
        : undefined;
      if (operation && args.length)
        throw new Error(`${command} 不需要额外参数`);
      if (!operation) {
        const action = command === "allin" ? "all-in" : command;
        if (["fold", "check", "call", "all-in"].includes(action)) {
          if (args.length) throw new Error(`${command} 不需要金额参数`);
          operation = "player_action";
          extras = { action };
        } else if (["bet", "raise"].includes(action)) {
          const amount = Number(args[0]);
          if (args.length !== 1 || !Number.isSafeInteger(amount) || amount <= 0)
            throw new Error(`用法：${action} <本轮总下注目标>`);
          operation = "player_action";
          extras = { action, amount };
        } else throw new Error(`未知命令：${command}（输入 help 查看命令）`);
      }
    }
    helpVisible = false;
    notice = "";
    await client.mutate(operation, extras, expected);
    notice = command === "say" ? "聊天已发送" : "操作已确认";
  }

  rl.on("line", async (line) => {
    const expected =
      inputContext === undefined ? client.context() : inputContext;
    inputContext = undefined;
    try {
      await handle(line, expected);
    } catch (error) {
      notice = `操作失败：${cleanTerminalText(error.message)}`;
      if (error.status === 409) await client.refresh().catch(() => {});
    }
    render();
  });
  function onKeypress(_text, key) {
    if (rl.line && inputContext === undefined) inputContext = client.context();
    if (!rl.line) inputContext = undefined;
    if (lastInputRows !== inputRows() || (key?.ctrl && key.name === "l"))
      render();
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(refreshTimer);
    clearInterval(renderTimer);
    input.off("keypress", onKeypress);
    output.off("resize", render);
    client.close();
    if (interactive) output.write("\x1b[?25h\x1b[?1049l");
    output.write("已退出客户端，座位不会立即退出；局间可用 leave 主动离席。\n");
    rl.close();
  }
  rl.on("close", close);
  rl.on("SIGINT", close);
  input.on("keypress", onKeypress);
  output.on("resize", render);
  if (interactive) output.write("\x1b[?1049h");
  render();
  await client.refresh().catch(() => {});
  if (timers && !closed) {
    refreshTimer = setInterval(() => client.refresh().catch(() => {}), 1500);
    refreshTimer.unref();
    if (interactive) {
      renderTimer = setInterval(render, 1000);
      renderTimer.unref();
    }
  }
  return { client, rl, render, close };
}

async function main() {
  const options = parseOptions(argv.slice(2));
  if (options.help) {
    stdout.write(usage());
    return;
  }
  const base = serverUrlFromEnv({
    ...env,
    ...(options.url ? { HOLDEM_SERVER_URL: options.url } : {}),
  });
  const requestedTheme = options.theme || env.HOLDEM_TUI_THEME || "dark";
  if (!["dark", "light"].includes(requestedTheme))
    throw new Error("HOLDEM_TUI_THEME 只能是 dark 或 light");
  const session = new TerminalSession({ base, statePath: tuiStatePath(env) });
  if (options.reset) await session.reset();
  else await session.load();
  const theme =
    stdout.isTTY && !options.noColor && !env.NO_COLOR && env.TERM !== "dumb"
      ? requestedTheme
      : false;
  const terminal = await runTerminal({ session, theme });
  process.once("SIGTERM", terminal.close);
}

if (argv[1] && import.meta.url === pathToFileURL(realpathSync(argv[1])).href) {
  main().catch((error) => {
    stdout.write(`${cleanTerminalText(error.message)}\n`);
    process.exitCode = 1;
  });
}

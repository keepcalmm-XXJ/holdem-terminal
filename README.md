# Holdem Terminal

局域网多人德州扑克终端版：虚拟筹码、私有手牌、实时同步；不包含 Web 页面或 Codex 插件。

需要 Node.js 22 或更高版本。

## 本机快速开始

在同一台电脑的两个终端窗口中执行：

```sh
# 窗口 1：启动服务（默认仅本机可访问）
npm ci
npm start

# 窗口 2：进入牌桌
npm run tui
```

终端客户端默认连接 `http://127.0.0.1:4318`。输入 `create <昵称>` 创建房间，或 `join <房间号> <昵称>` 加入房间；输入 `help` 查看完整命令。

同一房间内可输入 `say <内容>` 发送聊天。牌桌按终端宽度和高度显示，优先保留手牌、行动倒计时、本轮已投、跟注金额和下一步命令；聊天默认只显示最新一条。

宽屏将公共牌与手牌并排显示，空间充足时放大牌面；窄屏自动切换紧凑布局。筹码右对齐，玩家状态独立成列，本轮动作省略重复轮次，旧动作保留来源。操作区紧跟内容，仅留一行间距，不再填充空白撑满窗口；`--light` 和 `--no-color` 均可使用。

行动路线默认折叠，只显示标题和记录数。输入 `history` 展开按手号、下注轮组织的详细记录，再次输入 `history` 完全收起；刷新不会改变折叠状态。输入 `chat` 展开或收起聊天。聊天独立同步，不会使正常下注失效。准备、开局、暂离恢复和补充筹码的下一步提示会随状态变化。`bet` / `raise` 的金额始终是**本轮总下注目标**，`call` 不需要金额参数。

输入命令时牌桌仍会更新，输入内容和光标位置会保留。如果输入期间行动局面变化，旧动作会被拦下，需要核对后重新输入。断线会明确标出，倒计时不会因输入或断线而暂停。

网络异常或服务端提交结果不确定时会显示「结果待确认」，不会自动重复下注。输入 `retry` 使用相同请求 ID 和参数核实原操作；未确认前不能提交其他操作。若提示存储故障，需要先由房主恢复服务，再重试。`quit` 仅退出客户端，局间主动离席使用 `leave`。

服务端修复需要重启服务和终端客户端后生效；仅终端布局改动只需重新启动客户端。旧存档可直接恢复；旧行动记录缺少轮次时显示为旧记录，不会按当前座位猜测历史玩家。

## 局域网多人

在房主电脑启动服务时，显式监听局域网地址：

```sh
LAN_IP=$(ipconfig getifaddr en0)
HOLDEM_HOST=0.0.0.0 HOLDEM_ALLOWED_HOSTS=$LAN_IP npm start
```

房主可用 `echo $LAN_IP` 查看要分享给其他人的地址。朋友首次安装：

```sh
git clone https://github.com/keepcalmm-XXJ/holdem-terminal.git
cd holdem-terminal
npm ci --omit=dev
HOLDEM_ALLOW_INSECURE_LAN=1 npm run tui -- --url http://<房主局域网 IP>:4318
```

`HOLDEM_ALLOW_INSECURE_LAN=1` 只应在可信局域网中使用。

## 自动更新（macOS）

首次安装后执行一次：

```sh
npm run install-auto-update
```

它会创建当前用户的 LaunchAgent，每小时执行一次 `git pull --ff-only`；发现新版本时才同步依赖。更新会在下次启动终端客户端或重启服务时生效。

关闭自动更新：

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.holdem-terminal.update.plist
rm ~/Library/LaunchAgents/com.holdem-terminal.update.plist
```

也可以随时手动更新：

```sh
npm run update
```

## 隐私与规则

- 仅虚拟筹码，不涉及支付或真钱。
- 每位玩家只会收到自己的底牌。
- 结算时，仅实际进入摊牌的未弃牌玩家手牌会公开。

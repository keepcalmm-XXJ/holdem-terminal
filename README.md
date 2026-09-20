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

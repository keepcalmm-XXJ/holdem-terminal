# Holdem Terminal

局域网多人德州扑克终端版：虚拟筹码、私有手牌、实时同步；不包含 Web 页面或 Codex 插件。

需要 Node.js 22 或更高版本。

## 启动牌桌服务

在一台作为房主的电脑上：

```sh
npm ci
HOLDEM_HOST=0.0.0.0 HOLDEM_ALLOWED_HOSTS=<房主局域网 IP> npm start
```

房主通过 `ipconfig getifaddr en0` 查看局域网 IP；例如 `192.168.1.20`。其他玩家连接时使用这个地址。

## 终端加入牌局

```sh
npm ci --omit=dev
HOLDEM_ALLOW_INSECURE_LAN=1 npm run tui -- --url http://<房主局域网 IP>:4318
```

进入后输入 `create <昵称>` 创建房间，或 `join <房间号> <昵称>` 加入房间；输入 `help` 查看完整命令。

## 自动更新（macOS）

首次安装后执行一次：

```sh
npm run install-auto-update
```

它会创建当前用户的 LaunchAgent，每小时执行一次 `git pull --ff-only` 和依赖同步。更新会在下次启动终端客户端或重启服务时生效。

也可以随时手动更新：

```sh
npm run update
```

## 隐私与规则

- 仅虚拟筹码，不涉及支付或真钱。
- 每位玩家只会收到自己的底牌。
- 结算时，仅实际进入摊牌的未弃牌玩家手牌会公开。

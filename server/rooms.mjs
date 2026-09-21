import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { HoldemEngine } from "./engine.mjs";
import { SnapshotFile } from "./storage.mjs";

export class GameError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const requireValue = (condition, message, status = 400) => {
  if (!condition) throw new GameError(message, status);
};

function nickname(value) {
  requireValue(typeof value === "string", "请输入昵称");
  const name = value.trim();
  requireValue(
    name.length >= 1 && name.length <= 20 && !/[\p{C}]/u.test(name),
    "昵称需为 1–20 个可见字符",
  );
  return name;
}

function chatMessage(value) {
  requireValue(typeof value === "string", "请输入聊天内容");
  const text = value.trim();
  requireValue(
    text.length >= 1 && text.length <= 200 && !/[\p{C}]/u.test(text),
    "聊天内容需为 1–200 个可见字符",
  );
  return text;
}

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class RoomStore extends EventEmitter {
  constructor({
    now = Date.now,
    turnMs = 30_000,
    idleMs = 120_000,
    reconnectMs = 30 * 60_000,
    onlineMs = 45_000,
    storagePath,
    inviteBaseUrl = null,
  } = {}) {
    super();
    this.now = now;
    this.turnMs = turnMs;
    this.idleMs = idleMs;
    this.reconnectMs = reconnectMs;
    this.onlineMs = onlineMs;
    this.inviteBaseUrl = inviteBaseUrl;
    this.sessions = new Map();
    this.rooms = new Map();
    this.chatTimes = new Map();
    this.depth = 0;
    this.dirty = false;
    this.notify = false;
    if (storagePath) {
      this.storage = new SnapshotFile(storagePath);
      try {
        const saved = this.storage.load();
        if (saved !== undefined) {
          this.restoreState(saved);
          // A process outage is not player thinking time. Give everyone one
          // fresh action window and a reconnection grace period after boot.
          for (const room of this.rooms.values()) {
            for (const member of room.members) {
              member.connected = false;
              member.seenAt = this.now();
            }
            this.changed(room);
          }
          this.storage.save(this.exportState());
        }
      } catch (error) {
        this.storage.close();
        throw error;
      }
    }
    this.dirty = false;
    this.notify = false;
  }

  exportState() {
    const state = {
      version: 1,
      savedAt: this.now(),
      rooms: [...this.rooms.values()].map(({ engine, ...room }) => ({
        ...structuredClone(room),
        engine: engine.exportState(),
      })),
      sessions: [...this.sessions].map(([token, session]) => [
        token,
        { ...structuredClone(session), requests: [...session.requests] },
      ]),
    };
    return { ...state, checksum: digest(state) };
  }

  restoreState(saved) {
    requireValue(
      saved?.version === 1 &&
        Array.isArray(saved.rooms) &&
        Array.isArray(saved.sessions) &&
        saved.rooms.length <= 200 &&
        saved.sessions.length <= 2000,
      "保存的牌局格式无效，未覆盖原文件",
      503,
    );
    const { checksum, ...payload } = saved;
    requireValue(
      typeof checksum === "string" && digest(payload) === checksum,
      "保存的牌局校验失败，未覆盖原文件",
      503,
    );
    const rooms = new Map();
    const sessions = new Map();
    const identities = new Set();
    for (const [token, s] of saved.sessions) {
      requireValue(
        /^[A-Za-z0-9_-]{43}$/.test(token) &&
          typeof s.id === "string" &&
          Array.isArray(s.requests) &&
          s.requests.length <= 128 &&
          Number.isFinite(s.seenAt) &&
          (s.room === null || typeof s.room === "string") &&
          !sessions.has(token) &&
          !identities.has(s.id),
        "保存的玩家会话无效",
        503,
      );
      identities.add(s.id);
      sessions.set(token, {
        ...structuredClone(s),
        requests: new Map(s.requests),
      });
    }
    for (const value of saved.rooms) {
      requireValue(
        /^[A-F0-9]{8}$/.test(value.code) &&
          !rooms.has(value.code) &&
          Number.isSafeInteger(value.revision) &&
          value.revision >= 1 &&
          (value.chatRevision === undefined ||
            (Number.isSafeInteger(value.chatRevision) &&
              value.chatRevision >= 0)) &&
          Number.isSafeInteger(value.hand) &&
          value.hand >= 0 &&
          Number.isFinite(value.updatedAt) &&
          Array.isArray(value.history) &&
          value.history.length <= 10 &&
          Array.isArray(value.events) &&
          value.events.length <= 60 &&
          Array.isArray(value.chat ?? []) &&
          (value.chat?.length ?? 0) <= 50 &&
          Array.isArray(value.members) &&
          value.members.length > 0 &&
          value.members.length <= 6,
        "保存的房间无效",
        503,
      );
      const { engine, ...room } = value;
      room.chat ??= [];
      room.chatRevision ??= 0;
      for (const message of room.chat) {
        requireValue(
          typeof message.id === "string" &&
            Number.isFinite(message.at) &&
            Number.isInteger(message.seat) &&
            message.seat >= 0 &&
            message.seat < 6 &&
            typeof message.name === "string" &&
            message.name.length >= 1 &&
            message.name.length <= 20 &&
            !/[\p{C}]/u.test(message.name) &&
            typeof message.text === "string" &&
            message.text.length >= 1 &&
            message.text.length <= 200 &&
            !/[\p{C}]/u.test(message.text),
          "保存的聊天记录无效",
          503,
        );
      }
      const restored = HoldemEngine.fromState(engine);
      const seats = restored.publicState().seats;
      const ids = new Set();
      const seatNumbers = new Set();
      for (const p of room.members) {
        requireValue(
          typeof p.id === "string" &&
            identities.has(p.id) &&
            !ids.has(p.id) &&
            Number.isInteger(p.seat) &&
            p.seat >= 0 &&
            p.seat < seats.length &&
            !seatNumbers.has(p.seat) &&
            typeof p.name === "string" &&
            typeof p.ready === "boolean" &&
            typeof p.away === "boolean" &&
            typeof p.connected === "boolean" &&
            Number.isFinite(p.seenAt) &&
            [...sessions.values()].some(
              (s) => s.id === p.id && s.room === room.code,
            ),
          "保存的房间成员引用无效",
          503,
        );
        if (p.away) {
          requireValue(
            Number.isSafeInteger(p.parkedStack) &&
              p.parkedStack >= 0 &&
              !p.ready &&
              (p.parkedStack > 0
                ? seats[p.seat] === null
                : seats[p.seat]?.stack === 0),
            "保存的暂离座位无效",
            503,
          );
        } else {
          requireValue(seats[p.seat] !== null, "保存的座位无效", 503);
        }
        ids.add(p.id);
        seatNumbers.add(p.seat);
      }
      requireValue(
        seatNumbers.has(room.host) &&
          seats.every((seat, index) => !seat || seatNumbers.has(index)),
        "保存的房主或座位引用无效",
        503,
      );
      rooms.set(room.code, { ...structuredClone(room), engine: restored });
    }
    for (const session of sessions.values())
      requireValue(
        session.room === null ||
          rooms.get(session.room)?.members.some((p) => p.id === session.id),
        "保存的玩家房间引用无效",
        503,
      );
    this.rooms = rooms;
    this.sessions = sessions;
    this.chatTimes.clear();
  }

  transaction(operation) {
    if (this.storageFault)
      throw new GameError(
        "存储提交状态不确定，请重启服务恢复牌局",
        503,
        "STORAGE_FAULT",
      );
    if (this.depth) return operation();
    const before = this.storage ? this.exportState() : null;
    this.depth = 1;
    this.dirty = false;
    this.notify = false;
    try {
      const result = operation();
      if (this.dirty && this.storage) this.storage.save(this.exportState());
      this.depth = 0;
      if (this.notify) this.emit("change");
      return result;
    } catch (error) {
      this.depth = 0;
      if (error.committed) {
        this.storageFault = true;
        error.status = 503;
        error.code = "COMMIT_UNCERTAIN";
        this.emit("storage-error");
      } else if (before) {
        this.restoreState(before);
      }
      this.notify = false;
      throw error;
    }
  }

  close() {
    this.storage?.close();
  }

  createSession() {
    return this.transaction(() => this._createSession());
  }

  _createSession() {
    this.cleanup();
    requireValue(this.sessions.size < 2000, "服务繁忙，请稍后再试", 503);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      id: randomUUID(),
      room: null,
      seenAt: this.now(),
      requests: new Map(),
    });
    this.dirty = true;
    return { token };
  }

  session(token) {
    const session = this.sessions.get(token);
    requireValue(session, "玩家会话已失效，请重新连接", 401);
    session.seenAt = this.now();
    this.dirty = true;
    const room = this.rooms.get(session.room);
    const member = room && this.member(room, session);
    if (member) {
      member.seenAt = session.seenAt;
      if (!member.connected) {
        member.connected = true;
        this.changed(room, false);
      }
    }
    return session;
  }

  roomFor(session, code) {
    code = String(code).toUpperCase();
    const room = this.rooms.get(code);
    requireValue(room, "房间不存在或已过期", 404);
    requireValue(
      session.room === code && room.members.some((p) => p.id === session.id),
      "你尚未加入这个房间",
      403,
    );
    return room;
  }

  member(room, session) {
    return room.members.find((p) => p.id === session.id);
  }

  log(room, text, detail = {}) {
    room.events.push({
      id: randomUUID(),
      at: this.now(),
      hand: room.hand,
      phase: room.engine.publicState().phase,
      text,
      ...detail,
    });
    if (room.events.length > 60) room.events.shift();
  }

  changed(room, resetDeadline = true) {
    this.dirty = true;
    this.notify = true;
    room.revision += 1;
    room.updatedAt = this.now();
    const state = room.engine.publicState();
    if (resetDeadline)
      room.deadline = state.inProgress ? this.now() + this.turnMs : null;
    if (!state.inProgress && state.result && room.completedHand !== room.hand) {
      room.completedHand = room.hand;
      room.members.forEach((p) => (p.ready = false));
      room.history.unshift({
        hand: room.hand,
        board: state.board,
        result: state.result,
        players: room.members.map(({ seat, name }) => ({ seat, name })),
      });
      room.history = room.history.slice(0, 10);
      this.log(room, `第 ${room.hand} 手结束`);
    }
  }

  tick() {
    if (!this.storageFault) {
      const now = this.now();
      const due = [...this.rooms.values()].some(
        (room) =>
          (room.deadline !== null && now >= room.deadline) ||
          room.members.some(
            (p) =>
              (p.connected && now - p.seenAt >= this.onlineMs) ||
              (room.deadline === null &&
                now - p.seenAt >= (p.away ? this.reconnectMs : this.idleMs)),
          ) ||
          (room.deadline === null &&
            room.members.find((p) => p.seat === room.host)?.away &&
            room.members.some((p) => !p.away)),
      );
      // Do not clone every saved retry response four times per second when
      // no game deadline or presence transition is due.
      if (!due) return;
    }
    return this.transaction(() => this._tick());
  }

  _tick() {
    for (const room of this.rooms.values()) {
      const state = room.engine.publicState();
      for (const member of room.members) {
        if (member.connected && this.now() - member.seenAt >= this.onlineMs) {
          member.connected = false;
          this.changed(room, false);
        }
      }
      if (!state.inProgress) {
        for (const member of [...room.members]) {
          const idle = this.now() - member.seenAt;
          if (idle >= this.reconnectMs) {
            this.removeMember(room, member, "重连保留时间已到，已离席");
          } else if (idle >= this.idleMs && !member.away) {
            member.parkedStack = state.seats[member.seat]?.stack ?? 0;
            if (member.parkedStack > 0) room.engine.remove(member.seat);
            member.away = true;
            member.ready = false;
            room.showdownOnSeats = false;
            this.log(room, `${member.name} 暂离，座位与筹码保留 30 分钟`);
            this.changed(room, false);
          }
        }
        const host = room.members.find((p) => p.seat === room.host);
        if (host?.away) {
          const next = room.members.find((p) => !p.away);
          if (next) {
            room.host = next.seat;
            this.log(room, `${next.name} 接任房主`);
            this.changed(room, false);
          }
        }
        continue;
      }
      if (room.deadline === null || this.now() < room.deadline) continue;
      const action = state.legal.actions.includes("check") ? "check" : "fold";
      room.engine.act(state.actor, action);
      const player = room.members.find((p) => p.seat === state.actor);
      player.lastAction = {
        action,
        amount: null,
        at: this.now(),
        timeout: true,
        hand: room.hand,
        phase: state.phase,
      };
      this.log(
        room,
        `${player.name} 超时${action === "check" ? "过牌" : "弃牌"}`,
        {
          seat: player.seat,
          name: player.name,
          phase: state.phase,
          action: player.lastAction,
        },
      );
      this.changed(room);
    }
  }

  removeMember(room, member, reason = "离开房间") {
    if (!member.away || member.parkedStack === 0)
      room.engine.remove(member.seat);
    room.members = room.members.filter((p) => p.id !== member.id);
    room.showdownOnSeats = false;
    for (const session of this.sessions.values())
      if (session.id === member.id) session.room = null;
    if (room.host === member.seat)
      room.host =
        (room.members.find((p) => !p.away) || room.members[0])?.seat ?? null;
    this.log(room, `${member.name} ${reason}`);
    this.changed(room);
    if (!room.members.length) this.rooms.delete(room.code);
  }

  cleanup() {
    return this.transaction(() => this._cleanup());
  }

  _cleanup() {
    const cutoff = this.now() - 6 * 60 * 60 * 1000;
    for (const [code, room] of this.rooms) {
      if (
        room.updatedAt < cutoff &&
        room.members.every((p) => p.seenAt < cutoff) &&
        !room.engine.publicState().inProgress
      ) {
        this.rooms.delete(code);
        this.dirty = this.notify = true;
        for (const s of this.sessions.values())
          if (s.room === code) s.room = null;
      }
    }
    for (const [token, s] of this.sessions) {
      if (!s.room && s.seenAt < cutoff) {
        this.sessions.delete(token);
        this.dirty = true;
      }
    }
  }

  snapshot(session, room) {
    const me = this.member(room, session);
    const state = room.engine.publicState();
    return {
      room: room.code,
      revision: room.revision,
      chatRevision: room.chatRevision,
      hand: room.hand,
      host: room.host,
      me: me.seat,
      config: room.config,
      inviteBaseUrl: this.inviteBaseUrl,
      ...state,
      showdownOnSeats: room.showdownOnSeats,
      legal: state.actor === me.seat ? state.legal : { actions: [] },
      players: room.members.map((p) => ({
        seat: p.seat,
        name: p.name,
        ready: p.ready,
        connected: p.connected,
        away: p.away,
        lastAction: p.lastAction ?? null,
        reconnectUntil: p.away ? p.seenAt + this.reconnectMs : null,
        ...(p.away
          ? { stack: p.parkedStack, bet: 0, folded: false, inHand: false }
          : state.seats[p.seat]),
      })),
      holeCards: room.engine.holeCards(me.seat),
      deadline: room.deadline,
      serverTime: this.now(),
      events: room.events,
      chat: room.chat,
      history: room.history,
    };
  }

  execute(token, operation, input = {}) {
    return this.transaction(() => this._execute(token, operation, input));
  }

  _execute(token, operation, input = {}) {
    this.tick();
    const session = this.session(token);
    requireValue(
      input && typeof input === "object" && !Array.isArray(input),
      "无效请求",
    );
    const read = operation === "get_table_state";
    const key = input.requestId;
    const fingerprint = JSON.stringify([operation, input]);
    if (!read) {
      requireValue(
        typeof key === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(key),
        "操作必须包含唯一 requestId",
      );
      const old = session.requests.get(key);
      if (old) {
        requireValue(
          old.fingerprint === fingerprint,
          "requestId 已用于不同操作",
          409,
        );
        return structuredClone(old.value);
      }
    }
    let value;
    if (operation === "create_room") {
      requireValue(!session.room, "请先离开当前房间");
      requireValue(this.rooms.size < 200, "房间数量已达上限", 503);
      const name = nickname(input.name);
      const config = {
        smallBlind: 10,
        bigBlind: 20,
        buyIn: 2000,
        maxPlayers: 6,
      };
      let code;
      do {
        code = randomBytes(4).toString("hex").toUpperCase();
      } while (this.rooms.has(code));
      const engine = new HoldemEngine(config);
      engine.sit(0, config.buyIn);
      const room = {
        code,
        config,
        engine,
        host: 0,
        members: [
          {
            id: session.id,
            seat: 0,
            name,
            ready: false,
            seenAt: this.now(),
            connected: true,
            away: false,
            lastAction: null,
          },
        ],
        showdownOnSeats: false,
        revision: 1,
        chatRevision: 0,
        hand: 0,
        completedHand: 0,
        deadline: null,
        updatedAt: this.now(),
        events: [],
        history: [],
        chat: [],
      };
      this.rooms.set(code, room);
      this.dirty = this.notify = true;
      session.room = code;
      this.log(room, `${name} 创建房间`);
      value = this.snapshot(session, room);
    } else if (operation === "join_room") {
      requireValue(!session.room, "请先离开当前房间");
      const room = this.rooms.get(String(input.room || "").toUpperCase());
      requireValue(room, "房间不存在或已过期", 404);
      requireValue(
        !room.engine.publicState().inProgress,
        "本手进行中，请结算后加入",
      );
      requireValue(room.members.length < 6, "房间已满");
      const name = nickname(input.name);
      requireValue(
        !room.members.some((p) => p.name === name),
        "房间中已有此昵称",
      );
      const seat = Array.from({ length: 6 }, (_, i) => i).find(
        (i) => !room.members.some((p) => p.seat === i),
      );
      room.engine.sit(seat, room.config.buyIn);
      room.members.push({
        id: session.id,
        seat,
        name,
        ready: false,
        seenAt: this.now(),
        connected: true,
        away: false,
        lastAction: null,
      });
      room.showdownOnSeats = false;
      session.room = room.code;
      this.log(room, `${name} 加入房间`);
      this.changed(room);
      value = this.snapshot(session, room);
    } else if (
      operation === "get_table_state" &&
      !session.room &&
      !input.room
    ) {
      value = { room: null, serverTime: this.now() };
    } else {
      const room = this.roomFor(session, input.room || session.room);
      const me = this.member(room, session);
      const state = room.engine.publicState();
      if (
        [
          "player_action",
          "start_game",
          "set_ready",
          "set_away",
          "transfer_host",
          "leave_room",
          "rebuy",
          "resume_seat",
        ].includes(operation)
      ) {
        requireValue(
          Number.isInteger(input.revision) && input.revision === room.revision,
          "牌桌状态已变化，请刷新后重试",
          409,
        );
      }
      switch (operation) {
        case "get_table_state":
          break;
        case "send_chat": {
          const text = chatMessage(input.text);
          const now = this.now();
          requireValue(
            now - (this.chatTimes.get(session.id) ?? -Infinity) >= 1000,
            "发言过快，请稍后再试",
            429,
          );
          this.chatTimes.set(session.id, now);
          room.chat.push({
            id: randomUUID(),
            at: now,
            seat: me.seat,
            name: me.name,
            text,
          });
          if (room.chat.length > 50) room.chat.shift();
          room.chatRevision += 1;
          room.updatedAt = now;
          this.dirty = this.notify = true;
          break;
        }
        case "set_ready":
          requireValue(!state.inProgress, "请等待本手结束");
          requireValue(!me.away, "请先恢复入座");
          requireValue(typeof input.ready === "boolean", "ready 必须为布尔值");
          requireValue(
            state.seats[me.seat].stack > 0,
            "筹码不足，请先补充虚拟筹码",
          );
          me.ready = input.ready;
          this.changed(room);
          break;
        case "set_away":
          requireValue(!state.inProgress, "请等待本手结束");
          requireValue(!me.away, "你已经暂离");
          me.parkedStack = state.seats[me.seat]?.stack ?? 0;
          if (me.parkedStack > 0) room.engine.remove(me.seat);
          me.away = true;
          me.ready = false;
          room.showdownOnSeats = false;
          this.log(room, `${me.name} 暂离，座位与筹码保留 30 分钟`);
          if (room.host === me.seat) {
            const next = room.members.find((p) => !p.away);
            if (next) {
              room.host = next.seat;
              this.log(room, `${next.name} 接任房主`);
            }
          }
          this.changed(room);
          break;
        case "transfer_host": {
          requireValue(!state.inProgress, "请等待本手结束");
          requireValue(me.seat === room.host, "只有房主能转移房主权限", 403);
          requireValue(
            Number.isInteger(input.seat) && input.seat >= 0 && input.seat < 6,
            "目标座位无效",
          );
          const target = room.members.find((p) => p.seat === input.seat);
          requireValue(target, "目标玩家不在房间内", 404);
          requireValue(target.seat !== me.seat, "请选择另一位玩家");
          requireValue(!target.away, "暂离玩家不能成为房主");
          room.host = target.seat;
          this.log(room, `${target.name} 接任房主`);
          this.changed(room);
          break;
        }
        case "start_game": {
          requireValue(me.seat === room.host, "只有房主能开局", 403);
          requireValue(!state.inProgress, "本手尚未结束");
          const funded = room.members.filter(
            (p) => !p.away && state.seats[p.seat].stack > 0,
          );
          requireValue(funded.length >= 2, "至少需要两名有筹码的玩家");
          requireValue(
            funded.every((p) => p.ready),
            "等待所有有筹码的玩家准备",
          );
          room.engine.start();
          room.showdownOnSeats = true;
          room.hand += 1;
          room.members.forEach((player) => (player.lastAction = null));
          this.log(room, `第 ${room.hand} 手开始 · 盲注 10 / 20`);
          this.changed(room);
          break;
        }
        case "player_action":
          requireValue(
            state.inProgress && state.actor === me.seat,
            "还没轮到你行动",
            409,
          );
          const actionAmount =
            input.action === "call" ? state.legal.call : (input.amount ?? null);
          room.engine.act(me.seat, input.action, input.amount);
          me.lastAction = {
            action: input.action,
            amount: actionAmount,
            at: this.now(),
            hand: room.hand,
            phase: state.phase,
          };
          this.log(
            room,
            `${me.name} ${input.action}${input.amount === undefined ? "" : ` ${input.amount}`}`,
            {
              seat: me.seat,
              name: me.name,
              phase: state.phase,
              action: me.lastAction,
            },
          );
          this.changed(room);
          break;
        case "rebuy":
          requireValue(!state.inProgress, "请等待本手结束");
          requireValue(!me.away, "请先恢复入座");
          requireValue(
            state.seats[me.seat].stack === 0,
            "仅在筹码耗尽后可补充",
          );
          room.engine.remove(me.seat);
          room.engine.sit(me.seat, room.config.buyIn);
          me.ready = false;
          this.log(room, `${me.name} 补充 2000 虚拟筹码`);
          this.changed(room);
          break;
        case "resume_seat":
          requireValue(!state.inProgress, "请等待本手结束再恢复入座");
          requireValue(me.away, "你已经在座位上");
          // Busted seats stay empty; returning never silently grants chips.
          if (me.parkedStack > 0) room.engine.sit(me.seat, me.parkedStack);
          this.log(room, `${me.name} 恢复入座`);
          me.away = false;
          delete me.parkedStack;
          me.ready = false;
          this.changed(room);
          break;
        case "leave_room":
          requireValue(
            !state.inProgress,
            "本手结束后可离开；离线时由计时器自动过牌或弃牌",
          );
          this.removeMember(room, me);
          value = { room: null, serverTime: this.now() };
          break;
        default:
          throw new GameError("未知操作", 404);
      }
      value ??= this.snapshot(session, room);
    }
    // Cache detached snapshots: later mutations must not alter a retry response.
    if (!read) {
      this.dirty = true;
      session.requests.set(key, { fingerprint, value: structuredClone(value) });
      if (session.requests.size > 128)
        session.requests.delete(session.requests.keys().next().value);
    }
    return structuredClone(value);
  }
}

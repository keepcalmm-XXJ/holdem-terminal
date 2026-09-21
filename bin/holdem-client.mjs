import { requestId } from "./holdem-lib.mjs";

export class TerminalClient {
  constructor({ session, onChange = () => {}, now = Date.now }) {
    this.session = session;
    this.onChange = onChange;
    this.now = now;
    this.state = undefined;
    this.connection = "connecting";
    this.lastSuccessAt = null;
    this.lastError = "";
    this.clockOffset = 0;
    this.busy = false;
    this.pending = null;
    this.closed = false;
    this.generation = 0;
    this.poll = null;
  }

  serverNow() {
    return this.now() + this.clockOffset;
  }

  context() {
    const state = this.state;
    return state
      ? {
          room: state.room,
          revision: state.revision,
          hand: state.hand,
          phase: state.phase,
          actor: state.actor,
        }
      : null;
  }

  changed() {
    if (!this.closed) this.onChange();
  }

  accept(next, { syncClock = true } = {}) {
    this.connection = "online";
    this.lastError = "";
    this.lastSuccessAt = this.now();
    const current = this.state;
    if (
      current?.room &&
      current.room === next.room &&
      (next.revision < current.revision ||
        (next.chatRevision ?? 0) < (current.chatRevision ?? 0))
    ) {
      this.changed();
      return false;
    }
    if (syncClock && Number.isFinite(next.serverTime))
      this.clockOffset = next.serverTime - this.lastSuccessAt;
    this.state = next;
    this.changed();
    return true;
  }

  failed(error) {
    this.connection = "offline";
    this.lastError = error.message;
    if (error.status === 401) {
      this.state = undefined;
      this.pending = null;
    }
    this.changed();
  }

  async refresh() {
    if (this.closed || this.busy) return this.state;
    if (this.poll) return this.poll;
    const generation = this.generation;
    const poll = (async () => {
      try {
        const next = await this.session.state();
        if (!this.closed && generation === this.generation) this.accept(next);
        return this.state;
      } catch (error) {
        if (!this.closed && generation === this.generation) {
          this.failed(error);
          throw error;
        }
        return this.state;
      }
    })();
    this.poll = poll;
    try {
      return await poll;
    } finally {
      if (this.poll === poll) this.poll = null;
    }
  }

  async mutate(operation, extras = {}, expected = this.context()) {
    if (this.closed) throw new Error("终端已关闭");
    if (this.busy) throw new Error("上一项操作尚未完成，请稍候");
    if (this.pending)
      throw new Error("上一项操作结果待确认，请输入 retry 核实原请求");
    this.busy = true;
    // Invalidate reads started before this command, including another room's state.
    this.generation += 1;
    this.changed();
    try {
      if (!this.state || this.connection !== "online") {
        try {
          this.accept(await this.session.state());
        } catch (error) {
          this.failed(error);
          throw error;
        }
      }
      if (this.closed) return;
      if (
        operation === "player_action" &&
        (!expected ||
          JSON.stringify(expected) !== JSON.stringify(this.context()))
      )
        throw new Error("输入期间牌局已变化，请核对当前牌桌后重新输入动作");
      this.pending = {
        operation,
        state: this.state,
        extras,
        id: requestId(),
        identity: this.session.token,
        uncertain: false,
      };
      return await this.sendPending();
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async retry() {
    if (this.closed) throw new Error("终端已关闭");
    if (this.busy) throw new Error("上一项操作尚未完成，请稍候");
    if (!this.pending) throw new Error("没有待确认的操作");
    if (this.session.token !== this.pending.identity) {
      this.pending = null;
      throw new Error("玩家身份已变化，无法重试原操作");
    }
    this.busy = true;
    this.generation += 1;
    this.changed();
    try {
      return await this.sendPending();
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async sendPending() {
    const {
      operation,
      state,
      extras,
      id,
      uncertain: wasUncertain,
    } = this.pending;
    try {
      const next = await this.session.mutate(operation, state, extras, id);
      this.pending = null;
      if (!this.closed) this.accept(next, { syncClock: !wasUncertain });
      return next;
    } catch (error) {
      const uncertain =
        !error.status ||
        ["COMMIT_UNCERTAIN", "STORAGE_FAULT"].includes(error.code);
      if (!uncertain) this.pending = null;
      else this.pending.uncertain = true;
      if (uncertain || error.status === 401 || error.status >= 500)
        this.failed(error);
      if (uncertain) {
        const failure = new Error(
          "操作结果待确认，请输入 retry 核实原请求；不会自动重复下注",
          { cause: error },
        );
        failure.code = "ACTION_UNCERTAIN";
        throw failure;
      }
      throw error;
    }
  }

  close() {
    this.closed = true;
    this.generation += 1;
    this.session.close?.();
  }
}

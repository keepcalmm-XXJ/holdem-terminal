import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = fileURLToPath(new URL("../", import.meta.url));

async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "holdem-process-restart-"),
  );
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const children = [];
  const running = (record) =>
    record.child.exitCode === null && record.child.signalCode === null;

  async function stop(record, signal = "SIGTERM") {
    if (running(record)) record.child.kill(signal);
    return deadline(record.exited, 5000, "Owned game server did not stop");
  }
  t.after(async () => {
    try {
      for (const record of children) {
        if (!running(record)) continue;
        try {
          await stop(record);
        } catch {
          // Only this test's still-owned child can reach the forced cleanup.
          record.child.kill("SIGKILL");
          await deadline(record.exited, 5000, "Owned child cleanup failed");
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function start() {
    const child = spawn(process.execPath, ["server/http.mjs"], {
      cwd: project,
      env: {
        ...process.env,
        HOLDEM_HOST: "127.0.0.1",
        HOLDEM_PORT: String(port),
        HOLDEM_DATA_DIR: directory,
        HOLDEM_EPHEMERAL: "0",
        HOLDEM_PUBLIC_URL: "",
        HOLDEM_ALLOWED_HOSTS: "",
      },
      // Private session contents and server output never enter test reports.
      stdio: "ignore",
    });
    let spawnFailed = false;
    child.on("error", () => {
      spawnFailed = true;
    });
    const record = {
      child,
      exited: new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      ),
    };
    children.push(record);
    const expires = Date.now() + 8000;
    while (Date.now() < expires) {
      assert.equal(spawnFailed, false, "Game server child must spawn");
      assert.equal(running(record), true, "Game server exited during startup");
      try {
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          assert.deepEqual(await response.json(), {
            service: "codex-holdem",
            version: "0.2.0",
          });
          return record;
        }
      } catch {
        // The port is expected to be unavailable until the owned child listens.
      }
      await delay(40);
    }
    throw new Error("Owned game server did not become healthy");
  }

  async function post(operation, data = {}, token) {
    const response = await fetch(`${base}/api/${operation}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, operation === "session" ? 201 : 200);
    return response.json();
  }
  const view = (token) => post("get_table_state", {}, token);
  async function command(token, operation, data = {}) {
    const state = await view(token);
    return post(
      operation,
      {
        revision: state.revision,
        requestId: randomUUID(),
        ...data,
      },
      token,
    );
  }
  return { directory, start, stop, post, view, command };
}

for (const signal of ["SIGTERM", "SIGKILL"]) {
  const mode =
    signal === "SIGTERM" ? "graceful restart" : "owned-process crash";
  test(`CLI ${mode} restores private hand state and durable action idempotency`, async (t) => {
    const game = await fixture(t);
    let child = await game.start();
    const alice = (await game.post("session")).token;
    const bob = (await game.post("session")).token;
    const room = (
      await game.command(alice, "create_room", { name: "Restart Alice" })
    ).room;
    await game.command(bob, "join_room", { name: "Restart Bob", room });
    await game.command(alice, "set_ready", { ready: true });
    await game.command(bob, "set_ready", { ready: true });
    await game.command(alice, "start_game");
    const firstView = await game.view(alice);
    assert.equal(firstView.actor, 0);
    const action = {
      room,
      action: "call",
      revision: firstView.revision,
      requestId: randomUUID(),
    };
    const acknowledged = await game.post("player_action", action, alice);
    const beforeAlice = await game.view(alice);
    const beforeBob = await game.view(bob);
    const commitment = (state) =>
      state.players.map(({ seat, name, stack, bet, folded, inHand }) => ({
        seat,
        name,
        stack,
        bet,
        folded,
        inHand,
      }));
    assert.equal(beforeAlice.actor, 1);
    assert.equal(beforeAlice.pot, 40);
    assert.equal(beforeAlice.holeCards.length, 2);
    assert.equal(beforeBob.holeCards.length, 2);
    const stateFile = join(game.directory, "state.json");
    const lock = `${stateFile}.lock`;
    assert.equal(existsSync(stateFile), true);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    const exit = await game.stop(child, signal);
    if (signal === "SIGTERM") {
      assert.equal(exit.code, 0);
      assert.equal(existsSync(lock), false);
    } else {
      assert.equal(exit.signal, "SIGKILL");
      assert.equal(existsSync(lock), true);
    }

    child = await game.start();
    // Reuse the exact credentials, with no session-create or room-join request.
    const restoredAlice = await game.view(alice);
    const restoredBob = await game.view(bob);
    for (const [before, after] of [
      [beforeAlice, restoredAlice],
      [beforeBob, restoredBob],
    ]) {
      assert.equal(after.room, room);
      assert.equal(after.me, before.me);
      assert.equal(after.actor, before.actor);
      assert.equal(after.phase, before.phase);
      assert.equal(after.hand, before.hand);
      assert.equal(after.pot, before.pot);
      assert.deepEqual(after.holeCards, before.holeCards);
      assert.deepEqual(after.board, before.board);
      assert.deepEqual(after.legal, before.legal);
      assert.deepEqual(commitment(after), commitment(before));
      assert.ok(after.deadline >= before.deadline);
    }
    const beforeRetry = await game.view(alice);
    const repeated = await game.post("player_action", action, alice);
    assert.deepEqual(repeated, acknowledged);
    const afterRetry = await game.view(alice);
    assert.equal(afterRetry.revision, beforeRetry.revision);
    assert.deepEqual(commitment(afterRetry), commitment(beforeRetry));
    assert.deepEqual(afterRetry.events, beforeRetry.events);
    assert.equal(afterRetry.actor, 1);

    // A fresh legal action proves the reconstructed live engine can continue.
    await game.command(bob, "player_action", { action: "check" });
    const continued = await game.view(alice);
    assert.equal(continued.phase, "flop");
    assert.equal(continued.board.length, 3);
    assert.deepEqual(continued.holeCards, beforeAlice.holeCards);
    const finalExit = await game.stop(child);
    assert.equal(finalExit.code, 0);
    assert.equal(existsSync(lock), false);
  });
}

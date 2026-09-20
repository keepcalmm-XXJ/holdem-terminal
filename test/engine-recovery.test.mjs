import test from "node:test";
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { HoldemEngine } from "../server/engine.mjs";

const restore = (game) =>
  HoldemEngine.fromState(JSON.parse(JSON.stringify(game.exportState())));

function create(stacks = [1000, 1000, 1000]) {
  const game = new HoldemEngine();
  stacks.forEach((stack, seat) => game.sit(seat, stack));
  game.start();
  return game;
}

function same(left, right) {
  assert.deepEqual(right.publicState(), left.publicState());
  for (let seat = 0; seat < left.publicState().seats.length; seat++)
    assert.deepEqual(right.holeCards(seat), left.holeCards(seat));
}

function finishTogether(left, right) {
  let count = 0;
  while (left.publicState().inProgress) {
    assert.ok(++count < 50);
    const { actor, legal } = left.publicState();
    const action = legal.actions.includes("check") ? "check" : "call";
    left.act(actor, action);
    right.act(actor, action);
    same(left, right);
  }
}

function reseal(snapshot) {
  snapshot.checksum = createHash("sha256")
    .update(JSON.stringify(snapshot.state))
    .digest("hex");
  return snapshot;
}

test("recovery handles empty and partially occupied waiting tables", () => {
  const game = new HoldemEngine({ maxPlayers: 4, smallBlind: 5, bigBlind: 10 });
  same(game, restore(game));
  game.sit(3, 100);
  game.sit(1, 200);
  const recovered = restore(game);
  assert.deepEqual(recovered.exportState(), game.exportState());
  same(game, recovered);
  game.start();
  recovered.start();
  assert.equal(game.publicState().button, 1);
  assert.equal(recovered.publicState().button, 1);
});

test("midhand recovery preserves private cards, undealt deck and each subsequent action", () => {
  const game = create();
  game.act(0, "raise", 80);
  game.act(1, "fold");
  game.act(2, "call");
  game.act(2, "bet", 40);
  const recovered = restore(game);
  same(game, recovered);
  finishTogether(game, recovered);
  assert.deepEqual(recovered.exportState(), game.exportState());
  same(game, restore(recovered));
});

test("short all-in reopening restrictions survive replay and illegal actions do not enter the log", () => {
  const game = create([500, 130, 500]);
  game.act(0, "raise", 100);
  game.act(1, "all-in");
  game.act(2, "call");
  const recovered = restore(game);
  same(game, recovered);
  assert.deepEqual(recovered.publicState().legal.actions.sort(), [
    "call",
    "fold",
  ]);
  const before = recovered.exportState();
  assert.throws(() => recovered.act(0, "raise", 210), /not legal/);
  assert.deepEqual(recovered.exportState(), before);
  finishTogether(game, recovered);
});

test("cumulative all-in reopening and previous-street pot eligibility survive replay", () => {
  const game = create([130, 180, 500, 500]);
  game.act(3, "raise", 100);
  game.act(0, "all-in");
  game.act(1, "all-in");
  game.act(2, "call");
  let recovered = restore(game);
  same(game, recovered);
  assert.ok(recovered.publicState().legal.actions.includes("raise"));
  game.act(3, "call");
  recovered.act(3, "call");
  recovered = restore(recovered);
  same(game, recovered);
  game.act(2, "bet", 50);
  recovered.act(2, "bet", 50);
  finishTogether(game, recovered);
});

test("completed checkpoints compact hand logs and preserve button rotation over multiple hands", () => {
  let game = create();
  for (let hand = 0; hand < 30; hand++) {
    assert.equal(game.publicState().button, hand % 3);
    const recovered = restore(game);
    finishTogether(game, recovered);
    const checkpoint = recovered.exportState();
    assert.equal(checkpoint.state.hand, null);
    assert.ok(JSON.stringify(checkpoint).length < 5000);
    game = restore(recovered);
    same(recovered, game);
    if (hand < 29) game.start();
  }
});

test("folded, busted, removed and reused seats survive completed checkpoints", () => {
  const originalRandom = crypto.randomInt;
  let game;
  try {
    crypto.randomInt = () => 0;
    syncBuiltinESMExports();
    game = create([5, 10]);
  } finally {
    crypto.randomInt = originalRandom;
    syncBuiltinESMExports();
  }
  assert.equal(game.publicState().phase, "complete");
  let recovered = restore(game);
  same(game, recovered);
  const busted = game
    .publicState()
    .seats.findIndex((seat) => seat?.stack === 0);
  assert.notEqual(busted, -1);
  assert.throws(() => recovered.sit(busted, 100), /occupied/);
  game.remove(busted);
  recovered.remove(busted);
  same(game, recovered);
  game.sit(busted, 100);
  recovered.sit(busted, 100);
  recovered = restore(recovered);
  same(game, recovered);
  assert.deepEqual(recovered.holeCards(busted), []);
  game.start();
  const next = restore(game);
  game.act(game.publicState().actor, "fold");
  next.act(next.publicState().actor, "fold");
  same(game, restore(next));
});

test("server-only snapshots never become part of public state and exports are detached", () => {
  const game = create();
  const original = game.publicState();
  const snapshot = game.exportState();
  assert.equal(snapshot.state.hand.deck.length, 52);
  snapshot.state.hand.deck[0][0] = 99;
  snapshot.state.checkpoint.stacks[0] = 0;
  assert.deepEqual(game.publicState(), original);
  const publicJSON = JSON.stringify(game.publicState());
  for (const privateKey of ["checkpoint", "deck", "checksum", "hole"])
    assert.equal(publicJSON.includes(`"${privateKey}"`), false);
  assert.equal(game.exportState().state.checkpoint.stacks[0], 1000);
});

test("recovery rejects corrupted, malformed and impossible snapshots", () => {
  const game = create();
  assert.throws(() => HoldemEngine.fromState(null), /Invalid engine recovery/);
  for (const mutate of [
    (snapshot) => {
      snapshot.format = "unknown";
    },
    (snapshot) => {
      snapshot.checksum = "0".repeat(64);
    },
    (snapshot) => {
      snapshot.state.checkpoint.stacks[0]++;
    },
    (snapshot) => {
      snapshot.state.hand.deck[0] = snapshot.state.hand.deck[1];
      reseal(snapshot);
    },
    (snapshot) => {
      snapshot.state.hand.actions.push({ seat: 5, action: "fold" });
      reseal(snapshot);
    },
    (snapshot) => {
      snapshot.state.config.maxPlayers = 3;
      reseal(snapshot);
    },
    (snapshot) => {
      snapshot.state.checkpoint.stacks[0] = -1;
      reseal(snapshot);
    },
    (snapshot) => {
      snapshot.state.hand.actions = Array.from({ length: 100_001 }, () => ({
        seat: 0,
        action: "check",
      }));
      reseal(snapshot);
    },
  ]) {
    const snapshot = game.exportState();
    mutate(snapshot);
    assert.throws(
      () => HoldemEngine.fromState(snapshot),
      /Invalid engine recovery snapshot/,
    );
  }
});

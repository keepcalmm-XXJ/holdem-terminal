import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { Table } from "poker-ts";
import { HoldemEngine } from "../server/engine.mjs";

function fixedShuffle(callback, randomInt = () => 0) {
  const original = crypto.randomInt;
  try {
    crypto.randomInt = randomInt;
    syncBuiltinESMExports();
    callback();
  } finally {
    crypto.randomInt = original;
    syncBuiltinESMExports();
  }
}

function create(stacks = [1000, 1000], options) {
  const game = new HoldemEngine(options);
  stacks.forEach((chips, seat) => game.sit(seat, chips));
  game.start();
  return game;
}

function passiveFinish(game) {
  let count = 0;
  while (game.publicState().inProgress) {
    assert.ok(count++ < 50, "Hand must terminate");
    const state = game.publicState();
    game.act(
      state.actor,
      state.legal.actions.includes("check") ? "check" : "call",
    );
  }
  return game.publicState();
}

const total = (state) =>
  state.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0), 0);

test("heads-up button posts small blind and acts first preflop, last postflop", () => {
  const game = create();
  let state = game.publicState();
  assert.equal(state.button, 0);
  assert.equal(state.actor, 0);
  assert.equal(state.seats[0].bet, 10);
  assert.equal(state.seats[1].bet, 20);
  assert.equal(state.pot, 30);
  assert.equal(state.legal.call, 10);
  assert.equal(state.legal.min, 40);
  game.act(0, "call");
  game.act(1, "check");
  state = game.publicState();
  assert.equal(state.phase, "flop");
  assert.equal(state.actor, 1);
  assert.equal(state.board.length, 3);
  passiveFinish(game);
  game.start();
  assert.equal(game.publicState().button, 1);
  assert.equal(game.publicState().actor, 1);
});

test("passive hand advances streets, settles, and preserves result", () => {
  const game = create();
  const state = passiveFinish(game);
  assert.equal(state.phase, "complete");
  assert.equal(state.board.length, 5);
  assert.equal(state.actor, null);
  assert.deepEqual(state.legal, { actions: [] });
  assert.equal(state.result.pot, 40);
  assert.equal(
    state.result.payouts.reduce((sum, value) => sum + value.amount, 0),
    40,
  );
  assert.equal(total(state), 2000);
  assert.equal(state.result.showdown.length, 2);
  assert.equal(game.holeCards(0).length, 2);
  assert.deepEqual(game.publicState(), state);
});

test("uncontested winner and folded hands are never revealed publicly", () => {
  const game = create();
  const mine = game.holeCards(0);
  const state = game.act(0, "fold");
  assert.equal(state.phase, "complete");
  assert.equal(state.board.length, 0);
  assert.deepEqual(state.result.showdown, []);
  assert.deepEqual(state.result.winners, [1]);
  assert.equal(total(state), 2000);
  assert.equal(state.seats[0].stack, 990);
  assert.equal(state.seats[1].stack, 1010);
  assert.equal(state.result.pot, 30);
  assert.equal(JSON.stringify(state).includes('"rank"'), false);
  mine[0].rank = "INVALID";
  assert.notEqual(game.holeCards(0)[0].rank, "INVALID");
});

test("three-way unequal all-ins build main and side pots and conserve chips", () => {
  const game = create([100, 200, 300]);
  game.act(0, "all-in");
  game.act(1, "all-in");
  const state = game.act(2, "all-in");
  assert.equal(state.phase, "complete");
  assert.equal(state.board.length, 5);
  assert.deepEqual(state.pots, [
    { size: 300, eligiblePlayers: [0, 1, 2] },
    { size: 200, eligiblePlayers: [1, 2] },
    { size: 100, eligiblePlayers: [2] },
  ]);
  assert.equal(total(state), 600);
  assert.equal(
    state.result.payouts.reduce((sum, payout) => sum + payout.amount, 0),
    600,
  );
  assert.equal(state.result.showdown.length, 3);
});

test("previous-street all-in remains eligible when two others keep betting", () => {
  const game = create([50, 300, 300]);
  game.act(0, "all-in");
  game.act(1, "call");
  game.act(2, "call");
  assert.equal(game.publicState().phase, "flop");
  game.act(1, "bet", 50);
  game.act(2, "call");
  const state = passiveFinish(game);
  assert.deepEqual(state.pots, [
    { size: 150, eligiblePlayers: [0, 1, 2] },
    { size: 100, eligiblePlayers: [1, 2] },
  ]);
  assert.equal(total(state), 650);
  assert.equal(state.result.showdown.length, 3);
});

test("folded contributors are excluded from all showdown pots", () => {
  const game = create([50, 300, 300]);
  game.act(0, "all-in");
  game.act(1, "call");
  game.act(2, "call");
  game.act(1, "bet", 50);
  game.act(2, "fold");
  const state = game.publicState();
  assert.equal(state.phase, "complete");
  assert.deepEqual(state.pots, [
    { size: 150, eligiblePlayers: [0, 1] },
    { size: 50, eligiblePlayers: [1] },
  ]);
  assert.equal(total(state), 650);
  assert.deepEqual(
    state.result.showdown.map(({ seat }) => seat),
    [0, 1],
  );
  assert.ok(state.result.payouts.every(({ seat }) => seat !== 2));
});

test("reject wrong actor, invalid sizes, unexpected arguments and changes during hand", () => {
  const game = create();
  const before = game.publicState();
  assert.throws(() => game.act(1, "fold"), /not your turn/);
  assert.throws(() => game.act(0, "check"), /not legal/);
  for (const amount of [
    undefined,
    0,
    -1,
    39,
    1001,
    40.5,
    NaN,
    Infinity,
    "40",
  ]) {
    assert.throws(() => game.act(0, "raise", amount));
    assert.deepEqual(game.publicState(), before);
  }
  assert.throws(() => game.act(0, "call", 20), /Only bet and raise/);
  assert.throws(() => game.remove(0), /during a hand/);
  assert.throws(() => game.sit(2, 100), /during a hand/);
  assert.throws(() => game.start(), /already/);
  assert.deepEqual(game.publicState(), before);
});

test("raise amount is total bet-to, not incremental chips", () => {
  const game = create();
  game.act(0, "raise", 60);
  const state = game.publicState();
  assert.equal(state.seats[0].stack, 940);
  assert.equal(state.seats[0].bet, 60);
  assert.equal(state.legal.call, 40);
  assert.equal(state.legal.min, 100);
  assert.equal(state.pot, 80);
});

test("short all-in does not reopen raises or lower the last full raise", () => {
  const game = create([500, 130, 500]);
  game.act(0, "raise", 100);
  game.act(1, "all-in");
  let state = game.publicState();
  assert.equal(state.actor, 2);
  assert.equal(state.legal.min, 210);
  assert.throws(() => game.act(2, "raise", 160), /between 210/);
  game.act(2, "call");
  state = game.publicState();
  assert.equal(state.actor, 0);
  assert.deepEqual(state.legal.actions.sort(), ["call", "fold"]);
  assert.throws(() => game.act(0, "raise", 210), /not legal/);
  assert.throws(() => game.act(0, "all-in"), /not legal/);
  const result = passiveFinish(game);
  assert.equal(total(result), 1130);
});

test("a full raise following a short all-in reopens action", () => {
  const game = create([500, 130, 500]);
  game.act(0, "raise", 100);
  game.act(1, "all-in");
  game.act(2, "raise", 210);
  const state = game.publicState();
  assert.equal(state.actor, 0);
  assert.ok(state.legal.actions.includes("raise"));
  assert.equal(state.legal.min, 290);
  assert.equal(total(passiveFinish(game)), 1130);
});

test("blinds can put every player all-in immediately", () => {
  const game = create([5, 10]);
  const state = game.publicState();
  assert.equal(state.phase, "complete");
  assert.equal(state.board.length, 5);
  assert.equal(total(state), 15);
});

test("a short all-in big blind does not request a phantom call", () => {
  const game = create([963, 2]);
  const state = game.publicState();
  assert.equal(state.phase, "complete");
  assert.equal(state.board.length, 5);
  assert.equal(total(state), 965);
  assert.deepEqual(state.pots, [
    { size: 4, eligiblePlayers: [0, 1] },
    { size: 8, eligiblePlayers: [0] },
  ]);
  assert.equal(state.result.showdown.length, 2);
});

test("three players retain nominal big-blind call and minimum raise with a short big blind", () => {
  const game = create([1000, 1000, 7]);
  let state = game.publicState();
  assert.equal(state.actor, 0);
  assert.equal(state.legal.call, 20);
  assert.equal(state.legal.min, 40);
  game.act(0, "call");
  state = game.publicState();
  assert.equal(state.actor, 1);
  assert.equal(state.legal.call, 10);
  assert.equal(state.legal.min, 40);
  game.act(1, "call");
  state = game.publicState();
  assert.equal(state.phase, "flop");
  assert.equal(state.actor, 1);
  assert.equal(state.legal.call, 0);
  assert.equal(state.legal.min, 20);
  assert.deepEqual(state.pots, [
    { size: 21, eligiblePlayers: [0, 1, 2] },
    { size: 26, eligiblePlayers: [0, 1] },
  ]);
  assert.equal(total(passiveFinish(game)), 2007);
});

test("short small blind is skipped while a funded big blind keeps its option", () => {
  const game = create([1000, 3, 1000]);
  game.act(0, "call");
  const state = game.publicState();
  assert.equal(state.phase, "preflop");
  assert.equal(state.actor, 2);
  assert.ok(state.legal.actions.includes("check"));
  assert.equal(state.legal.min, 40);
  assert.equal(total(passiveFinish(game)), 2003);
});

test("busted seats remain visible but receive no cards or action next hand", () => {
  fixedShuffle(() => {
    const game = create([100, 100]);
    game.act(0, "all-in");
    let state = game.act(1, "call");
    assert.equal(state.seats[0].stack, 0);
    assert.equal(state.seats[1].stack, 200);
    assert.deepEqual(state.result.winners, [1]);
    assert.throws(() => game.start(), /At least two/);
    assert.deepEqual(game.publicState(), state);
    game.sit(2, 200);
    state = game.start();
    assert.equal(state.button, 1);
    assert.equal(state.actor, 1);
    assert.equal(state.seats[0].inHand, false);
    assert.deepEqual(game.holeCards(0), []);
    game.act(1, "fold");
    game.remove(0);
    assert.equal(game.publicState().seats[0], null);
    game.sit(0, 100);
    state = game.start();
    assert.equal(state.button, 2);
    assert.equal(game.holeCards(0).length, 2);
  });
});

test("button starts at the first occupied seat and rotates through removals and additions", () => {
  const game = new HoldemEngine();
  game.sit(4, 1000);
  game.sit(1, 1000);
  assert.equal(game.start().button, 1);
  game.act(1, "fold");
  game.remove(1);
  game.sit(2, 1000);
  assert.equal(game.start().button, 2);
  game.act(2, "fold");
  game.remove(4);
  game.sit(0, 1000);
  const state = game.start();
  assert.equal(state.button, 0);
  assert.equal(state.actor, 0);
  assert.equal(state.seats[0].bet, 10);
  assert.equal(state.seats[2].bet, 20);
});

test("a dependency rejection before execution does not change adapter tracking", (context) => {
  const game = create();
  const before = game.publicState();
  const rejected = context.mock.method(Table.prototype, "actionTaken", () => {
    throw new Error("Injected dependency validation rejection");
  });
  assert.throws(() => game.act(0, "raise", 100), /Injected/);
  assert.deepEqual(game.publicState(), before);
  assert.throws(() => game.act(0, "fold"), /Injected/);
  assert.deepEqual(game.publicState(), before);
  rejected.mock.restore();
  game.act(0, "raise", 40);
  assert.equal(game.publicState().legal.min, 60);
});

test("folding to an overbet returns its uncalled portion without revealing the winner", () => {
  const game = create();
  game.act(0, "all-in");
  const state = game.act(1, "fold");
  assert.equal(state.seats[0].stack, 1020);
  assert.equal(state.seats[1].stack, 980);
  assert.deepEqual(state.result.winners, [0]);
  assert.deepEqual(state.result.showdown, []);
  assert.deepEqual(state.result.payouts, [{ seat: 0, amount: 1020 }]);
  assert.equal(state.board.length, 0);
});

test("uncontested flop winner receives commitments from every earlier folded player", () => {
  const game = create([1000, 1000, 1000]);
  game.act(0, "raise", 100);
  game.act(1, "call");
  game.act(2, "fold");
  game.act(1, "bet", 50);
  game.act(0, "raise", 100);
  const state = game.act(1, "fold");
  assert.deepEqual(
    state.seats.slice(0, 3).map(({ stack }) => stack),
    [1170, 850, 980],
  );
  assert.deepEqual(state.result.payouts, [{ seat: 0, amount: 370 }]);
  assert.deepEqual(state.result.showdown, []);
  assert.equal(state.board.length, 3);
  assert.equal(total(state), 3000);
});

test("uncalled refunds do not label a losing hand as a showdown winner", () => {
  fixedShuffle(() => {
    const game = create([300, 100]);
    game.act(0, "all-in");
    const state = game.act(1, "call");
    assert.deepEqual(state.result.payouts, [
      { seat: 0, amount: 200 },
      { seat: 1, amount: 200 },
    ]);
    assert.deepEqual(state.result.winners, [1]);
    assert.equal(total(state), 400);
  });
});

test("deterministic prior-street all-in winner receives the main pot after side betting", () => {
  fixedShuffle(() => {
    const game = create([300, 300, 50]);
    game.act(0, "call");
    game.act(1, "call");
    game.act(2, "all-in");
    game.act(0, "call");
    game.act(1, "call");
    assert.equal(game.publicState().phase, "flop");
    game.act(1, "bet", 50);
    game.act(0, "call");
    const state = passiveFinish(game);
    assert.deepEqual(
      state.seats.slice(0, 3).map(({ stack }) => stack),
      [250, 250, 150],
    );
    assert.ok(
      state.result.payouts.some(
        ({ seat, amount }) => seat === 2 && amount === 150,
      ),
    );
    assert.equal(total(state), 650);
  });
});

test("a tied odd pot gives the odd chip to the winner clockwise after the button", () => {
  fixedShuffle(
    () => {
      const game = create([100, 100, 100], { smallBlind: 5, bigBlind: 11 });
      game.act(0, "call");
      game.act(1, "call");
      game.act(2, "fold");
      const state = passiveFinish(game);
      assert.deepEqual(state.result.winners, [0, 1]);
      assert.deepEqual(state.result.payouts, [
        { seat: 0, amount: 16 },
        { seat: 1, amount: 17 },
      ]);
      assert.deepEqual(
        state.seats.slice(0, 3).map(({ stack }) => stack),
        [105, 106, 89],
      );
      assert.equal(total(state), 300);
    },
    (limit) => limit - 1,
  );
});

test("cumulative short all-ins reopen action when they add up to a full raise", () => {
  const game = create([130, 180, 500, 500]);
  assert.equal(game.publicState().actor, 3);
  game.act(3, "raise", 100);
  game.act(0, "all-in");
  game.act(1, "all-in");
  game.act(2, "call");
  const state = game.publicState();
  assert.equal(state.actor, 3);
  assert.ok(state.legal.actions.includes("raise"));
  assert.equal(state.legal.min, 260);
  assert.equal(total(passiveFinish(game)), 1310);
});

test("cards are unique across all dealt seats and board", () => {
  const game = create([1000, 1000, 1000, 1000, 1000, 1000]);
  const cards = Array.from({ length: 6 }, (_, seat) =>
    game.holeCards(seat),
  ).flat();
  cards.push(...passiveFinish(game).board);
  assert.equal(cards.length, 17);
  assert.equal(
    new Set(cards.map((card) => `${card.rank}-${card.suit}`)).size,
    17,
  );
});

test("validate table configuration, seats, buy-ins, and waiting state", () => {
  assert.throws(() => new HoldemEngine({ maxPlayers: 1 }));
  assert.throws(() => new HoldemEngine({ smallBlind: 30, bigBlind: 20 }));
  const game = new HoldemEngine();
  assert.equal(game.publicState().phase, "waiting");
  assert.deepEqual(game.holeCards(0), []);
  assert.throws(() => game.sit(-1, 100));
  assert.throws(() => game.sit(0, 0));
  assert.throws(() => game.sit(0, 1.5));
  game.sit(0, 100);
  assert.throws(() => game.sit(0, 100));
  assert.throws(() => game.start(), /At least two/);
  game.remove(0);
  assert.equal(game.publicState().seats[0], null);
});

test("random legal action sequences terminate, conserve chips, and keep folds private", () => {
  let seed = 97531;
  const random = (limit) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % limit;
  };
  fixedShuffle(() => {
    for (let run = 0; run < 250; run++) {
      const count = 2 + random(5);
      const stacks = Array.from({ length: count }, () => 1 + random(1000));
      const game = create(stacks);
      let turns = 0;
      while (game.publicState().inProgress) {
        assert.ok(turns++ < 100, `Run ${run} must terminate`);
        const state = game.publicState();
        const action = state.legal.actions[random(state.legal.actions.length)];
        const amount = ["bet", "raise"].includes(action)
          ? state.legal.min + random(state.legal.max - state.legal.min + 1)
          : undefined;
        game.act(state.actor, action, amount);
      }
      const state = game.publicState();
      assert.equal(
        total(state),
        stacks.reduce((sum, stack) => sum + stack, 0),
      );
      assert.ok(
        state.result.showdown.every(({ seat }) => !state.seats[seat].folded),
      );
    }
  }, random);
});

import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { Table } from "poker-ts";
import DeckModule from "poker-ts/dist/lib/deck.js";
import PotModule from "poker-ts/dist/lib/pot.js";

const Deck = DeckModule.default;
const Pot = PotModule.default;
const copy = (value) => structuredClone(value);
const MAX_REPLAY_ACTIONS = 100_000;
const chipCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const seatIndex = z.number().int().min(0).max(5);
const visibleCard = z
  .object({
    rank: z.enum([
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "T",
      "J",
      "Q",
      "K",
      "A",
    ]),
    suit: z.enum(["clubs", "diamonds", "hearts", "spades"]),
  })
  .strict();
const recoverySchema = z
  .object({
    config: z
      .object({
        smallBlind: z.number().int().positive(),
        bigBlind: z.number().int().positive(),
        maxPlayers: z.number().int().min(2).max(6),
      })
      .strict(),
    checkpoint: z
      .object({
        stacks: z.array(chipCount.nullable()).min(2).max(6),
        buttonCursor: seatIndex,
        firstButton: z.boolean(),
      })
      .strict(),
    hand: z
      .object({
        deck: z
          .array(
            z.tuple([
              z.number().int().min(0).max(12),
              z.number().int().min(0).max(3),
            ]),
          )
          .length(52),
        actions: z
          .array(
            z
              .object({
                seat: seatIndex,
                action: z.enum(["fold", "check", "call", "bet", "raise"]),
                amount: chipCount.optional(),
              })
              .strict(),
          )
          .max(MAX_REPLAY_ACTIONS),
      })
      .strict()
      .nullable(),
    presentation: z
      .object({
        button: seatIndex.nullable(),
        folded: z.array(seatIndex).max(6),
        hole: z.array(z.array(visibleCard).max(2).nullable()).max(6),
        board: z.array(visibleCard).max(5),
        pots: z
          .array(
            z
              .object({
                size: chipCount,
                eligiblePlayers: z.array(seatIndex).max(6),
              })
              .strict(),
          )
          .max(6),
        result: z
          .object({
            payouts: z
              .array(z.object({ seat: seatIndex, amount: chipCount }).strict())
              .max(6),
            winners: z.array(seatIndex).max(6),
            showdown: z
              .array(
                z
                  .object({
                    seat: seatIndex,
                    cards: z.array(visibleCard).length(2),
                    ranking: z.number().int().min(0).max(9).optional(),
                  })
                  .strict(),
              )
              .max(6),
            pot: chipCount,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function secureShuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}

export class HoldemEngine {
  #game;
  #occupied = new Set();
  #folded = new Set();
  #dealt = new Set();
  #hole = [];
  #initialStacks = [];
  #button = null;
  #result = null;
  #board = [];
  #settledPots = [];
  #actedAt = new Map();
  #biggestBet = 0;
  #fullRaise;
  #bigBlind;
  #maxPlayers;
  #config;
  #replayBase = null;
  #replayActions = [];
  #handDeck = null;
  #restoreDeck = null;

  constructor({ smallBlind = 10, bigBlind = 20, maxPlayers = 6 } = {}) {
    positiveInteger(smallBlind, "smallBlind");
    positiveInteger(bigBlind, "bigBlind");
    if (smallBlind > bigBlind)
      throw new Error("smallBlind cannot exceed bigBlind");
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6) {
      throw new Error("maxPlayers must be between 2 and 6");
    }
    this.#bigBlind = bigBlind;
    this.#fullRaise = bigBlind;
    this.#maxPlayers = maxPlayers;
    this.#config = { smallBlind, bigBlind, maxPlayers };
    this.#game = new Table({ smallBlind, bigBlind }, maxPlayers);
    // poker-ts 1.5.0 exposes shuffle injection on Deck, but not its facade.
    // Pin the dependency: this is the only deck integration boundary.
    this.#game._table._deck = new Deck((cards) => {
      if (this.#restoreDeck) {
        const available = new Map(
          Array.from(cards, (card) => [`${card.rank}:${card.suit}`, card]),
        );
        this.#restoreDeck.forEach(([rank, suit], index) => {
          cards[index] = available.get(`${rank}:${suit}`);
        });
        this.#restoreDeck = null;
      } else {
        secureShuffle(cards);
      }
      this.#handDeck = Array.from(cards, ({ rank, suit }) => [rank, suit]);
    });
  }

  #checkpoint() {
    const table = this.#game._table;
    const seats = this.#game.seats();
    return {
      stacks: Array.from({ length: this.#maxPlayers }, (_, seat) =>
        this.#occupied.has(seat) ? (seats[seat]?.stack ?? 0) : null,
      ),
      buttonCursor: table._button,
      firstButton: table._firstTimeButton,
    };
  }

  // PRIVATE SERVER DATA: includes every hole card and the undealt deck.
  // Checkpoint between hands; replay only the current hand, never room history.
  // The digest detects storage corruption, not malicious edits by disk owners.
  exportState() {
    const inProgress = this.#game.isHandInProgress();
    const state = {
      config: copy(this.#config),
      checkpoint: copy(inProgress ? this.#replayBase : this.#checkpoint()),
      hand: inProgress
        ? { deck: copy(this.#handDeck), actions: copy(this.#replayActions) }
        : null,
      presentation: inProgress
        ? null
        : {
            button: this.#button,
            folded: [...this.#folded],
            hole: Array.from({ length: this.#maxPlayers }, (_, seat) =>
              copy(this.#hole[seat] ?? null),
            ),
            board: copy(this.#board),
            pots: copy(this.#settledPots),
            result: copy(this.#result),
          },
    };
    return {
      format: "codex-holdem-engine/1",
      state,
      checksum: checksum(state),
    };
  }

  static fromState(snapshot) {
    try {
      if (
        !snapshot ||
        snapshot.format !== "codex-holdem-engine/1" ||
        typeof snapshot.checksum !== "string" ||
        JSON.stringify(snapshot).length > 8_000_000 ||
        checksum(snapshot.state) !== snapshot.checksum
      ) {
        throw new Error("Invalid format, size, or checksum");
      }
      const { config, checkpoint, hand, presentation } = recoverySchema.parse(
        snapshot.state,
      );
      if (
        checkpoint.stacks.length !== config.maxPlayers ||
        checkpoint.buttonCursor >= config.maxPlayers ||
        (hand === null) === (presentation === null)
      ) {
        throw new Error("Invalid checkpoint");
      }
      const game = new HoldemEngine(config);
      checkpoint.stacks.forEach((stack, seat) => {
        if (stack === null) return;
        // Busted players still own a seat. Winners can exceed the buy-in limit.
        if (stack > 0) game.#game.sitDown(seat, stack);
        game.#occupied.add(seat);
      });
      game.#game._table._button = checkpoint.buttonCursor;
      game.#game._table._firstTimeButton = checkpoint.firstButton;
      if (hand) {
        if (
          new Set(hand.deck.map(([rank, suit]) => `${rank}:${suit}`)).size !==
          52
        )
          throw new Error("Deck must contain 52 different cards");
        game.#restoreDeck = hand.deck;
        game.start();
        for (const { seat, action, amount } of hand.actions)
          game.act(seat, action, amount);
        if (!game.#game.isHandInProgress())
          throw new Error("Active checkpoint replay ended the hand");
      } else {
        const referencedSeats = [
          ...presentation.folded,
          ...(presentation.button === null ? [] : [presentation.button]),
          ...presentation.pots.flatMap((pot) => pot.eligiblePlayers),
          ...(presentation.result?.winners ?? []),
          ...(presentation.result?.payouts.map(({ seat }) => seat) ?? []),
          ...(presentation.result?.showdown.map(({ seat }) => seat) ?? []),
        ];
        if (referencedSeats.some((seat) => seat >= config.maxPlayers))
          throw new Error("Invalid presentation seat");
        game.#button = presentation.button;
        game.#folded = new Set(presentation.folded);
        game.#hole = copy(presentation.hole);
        game.#board = copy(presentation.board);
        game.#settledPots = copy(presentation.pots);
        game.#result = copy(presentation.result);
      }
      return game;
    } catch (error) {
      throw new Error("Invalid engine recovery snapshot", { cause: error });
    }
  }

  #checkSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.#maxPlayers) {
      throw new Error("Invalid seat");
    }
  }

  sit(seat, chips) {
    this.#checkSeat(seat);
    positiveInteger(chips, "chips");
    if (chips > 1_000_000_000)
      throw new Error("Buy-in exceeds the table limit");
    if (this.#game.isHandInProgress())
      throw new Error("Cannot sit during a hand");
    if (this.#occupied.has(seat)) throw new Error("Seat is occupied");
    this.#game.sitDown(seat, chips);
    this.#occupied.add(seat);
  }

  remove(seat) {
    this.#checkSeat(seat);
    if (this.#game.isHandInProgress())
      throw new Error("Cannot leave during a hand");
    if (!this.#occupied.has(seat)) throw new Error("Seat is empty");
    if (this.#game.seats()[seat]) this.#game.standUp(seat);
    this.#occupied.delete(seat);
    this.#folded.delete(seat);
    this.#hole[seat] = null;
    this.#dealt.delete(seat);
  }

  start() {
    if (this.#game.isHandInProgress())
      throw new Error("A hand is already in progress");
    const seats = this.#game.seats();
    if (seats.filter((seat) => seat && seat.stack > 0).length < 2) {
      throw new Error("At least two players with chips are required");
    }
    this.#replayBase = this.#checkpoint();
    this.#replayActions = [];
    this.#initialStacks = seats.map((seat) => seat?.stack ?? 0);
    this.#dealt = new Set(seats.flatMap((seat, i) => (seat ? [i] : [])));
    this.#folded.clear();
    this.#result = null;
    this.#board = [];
    this.#settledPots = [];
    this.#actedAt.clear();
    this.#biggestBet = this.#bigBlind;
    this.#fullRaise = this.#bigBlind;
    this.#game.startHand();
    this.#button = this.#game.button();
    this.#hole = copy(this.#game.holeCards());
    this.#advance();
    return this.publicState();
  }

  #legal() {
    if (
      !this.#game.isHandInProgress() ||
      !this.#game.isBettingRoundInProgress()
    ) {
      return { actions: [] };
    }
    const actor = this.#game.playerToAct();
    const player = this.#game.seats()[actor];
    const native = this.#game.legalActions();
    let actions = [...native.actions];
    const lastActed = this.#actedAt.get(actor);
    const canReopen =
      lastActed === undefined ||
      this.#biggestBet - lastActed >= this.#fullRaise;
    if (!canReopen)
      actions = actions.filter((action) => !["bet", "raise"].includes(action));
    const call = Math.min(
      player.stack,
      Math.max(0, this.#biggestBet - player.betSize),
    );
    const legal = { actions, call };
    if (actions.includes("bet") || actions.includes("raise")) {
      legal.max = player.stack + player.betSize;
      legal.min = Math.min(legal.max, this.#biggestBet + this.#fullRaise);
      actions.push("all-in");
    } else if (actions.includes("call") && call === player.stack) {
      actions.push("all-in");
    }
    return legal;
  }

  act(seat, action, amount) {
    this.#checkSeat(seat);
    if (!this.#game.isHandInProgress())
      throw new Error("No hand is in progress");
    if (this.#game.playerToAct() !== seat)
      throw new Error("It is not your turn");
    if (this.#replayActions.length >= MAX_REPLAY_ACTIONS)
      throw new Error("Hand action limit reached");
    const legal = this.#legal();
    if (!legal.actions.includes(action)) throw new Error("Action is not legal");
    if (amount !== undefined && !["bet", "raise"].includes(action)) {
      throw new Error("Only bet and raise accept an amount");
    }
    const player = this.#game.seats()[seat];
    if (action === "all-in") {
      if (legal.max !== undefined) {
        action = legal.actions.includes("bet") ? "bet" : "raise";
        amount = legal.max;
      } else {
        action = "call";
      }
    }
    let nextFullRaise = this.#fullRaise;
    let nextBiggestBet = this.#biggestBet;
    if (action === "bet" || action === "raise") {
      positiveInteger(amount, "amount");
      if (amount < legal.min || amount > legal.max) {
        throw new Error(
          `Bet-to amount must be between ${legal.min} and ${legal.max}`,
        );
      }
      const increment = amount - this.#biggestBet;
      if (increment >= this.#fullRaise) nextFullRaise = increment;
      nextBiggestBet = amount;
    }
    this.#game.actionTaken(action, amount);
    this.#fullRaise = nextFullRaise;
    this.#biggestBet = nextBiggestBet;
    if (action === "fold") this.#folded.add(seat);
    this.#actedAt.set(
      seat,
      Math.min(this.#biggestBet, player.stack + player.betSize),
    );
    this.#advance();
    this.#replayActions.push({
      seat,
      action,
      ...(amount === undefined ? {} : { amount }),
    });
    return this.publicState();
  }

  #contributions() {
    const seats = this.#game.seats();
    return this.#initialStacks.map(
      (initial, seat) => initial - (seats[seat]?.stack ?? 0),
    );
  }

  #pots() {
    const contributions = this.#contributions();
    const levels = [
      ...new Set(contributions.filter((value) => value > 0)),
    ].sort((a, b) => a - b);
    const pots = [];
    let previous = 0;
    for (const level of levels) {
      const contributors = contributions.flatMap((value, seat) =>
        value >= level ? [seat] : [],
      );
      const eligiblePlayers = contributors.filter(
        (seat) => !this.#folded.has(seat),
      );
      const size = (level - previous) * contributors.length;
      // Layers with identical eligibility are one pot, including folded chips.
      const last = pots.at(-1);
      if (last && last.eligiblePlayers.join(",") === eligiblePlayers.join(","))
        last.size += size;
      else pots.push({ size, eligiblePlayers });
      previous = level;
    }
    return pots;
  }

  #advance() {
    while (this.#game.isHandInProgress()) {
      if (this.#game.isBettingRoundInProgress()) {
        const actor = this.#game.playerToAct();
        const seats = this.#game.seats();
        const live = [...this.#dealt].filter((seat) => !this.#folded.has(seat));
        const funded = live.filter((seat) => seats[seat]?.stack > 0);
        const largestBet = Math.max(
          ...live.map((seat) => seats[seat]?.betSize ?? 0),
        );
        if (
          seats[actor].stack === 0 ||
          (funded.length === 1 &&
            funded[0] === actor &&
            seats[actor].betSize >= largestBet)
        ) {
          // A short all-in blind cannot force its sole funded opponent to add a
          // nominal full blind, and a player cannot bet into an uncontested pot.
          if (funded.length <= 1) {
            this.#game._table._dealer._bettingRound._biggestBet = largestBet;
          }
          const actions = this.#game.legalActions().actions;
          this.#game.actionTaken(actions.includes("check") ? "check" : "call");
          continue;
        }
        break;
      }
      if (this.#game.areBettingRoundsCompleted()) {
        this.#settle();
        break;
      }
      this.#game.endBettingRound();
      this.#actedAt.clear();
      this.#biggestBet = 0;
      this.#fullRaise = this.#bigBlind;
    }
    if (this.#game.isHandInProgress())
      this.#board = copy(this.#game.communityCards());
  }

  #settle() {
    this.#settledPots = this.#pots();
    const before = this.#game.seats().map((player) => player?.stack ?? 0);
    const table = this.#game._table;
    const dealer = table._dealer;
    // Version-specific compatibility boundary: 1.5.0 aggregates folded bets and
    // drops previous-street all-ins from dealer._players. Rebuild pot eligibility
    // from exact commitments and restore the original player references before
    // delegating hand evaluation, split pots, and odd-chip payouts to poker-ts.
    dealer._potManager._pots = this.#settledPots.map(
      ({ size, eligiblePlayers }) => {
        const pot = new Pot();
        pot.add(size);
        pot._eligiblePlayers = [...eligiblePlayers];
        return pot;
      },
    );
    dealer._players = table._handPlayers.map((player, seat) =>
      this.#folded.has(seat) ? null : player,
    );
    const showdownSeats = [...this.#dealt].filter(
      (seat) => !this.#folded.has(seat),
    );
    if (showdownSeats.length > 1 && this.#game.communityCards().length < 5) {
      dealer.dealCommunityCards();
    }
    this.#board = copy(this.#game.communityCards());
    this.#game.showdown();
    const after = this.#game.seats();
    const payouts = before.flatMap((stack, seat) => {
      const amount = (after[seat]?.stack ?? 0) - stack;
      return amount > 0 ? [{ seat, amount }] : [];
    });
    const winners = this.#game.winners();
    const rankings = new Map(
      winners.flatMap((pot) => pot.map(([seat, hand]) => [seat, hand.ranking])),
    );
    this.#result = {
      payouts,
      winners: [
        ...new Set(
          winners.flatMap((pot, index) =>
            this.#settledPots[index].eligiblePlayers.length > 1
              ? pot.map(([seat]) => seat)
              : [],
          ),
        ),
      ],
      showdown:
        showdownSeats.length > 1
          ? showdownSeats.map((seat) => ({
              seat,
              cards: copy(this.#hole[seat]),
              ...(rankings.has(seat) ? { ranking: rankings.get(seat) } : {}),
            }))
          : [],
      pot: this.#settledPots.reduce((sum, pot) => sum + pot.size, 0),
    };
    if (showdownSeats.length === 1) this.#result.winners = showdownSeats;
  }

  holeCards(seat) {
    this.#checkSeat(seat);
    return copy(this.#hole[seat] ?? []);
  }

  publicState() {
    const inProgress = this.#game.isHandInProgress();
    const seats = this.#game.seats();
    const pots = inProgress ? this.#pots() : this.#settledPots;
    return {
      inProgress,
      phase: inProgress
        ? this.#game.roundOfBetting()
        : this.#result
          ? "complete"
          : "waiting",
      board: copy(this.#board),
      button: this.#button,
      actor:
        inProgress && this.#game.isBettingRoundInProgress()
          ? this.#game.playerToAct()
          : null,
      pot: this.#result?.pot ?? pots.reduce((sum, pot) => sum + pot.size, 0),
      pots: copy(pots),
      seats: Array.from({ length: this.#maxPlayers }, (_, seat) =>
        this.#occupied.has(seat)
          ? {
              stack: seats[seat]?.stack ?? 0,
              bet: inProgress ? (seats[seat]?.betSize ?? 0) : 0,
              folded: this.#folded.has(seat),
              inHand:
                inProgress && this.#dealt.has(seat) && !this.#folded.has(seat),
            }
          : null,
      ),
      legal: this.#legal(),
      result: copy(this.#result),
    };
  }
}

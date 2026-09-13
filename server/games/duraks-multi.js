'use strict';

/**
 * server/games/duraks-multi.js
 *
 * Duraks for 2-4 players ("podkidnoy" / throw-in variant). Kept as its own
 * engine, separate from games/duraks52.js (the tested, unmodified 2-player
 * game) — this is a genuinely different rule set, not a drop-in
 * replacement, so it lives in its own file and gets its own registry entry.
 *
 * Design, as agreed with the user:
 *   - Fixed seating order, clockwise, set once at game start (the order
 *     `playerIds` is passed in).
 *   - 52-card deck for now, for any player count.
 *   - Throw-ins happen in strict seating order, not a free-for-all: after
 *     the primary attacker's first card, every OTHER non-defender player
 *     (in clockwise order, defender skipped) gets an explicit turn to
 *     either add a matching-rank card or decline. Whoever currently holds
 *     that turn keeps it as long as they keep successfully adding cards —
 *     priority only passes to the next player once they explicitly
 *     decline. A successful throw-in by anyone still resets everyone
 *     else's "declined" state, so the rotation gives fresh chances once
 *     it does reach them, until either the table is full or everyone in
 *     a row declines.
 *   - The defender can defend an open slot at any time — they aren't
 *     gated by the throw-in turn order, matching how the table actually
 *     plays out (the defender reacts as attacks land, doesn't wait for a
 *     "turn").
 *   - With exactly 2 active players, the throw-in rotation degrades to
 *     just the attacker (the only non-defender player) — which reproduces
 *     the existing 2-player rules exactly, so "once two players are left,
 *     play continues as normal" falls out of the general logic for free.
 *   - After a round resolves successfully (fully defended), the defender
 *     becomes the next attacker — unless they also just went safe in that
 *     same refill, in which case (same as a failed defense) the next
 *     active player clockwise after them attacks instead, and the
 *     defender who failed is skipped as a penalty.
 *   - Hand refill after a round: whoever actually played an attack card
 *     this round (the attacker, then throw-in contributors, in the order
 *     they played — each counted once even if they threw in more than
 *     once), refilled to 6 in that order; the defender refills last, and
 *     only if they successfully defended (not if they took).
 *   - A player whose hand is empty once the deck is also empty goes
 *     "safe" and drops out of the rotation. Play continues among the
 *     rest; when only one active player remains, they're the durak.
 */

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANKS_36 = RANKS.slice(4); // ['6','7','8','9','10','J','Q','K','A'] — 9 ranks x 4 suits = 36
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
const MAX_TABLE_SLOTS = 6;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

function ranksForDeckSize(deckSize) {
  return deckSize === 36 ? RANKS_36 : RANKS;
}

function rankValueFor(ranks) {
  return Object.fromEntries(ranks.map((r, i) => [r, i + 2]));
}

function makeDeck(ranks) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of ranks) {
      deck.push({ suit, rank, id: `${rank}-${suit}` });
    }
  }
  return deck;
}

function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

class Game {
  constructor(playerIds, opts = {}) {
    if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
      throw new Error(`Multiplayer Duraks supports ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
    }
    this.players = playerIds.slice(); // fixed seating order, clockwise — never changes
    this.activePlayers = playerIds.slice(); // shrinks as people go safe
    // When true, a round that becomes resolvable (last open slot defended,
    // nobody left to throw in) does NOT clear the table automatically —
    // the caller must call tryResolveRound() explicitly once it's ready.
    // Lets a caller (e.g. the bots-mode room driver) pause for a beat
    // before the table visibly clears, instead of it vanishing the instant
    // the last card is defended. Defaults to false (original behavior,
    // used by every existing test) so nothing changes unless requested.
    this.deferAutoResolve = !!opts.deferAutoResolve;
    // True from the moment the defender says "I'll take" until the final
    // throw-in window (see takeCards()) actually closes — while true, the
    // defender is done acting, but others still get one last chance to
    // throw in matching-rank cards before the pickup is finalized, same as
    // physical Durak's "beru" moment.
    this.pendingTake = false;
    // 52 (default) or 36 — a 36-card deck drops ranks 2-5, per the same
    // convention as the standalone duraks36.js 2-player engine. Kept as
    // instance state (not a module constant) so ranks/rankValue below are
    // correctly recalibrated per game — comparisons, trump preservation
    // cost, and danger-scoring all rely on rank *position*, not the
    // specific characters, so this is the only thing that needs to vary.
    this.deckSize = opts.deckSize === 36 ? 36 : 52;
    this.ranks = ranksForDeckSize(this.deckSize);
    this.rankValue = rankValueFor(this.ranks);
    this.hands = {};
    for (const p of this.players) this.hands[p] = [];
    this.deck = shuffle(makeDeck(this.ranks));
    this.discard = [];
    this.trumpCard = null;
    this.trumpSuit = null;
    this.table = []; // [{attack, defend}]
    this.attackerId = null;
    this.defenderId = null;
    this.status = 'active'; // active | finished
    this.durakId = null;
    this.safeOrder = []; // usernames, in the order they went safe (finished, didn't lose)
    this.log = [];
    this.seenCards = new Set();

    // Throw-in state for the current round.
    this.throwInRotation = []; // active, non-defender players, seating order from the attacker
    this.throwInPointer = 0;
    this.throwInDeclined = new Set();
    this.roundParticipants = []; // usernames who played an attack card this round, first-appearance order

    this._deal();
  }

  _deal() {
    for (let i = 0; i < 6; i++) {
      for (const p of this.players) {
        if (this.deck.length) this.hands[p].push(this.deck.shift());
      }
    }
    this.trumpCard = this.deck[this.deck.length - 1];
    this.trumpSuit = this.trumpCard.suit;

    let lowest = null;
    let starter = this.players[0];
    for (const p of this.players) {
      for (const c of this.hands[p]) {
        if (c.suit === this.trumpSuit) {
          if (!lowest || this.rankValue[c.rank] < this.rankValue[lowest]) {
            lowest = c.rank;
            starter = p;
          }
        }
      }
    }
    this.attackerId = starter;
    this.defenderId = this._nextActiveAfter(starter);
    this.roundStartHandSize = this.hands[this.defenderId].length;
  }

  // --- seating helpers ---

  _nextActiveAfter(username) {
    const startIdx = this.players.indexOf(username);
    for (let step = 1; step <= this.players.length; step++) {
      const candidate = this.players[(startIdx + step) % this.players.length];
      if (this.activePlayers.includes(candidate)) return candidate;
    }
    return null; // no other active player — shouldn't happen when called correctly
  }

  _buildThrowInRotation() {
    // Every active player except the defender, in clockwise seating order
    // starting from the attacker (who already gets the first slot in the
    // rotation for *subsequent* throw-ins, on top of their mandatory first
    // card). With exactly 2 active players this is just [attackerId].
    const order = [];
    const startIdx = this.players.indexOf(this.attackerId);
    for (let step = 0; step < this.players.length; step++) {
      const candidate = this.players[(startIdx + step) % this.players.length];
      if (this.activePlayers.includes(candidate) && candidate !== this.defenderId) {
        order.push(candidate);
      }
    }
    return order;
  }

  beats(attackCard, defendCard) {
    if (defendCard.suit === attackCard.suit) {
      return this.rankValue[defendCard.rank] > this.rankValue[attackCard.rank];
    }
    return defendCard.suit === this.trumpSuit && attackCard.suit !== this.trumpSuit;
  }

  ranksOnTable() {
    const ranks = new Set();
    for (const slot of this.table) {
      ranks.add(slot.attack.rank);
      if (slot.defend) ranks.add(slot.defend.rank);
    }
    return ranks;
  }

  openSlots() {
    return this.table.filter((s) => !s.defend).length;
  }

  removeFromHand(playerId, cardId) {
    const hand = this.hands[playerId];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    return hand.splice(idx, 1)[0];
  }

  _tableCap() {
    return Math.min(MAX_TABLE_SLOTS, this.roundStartHandSize);
  }

  _noteParticipant(playerId) {
    if (!this.roundParticipants.includes(playerId)) this.roundParticipants.push(playerId);
  }

  // --- actions ---

  /** Primary attack (table empty) or a throw-in (table non-empty). Same
   *  entry point as the 2-player engine, but gated by strict turn order
   *  once a round is already underway. */
  attack(playerId, cardId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId === this.defenderId) return { error: 'Aizstāvis nevar uzbrukt' };
    const hand = this.hands[playerId];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Kārts nav tavā rokā' };

    const isFirstCard = this.table.length === 0;
    if (isFirstCard) {
      if (playerId !== this.attackerId) return { error: 'Nav tava kārta uzbrukt' };
    } else {
      if (this.throwInRotation[this.throwInPointer] !== playerId) {
        return { error: 'Nav tava kārta piemest' };
      }
      const ranks = this.ranksOnTable();
      if (!ranks.has(card.rank)) return { error: 'Šis rangs vēl nav uz galda' };
    }
    if (this.table.length >= this._tableCap()) return { error: 'Uz galda vairs nav vietas' };

    this.removeFromHand(playerId, cardId);
    this.table.push({ attack: card, defend: null });
    this.seenCards.add(card.id);
    this._noteParticipant(playerId);
    this.log.push(`${playerId} attacks with ${card.rank} of ${card.suit}`);

    if (isFirstCard) {
      this.throwInRotation = this._buildThrowInRotation();
      this.throwInPointer = 0;
      this.throwInDeclined = new Set();
    } else {
      // A successful throw-in gives everyone a fresh chance once it's
      // their turn — but the same player who just added a card keeps
      // priority to add more, rather than immediately passing to the
      // next player. Priority only moves on once they explicitly decline
      // (see declineThrowIn).
      this.throwInDeclined = new Set();
    }
    if (this.pendingTake) return this._maybeResolveTake() || { ok: true };
    return { ok: true };
  }

  /** The player whose throw-in turn it is declines to add anything right
   *  now. May re-open later in the same round if someone else throws in
   *  after them (the rotation keeps cycling until everyone declines in a
   *  row, or the table fills up). */
  declineThrowIn(playerId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (this.table.length === 0) return { error: 'Vēl nav ko atteikt — uzbrukums nav sācies' };
    if (this.throwInRotation[this.throwInPointer] !== playerId) {
      return { error: 'Nav tava kārta lemt par piemešanu' };
    }
    this.throwInDeclined.add(playerId);
    this.throwInPointer = (this.throwInPointer + 1) % this.throwInRotation.length;
    if (this.pendingTake) return this._maybeResolveTake() || { ok: true };
    return this._maybeResolveRound() || { ok: true };
  }

  defend(playerId, cardId, slotIndex) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId !== this.defenderId) return { error: 'Nav tava kārta aizsargāties' };
    const slot = this.table[slotIndex];
    if (!slot || slot.defend) return { error: 'Nederīga vieta' };
    const hand = this.hands[playerId];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Kārts nav tavā rokā' };
    if (!this.beats(slot.attack, card)) return { error: 'Šī kārts nevar sist uzbrukuma kārti' };

    this.removeFromHand(playerId, cardId);
    slot.defend = card;
    this.seenCards.add(card.id);
    this.log.push(`${playerId} defends with ${card.rank} of ${card.suit}`);

    return this._maybeResolveRound() || { ok: true };
  }

  /** True once nobody in the throw-in rotation has anything left to add —
   *  either the table is full, or everyone has declined since the last
   *  successful throw-in. */
  _throwInWindowClosed() {
    if (this.table.length >= this._tableCap()) return true;
    return this.throwInDeclined.size >= this.throwInRotation.length;
  }

  /** True once a round has actually started (table.length > 0) and is
   *  fully resolvable — every slot defended and nobody left to throw in.
   *  Safe to call at any point, including before any card has been
   *  played (correctly returns false then, rather than the vacuous-true
   *  a bare openSlots===0 check would give on an empty table). Never
   *  true during a pending take — that path resolves via
   *  isTakeResolvable()/tryResolveTake() instead. */
  isRoundResolvable() {
    return !this.pendingTake && this.table.length > 0 && this.openSlots() === 0 && this._throwInWindowClosed();
  }

  /** Explicit, caller-driven resolution for deferAutoResolve mode — clears
   *  the table and advances turn order, same as the automatic path would,
   *  but only when the caller decides to (e.g. after a UI pause). No-op
   *  (returns null) if the round isn't actually resolvable yet. */
  tryResolveRound() {
    if (!this.isRoundResolvable()) return null;
    return this._endRound(false) || { ok: true };
  }

  _maybeResolveRound() {
    if (this.deferAutoResolve) return null; // caller resolves explicitly via tryResolveRound()
    if (this.openSlots() > 0) return null; // defender still has work to do
    if (!this._throwInWindowClosed()) return null; // still someone's turn to possibly add more
    return this._endRound(false);
  }

  /** Defender gives up on defending — but this doesn't immediately hand
   *  them the pile. Standard Durak rule: everyone else still gets one
   *  final chance, in the same seating-order rotation, to throw in more
   *  matching-rank cards (since they'd be swept up in the pickup anyway)
   *  before the cards are actually collected. */
  takeCards(playerId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId !== this.defenderId) return { error: 'Tikai aizstāvis var ņemt kārtis' };
    if (this.table.length === 0) return { error: 'Uz galda nav kāršu' };
    if (this.pendingTake) return { error: 'Jau gaida pēdējo piemešanu' };

    this.pendingTake = true;
    this.throwInRotation = this._buildThrowInRotation();
    this.throwInPointer = 0;
    this.throwInDeclined = new Set();
    this.log.push(`${playerId} takes — waiting for any final throw-ins`);

    return this._maybeResolveTake() || { ok: true };
  }

  /** True once the pending-take final throw-in window has closed and the
   *  pickup is ready to actually happen. */
  isTakeResolvable() {
    return this.pendingTake && this._throwInWindowClosed();
  }

  /** Explicit, caller-driven finalization for deferAutoResolve mode —
   *  actually gives the table's cards to the defender and advances turn
   *  order. No-op (returns null) if the final throw-in window is still open. */
  tryResolveTake() {
    if (!this.isTakeResolvable()) return null;
    return this._finalizeTake() || { ok: true };
  }

  _maybeResolveTake() {
    if (this.deferAutoResolve) return null; // caller resolves explicitly via tryResolveTake()
    if (!this._throwInWindowClosed()) return null;
    return this._finalizeTake();
  }

  _finalizeTake() {
    const defenderId = this.defenderId;
    for (const slot of this.table) {
      this.hands[defenderId].push(slot.attack);
      if (slot.defend) this.hands[defenderId].push(slot.defend);
    }
    this.pendingTake = false;
    this.log.push(`${defenderId} takes the cards`);
    return this._endRound(true);
  }

  _endRound(defenderTook) {
    const defenderId = this.defenderId;

    if (!defenderTook) {
      for (const slot of this.table) {
        this.discard.push(slot.attack, slot.defend);
      }
    }
    this.table = [];

    // Refill: round participants in the order they first played, then the
    // defender last (only if they successfully defended).
    const refillOrder = this.roundParticipants.slice();
    if (!defenderTook) refillOrder.push(defenderId);
    for (const p of refillOrder) {
      while (this.hands[p].length < 6 && this.deck.length > 0) {
        this.hands[p].push(this.deck.shift());
      }
    }

    // Anyone now out of cards, with nothing left to draw, is safe.
    for (const p of this.activePlayers.slice()) {
      if (this.hands[p].length === 0 && this.deck.length === 0) {
        this.safeOrder.push(p);
        this.activePlayers = this.activePlayers.filter((x) => x !== p);
      }
    }

    if (this.activePlayers.length === 0) {
      this.status = 'finished';
      this.log.push('Visiem beidzās kārtis vienlaicīgi — neizšķirts, nav duraka!');
      this.roundParticipants = [];
      return { ok: true, gameOver: true, draw: true };
    }
    if (this.activePlayers.length === 1) {
      this.status = 'finished';
      this.durakId = this.activePlayers[0];
      this.log.push(`${this.durakId} is the durak!`);
      this.roundParticipants = [];
      return { ok: true, gameOver: true, durakId: this.durakId };
    }

    // Successful defense: the defender becomes the next attacker (unless
    // they just went safe from that same refill, in which case skip to
    // the next active player instead, same as the take-penalty case).
    // A take: the defender is skipped as a penalty — the next active
    // player after them attacks instead.
    if (!defenderTook && this.activePlayers.includes(defenderId)) {
      this.attackerId = defenderId;
    } else {
      this.attackerId = this._nextActiveAfter(defenderId);
    }
    this.defenderId = this._nextActiveAfter(this.attackerId);
    this.roundStartHandSize = this.hands[this.defenderId].length;
    this.roundParticipants = [];
    this.throwInRotation = [];
    this.throwInPointer = 0;
    this.throwInDeclined = new Set();

    return null;
  }

  // Who currently owes an action. During an active game there can be *two*
  // simultaneous pending actors in the multiplayer game — the defender (if
  // any slot is open) and whoever's turn it is in the throw-in rotation
  // (if the window isn't closed yet) — unlike the 2-player engine, which
  // only ever has one. Callers that need a single "on the clock" player
  // for timeout purposes should treat the defender as primary when both
  // are pending.
  pendingActors() {
    if (this.status !== 'active') return [];
    const actors = [];
    if (!this.pendingTake && this.openSlots() > 0) {
      actors.push({ playerId: this.defenderId, kind: 'defend' });
    }
    if (this.table.length === 0) {
      actors.push({ playerId: this.attackerId, kind: 'attackOpen' });
    } else if (!this._throwInWindowClosed()) {
      actors.push({ playerId: this.throwInRotation[this.throwInPointer], kind: 'throwInDecision' });
    }
    return actors;
  }

  viewFor(playerId) {
    const opponents = this.players.filter((p) => p !== playerId);
    const isThrowInTurn =
      this.table.length > 0 &&
      !this._throwInWindowClosed() &&
      this.throwInRotation[this.throwInPointer] === playerId;
    return {
      you: playerId,
      players: this.players,
      activePlayers: this.activePlayers,
      hand: this.hands[playerId],
      opponentCounts: Object.fromEntries(opponents.map((p) => [p, this.hands[p].length])),
      deckCount: this.deck.length,
      trumpCard: this.trumpCard,
      trumpSuit: this.trumpSuit,
      table: this.table,
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      yourRole: playerId === this.attackerId ? 'attacker' : playerId === this.defenderId ? 'defender' : 'other',
      canThrowIn: playerId !== this.defenderId && this.activePlayers.includes(playerId) && isThrowInTurn,
      pendingTake: this.pendingTake,
      pendingActorIds: this.pendingActors().map((a) => a.playerId),
      status: this.status,
      durakId: this.durakId,
      draw: this.status === 'finished' && !this.durakId && this.activePlayers.length === 0,
      safeOrder: this.safeOrder,
      log: this.log.slice(-8),
    };
  }
}

module.exports = { Game, RANK_VALUE, SUITS, RANKS, MAX_TABLE_SLOTS, MIN_PLAYERS, MAX_PLAYERS };

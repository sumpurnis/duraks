'use strict';
/**
 * Meļi rules engine. Pure logic, no I/O, so it can be unit-tested and later
 * reused for human-vs-human rooms.
 *
 * Rules implemented (see README):
 *  - 2 players, 26 cards each (full 52-card deck).
 *  - A round starts with the starter placing ANY card face-down and announcing a suit
 *    (truth or bluff). That announcement locks the suit for the round.
 *    announce = 'suit-rank': the starter also names a rank, and every later card is announced
 *    as a suit + rank in the locked suit (rank free). Honest = the card is exactly that card.
 *    announce = 'suit': only the suit is announced; every later card is implicitly announced as
 *    the locked suit. Honest = the card is of that suit.
 *  - Players alternate. Playing the next card is the "pass"; there is no pass button.
 *  - Any card in your hand may be played. Holding no card of the locked suit means you must bluff.
 *  - On your turn, with a non-empty pile, you may call "bluff" on the previous card.
 *    Only that last card is revealed. If it differs from its announcement the liar
 *    picks up the whole pile, otherwise the challenger does.
 *  - Whoever was right starts the next round (caught liar -> challenger starts,
 *    honest player -> that player starts).
 *  - First player with no cards wins. Emptying your hand triggers an automatic check
 *    of your last card (the opponent would always challenge it): if it was a lie you
 *    pick up the pile and play on.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ANNOUNCE_MODES = ['suit-rank', 'suit'];
const DEFAULTS = Object.freeze({ handSize: 26, announce: 'suit-rank' });

class RuleError extends Error {}

const pub = (c) => ({ id: c.id, rank: c.rank, suit: c.suit });
const sameFace = (a, b) => a.rank === b.rank && a.suit === b.suit;

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: rank + suit, rank, suit });
  return deck;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  hand.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
}

class MeliGame {
  /**
   * @param {object} [opts]
   * @param {number} [opts.handSize=26]
   * @param {string} [opts.announce='suit-rank'] 'suit' | 'suit-rank'
 * @param {number} [opts.starter=0]    player index who starts round 1
   * @param {() => number} [opts.rng]    injectable for tests
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.opts[k] = opts[k];
    this.rng = opts.rng || Math.random;
    const h = this.opts.handSize;
    if (!Number.isInteger(h) || h < 1 || h * 2 > 52) throw new RangeError('handSize must be an integer between 1 and 26');
    if (!ANNOUNCE_MODES.includes(this.opts.announce)) throw new RangeError('announce must be "suit" or "suit-rank"');

    const deck = shuffle(makeDeck(), this.rng);
    this.hands = [deck.slice(0, h), deck.slice(h, 2 * h)];
    this.hands.forEach(sortHand);

    this.pile = []; // { player, card, claim:{rank,suit} }
    this.lockedSuit = null;
    this.round = 1;
    this.turn = opts.starter === 1 ? 1 : 0;
    this.phase = 'play'; // 'play' | 'over'
    this.winner = null;
    this.endReason = null; // 'empty-hand' | 'forfeit'
  }

  // ---------- actions ----------

  /** Place a card face-down and announce it as `claim`. */
  play(player, cardId, claim) {
    this._assertTurn(player);
    const hand = this.hands[player];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx < 0) throw new RuleError('That card is not in your hand.');
    const card = hand[idx];

    const cl = this._normalizeClaim(claim);

    hand.splice(idx, 1);
    this.pile.push({ player, card, claim: cl });
    if (!this.lockedSuit) this.lockedSuit = cl.suit;

    if (hand.length === 0) return this._resolve(1 - player, true);

    this.turn = 1 - player;
    return { type: 'played', player };
  }

  /** A player gives up (left, timed out, disconnected). The opponent wins. */
  forfeit(player) {
    if (this.phase !== 'play') throw new RuleError('The game is over.');
    this.phase = 'over';
    this.winner = 1 - player;
    this.turn = null;
    this.endReason = 'forfeit';
    return { type: 'forfeit', over: true, player };
  }

  /** Call "bluff" on the card the opponent just placed. */
  challenge(player) {
    this._assertTurn(player);
    if (this.pile.length === 0) throw new RuleError('There is nothing to challenge yet.');
    return this._resolve(player, false);
  }

  // ---------- internals ----------

  _suitOnly() {
    return this.opts.announce === 'suit';
  }

  /** Validate an announcement for the current mode and return it in canonical form. */
  _normalizeClaim(claim) {
    if (this._suitOnly()) {
      // After the first card the suit is implied, so a missing suit means "the locked suit".
      const suit = claim && claim.suit !== undefined ? claim.suit : this.lockedSuit;
      if (!SUITS.includes(suit)) throw new RuleError('Announce a suit.');
      if (this.lockedSuit && suit !== this.lockedSuit) throw new RuleError(`The suit is locked to ${this.lockedSuit} for this round.`);
      return { rank: null, suit };
    }
    if (!claim || !SUITS.includes(claim.suit) || !RANKS.includes(claim.rank)) {
      throw new RuleError('Announce a valid suit and rank.');
    }
    if (this.lockedSuit && claim.suit !== this.lockedSuit) {
      throw new RuleError(`The suit is locked to ${this.lockedSuit} for this round.`);
    }
    return { rank: claim.rank, suit: claim.suit };
  }

  _isHonest(entry) {
    return this._suitOnly() ? entry.card.suit === entry.claim.suit : sameFace(entry.card, entry.claim);
  }

  _assertTurn(player) {
    if (this.phase !== 'play') throw new RuleError('The game is over.');
    if (this.turn !== player) throw new RuleError('It is not your turn.');
  }

  _resolve(challenger, final) {
    const top = this.pile[this.pile.length - 1];
    const accused = top.player;
    const lie = !this._isHonest(top);
    const loser = lie ? accused : challenger;
    const taken = this.pile.length;

    const reveal = {
      challenger,
      accused,
      claim: { ...top.claim },
      actual: pub(top.card),
      lie,
      loser,
      taken,
      final,
    };

    this.hands[loser].push(...this.pile.map((e) => e.card));
    sortHand(this.hands[loser]);
    this.pile = [];
    this.lockedSuit = null;
    this.round += 1;

    if (final && !lie) {
      this.phase = 'over';
      this.winner = accused;
      this.endReason = 'empty-hand';
      this.turn = null;
      return { type: 'reveal', reveal, over: true };
    }

    this.turn = lie ? challenger : accused;
    return { type: 'reveal', reveal, over: false };
  }

  // ---------- views ----------

  /** Everything player `p` is allowed to know. */
  view(p) {
    const myTurn = this.phase === 'play' && this.turn === p;
    return {
      you: p,
      phase: this.phase,
      winner: this.winner,
      endReason: this.endReason,
      announce: this.opts.announce,
      round: this.round,
      turn: this.turn,
      lockedSuit: this.lockedSuit,
      hand: this.hands[p].map(pub),
      oppCount: this.hands[1 - p].length,
      pile: {
        count: this.pile.length,
        claims: this.pile.map((e) => ({ by: e.player === p ? 'you' : 'opp', rank: e.claim.rank, suit: e.claim.suit })),
      },
      canPlay: myTurn,
      canChallenge: myTurn && this.pile.length > 0,
    };
  }
}

module.exports = { MeliGame, RuleError, SUITS, RANKS, DEFAULTS, ANNOUNCE_MODES };

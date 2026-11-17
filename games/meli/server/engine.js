'use strict';
/**
 * Meļi rules engine. Pure logic, no I/O, so it can be unit-tested and later
 * reused for human-vs-human rooms.
 *
 * Rules implemented (see README):
 *  - 2 to 6 players. The whole deck is dealt round-robin (or `handSize` cards each when given).
 *  - A round starts with the starter placing ANY card face-down and announcing a suit
 *    (truth or bluff). That announcement locks the suit for the round.
 *    announce = 'suit-rank': the starter also names a rank, and every later card is announced
 *    as a suit + rank in the locked suit (rank free). Honest = the card is exactly that card.
 *    announce = 'suit': only the suit is announced; every later card is implicitly announced as
 *    the locked suit. Honest = the card is of that suit.
 *  - Turns go round in seat order. Playing the next card is the "pass"; there is no pass button.
 *  - Any card in your hand may be played. Holding no card of the locked suit means you must bluff.
 *  - On your turn, with a non-empty pile, you may call "bluff" on the previous card
 *    (challenge = 'next', the default; challenge = 'any' lets anyone but its owner call it).
 *    Only that last card is revealed. If it differs from its announcement the liar
 *    picks up the whole pile, otherwise the challenger does.
 *  - Whoever was right starts the next round (caught liar -> challenger starts,
 *    honest player -> that player starts).
 *  - First player with no cards wins and the game is over. Emptying your hand triggers an
 *    automatic check of your last card (the next player would always challenge it): if it
 *    was a lie you pick up the pile and play on.
 *  - A player who forfeits (left, timed out) is out: their cards leave the game and the
 *    others play on. The last player left wins.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ANNOUNCE_MODES = ['suit-rank', 'suit'];
const DECKS = ['full', 'half'];
const CHALLENGE_MODES = ['next', 'any'];
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
// handSize: null = deal the whole deck round-robin (2 players, full deck: 26 each)
const DEFAULTS = Object.freeze({ handSize: null, announce: 'suit-rank', deck: 'full', players: 2, challenge: 'next' });
// 'half' = the 24 strongest cards: 9 to Ace in every suit.

class RuleError extends Error {}

const pub = (c) => ({ id: c.id, rank: c.rank, suit: c.suit });
const sameFace = (a, b) => a.rank === b.rank && a.suit === b.suit;

function makeDeck(kind = 'full') {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (kind === 'half' && RANKS.indexOf(rank) < RANKS.indexOf('9')) continue;
      deck.push({ id: rank + suit, rank, suit });
    }
  }
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
   * @param {number} [opts.players=2]       2..6
   * @param {number|null} [opts.handSize]   cards each; default: the whole deck dealt round-robin
   * @param {string} [opts.announce='suit-rank'] 'suit' | 'suit-rank'
   * @param {string} [opts.deck='full']     'full' | 'half'
   * @param {string} [opts.challenge='next'] 'next' (only the player whose turn it is) | 'any'
   * @param {number} [opts.starter=0]       player index who starts round 1
   * @param {() => number} [opts.rng]       injectable for tests
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.opts[k] = opts[k];
    this.rng = opts.rng || Math.random;
    const n = this.opts.players;
    if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) throw new RangeError(`players must be ${MIN_PLAYERS}..${MAX_PLAYERS}`);
    if (!DECKS.includes(this.opts.deck)) throw new RangeError('deck must be "full" or "half"');
    if (!ANNOUNCE_MODES.includes(this.opts.announce)) throw new RangeError('announce must be "suit" or "suit-rank"');
    if (!CHALLENGE_MODES.includes(this.opts.challenge)) throw new RangeError('challenge must be "next" or "any"');

    const deck = shuffle(makeDeck(this.opts.deck), this.rng);
    const h = this.opts.handSize;
    if (h !== null) {
      if (!Number.isInteger(h) || h < 1 || h * n > deck.length) throw new RangeError(`handSize too large for ${n} players and the ${this.opts.deck} deck`);
    }
    /** Ranks that exist in this deck (a rank outside it can never be a true announcement). */
    this.ranks = RANKS.filter((r) => deck.some((c) => c.rank === r));
    this.n = n;
    this.hands = Array.from({ length: n }, () => []);
    const dealt = h === null ? deck.length : h * n;
    for (let i = 0; i < dealt; i++) this.hands[i % n].push(deck[i]);
    this.hands.forEach(sortHand);

    this.out = Array(n).fill(false); // forfeited players
    this.removed = []; // cards that left the game with a forfeiting player
    this.pile = []; // { player, card, claim:{rank,suit} }
    this.lockedSuit = null;
    this.round = 1;
    const s = Number(opts.starter);
    this.turn = Number.isInteger(s) && s >= 0 && s < n ? s : 0;
    this.phase = 'play'; // 'play' | 'over'
    this.winner = null;
    this.endReason = null; // 'empty-hand' | 'forfeit'
  }

  /** The next player after `p` who is still in the game. */
  next(p) {
    for (let j = 1; j <= this.n; j++) {
      const q = (p + j) % this.n;
      if (!this.out[q]) return q;
    }
    return p;
  }

  active() {
    return this.out.reduce((a, o, i) => (o ? a : a.concat(i)), []);
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

    // the last card is always checked (the next player would challenge it anyway)
    if (hand.length === 0) return this._resolve(this.next(player), true);

    this.turn = this.next(player);
    return { type: 'played', player };
  }

  /** A player gives up (left, timed out, disconnected): they are out and their cards leave the game. */
  forfeit(player) {
    if (this.phase !== 'play') throw new RuleError('The game is over.');
    if (this.out[player]) throw new RuleError('You are out of this game.');
    this.out[player] = true;
    this.removed.push(...this.hands[player]);
    this.hands[player] = [];
    const left = this.active();
    if (left.length === 1) {
      this.phase = 'over';
      this.winner = left[0];
      this.turn = null;
      this.endReason = 'forfeit';
      return { type: 'forfeit', over: true, player };
    }
    if (this.turn === player) this.turn = this.next(player);
    return { type: 'forfeit', over: false, player };
  }

  /** Can `player` call "bluff" right now? */
  canChallenge(player) {
    if (this.phase !== 'play' || this.out[player] || !this.pile.length) return false;
    if (this.pile[this.pile.length - 1].player === player) return false;
    return this.opts.challenge === 'any' || this.turn === player;
  }

  /** Call "bluff" on the card that was just placed. */
  challenge(player) {
    if (this.opts.challenge !== 'any') this._assertTurn(player);
    else if (this.phase !== 'play') throw new RuleError('The game is over.');
    if (this.pile.length === 0) throw new RuleError('There is nothing to challenge yet.');
    if (!this.canChallenge(player)) throw new RuleError('You cannot challenge your own card.');
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
    if (!claim || !SUITS.includes(claim.suit) || !this.ranks.includes(claim.rank)) {
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

    const cards = this.pile.map((e) => e.card);
    if (this.out[loser]) {
      this.removed.push(...cards); // the liar has left the game: the pile goes with them
    } else {
      this.hands[loser].push(...cards);
      sortHand(this.hands[loser]);
    }
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

    // whoever was right starts the next round
    const starter = lie ? challenger : accused;
    this.turn = this.out[starter] ? this.next(starter) : starter;
    return { type: 'reveal', reveal, over: false };
  }

  // ---------- views ----------

  /** Everything player `p` is allowed to know. */
  view(p) {
    const myTurn = this.phase === 'play' && this.turn === p;
    const top = this.pile.length ? this.pile[this.pile.length - 1].player : null;
    return {
      you: p,
      players: this.n,
      phase: this.phase,
      winner: this.winner,
      endReason: this.endReason,
      announce: this.opts.announce,
      challengeMode: this.opts.challenge,
      ranks: this.ranks,
      round: this.round,
      turn: this.turn,
      lockedSuit: this.lockedSuit,
      hand: this.hands[p].map(pub),
      counts: this.hands.map((h) => h.length),
      out: this.out.slice(),
      oppCount: this.hands[this.next(p)].length, // 2 players: the opponent's count
      pile: {
        count: this.pile.length,
        top,
        claims: this.pile.map((e) => ({ by: e.player === p ? 'you' : 'opp', player: e.player, rank: e.claim.rank, suit: e.claim.suit })),
      },
      canPlay: myTurn && !this.out[p],
      canChallenge: this.canChallenge(p),
    };
  }
}

module.exports = { MeliGame, RuleError, SUITS, RANKS, DEFAULTS, ANNOUNCE_MODES, DECKS, CHALLENGE_MODES, MIN_PLAYERS, MAX_PLAYERS };

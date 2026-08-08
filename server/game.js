'use strict';

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
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

const MAX_TABLE_SLOTS = 6;

class Game {
  constructor(playerIds) {
    if (playerIds.length !== 2) throw new Error('MVP supports exactly 2 players');
    this.players = playerIds; // [idA, idB]
    this.hands = { [playerIds[0]]: [], [playerIds[1]]: [] };
    this.deck = shuffle(makeDeck());
    this.discard = [];
    this.trumpCard = null;
    this.trumpSuit = null;
    this.table = []; // [{attack, defend}]
    this.attackerId = null;
    this.defenderId = null;
    this.status = 'active'; // active | finished
    this.winnerId = null;
    this.durakId = null;
    this.log = [];

    this._deal();
  }

  _deal() {
    for (let i = 0; i < 6; i++) {
      for (const p of this.players) {
        if (this.deck.length) this.hands[p].push(this.deck.shift());
      }
    }
    // Trump = bottom card of remaining deck, stays visible until deck exhausted
    this.trumpCard = this.deck[this.deck.length - 1];
    this.trumpSuit = this.trumpCard.suit;

    // First attacker = player with lowest trump card
    let lowest = null;
    let starter = this.players[0];
    for (const p of this.players) {
      for (const c of this.hands[p]) {
        if (c.suit === this.trumpSuit) {
          if (!lowest || RANK_VALUE[c.rank] < RANK_VALUE[lowest]) {
            lowest = c.rank;
            starter = p;
          }
        }
      }
    }
    this.attackerId = starter;
    this.defenderId = this.players.find((p) => p !== starter);
    // Snapshot the defender's hand size *before* any attacks are thrown this
    // round — this is what caps how many attack cards can go down (up to 6),
    // not their hand size after they've already spent cards defending.
    this.roundStartHandSize = this.hands[this.defenderId].length;
  }

  other(playerId) {
    return this.players.find((p) => p !== playerId);
  }

  beats(attackCard, defendCard) {
    if (defendCard.suit === attackCard.suit) {
      return RANK_VALUE[defendCard.rank] > RANK_VALUE[attackCard.rank];
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

  // --- Actions ---

  attack(playerId, cardId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId !== this.attackerId) return { error: 'Nav tava kārta uzbrukt' };
    const hand = this.hands[playerId];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Kārts nav tavā rokā' };

    const isFirstCard = this.table.length === 0;
    if (!isFirstCard) {
      const ranks = this.ranksOnTable();
      if (!ranks.has(card.rank)) {
        return { error: 'Šis rangs vēl nav uz galda' };
      }
    }
    const cap = Math.min(MAX_TABLE_SLOTS, this.roundStartHandSize);
    if (this.table.length >= cap) {
      return { error: 'Uz galda vairs nav vietas' };
    }

    this.removeFromHand(playerId, cardId);
    this.table.push({ attack: card, defend: null });
    this.log.push(`${playerId} attacks with ${card.rank} of ${card.suit}`);
    return { ok: true };
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
    this.log.push(`${playerId} defends with ${card.rank} of ${card.suit}`);

    if (this.openSlots() === 0 && this.hands[this.attackerId].length === 0 && this.deck.length === 0) {
      // Nothing left for attacker to add; auto-resolve as a pass is left to explicit passTurn call from client for clarity
    }
    return { ok: true };
  }

  // Attacker declares no more cards to add -> successful defense, cards go to discard
  passTurn(playerId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId !== this.attackerId) return { error: 'Tikai uzbrucējs var beigt uzbrukumu' };
    if (this.table.length === 0) return { error: 'Uz galda vēl nav kāršu' };
    if (this.openSlots() > 0) return { error: 'Aizstāvim vēl ir neaizsargātas kārtis' };

    for (const slot of this.table) {
      this.discard.push(slot.attack, slot.defend);
    }
    this.table = [];
    this.log.push(`${playerId} ends the attack — round won by defense`);

    this._refillHands(this.attackerId, this.defenderId);
    // Defender becomes new attacker
    const prevDefender = this.defenderId;
    this.attackerId = prevDefender;
    this.defenderId = this.other(prevDefender);
    this.roundStartHandSize = this.hands[this.defenderId].length;

    return this._checkGameEnd() || { ok: true };
  }

  // Defender gives up on this round and takes all table cards into hand
  takeCards(playerId) {
    if (this.status !== 'active') return { error: 'Spēle ir beigusies' };
    if (playerId !== this.defenderId) return { error: 'Tikai aizstāvis var ņemt kārtis' };
    if (this.table.length === 0) return { error: 'Uz galda nav kāršu' };

    for (const slot of this.table) {
      this.hands[playerId].push(slot.attack);
      if (slot.defend) this.hands[playerId].push(slot.defend);
    }
    this.table = [];
    this.log.push(`${playerId} takes the cards`);

    this._refillHands(this.attackerId, this.defenderId);
    // Attacker stays the same, defender (who took) stays defender
    this.roundStartHandSize = this.hands[this.defenderId].length;
    return this._checkGameEnd() || { ok: true };
  }

  _refillHands(firstId, secondId) {
    for (const p of [firstId, secondId]) {
      while (this.hands[p].length < 6 && this.deck.length > 0) {
        this.hands[p].push(this.deck.shift());
      }
    }
  }

  _checkGameEnd() {
    if (this.deck.length > 0) return null;
    const [a, b] = this.players;
    const aEmpty = this.hands[a].length === 0;
    const bEmpty = this.hands[b].length === 0;
    if (aEmpty && bEmpty) {
      this.status = 'finished';
      this.log.push('Deck and both hands empty — draw, no durak!');
      return { ok: true, gameOver: true, draw: true };
    }
    if (aEmpty || bEmpty) {
      this.status = 'finished';
      this.winnerId = aEmpty ? a : b;
      this.durakId = aEmpty ? b : a;
      this.log.push(`${this.durakId} is the durak!`);
      return { ok: true, gameOver: true, winnerId: this.winnerId, durakId: this.durakId };
    }
    return null;
  }

  // Who currently owes an action, and what kind — used by server.js to run the
  // 60s move timer. During an active game there is always exactly one player
  // "on the clock"; if they never act, they forfeit.
  pendingActor() {
    if (this.status !== 'active') return null;
    if (this.openSlots() > 0) return { playerId: this.defenderId, kind: 'defend' };
    if (this.table.length > 0) return { playerId: this.attackerId, kind: 'attackDecision' };
    return { playerId: this.attackerId, kind: 'attackOpen' };
  }

  // Per-player view: hides opponent's hand (just count), reveals everything else
  viewFor(playerId) {
    const opponentId = this.other(playerId);
    return {
      you: playerId,
      opponent: opponentId,
      hand: this.hands[playerId],
      opponentCount: this.hands[opponentId].length,
      deckCount: this.deck.length,
      trumpCard: this.trumpCard,
      trumpSuit: this.trumpSuit,
      table: this.table,
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      yourRole: playerId === this.attackerId ? 'attacker' : 'defender',
      status: this.status,
      winnerId: this.winnerId,
      durakId: this.durakId,
      log: this.log.slice(-8),
    };
  }
}

module.exports = { Game, RANK_VALUE, SUITS, RANKS };

'use strict';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = (r) => RANKS.indexOf(r);

// A small, deliberately simple heuristic opponent — not meant to be hard to
// beat, just a reasonable stand-in for a second human player. Given a live
// Game instance, decides the one action the AI should take right now (or
// null if it isn't the AI's turn / there's nothing to do).
function chooseMove(game, aiId) {
  const pending = game.pendingActor();
  if (!pending || pending.playerId !== aiId) return null;

  if (pending.kind === 'defend') return chooseDefend(game, aiId);
  return chooseAttack(game, aiId, pending.kind);
}

function chooseAttack(game, aiId, kind) {
  if (kind === 'attackOpen') {
    const card = weakestCard(game.hands[aiId], game.trumpSuit);
    if (!card) return null;
    return { type: 'attack', cardId: card.id };
  }
  // attackDecision: everything currently on the table is already defended.
  // Keep the AI's behavior simple and predictable — don't pile on more
  // attack cards, just end the round.
  return { type: 'pass' };
}

function chooseDefend(game, aiId) {
  const slot = game.table.find((s) => !s.defend);
  if (!slot) return null;

  const beaters = game.hands[aiId]
    .filter((c) => game.beats(slot.attack, c))
    .sort((a, b) => cardCost(a, game.trumpSuit) - cardCost(b, game.trumpSuit));

  if (beaters.length === 0) return { type: 'take' };

  return { type: 'defend', cardId: beaters[0].id, slotIndex: game.table.indexOf(slot) };
}

function weakestCard(hand, trumpSuit) {
  if (hand.length === 0) return null;
  const nonTrump = hand.filter((c) => c.suit !== trumpSuit);
  const pool = nonTrump.length > 0 ? nonTrump : hand;
  return pool.reduce((min, c) => (rankValue(c.rank) < rankValue(min.rank) ? c : min), pool[0]);
}

// Trumps cost more to "spend" defensively than any non-trump, so the AI only
// reaches for one when it has no other card that beats the attack.
function cardCost(card, trumpSuit) {
  const base = rankValue(card.rank);
  return card.suit === trumpSuit ? base + 100 : base;
}

module.exports = { chooseMove };

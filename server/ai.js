'use strict';

const { SUITS, MAX_TABLE_SLOTS } = require('./game');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = (r) => RANKS.indexOf(r);
const HIGH_TRUMP_THRESHOLD = rankValue('10'); // rank index above this = J, Q, K, A
const STARTING_DECK_SIZE = 40; // 52 cards - 12 dealt (6 each) at game start

// A small, deliberately simple heuristic opponent — not meant to be hard to
// beat, just a reasonable stand-in for a second human player. Given a live
// Game instance, decides the one action the AI should take right now (or
// null if it isn't the AI's turn / there's nothing to do).
//
// Two things make it a bit sharper than pure "always play the weakest card":
//  1. Trump preservation — J/Q/K/A of the trump suit are treated as a
//     near-last-resort from the very first move, not just late game. Lower
//     trumps (2-10) are usable early on but get progressively more
//     expensive to spend as the deck runs low.
//  2. Card counting — the AI remembers every card that's been shown face-up
//     this game (Game#seenCards). When several cards are equally cheap to
//     open an attack with, it prefers whichever one has the fewest
//     still-unseen cards that could beat it.
function chooseMove(game, aiId) {
  const pending = game.pendingActor();
  if (!pending || pending.playerId !== aiId) return null;

  if (pending.kind === 'defend') return chooseDefend(game, aiId);
  return chooseAttack(game, aiId, pending.kind);
}

function chooseAttack(game, aiId, kind) {
  if (kind === 'attackOpen') {
    const card = bestOpeningCard(game, aiId);
    if (!card) return null;
    return { type: 'attack', cardId: card.id };
  }
  // attackDecision: everything currently on the table is already defended,
  // and the AI can choose to pile on another card of a rank already on the
  // table (real Duraks lets you "throw in" matching ranks) or end the round.
  return choosePileOn(game, aiId);
}

function choosePileOn(game, aiId) {
  const cap = Math.min(MAX_TABLE_SLOTS, game.roundStartHandSize);
  if (game.table.length >= cap) return { type: 'pass' };

  const ranks = game.ranksOnTable();
  const candidates = game.hands[aiId].filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return { type: 'pass' };

  const best = candidates.slice().sort((a, b) => cardCost(a, game) - cardCost(b, game))[0];
  // Even mid-round, a protected high trump isn't worth risking on a
  // speculative pile-on — better to keep it and just end the attack here.
  if (cardCost(best, game) >= 1000) return { type: 'pass' };

  return { type: 'attack', cardId: best.id };
}

function chooseDefend(game, aiId) {
  const slot = game.table.find((s) => !s.defend);
  if (!slot) return null;

  const beaters = game.hands[aiId]
    .filter((c) => game.beats(slot.attack, c))
    .sort((a, b) => cardCost(a, game) - cardCost(b, game));

  if (beaters.length === 0) return { type: 'take' };

  return { type: 'defend', cardId: beaters[0].id, slotIndex: game.table.indexOf(slot) };
}

// Picks which card to lead an attack with: cheapest first (see cardCost),
// and among cards tied for cheapest, the one fewest unseen cards could beat.
function bestOpeningCard(game, aiId) {
  const hand = game.hands[aiId];
  if (hand.length === 0) return null;
  if (hand.length === 1) return hand[0];

  const costs = hand.map((c) => cardCost(c, game));
  const minCost = Math.min(...costs);
  const cheapest = hand.filter((_, i) => costs[i] === minCost);
  if (cheapest.length === 1) return cheapest[0];

  const aiHandIds = new Set(hand.map((c) => c.id));
  return cheapest.reduce(
    (best, c) => (dangerScore(c, game, aiHandIds) < dangerScore(best, game, aiHandIds) ? c : best),
    cheapest[0]
  );
}

// How "expensive" it is to spend this card right now. Lower = happier to
// play it. Non-trumps only scale with rank. Trumps get an extra penalty:
//  - High trumps (J, Q, K, A of the trump suit) are always a near-last
//    resort, starting from the very first move of the game.
//  - Low/mid trumps (2-10) start out fairly usable, but become steadily
//    more expensive as the deck runs low — once the deck is empty there's
//    no replacing them, so they're worth saving for when they're needed.
function cardCost(card, game) {
  const base = rankValue(card.rank);
  if (card.suit !== game.trumpSuit) return base;

  if (rankValue(card.rank) > HIGH_TRUMP_THRESHOLD) {
    return 1000 + base;
  }

  const deckPhase = Math.max(0, Math.min(1, 1 - game.deck.length / STARTING_DECK_SIZE));
  return base + deckPhase * 40;
}

// Rough "how risky is this attack card" score: counts how many still-unseen
// cards (not in the AI's own hand, not already shown face-up this game)
// could beat it. Lower is safer to lead with. This is card counting, not
// mind-reading — the AI has no idea which of those unseen cards the
// opponent actually holds versus what's still sitting in the deck, only
// that they're the ones mathematically still in play.
function dangerScore(card, game, aiHandIds) {
  const seen = game.seenCards;
  let danger = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const id = `${rank}-${suit}`;
      if (id === card.id || seen.has(id) || aiHandIds.has(id)) continue;
      if (game.beats(card, { suit, rank })) danger++;
    }
  }
  return danger;
}

module.exports = { chooseMove };

'use strict';

/**
 * server/ai-multi.js
 *
 * Heuristic opponent for the multiplayer (2-4 player) Duraks engine
 * (games/duraks-multi.js). This is a separate module from ai.js on
 * purpose — ai.js is tightly coupled to the 2-player engine's shape
 * (game.other(), a single pendingActor(), an 'attackDecision' kind that
 * only ever applies to the attacker) and calling it against the
 * multiplayer engine would either throw or make wrong decisions, since
 * that engine has multiple opponents, an array of *simultaneous* pending
 * actors, and a turn-based throw-in rotation that ai.js knows nothing
 * about.
 *
 * Same "deliberately simple, reasonable stand-in" philosophy as ai.js:
 * trump preservation (low trumps spendable early, high trumps a
 * near-last-resort, both getting pricier as the deck depletes) plus
 * basic card counting for which cheap card is safest to lead with. The
 * throw-in decision (this engine's equivalent of ai.js's "pile on or end
 * the attack") uses the same cost logic, and applies whether this bot is
 * the original attacker continuing to add cards or another player taking
 * their turn in the throw-in rotation — mechanically the action is
 * identical either way (attack() with a matching-rank card, or decline).
 */

const { SUITS, RANKS, MAX_TABLE_SLOTS } = require('./games/duraks-multi');

const rankValue = (r) => RANKS.indexOf(r);
const HIGH_TRUMP_THRESHOLD = rankValue('10'); // rank index above this = J, Q, K, A

// Called once per game tick per bot seat — server.js is expected to check
// every AI-controlled player against game.pendingActors() and call this
// for whichever one(s) currently have something to do (unlike the
// 2-player engine, more than one seat's action can be pending at once,
// though never for the *same* seat twice — a player is never both the
// defender and in the throw-in rotation simultaneously).
function chooseMove(game, aiId) {
  const mine = game.pendingActors().find((a) => a.playerId === aiId);
  if (!mine) return null;

  if (mine.kind === 'defend') return chooseDefend(game, aiId);
  if (mine.kind === 'attackOpen') return chooseOpenAttack(game, aiId);
  if (mine.kind === 'throwInDecision') return chooseThrowIn(game, aiId);
  return null;
}

function chooseOpenAttack(game, aiId) {
  const card = bestOpeningCard(game, aiId);
  if (!card) return null;
  return { type: 'attack', cardId: card.id };
}

// This bot's turn in the throw-in rotation: add a matching-rank card, or
// decline. Applies the same whether this bot originally opened the
// attack or is another active player further along in the rotation.
function chooseThrowIn(game, aiId) {
  const cap = Math.min(MAX_TABLE_SLOTS, game.roundStartHandSize);
  if (game.table.length >= cap) return { type: 'declineThrowIn' };

  const ranks = game.ranksOnTable();
  const candidates = game.hands[aiId].filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return { type: 'declineThrowIn' };

  const best = candidates.slice().sort((a, b) => cardCost(a, game) - cardCost(b, game))[0];
  // A protected high trump isn't worth risking on a speculative throw-in
  // — better to keep it and decline this turn.
  if (cardCost(best, game) >= 1000) return { type: 'declineThrowIn' };

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

// How "expensive" it is to spend this card right now — same shape as
// ai.js, but the deck's starting size after dealing depends on how many
// players are seated (52 - 6 per player), not a fixed 40.
function cardCost(card, game) {
  const base = rankValue(card.rank);
  if (card.suit !== game.trumpSuit) return base;

  if (rankValue(card.rank) > HIGH_TRUMP_THRESHOLD) {
    return 1000 + base;
  }

  const startingDeckSize = 52 - 6 * game.players.length;
  const deckPhase = Math.max(0, Math.min(1, 1 - game.deck.length / startingDeckSize));
  return base + deckPhase * 40;
}

// Same card-counting idea as ai.js, generalized to however many opponents
// there are: counts still-unseen cards (not in this bot's own hand, not
// already shown face-up) that could beat the given card. With more
// players at the table there's naturally a larger unseen pool, but that's
// fine — this is only ever compared against other candidates within the
// same hand at the same moment, not across games with different player
// counts.
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

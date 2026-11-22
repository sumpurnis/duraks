'use strict';

/**
 * The daily challenge's computer opponent: it knows the whole deal — the player's hand and the
 * order of the deck — and looks ahead by playing each possible move out to the end of the game.
 *
 *   chooseChallengeMove(game, aiId, skill, rng)
 *
 * skill (0..1) is how often it uses that look-ahead; the rest of the time it plays like the
 * ordinary computer (ai-multi.js). The challenge's levels are different skills, tuned so that a
 * typical player wins about the target share of games (see challenges.js: calibrate()).
 *
 * Everything random goes through `rng`, which the room seeds from the deal, the level and the
 * number of the decision — so the same moves by the player always get the same answers.
 */

const { chooseMove } = require('./ai-multi');
const { MAX_TABLE_SLOTS } = require('./games/duraks-multi');

const STEP_LIMIT = 600; // a played-out game is far shorter; this only guards against a loop

/** A seeded random number generator (mulberry32). */
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of a string (FNV-1a), for seeds. */
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An independent copy of a game to try things on (the real game is never touched). */
function cloneGame(game) {
  const c = structuredClone(game);
  Object.setPrototypeOf(c, Object.getPrototypeOf(game));
  c.deferAutoResolve = false; // copies clear the table by themselves
  return c;
}

/** Every move `pid` may make right now. */
function legalMoves(game, pid) {
  const mine = game.pendingActors().find((a) => a.playerId === pid);
  if (!mine) return [];
  const hand = game.hands[pid];
  const moves = [];
  if (mine.kind === 'attackOpen') {
    for (const c of hand) moves.push({ type: 'attack', cardId: c.id });
  } else if (mine.kind === 'throwInDecision') {
    const cap = Math.min(MAX_TABLE_SLOTS, game.roundStartHandSize);
    if (game.table.length < cap) {
      const ranks = game.ranksOnTable();
      for (const c of hand) if (ranks.has(c.rank)) moves.push({ type: 'attack', cardId: c.id });
    }
    moves.push({ type: 'declineThrowIn' });
  } else if (mine.kind === 'defend') {
    game.table.forEach((slot, i) => {
      if (slot.defend) return;
      for (const c of hand) if (game.beats(slot.attack, c)) moves.push({ type: 'defend', cardId: c.id, slotIndex: i });
    });
    if (game.canTransfer && game.canTransfer(pid)) {
      const ranks = game.ranksOnTable();
      for (const c of hand) if (ranks.has(c.rank)) moves.push({ type: 'transfer', cardId: c.id });
    }
    moves.push({ type: 'take' });
  }
  return moves;
}

function apply(game, pid, mv) {
  if (!mv) return { error: 'no move' };
  if (mv.type === 'attack') return game.attack(pid, mv.cardId);
  if (mv.type === 'defend') return game.defend(pid, mv.cardId, mv.slotIndex);
  if (mv.type === 'transfer') return game.transferCards(pid, mv.cardId);
  if (mv.type === 'declineThrowIn') return game.declineThrowIn(pid);
  if (mv.type === 'take') return game.takeCards(pid);
  return { error: 'unknown move' };
}

const sameMove = (a, b) => !!a && !!b && a.type === b.type && a.cardId === b.cardId && (a.slotIndex === undefined || a.slotIndex === b.slotIndex);

/** One step of a played-out game: the ordinary computer's move, now and then a random one. */
function policyMove(game, pid, rng, noise) {
  if (noise > 0 && rng() < noise) {
    const all = legalMoves(game, pid);
    if (all.length) return all[Math.floor(rng() * all.length)];
  }
  return chooseMove(game, pid) || legalMoves(game, pid)[0];
}

/** Play a copied game to the end. 1 = `me` is not the durak, 0 = `me` is, 0.5 = a draw. */
function playOut(game, me, rng, noise) {
  for (let step = 0; step < STEP_LIMIT && game.status === 'active'; step++) {
    if (game.isRoundResolvable && game.isRoundResolvable()) { game.tryResolveRound(); continue; }
    if (game.isTakeResolvable && game.isTakeResolvable()) { game.tryResolveTake(); continue; }
    const actors = game.pendingActors();
    if (!actors.length) break;
    const a = actors[0];
    const r = apply(game, a.playerId, policyMove(game, a.playerId, rng, noise));
    if (r && r.error) {
      // fall back to any move the engine accepts
      const ok = legalMoves(game, a.playerId).some((m) => { const x = apply(game, a.playerId, m); return !(x && x.error); });
      if (!ok) break;
    }
  }
  if (game.status !== 'finished') return 0.5;
  if (!game.durakId) return 0.5;
  return game.durakId === me ? 0 : 1;
}

/** The best move found by playing every option out a few times (it sees all the cards). */
function lookAheadMove(game, me, rng, rollouts = 6, noise = 0.12) {
  const moves = legalMoves(game, me);
  if (moves.length <= 1) return moves[0] || null;
  const usual = chooseMove(game, me);
  let best = null;
  let bestScore = -1;
  for (const mv of moves) {
    let score = 0;
    for (let i = 0; i < rollouts; i++) {
      const g = cloneGame(game);
      const r = apply(g, me, mv);
      if (r && r.error) { score = -1; break; }
      score += playOut(g, me, rng, noise);
    }
    if (score < 0) continue;
    score /= rollouts;
    // ties go to the ordinary computer's choice, so it never plays oddly for no reason
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && sameMove(mv, usual))) {
      best = mv;
      bestScore = score;
    }
  }
  return best || usual || moves[0];
}

function chooseChallengeMove(game, aiId, skill, rng) {
  if (rng() < skill) return lookAheadMove(game, aiId, rng);
  return chooseMove(game, aiId) || legalMoves(game, aiId)[0] || null;
}

module.exports = { chooseChallengeMove, lookAheadMove, legalMoves, apply, cloneGame, playOut, policyMove, seededRng, hashSeed };

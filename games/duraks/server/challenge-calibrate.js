'use strict';

/**
 * Picks the day's deal and tunes the computer's strength for each level, by simulation.
 *
 *   calibrate(date, targets, opts) -> { seed, deck, skills, measured, deal }
 *
 * The stand-in for a typical player is the ordinary computer (ai-multi.js) that also makes a random
 * move one time in ten. For every level the strength (0..1, see challenge-ai.js) is searched so that
 * this stand-in wins about the target share (e.g. 0.20 / 0.10 / 0.05). Real people play differently,
 * so the real win rates are counted per level as well (challenges.js) and shown to the admin.
 *
 * A deal is used only if it can reach every target: the stand-in must win clearly more often than the
 * easiest target against a plain computer, and less often than the hardest one at full strength.
 * Run in a worker thread (challenge-worker.js): it takes about a minute.
 */

const { Game, makeDeck, ranksForDeckSize } = require('./games/duraks-multi');
const ai = require('./challenge-ai');

const DECK_SIZE = 36;
const PLAYER = 'P';
const COMPUTER = 'AI';
const PLAYER_NOISE = 0.1;

function dealFor(seed) {
  const r = ai.seededRng(seed);
  const d = makeDeck(ranksForDeckSize(DECK_SIZE));
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d.map((c) => ({ suit: c.suit, rank: c.rank }));
}

/** One simulated game: 1 if the stand-in player wins (the computer is the durak), 0 if not, 0.5 draw. */
function simulate(deck, skill, seed) {
  const g = new Game([PLAYER, COMPUTER], { deckSize: DECK_SIZE, deck });
  const rng = ai.seededRng(seed);
  for (let s = 0; s < 600 && g.status === 'active'; s++) {
    if (g.isRoundResolvable()) { g.tryResolveRound(); continue; }
    if (g.isTakeResolvable()) { g.tryResolveTake(); continue; }
    const a = g.pendingActors()[0];
    if (!a) break;
    const mv = a.playerId === COMPUTER ? ai.chooseChallengeMove(g, COMPUTER, skill, rng) : ai.policyMove(g, PLAYER, rng, PLAYER_NOISE);
    const r = ai.apply(g, a.playerId, mv);
    if (r && r.error) break;
  }
  if (g.status !== 'finished' || !g.durakId) return 0.5;
  return g.durakId === COMPUTER ? 1 : 0;
}

function winRate(deck, skill, n, seedBase) {
  let w = 0;
  for (let i = 0; i < n; i++) w += simulate(deck, skill, seedBase + i * 7919);
  return w / n;
}

/** The strength at which the stand-in wins about `target` (win rate falls as strength rises). */
function searchSkill(deck, target, n, steps, seedBase) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (winRate(deck, mid, n, seedBase + i * 104729) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function calibrate(date, targets, opts = {}) {
  const n = opts.sims || 150;
  const steps = opts.steps || 7;
  const tries = opts.tries || 25;
  const easiest = Math.max(...targets);
  const hardest = Math.min(...targets);
  let fallback = null;
  for (let k = 0; k < tries; k++) {
    const seed = ai.hashSeed(`duraks-daily:${date}:${k}`);
    const deck = dealFor(seed);
    const plain = winRate(deck, 0, Math.ceil(n / 2), seed);
    if (plain < easiest + 0.12) continue; // too hard even against the plain computer
    const full = winRate(deck, 1, Math.ceil(n / 3), seed + 1);
    if (!fallback || full < fallback.full) fallback = { seed, deck, full, plain };
    if (full > hardest) continue; // can't be made hard enough
    return finish(seed, deck, plain, full);
  }
  // no deal met both conditions: use the one that can be made hardest
  if (!fallback) {
    const seed = ai.hashSeed(`duraks-daily:${date}:0`);
    fallback = { seed, deck: dealFor(seed), plain: null, full: null };
  }
  return finish(fallback.seed, fallback.deck, fallback.plain, fallback.full);

  function finish(seed, deck, plain, full) {
    const skills = targets.map((t, i) => searchSkill(deck, t, n, steps, seed + 31 * (i + 1)));
    // a harder level is never weaker than an easier one (sampling noise could swap them)
    const order = targets.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]);
    for (let j = 1; j < order.length; j++) {
      const prev = skills[order[j - 1][1]];
      if (skills[order[j][1]] < prev) skills[order[j][1]] = prev;
    }
    const measured = skills.map((s, i) => winRate(deck, s, n, seed + 977 * (i + 1)));
    return { seed, deck, skills, measured, plain, full };
  }
}

module.exports = { calibrate, dealFor, simulate, winRate };

'use strict';

/**
 * The ordinary Duraks computer that slowly adapts to the table's host.
 *
 * Only in casual games of one account holder against computers (no ranked, tournament or
 * daily-challenge tables, no guests, no tables with other people). The host's last 10 such games
 * set two things, fixed at the start of each game and never changed during one:
 *
 *   strength  -0.25 … 0.8. Above 0 it is the share of decisions on which the computer looks ahead
 *             (plays each option out a few times); below 0 it is the share of decisions on which it
 *             makes a loose move. 0 is exactly the old computer, which is where everyone starts.
 *             After each game it moves at most STEP towards whatever keeps the host's results near
 *             the target (a little over an even share), so the change is hard to notice.
 *   habits    how often the host takes when they could have beaten every card, passes up a
 *             throw-in they could make, and transfers when they can. The look-ahead imagines the
 *             host playing like that on part (HABIT_WEIGHT) of their moves, so it leans into the
 *             host's habits a bit, without betting everything on them.
 *
 * It does not cheat: the look-ahead never sees the real hidden cards. Before every played-out game
 * it deals the cards it cannot know at random — everything except its own hand, the table, the
 * discard pile, the trump at the bottom of the deck, and cards it saw someone pick up from the
 * table (or the face-up trump being drawn).
 */

const path = require('path');
const { chooseMove } = require('./ai-multi');
const { legalMoves, apply, cloneGame } = require('./challenge-ai');
const { makeDeck } = require('./games/duraks-multi');

const WINDOW = 10; // games remembered per player
const MIN_GAMES = 3; // strength stays put until this many games are known
const STEP = 0.03; // most the strength moves after one game
const GAIN = 0.12; // how hard it reacts to results above / below the target
const MIN_STRENGTH = -0.25;
const MAX_STRENGTH = 0.8;
const HABIT_WEIGHT = 0.35; // share of the host's imagined moves that follow their habits
const ROLLOUTS = 6;
const STEP_LIMIT = 600;

// --- storage -------------------------------------------------------------------------------------

let store = null;
let saver = null;

function ensureStore() {
  if (store) return store;
  const persist = require('../../../platform/persist');
  const { DATA_DIR } = require('../../../platform/config');
  const file = path.join(DATA_DIR, 'duraks-adaptive.json');
  const loaded = persist.loadJson(file, () => ({ players: {} }), 'duraks-adaptive.json');
  store = { players: loaded && typeof loaded.players === 'object' && loaded.players ? loaded.players : {} };
  saver = persist.createSaver(file, () => store, { label: 'duraks-adaptive.json' });
  return store;
}

/** For tests: keep everything in memory. */
function _useMemoryStore() {
  store = { players: {} };
  saver = { save() {} };
}

function profileOf(username) {
  const s = ensureStore();
  const p = s.players[username];
  if (p && Array.isArray(p.games)) return p;
  return { strength: 0, games: [] };
}

// --- what the host's games say -------------------------------------------------------------------

/** A fair result for an even player: not being the durak at an N-player table. */
function targetFor(totalPlayers) {
  const n = Math.max(2, totalPlayers || 2);
  return Math.min(0.85, (n - 1) / n + 0.05);
}

function rate(hits, chances, prior) {
  // a few imagined decisions at the old computer's own habit keep small samples from swinging
  return (hits + prior * 4) / (chances + 4);
}

function habitsOf(games) {
  const sum = { dc: 0, at: 0, tc: 0, td: 0, xc: 0, xt: 0 };
  for (const g of games) for (const k of Object.keys(sum)) sum[k] += (g.c && g.c[k]) || 0;
  return {
    take: rate(sum.at, sum.dc, 0), // took although every open card could be beaten
    decline: rate(sum.td, sum.tc, 0), // passed up a throw-in they could make
    transfer: rate(sum.xt, sum.xc, 1), // transferred when they could
  };
}

/** The settings for one new game of `username`, or null for the old computer. */
function settingsFor(username) {
  const p = profileOf(username);
  const known = Math.min(1, p.games.length / WINDOW);
  return {
    strength: p.strength || 0,
    habits: habitsOf(p.games),
    habitWeight: HABIT_WEIGHT * known,
  };
}

/** After a game: remember it and nudge the strength. Returns the new strength. */
function recordGame(username, { durak, draw, totalPlayers, counts }) {
  const s = ensureStore();
  const p = profileOf(username);
  const target = targetFor(totalPlayers);
  const score = draw ? target : durak ? 0 : 1;
  p.games = [...p.games, { s: score, t: target, c: counts || {} }].slice(-WINDOW);
  if (p.games.length >= MIN_GAMES) {
    const off = p.games.reduce((a, g) => a + (g.s - g.t), 0) / p.games.length;
    const move = Math.max(-STEP, Math.min(STEP, GAIN * off));
    p.strength = Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, (p.strength || 0) + move));
  }
  p.strength = Math.round((p.strength || 0) * 1000) / 1000;
  s.players[username] = p;
  saver.save();
  return p.strength;
}

// --- one game ------------------------------------------------------------------------------------

/** The state a table keeps for the adaptive computer, made when the game starts. */
function startGame(username) {
  return {
    host: username,
    ...settingsFor(username),
    known: {}, // player -> Set of card ids everyone saw go into their hand
    counts: { dc: 0, at: 0, tc: 0, td: 0, xc: 0, xt: 0 },
  };
}

function canBeatAllOpen(game, pid) {
  const open = game.table.filter((s) => !s.defend);
  if (!open.length) return false;
  const hand = game.hands[pid] || [];
  return open.every((slot) => hand.some((c) => game.beats(slot.attack, c)));
}

function canThrowInSomething(game, pid) {
  const cap = Math.min(6, game.roundStartHandSize);
  if (game.table.length >= cap) return false;
  const ranks = game.ranksOnTable();
  return (game.hands[pid] || []).some((c) => ranks.has(c.rank));
}

function canTransferSomething(game, pid) {
  if (!game.canTransfer || !game.canTransfer(pid)) return false;
  const ranks = game.ranksOnTable();
  return (game.hands[pid] || []).some((c) => ranks.has(c.rank));
}

/**
 * Call before the host's move is applied: which of the decisions their habits are made of this
 * move is. Returns a note for count() once the game has accepted the move (a refused move counts
 * for nothing).
 */
function observe(state, game, pid, type) {
  if (!state || pid !== state.host || game.status !== 'active') return null;
  const mine = game.pendingActors().find((a) => a.playerId === pid);
  if (!mine) return null;
  const c = { dc: 0, at: 0, tc: 0, td: 0, xc: 0, xt: 0 };
  if (mine.kind === 'defend') {
    if ((type === 'take' || type === 'defend' || type === 'transfer') && canBeatAllOpen(game, pid)) {
      c.dc++;
      if (type === 'take') c.at++;
    }
    if ((type === 'take' || type === 'defend' || type === 'transfer') && canTransferSomething(game, pid)) {
      c.xc++;
      if (type === 'transfer') c.xt++;
    }
  } else if (mine.kind === 'throwInDecision') {
    if ((type === 'attack' || type === 'declineThrowIn') && canThrowInSomething(game, pid)) {
      c.tc++;
      if (type === 'declineThrowIn') c.td++;
    }
  }
  return c;
}

function count(state, note) {
  if (!state || !note) return;
  for (const k of Object.keys(note)) state.counts[k] = (state.counts[k] || 0) + note[k];
}

/** Call just before a pickup is carried out: everyone sees which cards the defender takes. */
function noteTake(state, game) {
  if (!state || !game.pendingTake) return;
  const pid = game.defenderId;
  const set = state.known[pid] || (state.known[pid] = new Set());
  for (const slot of game.table) {
    set.add(slot.attack.id);
    if (slot.defend) set.add(slot.defend.id);
  }
}

// --- deciding ------------------------------------------------------------------------------------

function shuffleWith(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A copy of the game in which every card `me` cannot know is dealt at random; null if the
 * bookkeeping doesn't add up (then the caller just plays the ordinary move).
 */
function determinize(game, me, known, rng) {
  const out = new Set();
  for (const c of game.hands[me]) out.add(c.id);
  for (const c of game.discard) out.add(c.id);
  for (const s of game.table) { out.add(s.attack.id); if (s.defend) out.add(s.defend.id); }
  const trumpInDeck = game.deck.length > 0;
  if (trumpInDeck) out.add(game.trumpCard.id);

  const others = game.players.filter((p) => p !== me);
  const fixed = {};
  for (const p of others) {
    const hand = game.hands[p];
    const ids = new Set(hand.map((c) => c.id));
    // cards seen going into the hand that are still there (anything played since was seen leaving)
    const keep = hand.filter((c) => known[p] && known[p].has(c.id));
    // the face-up trump went to whoever drew the last card — everyone saw it
    if (!trumpInDeck && ids.has(game.trumpCard.id) && !keep.some((c) => c.id === game.trumpCard.id)) {
      keep.push(game.trumpCard);
    }
    fixed[p] = keep;
    for (const c of keep) out.add(c.id);
  }

  const pool = shuffleWith(makeDeck(game.ranks).filter((c) => !out.has(c.id)), rng);
  let need = trumpInDeck ? game.deck.length - 1 : 0;
  for (const p of others) need += game.hands[p].length - fixed[p].length;
  if (need !== pool.length) return null;

  const g = cloneGame(game);
  let i = 0;
  for (const p of others) {
    const extra = game.hands[p].length - fixed[p].length;
    g.hands[p] = [...fixed[p].map((c) => ({ ...c })), ...pool.slice(i, i + extra)];
    i += extra;
  }
  g.deck = trumpInDeck ? [...pool.slice(i), { ...game.trumpCard }] : [];
  return g;
}

/** How the look-ahead imagines a move: the host now and then by their habits, otherwise as usual. */
function imaginedMove(game, pid, state, rng) {
  if (pid === state.host && state.habitWeight > 0 && rng() < state.habitWeight) {
    const mine = game.pendingActors().find((a) => a.playerId === pid);
    const h = state.habits;
    if (mine && mine.kind === 'defend' && !game.pendingTake) {
      if (canTransferSomething(game, pid) && rng() < h.transfer) {
        const ranks = game.ranksOnTable();
        const card = game.hands[pid].find((c) => ranks.has(c.rank));
        if (card) return { type: 'transfer', cardId: card.id };
      }
      if (canBeatAllOpen(game, pid) && rng() < h.take) return { type: 'take' };
    } else if (mine && mine.kind === 'throwInDecision' && canThrowInSomething(game, pid) && rng() < h.decline) {
      return { type: 'declineThrowIn' };
    }
  }
  return chooseMove(game, pid) || legalMoves(game, pid)[0];
}

function playOut(game, me, state, rng) {
  for (let step = 0; step < STEP_LIMIT && game.status === 'active'; step++) {
    if (game.isRoundResolvable()) { game.tryResolveRound(); continue; }
    if (game.isTakeResolvable()) { game.tryResolveTake(); continue; }
    const actors = game.pendingActors();
    if (!actors.length) break;
    const a = actors[0];
    const r = apply(game, a.playerId, imaginedMove(game, a.playerId, state, rng));
    if (r && r.error) {
      const ok = legalMoves(game, a.playerId).some((m) => { const x = apply(game, a.playerId, m); return !(x && x.error); });
      if (!ok) break;
    }
  }
  if (game.status !== 'finished' || !game.durakId) return 0.5;
  return game.durakId === me ? 0 : 1;
}

const sameMove = (a, b) => !!a && !!b && a.type === b.type && a.cardId === b.cardId && (a.slotIndex === undefined || a.slotIndex === b.slotIndex);

function lookAhead(game, me, state, rng) {
  const moves = legalMoves(game, me);
  const usual = chooseMove(game, me);
  if (moves.length <= 1) return moves[0] || usual;
  let best = null;
  let bestScore = -1;
  for (const mv of moves) {
    let score = 0;
    let n = 0;
    for (let i = 0; i < ROLLOUTS; i++) {
      const g = determinize(game, me, state.known, rng);
      if (!g) return usual;
      const r = apply(g, me, mv);
      if (r && r.error) { n = 0; break; }
      score += playOut(g, me, state, rng);
      n++;
    }
    if (!n) continue;
    score /= n;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && sameMove(mv, usual))) {
      best = mv;
      bestScore = score;
    }
  }
  return best || usual || moves[0];
}

/** The computer's move at an adaptive table. */
function chooseAdaptiveMove(state, game, botId, rng = Math.random) {
  const usual = () => chooseMove(game, botId) || legalMoves(game, botId)[0] || null;
  if (!state) return usual();
  const s = state.strength || 0;
  if (s > 0 && rng() < s) return lookAhead(game, botId, state, rng);
  if (s < 0 && rng() < -s) {
    const all = legalMoves(game, botId);
    if (all.length) return all[Math.floor(rng() * all.length)];
  }
  return usual();
}

module.exports = {
  startGame,
  observe,
  count,
  noteTake,
  recordGame,
  settingsFor,
  chooseAdaptiveMove,
  determinize,
  targetFor,
  _useMemoryStore,
  WINDOW,
  STEP,
  MIN_STRENGTH,
  MAX_STRENGTH,
};

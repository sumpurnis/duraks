'use strict';

/**
 * store.js
 * Persistence + registry for tournaments, kept deliberately separate from
 * the core game files (server/game.js, server/ai.js, server/users.js are
 * untouched by this module — the only thing it reads from users.js-land is
 * a plain stats object passed in from server.js).
 *
 * Responsibilities:
 *  - Load/save tournaments to disk (mirrors the users.js persistence style)
 *  - Public vs private visibility: private tournaments never appear in the
 *    public list and can only be found via their invite code
 *  - A separate tournament-results store, itself split into public/private
 *    buckets per player — private tournaments can be rigged by a friend
 *    group to farm placements, so they must never count toward a player's
 *    public competitive record
 *  - A simple, tunable rating adapter so Duraks's {played, won, winRate}
 *    stats can feed the imported Tournament class's rating-based
 *    eligibility check, since Duraks has no native ELO/rating number
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Tournament, ABSOLUTE_MIN_PARTICIPANTS } = require('./tournament');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOURNAMENTS_FILE = path.join(DATA_DIR, 'tournaments.json');
const RESULTS_FILE = path.join(DATA_DIR, 'tournament-results.json');

// A player must have at least this many completed real games before they're
// allowed to CREATE a tournament (Duraks has no formal rank/rating system
// yet, so "established player" is approximated by games played). Tunable —
// separate from requiredRank, which is a per-tournament JOIN gate the
// organizer sets themselves.
const MIN_GAMES_TO_CREATE = 0;

// --- persistence -----------------------------------------------------------

function loadTournaments() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOURNAMENTS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch {
    return {}; // username -> { public: {...}, private: {...} }
  }
}

// Live registry: id -> Tournament instance. Rehydrated from disk on startup.
const registry = new Map();
let results = loadResults();

function rehydrate(raw) {
  const t = new Tournament({
    id: raw.id,
    name: raw.name,
    createdBy: raw.createdBy,
    isPrivate: raw.isPrivate,
    inviteCode: raw.inviteCode,
    requiredRank: raw.requiredRank,
    maxParticipants: raw.maxParticipants,
    minParticipants: raw.minParticipants,
    seriesFormat: raw.seriesFormat,
    registrationEndTime: raw.registrationEndTime,
    startTime: raw.startTime,
    prizePool: raw.prizePool,
    prizeDistribution: raw.prizeDistribution
  });
  t.status = raw.status;
  t.cancelReason = raw.cancelReason || null;
  t.withdrawnPlayers = raw.withdrawnPlayers || [];
  t.participants = raw.participants || [];
  t.bracket = raw.bracket || null;
  t.createdAt = new Date(raw.createdAt);
  return t;
}

(function initFromDisk() {
  for (const raw of loadTournaments()) {
    try {
      registry.set(raw.id, rehydrate(raw));
    } catch (err) {
      // Skip a corrupt/incompatible saved tournament rather than crash boot.
      console.error('Failed to rehydrate tournament', raw && raw.id, err.message);
    }
  }
})();

function persistTournaments() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const serializable = [...registry.values()];
  fs.writeFileSync(TOURNAMENTS_FILE, JSON.stringify(serializable, null, 2));
}

function persistResults() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

// --- ids / invite codes ------------------------------------------------

function makeId() {
  return 't-' + crypto.randomBytes(6).toString('hex');
}

function makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while ([...registry.values()].some((t) => t.inviteCode === code));
  return code;
}

// --- stats adapter -------------------------------------------------------

/**
 * Turns Duraks's {played, won, ...} stats into a simple monotonic rating
 * number for the imported Tournament class's rating-based eligibility gate.
 * Deliberately simple and easy to retune later — not a real ELO system.
 */
function statsToRating(stats) {
  if (!stats) return 1000;
  const winPct = stats.played > 0 ? (stats.won / stats.played) * 100 : 0;
  return Math.round(1000 + stats.won * 10 + winPct * 3);
}

function canCreateTournament(stats) {
  return !!stats && stats.played >= MIN_GAMES_TO_CREATE;
}

// --- CRUD ------------------------------------------------------------------

/**
 * @param {Object} config - same shape as the Tournament constructor, minus
 *   id/inviteCode which this function assigns.
 */
function createTournament(config) {
  const id = makeId();
  const inviteCode = config.isPrivate ? makeInviteCode() : null;
  const tournament = new Tournament({ ...config, id, inviteCode });
  registry.set(id, tournament);
  persistTournaments();
  return tournament;
}

function getTournament(id) {
  return registry.get(id) || null;
}

function getTournamentByInviteCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return [...registry.values()].find((t) => t.inviteCode === normalized) || null;
}

function listAll() {
  return [...registry.values()];
}

/** Public list: open, browsable tournaments anyone can see and join. Never
 *  includes private tournaments — those are only reachable via invite code
 *  or if the user already created/joined one (see listForUser). */
function listPublic() {
  return [...registry.values()]
    .filter((t) => !t.isPrivate)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Everything a given user should see: all public tournaments, plus any
 *  private tournament they created or already joined. */
function listForUser(username) {
  return [...registry.values()]
    .filter((t) => !t.isPrivate || t.createdBy === username || t.hasJoined(username))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Permanently removes a tournament. Access control (who's allowed to call
 *  this) is enforced by the caller (server.js) — this just does the
 *  deletion once permission's already been checked. */
function deleteTournament(id) {
  const existed = registry.delete(id);
  if (existed) persistTournaments();
  return existed;
}

/** Deletes every completed tournament in one pass. Returns the count
 *  removed. Access control is enforced by the caller. */
function deleteAllCompleted() {
  let count = 0;
  for (const t of listAll()) {
    if (t.status === 'completed') {
      registry.delete(t.id);
      count++;
    }
  }
  if (count > 0) persistTournaments();
  return count;
}

function joinTournament(id, player) {
  const t = getTournament(id);
  if (!t) throw new Error('Tournament not found');
  t.join(player);
  persistTournaments();
  return t;
}

function leaveTournament(id, username) {
  const t = getTournament(id);
  if (!t) throw new Error('Tournament not found');
  const left = t.leave(username);
  if (left) persistTournaments();
  return t;
}

function cancelTournament(id, reason) {
  const t = getTournament(id);
  if (!t) throw new Error('Tournament not found');
  t.status = 'cancelled';
  t.cancelReason = reason || null;
  persistTournaments();
  return t;
}

function closeRegistrationAndGenerateBracket(id, generateBracketFn) {
  const t = getTournament(id);
  if (!t) throw new Error('Tournament not found');
  if (!t.canGenerateBracket()) {
    throw new Error(
      `Need at least ${t.minParticipants} participants to start (have ${t.participants.length})`
    );
  }
  t.status = 'active';
  t.bracket = generateBracketFn(t);
  persistTournaments();
  return t;
}

// --- results / placement history (public vs private, kept isolated) ------

function blankResultsBucket() {
  return { tournamentsPlayed: 0, wins: 0, placements: [] }; // placements: [{tournamentId, tournamentName, placement, at}]
}

function blankUserResults() {
  return { public: blankResultsBucket(), private: blankResultsBucket() };
}

/** Records a final placement for one player in one tournament. isPrivate
 *  determines which isolated bucket it lands in — this is the anti-rigging
 *  boundary: private-tournament results never touch a player's public
 *  competitive record. Called once per player when a tournament completes
 *  (wiring that calls this as brackets actually resolve is a follow-up —
 *  see the chat reply for what's left to build). */
function recordTournamentPlacement(username, { tournamentId, tournamentName, placement, isPrivate }) {
  const bucketKey = isPrivate ? 'private' : 'public';
  const userResults = results[username] || blankUserResults();
  const bucket = userResults[bucketKey] || blankResultsBucket();
  bucket.tournamentsPlayed += 1;
  if (placement === 1) bucket.wins += 1;
  bucket.placements.push({ tournamentId, tournamentName, placement, at: new Date().toISOString() });
  userResults[bucketKey] = bucket;
  results[username] = userResults;
  persistResults();
}

function getTournamentResults(username) {
  return results[username] || blankUserResults();
}

function findMatch(t, matchId) {
  return t.bracket && t.bracket.allMatches.find((m) => m.id === matchId);
}

/** Feeds a completed match's winner/loser into whichever later matches were
 *  waiting on it ("winner of M2" / "loser of M2" placeholders from
 *  bracket-generator.js), and flips a match to 'ready' once both its
 *  players are known. */
function advanceBracket(t, completedMatch) {
  for (const m of t.bracket.allMatches) {
    if (m.player1Source && m.player1Source.type === 'winner_of' && m.player1Source.matchId === completedMatch.id) {
      m.player1 = completedMatch.winner;
    }
    if (m.player2Source && m.player2Source.type === 'winner_of' && m.player2Source.matchId === completedMatch.id) {
      m.player2 = completedMatch.winner;
    }
    if (m.player1Source && m.player1Source.type === 'loser_of' && m.player1Source.matchId === completedMatch.id) {
      m.player1 = completedMatch.loser;
    }
    if (m.player2Source && m.player2Source.type === 'loser_of' && m.player2Source.matchId === completedMatch.id) {
      m.player2 = completedMatch.loser;
    }
    if (m.player1 && m.player2 && m.status === 'pending') m.status = 'ready';
  }
  checkAndMarkTournamentComplete(t);
}

/** Marks the whole tournament 'completed' once its final match and (if
 *  applicable) third-place match are both done. Handles the case where
 *  there was no real third-place match at all (one semifinal was a bye —
 *  the lone loser became 3rd automatically, per bracket-generator.js). */
function checkAndMarkTournamentComplete(t) {
  if (!t.bracket || t.status === 'completed') return;
  const finalDone = t.bracket.finalMatch && t.bracket.finalMatch.status === 'completed';
  const thirdDone = !t.bracket.thirdPlaceMatch || t.bracket.thirdPlaceMatch.status === 'completed';
  if (finalDone && thirdDone) {
    t.status = 'completed';
  }
}

/**
 * A player choosing to leave a tournament mid-way (instead of continuing
 * after a win, or after being eliminated with a later match still ahead —
 * e.g. the third-place match) forfeits every match they still have left,
 * as a clean 2:0 loss, with the opponent advancing automatically. This
 * cascades: forfeiting a semifinal can immediately free up the third-place
 * match too, and if THAT match's other side is also a withdrawn player,
 * it resolves in the same pass. Loops until a full scan makes no further
 * progress, exactly like the bot-vs-bot auto-resolve sweep.
 */
function withdrawFromTournament(tournamentId, username) {
  const t = getTournament(tournamentId);
  if (!t || !t.bracket) return { matchesAffected: 0 };
  t.withdrawnPlayers = t.withdrawnPlayers || [];
  if (!t.withdrawnPlayers.includes(username)) t.withdrawnPlayers.push(username);

  let matchesAffected = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of t.bracket.allMatches) {
      if (match.status === 'completed') continue;
      if (!match.player1 || !match.player2) continue; // opponent side not resolved yet
      const p1Out = t.withdrawnPlayers.includes(match.player1);
      const p2Out = t.withdrawnPlayers.includes(match.player2);
      if (!p1Out && !p2Out) continue;

      const loser = p1Out ? match.player1 : match.player2;
      const winner = p1Out ? match.player2 : match.player1;
      match.status = 'completed';
      match.winner = winner;
      match.loser = loser;
      match.player1Wins = match.player1 === loser ? 0 : 2;
      match.player2Wins = match.player2 === loser ? 0 : 2;
      match.forfeitedBy = loser;
      advanceBracket(t, match);
      matchesAffected++;
      changed = true;
    }
  }

  checkAndMarkTournamentComplete(t);
  persistTournaments();
  return { matchesAffected };
}

/**
 * Records the winner of ONE game within a Bo3/Bo5 series match. This is
 * per-game, not per-series — a forfeit or loss in one game only adds a
 * point to the other side's series score, it never ends the series by
 * itself. Once one side reaches requiredWins, the match completes and the
 * bracket advances (winner feeds forward, loser feeds the third-place
 * match if this was a semifinal).
 * @returns the updated match, with an extra `seriesComplete` boolean
 */
/**
 * Instantly resolves a match with no game played at all — used when both
 * sides are bots, since there's no human to trigger an actual game and
 * simulating one adds nothing. Picks a winner uniformly at random and
 * advances the bracket exactly like a played-out series would. Leaves
 * player1Wins/player2Wins at 0 (no games were played, so there's nothing
 * to record a score for), which distinguishes this from a normal
 * completed series in the bracket data if that distinction ever matters.
 */
function autoResolveMatchRandomly(tournamentId, matchId) {
  const t = getTournament(tournamentId);
  if (!t || !t.bracket) throw new Error('Tournament or bracket not found');
  const match = findMatch(t, matchId);
  if (!match) throw new Error('Match not found');
  if (match.status === 'completed') return match;

  match.status = 'completed';
  match.winner = Math.random() < 0.5 ? match.player1 : match.player2;
  match.loser = match.winner === match.player1 ? match.player2 : match.player1;
  advanceBracket(t, match);

  persistTournaments();
  return match;
}

/** Marks a match as having a game currently underway, so the auto-start
 *  scanner's re-scan passes don't start a second, duplicate game for the
 *  same match while the first one is still being played out. */
function markMatchInProgress(tournamentId, matchId) {
  const t = getTournament(tournamentId);
  if (!t || !t.bracket) return;
  const match = findMatch(t, matchId);
  if (!match || match.status === 'completed') return;
  match.status = 'in_progress';
  persistTournaments();
}

function recordSeriesGameResult(tournamentId, matchId, gameWinnerId, roomCode) {
  const t = getTournament(tournamentId);
  if (!t || !t.bracket) throw new Error('Tournament or bracket not found');
  const match = findMatch(t, matchId);
  if (!match) throw new Error('Match not found');
  if (match.status === 'completed') return { ...match, seriesComplete: true }; // already resolved — ignore a late/duplicate result

  if (gameWinnerId === match.player1) match.player1Wins += 1;
  else if (gameWinnerId === match.player2) match.player2Wins += 1;
  if (roomCode) match.gameIds.push(roomCode);

  const seriesComplete = match.player1Wins >= match.requiredWins || match.player2Wins >= match.requiredWins;
  if (seriesComplete) {
    match.status = 'completed';
    match.winner = match.player1Wins > match.player2Wins ? match.player1 : match.player2;
    match.loser = match.winner === match.player1 ? match.player2 : match.player1;
    advanceBracket(t, match);
  } else {
    match.status = 'in_progress';
  }

  persistTournaments();
  return { ...match, seriesComplete };
}

module.exports = {
  ABSOLUTE_MIN_PARTICIPANTS,
  MIN_GAMES_TO_CREATE,
  statsToRating,
  canCreateTournament,
  createTournament,
  getTournament,
  getTournamentByInviteCode,
  listPublic,
  listAll,
  listForUser,
  joinTournament,
  leaveTournament,
  deleteTournament,
  deleteAllCompleted,
  cancelTournament,
  closeRegistrationAndGenerateBracket,
  recordTournamentPlacement,
  getTournamentResults,
  findMatch,
  recordSeriesGameResult,
  autoResolveMatchRandomly,
  markMatchInProgress,
  withdrawFromTournament,
};

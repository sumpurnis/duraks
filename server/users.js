'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'users.json');
const MIN_PASSWORD_LEN = 4;
const LEADERBOARD_SIZE = 10;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function blankDaily() {
  return { date: todayStr(), played: 0, won: 0, lost: 0, currentStreak: 0, longestStreak: 0 };
}

function blankStats() {
  return {
    played: 0,
    won: 0,
    lost: 0,
    wonByForfeit: 0,
    lostByForfeit: 0,
    currentStreak: 0,
    longestStreak: 0,
    daily: blankDaily(),
  };
}

function blankGlobal() {
  return {
    allTimePlayed: 0,
    daily: { date: todayStr(), played: 0 },
    vsBotAllTime: 0,
    vsBotDaily: { date: todayStr(), played: 0 },
    pageVisitsAllTime: 0,
    pageVisitsDaily: { date: todayStr(), count: 0 },
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Back-compat: older data files were just a flat username -> record map.
    if (parsed && (parsed.users || parsed.global)) {
      return { users: parsed.users || {}, global: { ...blankGlobal(), ...parsed.global } };
    }
    return { users: parsed || {}, global: blankGlobal() };
  } catch {
    return { users: {}, global: blankGlobal() };
  }
}

let store = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function normalize(username) {
  return String(username || '').trim().slice(0, 20);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function setPassword(record, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  record.salt = salt;
  record.hash = hashPassword(password, salt);
}

function verifyPassword(record, password) {
  if (!record.salt || !record.hash) return false;
  const candidate = hashPassword(password, record.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Returns a record's daily bucket if it's actually from today, otherwise a
// fresh (zeroed) one — without mutating storage. Used for read paths like
// getStats() and the leaderboards, so stale numbers from a previous day never
// leak into a live "today" view just because the player hasn't played yet.
function effectiveDaily(record) {
  const daily = (record && record.stats && record.stats.daily) || blankDaily();
  return daily.date === todayStr() ? daily : blankDaily();
}

function publicStats(record) {
  const stats = { ...blankStats(), ...record.stats };
  const daily = effectiveDaily(record);
  return {
    played: stats.played,
    won: stats.won,
    lost: stats.lost,
    wonByForfeit: stats.wonByForfeit,
    lostByForfeit: stats.lostByForfeit,
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
    today: {
      played: daily.played,
      won: daily.won,
      lost: daily.lost,
      currentStreak: daily.currentStreak,
      longestStreak: daily.longestStreak,
    },
  };
}

function toPublic(username, record) {
  // Never send salt/hash to the client.
  return {
    username,
    email: record.email || null,
    stats: publicStats(record),
    lastRoomSettings: record.lastRoomSettings || null,
  };
}

function usernameExists(username) {
  return !!store.users[normalize(username)];
}

// Creates a brand-new account. Returns the public record, or null if the
// name is invalid, the password is too short, or the name is already taken.
function createAccount(username, password) {
  const name = normalize(username);
  if (!name) return null;
  if (!password || password.length < MIN_PASSWORD_LEN) return null;
  if (store.users[name]) return null;

  const record = { createdAt: Date.now(), email: null, stats: blankStats() };
  setPassword(record, password);
  store.users[name] = record;
  save();
  return toPublic(name, record);
}

// Verifies an existing account's password. Returns the public record, or
// null if the account doesn't exist or the password is wrong.
function verifyLogin(username, password) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return null;
  if (!verifyPassword(record, password)) return null;
  return toPublic(name, record);
}

function recordResult(username, didWin, isForfeit) {
  const name = normalize(username);
  if (!name || !store.users[name]) return;
  const record = store.users[name];
  const stats = { ...blankStats(), ...record.stats };

  // All-time.
  stats.played += 1;
  if (didWin) {
    stats.won += 1;
    if (isForfeit) stats.wonByForfeit += 1;
    stats.currentStreak += 1;
    stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
  } else {
    stats.lost += 1;
    if (isForfeit) stats.lostByForfeit += 1;
    stats.currentStreak = 0;
  }

  // Today (resets automatically once the stored date is stale).
  const daily = stats.daily && stats.daily.date === todayStr() ? stats.daily : blankDaily();
  daily.played += 1;
  if (didWin) {
    daily.won += 1;
    daily.currentStreak += 1;
    daily.longestStreak = Math.max(daily.longestStreak, daily.currentStreak);
  } else {
    daily.lost += 1;
    daily.currentStreak = 0;
  }
  stats.daily = daily;

  record.stats = stats;
  save();
}

function getStats(username) {
  const name = normalize(username);
  const record = store.users[name];
  return record ? publicStats(record) : null;
}

// Per-user game history: a capped, most-recent-first list of completed
// games, independent of the running-total stats above. Each entry is a
// simple, self-contained record — mode ('2p' or 'multi'), player count,
// deck size, outcome ('won'/'lost'/'placed'/'draw' — 'placed' covers a
// multiplayer finish that's safe but not 1st), placement (1 = best),
// whether AI was involved, and opponent usernames (bot names included as
// plain strings for context). Silently no-ops for accounts that don't
// exist (guests), matching recordResult's existing behavior — a guest's
// games simply aren't persisted anywhere.
const HISTORY_LIMIT = 100;

function recordGameHistoryEntry(username, entry) {
  const name = normalize(username);
  if (!name || !store.users[name]) return;
  const record = store.users[name];
  const history = Array.isArray(record.history) ? record.history : [];
  history.unshift({ ...entry, timestamp: entry.timestamp || Date.now() });
  record.history = history.slice(0, HISTORY_LIMIT);
  save();
}

function getGameHistory(username, limit) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record || !Array.isArray(record.history)) return [];
  const n = Number.isInteger(limit) && limit > 0 ? limit : HISTORY_LIMIT;
  return record.history.slice(0, n);
}

// Tracks which IP addresses a registered account has connected from — one
// signal (among several) for the anomaly-detection tool
// (server/tools/anomaly-report.js), which flags different accounts that
// always share an IP. Capped list, most-recently-seen first; each entry
// also keeps a running count and first/last-seen timestamps so the report
// can tell "logged in once from a friend's house" apart from "every single
// session is from this IP". Silently no-ops for guests/non-existent
// accounts, same convention as the rest of this file. Not itself proof of
// anything — shared households, NAT and VPNs all produce the same signal.
const KNOWN_IPS_LIMIT = 20;

function recordLoginIp(username, ip) {
  const name = normalize(username);
  if (!name || !store.users[name] || !ip) return;
  const record = store.users[name];
  const knownIps = Array.isArray(record.knownIps) ? record.knownIps : [];
  const existing = knownIps.find((e) => e.ip === ip);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = Date.now();
  } else {
    knownIps.unshift({ ip, count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
  }
  knownIps.sort((a, b) => b.lastSeen - a.lastSeen);
  record.knownIps = knownIps.slice(0, KNOWN_IPS_LIMIT);
  save();
}

// Remembers a registered user's most recently used room-creation settings
// (button-group choices in the create-room modal), so the next time they
// open that modal it can be pre-filled for them. Silently no-ops for
// guests/non-existent accounts, same convention as the rest of this file.
// This only ever stores a settings snapshot — it never creates or starts a
// room by itself, and the client still requires an explicit "Izveidot"
// click to actually host.
function saveLastRoomSettings(username, settings) {
  const name = normalize(username);
  if (!name || !store.users[name]) return;
  const record = store.users[name];
  record.lastRoomSettings = {
    totalPlayers: settings.totalPlayers,
    aiCount: settings.aiCount,
    deckSize: settings.deckSize,
    isPrivate: !!settings.isPrivate,
    ranked: !!settings.ranked,
  };
  save();
}

// ---------- ELO rating ----------
//
// One rating, shared across all player counts (2-4) — a ranked game
// always counts toward it regardless of how many people were at the
// table, same spirit as Age of Empires 2's ranked queue. There's no
// separate "team" concept here, just N individuals with a placement
// (1 = best) each. Extended to N>2 by treating the game as every
// possible pair of participants playing a virtual 1v1: each pair
// contributes a standard expected-score comparison based on the ELO gap,
// and a player's own rating change is the sum of their pairwise deltas
// averaged across their (N-1) opponents — this keeps a typical change
// roughly the same size regardless of table size, rather than a 4-player
// game swinging ratings 3x harder than a 2-player one for the same K.
//
// New accounts don't get an elo field until their first ranked game —
// getElo and applyRankedGameResult both treat a missing field as
// DEFAULT_ELO, so this needs no migration for existing accounts.
const DEFAULT_ELO = 1000;
const ELO_K = 32;

function getElo(username) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return null;
  return typeof record.elo === 'number' ? record.elo : DEFAULT_ELO;
}

// placements: array of { username, placement } (1 = best place at the
// table). Only entries whose account actually exists are rated — guests
// are silently excluded, same as everywhere else. Requires at least 2
// ratable participants. Returns { [username]: { before, after, delta } }
// for each rated participant, or null if fewer than 2 were ratable.
// Does NOT decide whether a game qualifies as ranked — that's the
// caller's job (see multi-rooms.js's ranked-room restrictions).
function applyRankedGameResult(placements) {
  const eligible = (placements || [])
    .map((p) => ({ username: normalize(p.username), placement: p.placement }))
    .filter((p) => p.username && store.users[p.username]);
  if (eligible.length < 2) return null;

  const before = {};
  for (const p of eligible) before[p.username] = getElo(p.username);

  const deltaSum = {};
  for (const p of eligible) deltaSum[p.username] = 0;

  for (const a of eligible) {
    for (const b of eligible) {
      if (a.username === b.username) continue;
      const expectedA = 1 / (1 + Math.pow(10, (before[b.username] - before[a.username]) / 400));
      const actualA = a.placement < b.placement ? 1 : a.placement > b.placement ? 0 : 0.5;
      deltaSum[a.username] += ELO_K * (actualA - expectedA);
    }
  }

  const result = {};
  const n = eligible.length - 1;
  for (const p of eligible) {
    const avgDelta = Math.round(deltaSum[p.username] / n);
    const newElo = before[p.username] + avgDelta;
    store.users[p.username].elo = newElo;
    result[p.username] = { before: before[p.username], after: newElo, delta: avgDelta };
  }
  save();
  return result;
}

// Called once per completed real (non-AI) game, regardless of how many
// players are in it — this is a count of games, not of results.
function recordGameCompleted() {
  const g = store.global && store.global.allTimePlayed !== undefined ? store.global : blankGlobal();
  g.allTimePlayed += 1;
  g.daily = g.daily && g.daily.date === todayStr() ? g.daily : { date: todayStr(), played: 0 };
  g.daily.played += 1;
  store.global = g;
  save();
}

function getGameCounts() {
  const g = store.global || blankGlobal();
  const daily = g.daily && g.daily.date === todayStr() ? g.daily : { date: todayStr(), played: 0 };
  return { today: daily.played, allTime: g.allTimePlayed };
}

// Called once per completed game against the AI opponent — covers the
// plain "Spēlēt pret datoru" button, guest play, and tournament matches
// played against a bot, since all of those are the same vsAI room type.
function recordVsBotGameCompleted() {
  const g = { ...blankGlobal(), ...store.global };
  g.vsBotAllTime = (g.vsBotAllTime || 0) + 1;
  g.vsBotDaily = g.vsBotDaily && g.vsBotDaily.date === todayStr() ? g.vsBotDaily : { date: todayStr(), played: 0 };
  g.vsBotDaily.played += 1;
  store.global = g;
  save();
}

function getVsBotGameCounts() {
  const g = { ...blankGlobal(), ...store.global };
  const daily = g.vsBotDaily && g.vsBotDaily.date === todayStr() ? g.vsBotDaily : { date: todayStr(), played: 0 };
  return { today: daily.played, allTime: g.vsBotAllTime || 0 };
}

// Called once per HTTP load of the main page (see the dedicated route in
// server.js — this is a page-visit count, not a login or session count).
function recordPageVisit() {
  const g = { ...blankGlobal(), ...store.global };
  g.pageVisitsAllTime = (g.pageVisitsAllTime || 0) + 1;
  g.pageVisitsDaily = g.pageVisitsDaily && g.pageVisitsDaily.date === todayStr() ? g.pageVisitsDaily : { date: todayStr(), count: 0 };
  g.pageVisitsDaily.count += 1;
  store.global = g;
  save();
}

function getPageVisitCounts() {
  const g = { ...blankGlobal(), ...store.global };
  const daily = g.pageVisitsDaily && g.pageVisitsDaily.date === todayStr() ? g.pageVisitsDaily : { date: todayStr(), count: 0 };
  return { today: daily.count, allTime: g.pageVisitsAllTime || 0 };
}

function winPct(played, won) {
  return played > 0 ? (won / played) * 100 : 0;
}

// Builds the "Labākie spēlētāji TOP10" lists (by win %), plus the single
// record-holders for longest win streak and most games played, each split
// into today / all-time.
function getLeaderboards() {
  const entries = Object.entries(store.users);

  const topByWinRate = (getPlayed, getWon) =>
    entries
      .map(([name, record]) => {
        const stats = { ...blankStats(), ...record.stats };
        const daily = effectiveDaily(record);
        const played = getPlayed(stats, daily);
        const won = getWon(stats, daily);
        return { username: name, played, won, winPct: winPct(played, won) };
      })
      .filter((e) => e.played > 0)
      .sort((a, b) => b.winPct - a.winPct || b.played - a.played)
      .slice(0, LEADERBOARD_SIZE)
      .map((e) => ({ username: e.username, winPct: Math.round(e.winPct), played: e.played }));

  const topSingle = (getValue) => {
    let best = null;
    for (const [name, record] of entries) {
      const stats = { ...blankStats(), ...record.stats };
      const daily = effectiveDaily(record);
      const value = getValue(stats, daily);
      if (value > 0 && (!best || value > best.value)) best = { username: name, value };
    }
    return best;
  };

  return {
    games: getGameCounts(),
    gamesVsBot: getVsBotGameCounts(),
    pageVisits: getPageVisitCounts(),
    topWinRate: {
      today: topByWinRate((s, d) => d.played, (s, d) => d.won),
      allTime: topByWinRate((s) => s.played, (s) => s.won),
    },
    longestStreak: {
      today: topSingle((s, d) => d.longestStreak),
      allTime: topSingle((s) => s.longestStreak),
    },
    mostPlayed: {
      today: topSingle((s, d) => d.played),
      allTime: topSingle((s) => s.played),
    },
  };
}

module.exports = {
  usernameExists,
  createAccount,
  verifyLogin,
  recordResult,
  getStats,
  recordGameCompleted,
  recordVsBotGameCompleted,
  recordPageVisit,
  getLeaderboards,
  recordGameHistoryEntry,
  getGameHistory,
  saveLastRoomSettings,
  recordLoginIp,
  getElo,
  applyRankedGameResult,
  MIN_PASSWORD_LEN,
};

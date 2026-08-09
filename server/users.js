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
  return { allTimePlayed: 0, daily: { date: todayStr(), played: 0 } };
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
  return { username, email: record.email || null, stats: publicStats(record) };
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
  getLeaderboards,
  MIN_PASSWORD_LEN,
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR defaults to a folder next to this file, but can be pointed
// somewhere else entirely via DURAKS_DATA_DIR — e.g. a Railway Volume
// mounted outside the deployed code, so that every redeploy (which
// replaces the code on disk with a fresh copy) doesn't also wipe out
// player accounts, stats and ELO history stored here. See the deploy
// notes in README / the message this was introduced in for setup steps.
const DATA_DIR = process.env.DURAKS_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'users.json');
const MIN_PASSWORD_LEN = 8;
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

// Deliberately simple/lenient (not full RFC 5322) — good enough to catch
// typos and missing @ / domain, without rejecting valid-but-unusual
// addresses. Lowercased so lookups and uniqueness checks are
// case-insensitive, matching how virtually every real mail provider
// treats the address anyway.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  const trimmed = String(email || '').trim().toLowerCase();
  if (!trimmed || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function isValidEmail(email) {
  return !!normalizeEmail(email);
}

// Linear scan over all accounts — fine at this app's scale (hundreds to
// low thousands of accounts), and avoids keeping a second persisted index
// in sync with store.users by hand.
function findUsernameByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  for (const [name, record] of Object.entries(store.users)) {
    if (record.email === normalized) return name;
  }
  return null;
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
    linkedProviders: record.oauth ? Object.keys(record.oauth) : [],
    stats: publicStats(record),
    lastRoomSettings: record.lastRoomSettings || null,
  };
}

function usernameExists(username) {
  return !!store.users[normalize(username)];
}

// Creates a brand-new account. Returns the public record, or null if the
// name is invalid, the password is too short, the name is already taken,
// or the email is missing/invalid/already used by another account. Email
// is required from here on so every new account can use the password/
// username recovery flow below — existing accounts created before this
// (with email: null) keep working and can add one later via updateEmail.
function createAccount(username, password, email) {
  const name = normalize(username);
  if (!name) return null;
  if (!password || password.length < MIN_PASSWORD_LEN) return null;
  if (store.users[name]) return null;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  if (findUsernameByEmail(normalizedEmail)) return null;

  const record = { createdAt: Date.now(), email: normalizedEmail, stats: blankStats() };
  setPassword(record, password);
  store.users[name] = record;
  save();
  return toPublic(name, record);
}

// Adds or changes an existing account's email — the only way a
// pre-existing account (registered back when email wasn't collected) gets
// one on file, and how anyone updates it later. Returns
// { ok: true, email } on success, or { ok: false, error } with a
// user-facing Latvian message otherwise.
function updateEmail(username, email) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return { ok: false, error: 'Lietotājs nav atrasts' };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { ok: false, error: 'Nederīga e-pasta adrese' };
  const owner = findUsernameByEmail(normalizedEmail);
  if (owner && owner !== name) return { ok: false, error: 'Šis e-pasts jau tiek izmantots citam kontam' };
  record.email = normalizedEmail;
  save();
  return { ok: true, email: normalizedEmail };
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

// Session tokens let a browser stay logged in ("remember me") without
// storing the account password anywhere on the client — only a random,
// server-issued, single-purpose token is kept in localStorage. The server
// itself only ever stores a SHA-256 hash of each token (never the raw
// value), the same defense-in-depth reasoning as password hashing: a leak
// of users.json alone doesn't hand out usable login tokens either.
//
// Each account keeps a capped list of concurrent tokens (most-recent-use
// first) so a person can stay logged in on a few devices/browsers at once
// without them evicting each other. Using a token slides its expiry
// forward (so an actively-used browser never gets logged out), while an
// abandoned token quietly expires on its own.
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSION_TOKENS = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Mints a new session token for an existing account. Returns the raw token
// (only ever handed out once, at creation time — never persisted or logged
// in plaintext) or null if the account doesn't exist.
function createSessionToken(username) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokens = Array.isArray(record.sessionTokens) ? record.sessionTokens : [];
  const now = Date.now();
  const fresh = tokens.filter((t) => t.expiresAt > now);
  fresh.unshift({ hash: hashToken(token), createdAt: now, expiresAt: now + SESSION_TOKEN_TTL_MS });
  record.sessionTokens = fresh.slice(0, MAX_SESSION_TOKENS);
  save();
  return token;
}

// Verifies a previously-issued session token for an account. On success,
// slides the token's expiry forward (so active use keeps a browser logged
// in) and returns the public record; returns null if the account, token,
// or a non-expired match doesn't exist.
function verifySessionToken(username, token) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record || !token) return null;
  const tokens = Array.isArray(record.sessionTokens) ? record.sessionTokens : [];
  const hash = hashToken(token);
  const now = Date.now();
  const match = tokens.find((t) => t.hash === hash && t.expiresAt > now);
  if (!match) return null;
  match.expiresAt = now + SESSION_TOKEN_TTL_MS;
  record.sessionTokens = tokens.filter((t) => t.expiresAt > now);
  save();
  return toPublic(name, record);
}

// Invalidates one specific session token (explicit logout on that device).
// Silently no-ops if the account or token isn't found.
function invalidateSessionToken(username, token) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record || !token) return;
  const tokens = Array.isArray(record.sessionTokens) ? record.sessionTokens : [];
  const hash = hashToken(token);
  record.sessionTokens = tokens.filter((t) => t.hash !== hash);
  save();
}

// ---------- Password reset tokens ----------
//
// Same shape/reasoning as session tokens above (single-use, hashed at
// rest, expiring) but much shorter-lived and single-purpose: proving
// "whoever clicked this link controls the account's email inbox", not
// "keep this browser logged in". A fresh token replaces any unused one
// for that account, so only the most recently requested reset link ever
// works — requesting a new one silently invalidates an older email still
// sitting in an inbox.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function createPasswordResetToken(username) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return null;
  const token = crypto.randomBytes(32).toString('hex');
  record.resetToken = { hash: hashToken(token), expiresAt: Date.now() + RESET_TOKEN_TTL_MS };
  save();
  return token;
}

// Looks up which account a reset token belongs to, without consuming it —
// used to validate a token before showing the "set new password" form.
function findUsernameByResetToken(token) {
  if (!token) return null;
  const hash = hashToken(token);
  const now = Date.now();
  for (const [name, record] of Object.entries(store.users)) {
    if (record.resetToken && record.resetToken.hash === hash && record.resetToken.expiresAt > now) {
      return name;
    }
  }
  return null;
}

// Validates the token, sets the new password, and consumes the token (and
// every existing session — a password reset is exactly the moment to log
// out any device someone else might be using). Returns true on success.
function resetPasswordWithToken(token, newPassword) {
  if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) return false;
  const name = findUsernameByResetToken(token);
  if (!name) return false;
  const record = store.users[name];
  setPassword(record, newPassword);
  delete record.resetToken;
  record.sessionTokens = [];
  save();
  return true;
}

// ---------- OAuth (Google / Facebook) linked accounts ----------
//
// Each account can optionally have one identity per provider linked to it:
// record.oauth = { google: { id, email }, facebook: { id, email } }.
// Lookup is a linear scan, same reasoning as findUsernameByEmail above —
// fine at this app's scale, and avoids a second index to keep in sync.

function findUsernameByOAuth(provider, providerId) {
  if (!provider || !providerId) return null;
  for (const [name, record] of Object.entries(store.users)) {
    const link = record.oauth && record.oauth[provider];
    if (link && link.id === providerId) return name;
  }
  return null;
}

// Links a provider identity to an already-existing account (used both
// right after createAccountFromOAuth, and when someone signs in with a
// provider whose email matches an account they already have). If that
// account has no email on file yet, adopts the provider's verified email
// for it too — a free upgrade for pre-existing no-email accounts, as long
// as that email isn't already claimed by some other account.
function linkOAuth(username, provider, providerId, email) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return false;
  const normalizedEmail = normalizeEmail(email);
  record.oauth = record.oauth || {};
  record.oauth[provider] = { id: providerId, email: normalizedEmail };
  if (!record.email && normalizedEmail && !findUsernameByEmail(normalizedEmail)) {
    record.email = normalizedEmail;
  }
  save();
  return true;
}

// Creates a brand-new account purely from an OAuth identity. No password
// is ever shown to the person — a random one is generated internally so
// the account still fits the existing salt/hash schema, and they can set
// a real one later via "Aizmirsi paroli" (same reset-token flow as anyone
// else) if they ever want to log in without the provider.
function createAccountFromOAuth(username, provider, providerId, email) {
  const name = normalize(username);
  if (!name) return null;
  if (store.users[name]) return null;
  const normalizedEmail = normalizeEmail(email);
  const record = {
    createdAt: Date.now(),
    email: normalizedEmail,
    stats: blankStats(),
    oauth: { [provider]: { id: providerId, email: normalizedEmail } },
  };
  setPassword(record, crypto.randomBytes(24).toString('hex'));
  store.users[name] = record;
  save();
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
// Two independent ratings — 'oneVOne' and 'multi' — rather than one
// number shared across every table size. A ranked game only ever updates
// the pool matching its own player count (see multi-rooms.js, which picks
// the pool from room.totalPlayers), because a player's 1v1 duelling skill
// and their 3-4 player free-for-all skill are different things, and
// blending them into one figure would make that figure represent neither
// very well (same reasoning chess sites apply to Bullet/Blitz/Rapid being
// separate ratings, not one number). There's no "team" concept in the
// multi pool — for a given ranked game, every present pool's rating is
// updated from every participant's placement (1 = best) at the table.
// Extended to N>2 by treating the game as every possible pair of
// participants playing a virtual 1v1: each pair contributes a standard
// expected-score comparison based on the ELO gap, and a player's own
// rating change is the sum of their pairwise deltas averaged across their
// (N-1) opponents — this keeps a typical change roughly the same size
// regardless of table size, rather than a 4-player game swinging ratings
// 3x harder than a 2-player one for the same K.
//
// New accounts don't get an eloByPool field (or a given pool inside it)
// until their first ranked game in that pool — getElo and
// applyRankedGameResult both treat a missing value as DEFAULT_ELO, so
// this needs no migration for existing accounts. (Older accounts may
// still carry a legacy single `elo` field from before the pool split —
// it's simply no longer read; nothing currently in production depends on
// it, so there's nothing to migrate.)
const DEFAULT_ELO = 1000;
const ELO_K = 32;
const ELO_POOLS = ['oneVOne', 'multi'];

function getElo(username, pool) {
  const name = normalize(username);
  const record = store.users[name];
  if (!record) return null;
  const val = record.eloByPool && record.eloByPool[pool];
  return typeof val === 'number' ? val : DEFAULT_ELO;
}

// placements: array of { username, placement } (1 = best place at the
// table). pool: which independent rating to update — 'oneVOne' or 'multi'
// (see ELO_POOLS above); the caller picks it from the table's player
// count. Only entries whose account actually exists are rated — guests
// are silently excluded, same as everywhere else. Requires at least 2
// ratable participants. Returns { [username]: { before, after, delta } }
// for each rated participant, or null if fewer than 2 were ratable.
// Does NOT decide whether a game qualifies as ranked — that's the
// caller's job (see multi-rooms.js's ranked-room restrictions).
function applyRankedGameResult(placements, pool) {
  if (!ELO_POOLS.includes(pool)) throw new Error(`applyRankedGameResult: unknown elo pool '${pool}'`);
  const eligible = (placements || [])
    .map((p) => ({ username: normalize(p.username), placement: p.placement }))
    .filter((p) => p.username && store.users[p.username]);
  if (eligible.length < 2) return null;

  const before = {};
  for (const p of eligible) before[p.username] = getElo(p.username, pool);

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
    const record = store.users[p.username];
    record.eloByPool = record.eloByPool || {};
    record.eloByPool[pool] = newElo;
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
  createSessionToken,
  verifySessionToken,
  invalidateSessionToken,
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
  ELO_POOLS,
  MIN_PASSWORD_LEN,
  isValidEmail,
  normalizeEmail,
  findUsernameByEmail,
  updateEmail,
  createPasswordResetToken,
  findUsernameByResetToken,
  resetPasswordWithToken,
  findUsernameByOAuth,
  linkOAuth,
  createAccountFromOAuth,
};

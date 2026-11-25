'use strict';

// The front page's living map ("pasaule").
//
// Every registered player owns a village on a hex grid. Places are handed out once, in a
// spiral from the centre, and never change, so a village stays where it was. The spacing
// itself lives on the client (it is sized for the biggest possible village plus a road).
//
// What this module keeps:
//   - DATA_DIR/world.json: village places, games played per player per game (village size
//     and its main game), and games played between each pair of players (road wear);
//   - in memory: who is connected right now (smoke), the games being played right now
//     (walkers), and a short list of recent events for the ticker.
//
// Games tell it about themselves through a few calls, wired in server.js / the Duraks server:
//   world.recordGame(game, names, { vsBot })   a finished game ('duraks' | 'meli')
//   world.seen(name, connId) / world.gone(connId)   presence
//   world.provide(game, fn)                    fn() -> [{ id, players:[names], guests?, vsBot }] live games
//
// Only registered accounts get villages; guests are counted but never named.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const users = require('./users');
const persist = require('./persist');

const FILE = path.join(DATA_DIR, 'world.json');
const GAMES = { duraks: 'd', meli: 'm' };
// Games needed for each of the 10 village levels.
const LEVELS = [0, 1, 5, 12, 25, 45, 75, 120, 180, 260];
const WINDOW = 3; // hex rings sent around the centre of the view (the page draws a margin around the screen for dragging)
const MAX_EVENTS = 30;
const POLL_MS = 3000;
const EVENT_MAX_AGE_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ storage
function blank() {
  return { slots: {}, next: 0, games: {}, pairs: {}, seeded: {}, history: [] };
}
function load() {
  return { ...blank(), ...persist.loadJson(FILE, blank, 'world.json') };
}
let data = load();
const saver = persist.createSaver(FILE, () => data, { delay: 800, label: 'world.json' });
function saveSoon() {
  saver.save();
}
// Own properties only (a player called "constructor" must not match the built-in).
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ------------------------------------------------------------------ hex spiral
// Axial coordinates (q, r). Slot 0 is the centre, then ring 1 (6 slots), ring 2 (12) …
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function slotToHex(i) {
  if (i === 0) return { q: 0, r: 0 };
  let ring = 1;
  let start = 1;
  while (start + 6 * ring <= i) { start += 6 * ring; ring++; }
  let k = i - start;
  let q = DIRS[4][0] * ring;
  let r = DIRS[4][1] * ring;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < ring; step++) {
      if (k === 0) return { q, r };
      q += DIRS[side][0];
      r += DIRS[side][1];
      k--;
    }
  }
  return { q, r };
}
function hexDist(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

function slotOf(name) {
  if (!has(data.slots, name)) {
    data.slots[name] = data.next++;
    saveSoon();
  }
  return data.slots[name];
}

// Existing accounts get places in the order they registered, the first time the world runs.
function seedAccounts() {
  if (data.seeded.accounts) return;
  const all = typeof users.listAccounts === 'function' ? users.listAccounts() : [];
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const a of all) {
    slotOf(a.username);
    const g = has(data.games, a.username) ? data.games[a.username] : (data.games[a.username] = { d: 0, m: 0 });
    g.d = Math.max(g.d, a.played || 0); // Duraks games played before the map existed
  }
  data.seeded.accounts = true;
  saveSoon();
}

/** One-off: Meļi games played before the map existed ({ name: played }). */
function seedGames(game, counts) {
  const k = GAMES[game];
  if (!k || data.seeded[game]) return;
  for (const [name, n] of Object.entries(counts || {})) {
    if (!users.usernameExists(name)) continue;
    slotOf(name);
    const g = has(data.games, name) ? data.games[name] : (data.games[name] = { d: 0, m: 0 });
    g[k] = Math.max(g[k], n || 0);
  }
  data.seeded[game] = true;
  saveSoon();
}

// ------------------------------------------------------------------ events
// `events`: the live ticker (memory, the last few minutes). `data.history`: the same news kept in
// world.json, so the front page's "Notikumi ciematos" list survives restarts (HISTORY_KEEP newest).
const HISTORY_KEEP = 30;
const HISTORY_SHOWN = 10;
if (!Array.isArray(data.history)) data.history = [];
let events = [];
// ids keep growing across restarts, so an open page doesn't take new news for old
let eventId = data.history.reduce((m, e) => Math.max(m, e.id || 0), 0);
function addEvent(e) {
  const ev = { id: ++eventId, t: Date.now(), ...e };
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  data.history.push(ev);
  if (data.history.length > HISTORY_KEEP) data.history = data.history.slice(-HISTORY_KEEP);
  saveSoon();
}

const pairKey = (a, b) => (a < b ? a + '\u0001' + b : b + '\u0001' + a);
const quality = (n) => (n >= 100 ? 3 : n >= 25 ? 2 : n >= 5 ? 1 : 0);

/**
 * A finished game. `names` are every human seat; guests are ignored.
 * winner / host / hostPlace (optional) go into the news line: who won, and where the player who made the
 * table finished ("🏆 Ilze 🏠 Anna · 3. vieta"). They may be guests or computers: shown as text only.
 */
function recordGame(game, names, { vsBot = false, winner = null, host = null, hostPlace = null } = {}) {
  const k = GAMES[game];
  if (!k) return;
  const real = [...new Set((names || []).filter((n) => n && users.usernameExists(n)))];
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 40) : null);
  const res = str(winner) ? { winner: str(winner), host: str(host), hostPlace: Number.isInteger(hostPlace) && hostPlace > 0 ? hostPlace : null } : {};
  for (const n of real) {
    slotOf(n);
    const g = has(data.games, n) ? data.games[n] : (data.games[n] = { d: 0, m: 0 });
    const before = levelOf(n);
    g[k] += 1;
    if (levelOf(n) > before) addEvent({ type: 'level', names: [n], level: levelOf(n) });
  }
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const key = pairKey(real[i], real[j]);
      const before = quality(has(data.pairs, key) ? data.pairs[key] : 0);
      data.pairs[key] = (has(data.pairs, key) ? data.pairs[key] : 0) + 1;
      if (real.length === 2) addEvent({ type: 'finish', game: k, names: [real[i], real[j]], ...res });
      const after = quality(data.pairs[key]);
      if (after > before) addEvent({ type: 'road', names: [real[i], real[j]], quality: after });
    }
  }
  // a table of 3+: one line with everyone (not one per pair of players)
  if (real.length > 2) addEvent({ type: 'finish', game: k, names: real.slice(0, 6), ...res });
  if (real.length === 1) addEvent({ type: 'finishSolo', game: k, names: real, vsBot: !!vsBot, ...res });
  saveSoon();
}

function levelOf(name) {
  const g = has(data.games, name) ? data.games[name] : null;
  const n = g ? g.d + g.m : 0;
  let L = 1;
  for (let i = 0; i < LEVELS.length; i++) if (n >= LEVELS[i]) L = i + 1;
  return L;
}

// ------------------------------------------------------------------ presence
const presence = new Map(); // connId -> name
function seen(name, connId) {
  if (!name || !users.usernameExists(name)) return;
  presence.set(connId, name);
}
function gone(connId) {
  presence.delete(connId);
}
// The front page has no permanent connection: its map check-ins (GET /api/world) say "this visitor
// still has the page open" for a short while. key = one browser tab; name = the account or null (guest).
const visits = new Map(); // key -> { name, ip, until }
const VISITS_MAX = 5000;
const GUEST_TABS_PER_IP = 3; // one address can't pump up the "online" number
function pruneVisits(now) {
  for (const [k, v] of visits) if (v.until <= now) visits.delete(k);
}
/** A front-page check-in. Returns true when this changed who is shown online. */
function touch(key, name, ip, ttlMs) {
  const now = Date.now();
  pruneVisits(now);
  const real = name && users.usernameExists(name) ? name : null;
  const had = visits.get(key);
  if (!had) {
    if (visits.size >= VISITS_MAX) return false;
    if (!real && [...visits.values()].filter((v) => !v.name && v.ip === ip).length >= GUEST_TABS_PER_IP) return false;
  }
  const wasOnline = real ? onlineNames().has(real) : true;
  visits.set(key, { name: real, ip, until: now + ttlMs });
  if (!had || (had.name !== real) || !wasOnline) {
    snapCache.clear(); // show the newcomer at once, not after the 2 s cache
    return true;
  }
  return false;
}
function onlineNames() {
  const now = Date.now();
  const out = new Set(presence.values());
  for (const v of visits.values()) if (v.name && v.until > now) out.add(v.name);
  return out;
}
function guestVisitors() {
  const now = Date.now();
  let n = 0;
  for (const v of visits.values()) if (!v.name && v.until > now) n += 1;
  return n;
}

// ------------------------------------------------------------------ live games
const providers = new Map(); // game -> fn
let live = []; // [{ id, game:'d'|'m', players:[all humans], real:[registered], vsBot }]
let tourHosts = () => [];

function provide(game, fn) {
  if (GAMES[game]) providers.set(game, fn);
}
function provideTournamentHosts(fn) {
  tourHosts = fn;
}

function pollLive() {
  const next = [];
  for (const [game, fn] of providers) {
    let list = [];
    try { list = fn() || []; } catch (err) { console.error('world provider', game, err.message); }
    for (const g of list) {
      const players = (g.players || []).filter(Boolean);
      next.push({
        id: game + ':' + g.id,
        game: GAMES[game],
        players,
        real: players.filter((n) => users.usernameExists(n)),
        vsBot: !!g.vsBot,
        guests: g.guests || 0, // humans without an account whose names can't be trusted (Meļi)
      });
    }
  }
  const old = new Set(live.map((g) => g.id));
  for (const g of next) {
    if (old.has(g.id) || !g.real.length) continue;
    if (g.real.length >= 2) addEvent({ type: 'start', game: g.game, names: g.real.slice(0, 4) });
    else addEvent({ type: 'startSolo', game: g.game, names: g.real, vsBot: g.vsBot });
  }
  live = next;
}
const pollTimer = setInterval(pollLive, POLL_MS);
if (pollTimer.unref) pollTimer.unref();

// ------------------------------------------------------------------ snapshot for the page
/**
 * What the front page draws. `me` (optional) is a username the browser says it belongs to;
 * the view is centred on that village. Without one it is centred on the next free place,
 * which is shown as the "free plot" — exactly where a new player's village will appear.
 * `at` ({ q, r }, optional) is where the visitor has dragged the map to; it overrides the centre.
 */
// Answers are cached for 2 s per (player, place): every open front page polls every 10 s, and the
// live games are refreshed by the 3 s timer above anyway.
const snapCache = new Map();
function snapshot(me, at) {
  const key = (me || '') + '|' + (at ? at.q + ',' + at.r : '');
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.t < 2000) return hit.v;
  const v = buildSnapshot(me, at);
  if (snapCache.size > 500) snapCache.clear();
  snapCache.set(key, { t: Date.now(), v });
  return v;
}

function buildSnapshot(me, at) {
  seedAccounts();
  const online = onlineNames();
  const meName = me && users.usernameExists(me) ? me : null;
  const freeHex = slotToHex(data.next);
  const home = meName ? slotToHex(slotOf(meName)) : freeHex;
  const center = at && Number.isInteger(at.q) && Number.isInteger(at.r) ? { q: at.q, r: at.r } : home;
  // how far out the villages go: the page doesn't let the map be dragged much past this
  let extent = 1;
  while (1 + 3 * extent * (extent + 1) < data.next + 1) extent++;

  const towns = [];
  for (const [name, idx] of Object.entries(data.slots)) {
    const h = slotToHex(idx);
    if (hexDist(h, center) > WINDOW) continue;
    if (!users.usernameExists(name)) continue; // deleted accounts leave an empty place
    const g = has(data.games, name) ? data.games[name] : { d: 0, m: 0 };
    towns.push({ name, q: h.q, r: h.r, L: levelOf(name), g: g.m > g.d ? 'm' : 'd', n: g.d + g.m, online: online.has(name) });
  }
  const shown = new Set(towns.map((t) => t.name));
  let hosts = [];
  try { hosts = tourHosts() || []; } catch { hosts = []; }
  for (const t of towns) if (hosts.includes(t.name)) t.tour = true;

  const pairs = [];
  for (const [key, n] of Object.entries(data.pairs)) {
    const [a, b] = key.split('\u0001');
    if (shown.has(a) && shown.has(b)) pairs.push({ a, b, n });
  }

  const matches = [];
  const solo = [];
  let playing = 0;
  let tables = { d: 0, m: 0 };
  let guestsPlaying = 0;
  for (const g of live) {
    playing += g.players.length + g.guests;
    guestsPlaying += g.players.length - g.real.length + g.guests;
    tables[g.game] += 1;
    const here = g.real.filter((n) => shown.has(n));
    if (here.length >= 2) {
      for (let i = 0; i + 1 < here.length; i++) matches.push({ id: g.id + ':' + i, a: here[i], b: here[i + 1], g: g.game });
    } else if (here.length === 1) {
      solo.push({ id: g.id, name: here[0], g: g.game, vsBot: g.vsBot });
    }
  }

  return {
    center,
    home,
    extent,
    me: meName,
    plot: meName ? null : freeHex,
    towns,
    pairs,
    matches,
    solo,
    // online: accounts (in a game or on the front page) + guests at tables + guests with the front page open
    counts: { playing, online: online.size + guestsPlaying + guestVisitors(), tables },
    // only recent news: the ticker must not keep showing a game that started an hour ago
    events: events.filter((e) => Date.now() - e.t < EVENT_MAX_AGE_MS).slice(-12),
    // the newest village news of any age, for the list under the map (deleted accounts left out)
    history: data.history.filter((e) => (e.names || []).every((n) => users.usernameExists(n))).slice(-HISTORY_SHOWN),
    // games needed for each village level, for the progress ring round each village
    levels: LEVELS,
  };
}

/** A renamed account keeps its village, its level and its roads. */
function renameName(oldName, newName) {
  if (has(data.slots, oldName) && !has(data.slots, newName)) { data.slots[newName] = data.slots[oldName]; delete data.slots[oldName]; }
  if (has(data.games, oldName) && !has(data.games, newName)) { data.games[newName] = data.games[oldName]; delete data.games[oldName]; }
  for (const key of Object.keys(data.pairs)) {
    const [a, b] = key.split('\u0001');
    if (a !== oldName && b !== oldName) continue;
    const n = data.pairs[key];
    delete data.pairs[key];
    data.pairs[pairKey(a === oldName ? newName : a, b === oldName ? newName : b)] = n;
  }
  for (const e of events) if (e.names) e.names = e.names.map((x) => (x === oldName ? newName : x));
  for (const e of data.history) {
    if (e.names) e.names = e.names.map((x) => (x === oldName ? newName : x));
    if (e.winner === oldName) e.winner = newName;
    if (e.host === oldName) e.host = newName;
  }
  snapCache.clear();
  saveSoon();
}

/** Map-side facts about one player for the village card (level, games, place). */
function playerInfo(name) {
  if (!name || !users.usernameExists(name) || !has(data.slots, name)) return null;
  const g = has(data.games, name) ? data.games[name] : { d: 0, m: 0 };
  return { level: levelOf(name), games: { d: g.d, m: g.m }, online: onlineNames().has(name), playing: live.some((x) => x.real.includes(name)) };
}

module.exports = { renameName, playerInfo, recordGame, seen, gone, touch, provide, provideTournamentHosts, seedGames, snapshot, levelOf, _slotToHex: slotToHex };

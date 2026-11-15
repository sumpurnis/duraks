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

const FILE = path.join(DATA_DIR, 'world.json');
const GAMES = { duraks: 'd', meli: 'm' };
// Games needed for each of the 10 village levels.
const LEVELS = [0, 1, 5, 12, 25, 45, 75, 120, 180, 260];
const WINDOW = 3; // hex rings sent around the centre of the view (the page draws a margin around the screen for dragging)
const MAX_EVENTS = 30;
const POLL_MS = 3000;

// ------------------------------------------------------------------ storage
function blank() {
  return { slots: {}, next: 0, games: {}, pairs: {}, seeded: {} };
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...blank(), ...d };
  } catch {
    return blank();
  }
}
let data = load();
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('world.json could not be saved:', err.message);
    }
  }, 800);
  if (saveTimer.unref) saveTimer.unref();
}

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
  if (!(name in data.slots)) {
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
    const g = data.games[a.username] || (data.games[a.username] = { d: 0, m: 0 });
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
    const g = data.games[name] || (data.games[name] = { d: 0, m: 0 });
    g[k] = Math.max(g[k], n || 0);
  }
  data.seeded[game] = true;
  saveSoon();
}

// ------------------------------------------------------------------ events
let events = [];
let eventId = 0;
function addEvent(e) {
  events.push({ id: ++eventId, t: Date.now(), ...e });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

const pairKey = (a, b) => (a < b ? a + '\u0001' + b : b + '\u0001' + a);
const quality = (n) => (n >= 100 ? 3 : n >= 25 ? 2 : n >= 5 ? 1 : 0);

/** A finished game. `names` are every human seat; guests are ignored. */
function recordGame(game, names, { vsBot = false } = {}) {
  const k = GAMES[game];
  if (!k) return;
  const real = [...new Set((names || []).filter((n) => n && users.usernameExists(n)))];
  for (const n of real) {
    slotOf(n);
    const g = data.games[n] || (data.games[n] = { d: 0, m: 0 });
    const before = levelOf(n);
    g[k] += 1;
    if (levelOf(n) > before) addEvent({ type: 'level', names: [n], level: levelOf(n) });
  }
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const key = pairKey(real[i], real[j]);
      const before = quality(data.pairs[key] || 0);
      data.pairs[key] = (data.pairs[key] || 0) + 1;
      addEvent({ type: 'finish', game: k, names: [real[i], real[j]] });
      const after = quality(data.pairs[key]);
      if (after > before) addEvent({ type: 'road', names: [real[i], real[j]], quality: after });
    }
  }
  if (real.length === 1) addEvent({ type: 'finishSolo', game: k, names: real, vsBot: !!vsBot });
  saveSoon();
}

function levelOf(name) {
  const g = data.games[name];
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
function onlineNames() {
  return new Set(presence.values());
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
function snapshot(me, at) {
  seedAccounts();
  pollLive();
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
    const g = data.games[name] || { d: 0, m: 0 };
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
    counts: { playing, online: online.size + guestsPlaying, tables },
    events: events.slice(-12),
  };
}

/** Map-side facts about one player for the village card (level, games, place). */
function playerInfo(name) {
  if (!name || !users.usernameExists(name) || !(name in data.slots)) return null;
  const g = data.games[name] || { d: 0, m: 0 };
  return { level: levelOf(name), games: { d: g.d, m: g.m }, online: onlineNames().has(name), playing: live.some((x) => x.real.includes(name)) };
}

module.exports = { playerInfo, recordGame, seen, gone, provide, provideTournamentHosts, seedGames, snapshot, levelOf, _slotToHex: slotToHex };

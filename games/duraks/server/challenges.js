'use strict';

/**
 * Duraks challenges ("Izaicinājumi"). For now the daily one; weekly and monthly come later.
 *
 * The daily challenge: one fixed deal for everyone (1 v 1, 36 cards) against a computer that knows
 * every card. Three levels, each tuned so a typical player wins about the admin's target share:
 *   CHALLENGE_TARGETS=20,10,5      (percent, for Viegls / Vidējs / Grūts)
 *   CHALLENGE_ATTEMPTS=3           (attempts per level per day; a won level is done)
 * A level won = a place in that level's list for the day (fewer moves = higher) and a reward:
 * points (+10 / +25 / +50) and, for the hardest, a badge.
 *
 * A new day starts at midnight, Latvian time. Each day's deal is picked and tuned in a worker thread
 * (challenge-calibrate.js, about a minute); the next day's is prepared in advance.
 * Kept in DATA_DIR/challenges.json (the last 14 days), with the real win rate of every level.
 */

const path = require('path');
const { Worker } = require('node:worker_threads');
const { DATA_DIR } = require('../../../platform/config');
const persist = require('../../../platform/persist');

const FILE = path.join(DATA_DIR, 'challenges.json');
const TZ = 'Europe/Riga';
const KEEP_DAYS = 14;
const TOP_SHOWN = 10;

const LEVELS = [
  { id: 'easy', name: 'Viegls', reward: 10, badge: null },
  { id: 'mid', name: 'Vidējs', reward: 25, badge: null },
  { id: 'hard', name: 'Grūts', reward: 50, badge: 'daily-hard' },
];

function parseTargets() {
  const raw = String(process.env.CHALLENGE_TARGETS || '20,10,5').split(',').map((x) => Number(x.trim()));
  const ok = raw.length === LEVELS.length && raw.every((x) => x > 0 && x < 100);
  return (ok ? raw : [20, 10, 5]).map((x) => x / 100);
}
const TARGETS = parseTargets();
const ATTEMPTS = Math.max(1, Math.min(20, parseInt(process.env.CHALLENGE_ATTEMPTS, 10) || 3));

const data = persist.loadJson(FILE, () => ({ days: {} }), 'challenges.json');
if (!data.days || typeof data.days !== 'object') data.days = {};
const saver = persist.createSaver(FILE, () => data, { label: 'challenges.json' });
const save = () => saver.save();

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const levelOf = (id) => LEVELS.find((l) => l.id === id) || null;

/** Today's date in Latvia, YYYY-MM-DD. */
function dayKey(at = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
function nextDayKey(at = Date.now()) {
  return dayKey(at + msToMidnight(at) + 60 * 1000);
}
/** Milliseconds until midnight in Latvia. */
function msToMidnight(at = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const passed = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (at % 1000);
  return 24 * 3600 * 1000 - passed;
}

// ---------------------------------------------------------------- preparing days

let users = null; // platform/users (rewards); set by init()
const pending = new Map(); // date -> Promise
let calibrateOpts = {};

function prepare(date) {
  if (data.days[date] && data.days[date].deck) return Promise.resolve(data.days[date]);
  if (pending.has(date)) return pending.get(date);
  const job = new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'challenge-worker.js'), { workerData: { date, targets: TARGETS, opts: calibrateOpts } });
    w.once('message', (msg) => {
      pending.delete(date);
      if (!msg.ok) {
        console.error(`Daily challenge ${date} could not be prepared:`, msg.error);
        return resolve(null);
      }
      const r = msg.result;
      data.days[date] = {
        date,
        seed: r.seed,
        deck: r.deck,
        targets: TARGETS.slice(),
        skills: Object.fromEntries(LEVELS.map((l, i) => [l.id, r.skills[i]])),
        expected: Object.fromEntries(LEVELS.map((l, i) => [l.id, r.measured[i]])),
        attempts: {}, // username -> { easy: n, … }
        wins: {}, // level -> [{ username, moves, at }]
        stats: Object.fromEntries(LEVELS.map((l) => [l.id, { plays: 0, wins: 0 }])),
      };
      prune();
      save();
      console.log(`Daily challenge ${date} ready: strength ${LEVELS.map((l, i) => `${l.name} ${r.skills[i].toFixed(2)} (~${Math.round(r.measured[i] * 100)}%)`).join(', ')}`);
      resolve(data.days[date]);
    });
    w.once('error', (err) => {
      pending.delete(date);
      console.error(`Daily challenge ${date} worker failed:`, err);
      resolve(null);
    });
  });
  pending.set(date, job);
  return job;
}

function prune() {
  const keys = Object.keys(data.days).sort();
  while (keys.length > KEEP_DAYS) delete data.days[keys.shift()];
}

let dayTimer = null;
/** Start: prepare today and tomorrow, and keep doing so every day. */
function init(opts = {}) {
  users = opts.users || users;
  // CHALLENGE_SIMS: fewer simulations per step (faster, less exact) — for tests and small machines
  const sims = parseInt(process.env.CHALLENGE_SIMS, 10);
  calibrateOpts = opts.calibrate || (sims > 0 ? { sims, steps: 5, tries: 8 } : {});
  if (opts.prepare === false) return;
  const tick = () => {
    prepare(dayKey()).then(() => prepare(nextDayKey()));
    clearTimeout(dayTimer);
    dayTimer = setTimeout(tick, Math.min(msToMidnight() + 5000, 3600 * 1000));
    if (dayTimer.unref) dayTimer.unref();
  };
  tick();
}

function today() {
  const d = data.days[dayKey()];
  return d && d.deck ? d : null;
}

// ---------------------------------------------------------------- players

function attemptsUsed(day, username, level) {
  const a = hasOwn(day.attempts, username) ? day.attempts[username] : null;
  return (a && a[level]) || 0;
}
function winOf(day, username, level) {
  return (day.wins[level] || []).find((w) => w.username === username) || null;
}

/** Can `username` start an attempt at `level` today? */
function canStart(username, level) {
  const day = today();
  if (!day) return { error: 'Šodienas izaicinājums vēl tiek gatavots — mēģini pēc minūtes.' };
  if (!username) return { error: 'Izaicinājumi ir reģistrētiem spēlētājiem — ielogojies.' };
  if (!levelOf(level)) return { error: 'Nezināma grūtība.' };
  if (winOf(day, username, level)) return { error: 'Šo līmeni šodien tu jau uzvarēji.' };
  if (attemptsUsed(day, username, level) >= ATTEMPTS) return { error: 'Šim līmenim šodien mēģinājumi ir izmantoti.' };
  return { ok: true, day };
}

/** Start an attempt: it counts as used straight away (leaving mid-game doesn't give it back). */
function startAttempt(username, level) {
  const check = canStart(username, level);
  if (check.error) return check;
  const day = check.day;
  if (!hasOwn(day.attempts, username)) day.attempts[username] = {};
  day.attempts[username][level] = attemptsUsed(day, username, level) + 1;
  day.stats[level].plays += 1;
  save();
  return { ok: true, date: day.date, level, seed: day.seed, skill: day.skills[level], deck: day.deck, attempt: day.attempts[username][level] };
}

/** A challenge game ended. Returns { won, reward, badge, place } for the player. */
function recordResult(username, date, level, won, moves) {
  const day = data.days[date];
  if (!day || !levelOf(level)) return null;
  if (!won) return { won: false };
  if (winOf(day, username, level)) return { won: true };
  day.stats[level].wins += 1;
  const list = day.wins[level] || (day.wins[level] = []);
  list.push({ username, moves, at: Date.now() });
  list.sort((a, b) => a.moves - b.moves || a.at - b.at);
  const lv = levelOf(level);
  if (users && users.addReward) users.addReward(username, lv.reward, lv.badge ? `${lv.badge}:${date}` : null);
  save();
  return { won: true, reward: lv.reward, badge: !!lv.badge, place: list.findIndex((w) => w.username === username) + 1 };
}

/** Everything the "Izaicinājumi" window shows, for one player (or a guest). */
function statusFor(username) {
  const day = today();
  const base = {
    ready: !!day,
    signedIn: !!username,
    attemptsMax: ATTEMPTS,
    endsInMs: msToMidnight(),
    points: username && users && users.getRewards ? users.getRewards(username).points : 0,
  };
  if (!day) return { ...base, levels: LEVELS.map((l, i) => ({ id: l.id, name: l.name, targetPct: Math.round(TARGETS[i] * 100), reward: l.reward, badge: !!l.badge })) };
  return {
    ...base,
    date: day.date,
    levels: LEVELS.map((l, i) => {
      const used = username ? attemptsUsed(day, username, l.id) : 0;
      const win = username ? winOf(day, username, l.id) : null;
      return {
        id: l.id,
        name: l.name,
        targetPct: Math.round((day.targets[i] || TARGETS[i]) * 100),
        reward: l.reward,
        badge: !!l.badge,
        attemptsUsed: used,
        won: !!win,
        moves: win ? win.moves : null,
        canPlay: !!username && !win && used < ATTEMPTS,
      };
    }),
    top: Object.fromEntries(LEVELS.map((l) => [l.id, (day.wins[l.id] || []).slice(0, TOP_SHOWN).map((w) => ({ username: w.username, moves: w.moves }))])),
  };
}

/** For the "!" marks: is there a challenge this player hasn't tried yet today? (guests: any) */
function isNewFor(username) {
  const day = today();
  if (!day) return false;
  if (!username) return true;
  return !hasOwn(day.attempts, username);
}

/** The admin's view: targets, tuned strength and real win rates per level, for the last days. */
function adminReport() {
  return Object.values(data.days)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((d) => ({
      date: d.date,
      levels: LEVELS.map((l, i) => ({
        level: l.id,
        target: d.targets[i],
        skill: d.skills[l.id],
        expected: d.expected[l.id],
        plays: d.stats[l.id].plays,
        wins: d.stats[l.id].wins,
      })),
    }));
}

module.exports = { init, prepare, today, canStart, startAttempt, recordResult, statusFor, isNewFor, adminReport, dayKey, msToMidnight, LEVELS, _data: data };

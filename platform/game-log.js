'use strict';
// The admin's game log: every game played on the site (Duraks and Meļi), from the deal to the end.
//
// Kept in DATA_DIR/gamelog/<YYYY-MM>.jsonl, one JSON object per line, appended — nothing is rewritten:
//   { k: 's', id, game, at, mode, players: [{ name, kind: 'user'|'guest'|'bot' }], opts, setup }
//   { k: 'e', id, at, status: 'finished'|'ended', reason, result, moves: [[ms, text], …] }
// A start with no end line is a game the server lost (a restart in the middle): it is shown as
// "pārtraukts". Games still running are in memory ("notiek"). Months older than KEEP_MONTHS are deleted
// at start-up, so the log can't fill the disk.
//
// The game modules know nothing of files: they get { start, sync, move, end } from server.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const DIR = process.env.GAME_LOG_DIR || path.join(DATA_DIR, 'gamelog');
const KEEP_MONTHS = Math.max(1, Number(process.env.GAME_LOG_MONTHS) || 6);
const MAX_MOVES = 3000; // a stuck bot game can't grow one line without end
const MAX_INDEX = 20000; // summaries kept in memory for the list (newest)

let ready = false;
const index = new Map(); // id -> summary (no moves), newest last
const live = new Map(); // id -> { start, moves, seen }

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const fileOf = (month) => path.join(DIR, month + '.jsonl');

function init() {
  if (ready) return;
  ready = true;
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { console.error('game log: cannot create', DIR, e.message); return; }
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { files = []; }
  // forget old months
  const now = new Date();
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (KEEP_MONTHS - 1), 1)).toISOString().slice(0, 7);
  for (const f of files) {
    if (f.slice(0, 7) < oldest) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* keep going */ } }
  }
  files = files.filter((f) => f.slice(0, 7) >= oldest);
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r.id !== 'string') continue;
      if (r.k === 's') index.set(r.id, summaryOfStart(r));
      else if (r.k === 'e' && index.has(r.id)) Object.assign(index.get(r.id), summaryOfEnd(r));
    }
  }
  trimIndex();
}

function summaryOfStart(r) {
  return {
    id: r.id, game: r.game, at: r.at, mode: r.mode || '', month: monthOf(r.at),
    players: r.players || [], bots: (r.players || []).filter((p) => p.kind === 'bot').length,
    opts: r.opts || {}, status: 'interrupted', endedAt: null, reason: null, result: null, moveCount: 0,
  };
}
function summaryOfEnd(r) {
  return { status: r.status, endedAt: r.at, reason: r.reason || null, result: r.result || null, moveCount: (r.moves || []).length };
}
function trimIndex() {
  while (index.size > MAX_INDEX) index.delete(index.keys().next().value);
}

function append(rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileOf(monthOf(rec.at)), JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('game log: write failed:', e.message);
  }
}

/**
 * A game starts. info: { game: 'duraks'|'meli', mode, players: [{ name, kind }], opts, setup }.
 * Returns the game's id (pass it to sync/move/end).
 */
function start(info) {
  init();
  const at = Date.now();
  const id = `${info.game}-${at.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const rec = { k: 's', id, game: info.game, at, mode: info.mode || '', players: info.players || [], opts: info.opts || {}, setup: info.setup || null };
  append(rec);
  index.set(id, summaryOfStart(rec));
  index.get(id).status = 'live';
  trimIndex();
  live.set(id, { start: rec, moves: [], seen: 0 });
  return id;
}

/** One move, as text ("Anna uzbrūk ar 7♥"). */
function move(id, text) {
  const g = id && live.get(id);
  if (!g || g.moves.length >= MAX_MOVES) return;
  g.moves.push([Date.now() - g.start.at, String(text).slice(0, 300)]);
  index.get(id).moveCount = g.moves.length;
}

/** For engines that keep their own list of lines: adds the lines not seen yet. */
function sync(id, lines) {
  const g = id && live.get(id);
  if (!g || !Array.isArray(lines)) return;
  for (let i = g.seen; i < lines.length; i++) move(id, lines[i]);
  g.seen = lines.length;
}

/** The game is over. info: { status: 'finished' | 'ended', reason, result }. */
function end(id, info = {}) {
  const g = id && live.get(id);
  if (!g) return;
  live.delete(id);
  const rec = { k: 'e', id, at: Date.now(), status: info.status || 'finished', reason: info.reason || null, result: info.result || null, moves: g.moves };
  append(rec);
  if (index.has(id)) Object.assign(index.get(id), summaryOfEnd(rec));
}

// ---------------------------------------------------------------- admin reading

/** Newest first. q: { game, status, player, before (id), limit } */
function list(q = {}) {
  init();
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const player = q.player ? String(q.player).toLowerCase() : '';
  const all = [...index.values()];
  let i = all.length - 1;
  if (q.before) { const at = all.findIndex((s) => s.id === q.before); if (at >= 0) i = at - 1; }
  const out = [];
  for (; i >= 0 && out.length < limit; i--) {
    const s = all[i];
    if (q.game && s.game !== q.game) continue;
    if (q.status && s.status !== q.status) continue;
    if (player && !s.players.some((p) => String(p.name).toLowerCase().includes(player))) continue;
    out.push(s);
  }
  const counts = { live: 0, finished: 0, ended: 0, interrupted: 0 };
  for (const s of all) if (s.status in counts) counts[s.status]++;
  return { games: out, more: i >= 0, total: all.length, counts, keepMonths: KEEP_MONTHS };
}

/** One game in full: start record, end record (or the moves so far while it runs). */
function get(id) {
  init();
  const s = index.get(String(id || ''));
  if (!s) return null;
  const g = live.get(s.id);
  if (g) return { ...s, setup: g.start.setup, moves: g.moves.slice() };
  let text = '';
  try { text = fs.readFileSync(fileOf(s.month), 'utf8'); } catch { return { ...s, moves: [] }; }
  let start = null, endRec = null;
  for (const line of text.split('\n')) {
    if (!line || !line.includes(s.id)) continue;
    try {
      const r = JSON.parse(line);
      if (r.id !== s.id) continue;
      if (r.k === 's') start = r; else if (r.k === 'e') endRec = r;
    } catch { /* skip */ }
  }
  // an end in the next month's file (a game across midnight at the month's end)
  if (!endRec) {
    const next = new Date(s.at); next.setUTCMonth(next.getUTCMonth() + 1);
    try {
      for (const line of fs.readFileSync(fileOf(monthOf(next.getTime())), 'utf8').split('\n')) {
        if (!line || !line.includes(s.id)) continue;
        const r = JSON.parse(line);
        if (r.id === s.id && r.k === 'e') endRec = r;
      }
    } catch { /* none */ }
  }
  return { ...s, setup: start ? start.setup : null, moves: endRec ? endRec.moves || [] : [] };
}

/** For tests. */
function _reset() { index.clear(); live.clear(); ready = false; }

module.exports = { start, move, sync, end, list, get, init, DIR, _reset };

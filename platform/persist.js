'use strict';

// Safe JSON files for the whole site (accounts, feedback, tournaments, the front-page map).
//
//   loadJson(file, fallback, label)   read a file; falls back to its .bak copy; refuses to start
//                                     (throws) when the file exists but can't be read, instead of
//                                     silently starting empty and later overwriting everything.
//   createSaver(file, getData, opts)  save() marks the data dirty and writes at most once per
//                                     `delay` ms; flush() writes now. Every write goes to a temp
//                                     file first and is then renamed over the real one (atomic on
//                                     the same disk), so a crash mid-write can't truncate the file.
//                                     An hourly copy is kept as <file>.bak.
//
// All savers are flushed on shutdown (SIGTERM from Railway, Ctrl+C) and before a crash exit.

const fs = require('fs');
const path = require('path');

const BACKUP_EVERY_MS = 60 * 60 * 1000;
const savers = new Set();
const lastBackup = new Map();

function loadJson(file, fallback, label = path.basename(file)) {
  const bak = file + '.bak';
  for (const f of [file, bak]) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (f === bak) console.warn(`${label}: ${file} was missing or unreadable — loaded the backup ${bak}`);
      return data;
    } catch (err) {
      console.error(`${label}: cannot read ${f}: ${err.message}`);
    }
  }
  if (fs.existsSync(file)) {
    // The file is there but broken and there is no usable backup. Starting empty would
    // overwrite it on the first save — stop and let a person look at it instead.
    throw new Error(`${label}: refusing to start — ${file} exists but cannot be parsed. Repair it or move it away.`);
  }
  return fallback();
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  const now = Date.now();
  if (fs.existsSync(file) && now - (lastBackup.get(file) || 0) > BACKUP_EVERY_MS) {
    try { fs.copyFileSync(file, file + '.bak'); lastBackup.set(file, now); } catch (err) { console.error('backup failed', file, err.message); }
  }
  fs.renameSync(tmp, file);
}

function createSaver(file, getData, { delay = 1000, label = path.basename(file) } = {}) {
  let timer = null;
  let dirty = false;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      writeAtomic(file, getData());
    } catch (err) {
      dirty = true; // try again on the next save
      console.error(`${label}: could not be saved: ${err.message}`);
    }
  }
  function save() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, delay);
    if (timer.unref) timer.unref();
  }
  const saver = { save, flush };
  savers.add(saver);
  return saver;
}

function flushAll() {
  for (const s of savers) s.flush();
}

let hooked = false;
function hookShutdown() {
  if (hooked) return;
  hooked = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      flushAll();
      process.exit(0);
    });
  }
  process.on('beforeExit', flushAll);
  // Last resort: anything that still escapes (the socket wrapper in server.js catches handler errors)
  // is logged, data is written, and the process exits so Railway restarts it cleanly.
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    flushAll();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled promise rejection:', err);
  });
}
hookShutdown();

module.exports = { loadJson, writeAtomic, createSaver, flushAll };

'use strict';
// Where the site keeps its data files (users.json, feedback.json, tournaments.json, meli-stats.json …).
// 1. DURAKS_DATA_DIR if set (e.g. the Railway Volume) — unchanged from before.
// 2. else <project>/server/data if that folder already exists (where older versions kept it),
// 3. else <project>/data.
// So an existing install keeps finding its accounts after the folders were reorganised.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function resolveDataDir() {
  if (process.env.DURAKS_DATA_DIR) return process.env.DURAKS_DATA_DIR;
  const legacy = path.join(ROOT, 'server', 'data');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(ROOT, 'data');
}

module.exports = { ROOT, DATA_DIR: resolveDataDir() };

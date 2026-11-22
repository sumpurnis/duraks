'use strict';

// Runs challenge-calibrate.js off the main thread (it simulates a few thousand games).
const { parentPort, workerData } = require('node:worker_threads');
const { calibrate } = require('./challenge-calibrate');

try {
  parentPort.postMessage({ ok: true, result: calibrate(workerData.date, workerData.targets, workerData.opts || {}) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
}

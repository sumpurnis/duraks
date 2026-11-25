'use strict';
// The front page's "Notikumi ciematos" list and the level progress data (platform/world.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Each step runs in its own process, like a server start, on the same data folder.
function run(dir, code) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const users = require('./platform/users');
    const world = require('./platform/world');
    (async () => { const out = await (async () => { ${code} })(); require('./platform/persist').flushAll(); process.stdout.write(JSON.stringify(out)); setTimeout(() => process.exit(0), 200); })();
  `], { cwd: ROOT, env: { ...process.env, DURAKS_DATA_DIR: dir } }).toString());
}

test('news is kept across restarts, newest 10, one line per table of 3+', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uzs-world-'));
  try {
    const first = run(dir, `
      for (const n of ['Anna', 'Bob', 'Ilze']) await users.createAccount(n, 'parole1234', n + '@example.lv');
      world.recordGame('duraks', ['Anna', 'Bob']);
      world.recordGame('duraks', ['Anna', 'Bob', 'Ilze']);
      const s = world.snapshot('Anna');
      return { history: s.history, levels: s.levels };
    `);
    assert.deepStrictEqual(first.levels, [0, 1, 5, 12, 25, 45, 75, 120, 180, 260]);
    const finishes = first.history.filter((e) => e.type === 'finish');
    assert.deepStrictEqual(finishes.map((e) => e.names.length), [2, 3], 'the 3-player table is one line');
    // a restart: still there, and new ids continue after the old ones
    const second = run(dir, `
      world.recordGame('meli', ['Ilze'], { vsBot: true });
      return world.snapshot('Anna').history;
    `);
    assert.ok(second.length > first.history.length);
    assert.strictEqual(second[second.length - 1].type, 'finishSolo');
    assert.ok(second[second.length - 1].id > first.history[first.history.length - 1].id);
    // the winner and the host's place ride along on finished games
    const fourth = run(dir, `
      world.recordGame('duraks', ['Anna', 'Bob', 'Ilze'], { winner: 'Ilze', host: 'Anna', hostPlace: 3 });
      world.recordGame('meli', ['Bob'], { vsBot: true, winner: 'Dators 1', host: 'Bob', hostPlace: 2 });
      world.recordGame('meli', ['Ilze'], { vsBot: true, winner: 'Ilze', host: 'Ilze', hostPlace: 1, }); 
      return world.snapshot('Anna').history.slice(-3);
    `);
    assert.deepStrictEqual([fourth[0].winner, fourth[0].host, fourth[0].hostPlace], ['Ilze', 'Anna', 3]);
    assert.deepStrictEqual([fourth[1].type, fourth[1].winner, fourth[1].hostPlace], ['finishSolo', 'Dators 1', 2]);
    assert.strictEqual(fourth[2].winner, 'Ilze');
    // only the newest 10 are sent
    const third = run(dir, `
      for (let i = 0; i < 20; i++) world.recordGame('duraks', ['Anna', 'Bob']);
      return world.snapshot('Anna').history;
    `);
    assert.strictEqual(third.length, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

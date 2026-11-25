'use strict';
// The admin's game log (platform/game-log.js) and its admin-only API. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'uzs-gamelog-'));
process.env.DURAKS_DATA_DIR = DATA;
const gameLog = require('../game-log');

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('a game from start to end: listed, readable in full', () => {
  const id = gameLog.start({ game: 'duraks', mode: 'casual', players: [{ name: 'Anna', kind: 'user' }, { name: 'Dators', kind: 'bot' }], opts: { deck: 36 }, setup: { trump: '7♥', hands: { Anna: ['6♠'] } } });
  let l = gameLog.list();
  assert.strictEqual(l.games[0].id, id);
  assert.strictEqual(l.games[0].status, 'live');
  assert.strictEqual(l.games[0].bots, 1);
  gameLog.sync(id, ['Anna attacks with 6 of spades']);
  gameLog.sync(id, ['Anna attacks with 6 of spades', 'Dators defends with 9 of spades']); // only the new line is added
  gameLog.move(id, 'Anna nepiemet');
  // while it runs, the moves so far are readable
  assert.strictEqual(gameLog.get(id).moves.length, 3);
  gameLog.end(id, { status: 'finished', reason: 'normal', result: { durak: 'Anna' } });
  l = gameLog.list();
  assert.strictEqual(l.games[0].status, 'finished');
  assert.strictEqual(l.games[0].moveCount, 3);
  const g = gameLog.get(id);
  assert.strictEqual(g.setup.trump, '7♥');
  assert.deepStrictEqual(g.moves.map((m) => m[1]), ['Anna attacks with 6 of spades', 'Dators defends with 9 of spades', 'Anna nepiemet']);
  assert.ok(g.moves.every((m) => typeof m[0] === 'number'));
  // moves after the end are ignored
  gameLog.move(id, 'late');
  assert.strictEqual(gameLog.get(id).moves.length, 3);
});

test('after a restart: finished games read back, a game with no end is "interrupted"', () => {
  const lost = gameLog.start({ game: 'meli', players: [{ name: 'Bob', kind: 'guest' }] });
  gameLog.move(lost, 'Bob noliek K♥ kā A♥');
  gameLog._reset(); // the server restarts: memory gone, the file stays
  const l = gameLog.list();
  const s = l.games.find((x) => x.id === lost);
  assert.strictEqual(s.status, 'interrupted');
  assert.strictEqual(l.counts.finished, 1);
  assert.strictEqual(l.counts.interrupted, 1);
  assert.deepStrictEqual(gameLog.get(lost).moves, []);
});

test('filters and paging', () => {
  for (let i = 0; i < 5; i++) {
    const id = gameLog.start({ game: i % 2 ? 'meli' : 'duraks', players: [{ name: 'P' + i, kind: 'user' }] });
    gameLog.end(id, { status: i === 4 ? 'ended' : 'finished', reason: i === 4 ? 'surrender' : 'normal' });
  }
  assert.ok(gameLog.list({ game: 'meli' }).games.every((g) => g.game === 'meli'));
  assert.deepStrictEqual(gameLog.list({ status: 'ended' }).games.map((g) => g.players[0].name), ['P4']);
  assert.deepStrictEqual(gameLog.list({ player: 'p3' }).games.map((g) => g.players[0].name), ['P3']);
  const page1 = gameLog.list({ limit: 2 });
  assert.strictEqual(page1.games.length, 2);
  assert.strictEqual(page1.more, true);
  const page2 = gameLog.list({ limit: 2, before: page1.games[1].id });
  assert.notStrictEqual(page2.games[0].id, page1.games[1].id);
});

test('months older than the keep window are deleted at start-up', () => {
  fs.writeFileSync(path.join(gameLog.DIR, '2001-01.jsonl'), JSON.stringify({ k: 's', id: 'old-1', game: 'duraks', at: Date.UTC(2001, 0, 5), players: [] }) + '\n');
  gameLog._reset();
  gameLog.list();
  assert.ok(!fs.existsSync(path.join(gameLog.DIR, '2001-01.jsonl')));
  assert.ok(!gameLog.list().games.some((g) => g.id === 'old-1'));
});

// ---------- the admin API on the real server ----------
test('the API answers the admin only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uzs-gamelog-srv-'));
  // an admin account and a normal one, made before the server starts (same data folder)
  const env = { ...process.env, DURAKS_DATA_DIR: dir };
  const prep = spawn(process.execPath, ['-e', `
    const users = require('./platform/users');
    (async () => {
      await users.createAccount('Bosss', 'parole1234', 'boss@example.lv');
      await users.createAccount('Parasts', 'parole1234', 'p@example.lv');
      const out = { admin: users.createSessionToken('Bosss'), user: users.createSessionToken('Parasts') };
      users.flush();
      require('./platform/persist').flushAll();
      process.stdout.write(JSON.stringify(out));
      setTimeout(() => process.exit(0), 300);
    })();`], { cwd: ROOT, env });
  let out = '';
  prep.stdout.on('data', (d) => { out += d; });
  await new Promise((ok) => prep.on('exit', ok));
  const tokens = JSON.parse(out);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, PORT: String(port), CHALLENGES: '0', ADMIN_USERNAME: 'Bosss', TRUST_PROXY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, bad) => {
    let s = '';
    const t = setTimeout(() => bad(new Error('no start: ' + s)), 15000);
    const f = (d) => { s += d; if (/running at/.test(s)) { clearTimeout(t); ok(); } };
    child.stdout.on('data', f); child.stderr.on('data', f);
  });
  const base = `http://127.0.0.1:${port}`;
  const h = (u, t) => ({ 'X-Uzs-User': u, 'X-Uzs-Token': t });
  try {
    assert.strictEqual((await fetch(base + '/api/admin/games')).status, 403);
    assert.strictEqual((await fetch(base + '/api/admin/games', { headers: h('Parasts', tokens.user) })).status, 403);
    assert.strictEqual((await fetch(base + '/api/admin/games', { headers: h('Bosss', 'wrong') })).status, 403);
    const ok = await fetch(base + '/api/admin/games', { headers: h('Bosss', tokens.admin) });
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.ok(Array.isArray(body.games));
    assert.strictEqual((await fetch(base + '/api/admin/games/nope', { headers: h('Bosss', tokens.admin) })).status, 404);
    // the page itself is a plain static file (it shows nothing without the admin's login)
    assert.strictEqual((await fetch(base + '/admin-games.html')).status, 200);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

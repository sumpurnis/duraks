'use strict';
// Discord Activity groundwork: the signature check, and that the website is unchanged while it is off.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const APP_ID = '123456789012345678';

function signed(payload, { enc = 'hex', key = privateKey, tsOverride } = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, bytes, key);
  return {
    'x-discord-proxy-payload': bytes.toString('base64'),
    'x-signature-ed25519': enc === 'hex' ? sig.toString('hex') : sig.toString('base64'),
    'x-signature-timestamp': tsOverride || String(payload.created_at),
  };
}
const now = () => Math.floor(Date.now() / 1000);
const goodPayload = (o = {}) => ({ application_id: APP_ID, user_id: '987654321098765432', channel_id: '1', guild_id: '2', created_at: now(), expires_at: now() + 3600, ...o });
const LAUNCH = 'frame_id=abc123&instance_id=i-1234-gc-5678&platform=desktop';

// ---------- unit: platform/discord.js ----------
const discord = require('../discord');

test('off by default: nothing counts as Discord', () => {
  discord._configure({ enabled: false, publicKeyHex: PUB_HEX, clientId: APP_ID });
  assert.strictEqual(discord.verifyProxy(signed(goodPayload())), null);
  assert.strictEqual(discord.isDiscordRequest({ headers: signed(goodPayload()), query: { frame_id: 'a', instance_id: 'b', platform: 'desktop' } }), false);
  assert.strictEqual(discord.discordKey(signed(goodPayload())), null);
});

test('signature: valid (hex and base64) passes, anything altered fails', () => {
  discord._configure({ enabled: true, publicKeyHex: PUB_HEX, clientId: APP_ID });
  assert.strictEqual(discord.verifyProxy(signed(goodPayload())).user_id, '987654321098765432');
  assert.ok(discord.verifyProxy(signed(goodPayload({ user_id: '111111111111111111' }), { enc: 'base64' })));
  assert.strictEqual(discord.discordKey(signed(goodPayload())), 'discord:987654321098765432');
  // tampered payload (signature of another payload)
  const h = signed(goodPayload());
  h['x-discord-proxy-payload'] = Buffer.from(JSON.stringify(goodPayload({ user_id: '222222222222222222' }))).toString('base64');
  assert.strictEqual(discord.verifyProxy(h), null);
  // signed by someone else's key
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.strictEqual(discord.verifyProxy(signed(goodPayload({ user_id: '333333333333333333' }), { key: other })), null);
  // expired, from the future, timestamp header mismatch, another application
  assert.strictEqual(discord.verifyProxy(signed(goodPayload({ expires_at: now() - 5 }))), null);
  assert.strictEqual(discord.verifyProxy(signed(goodPayload({ created_at: now() + 600 }))), null);
  assert.strictEqual(discord.verifyProxy(signed(goodPayload({ user_id: '444444444444444444' }), { tsOverride: '1' })), null);
  assert.strictEqual(discord.verifyProxy(signed(goodPayload({ application_id: '999' }))), null);
  // missing / junk headers
  assert.strictEqual(discord.verifyProxy({}), null);
  assert.strictEqual(discord.verifyProxy({ 'x-discord-proxy-payload': 'x', 'x-signature-ed25519': 'zz', 'x-signature-timestamp': '1' }), null);
});

test('no public key configured: signatures are never trusted', () => {
  discord._configure({ enabled: true, publicKeyHex: '', clientId: APP_ID });
  assert.strictEqual(discord.verifyProxy(signed(goodPayload())), null);
  assert.strictEqual(discord.discordKey(signed(goodPayload())), null);
});

test('launch parameters: recognised, and ignored when a signature is required', () => {
  discord._configure({ enabled: true, publicKeyHex: PUB_HEX, clientId: APP_ID });
  const q = { frame_id: 'abc', instance_id: 'i-1-gc-2', platform: 'mobile' };
  assert.ok(discord.hasLaunchParams(q));
  assert.ok(!discord.hasLaunchParams({ ...q, platform: 'tv' }));
  assert.ok(!discord.hasLaunchParams({ ...q, frame_id: '<script>' }));
  assert.ok(discord.isDiscordRequest({ headers: {}, query: q }));
  discord._configure({ enabled: true, publicKeyHex: PUB_HEX, clientId: APP_ID, requireSignature: true });
  assert.ok(!discord.isDiscordRequest({ headers: {}, query: q }));
  assert.ok(discord.isDiscordRequest({ headers: signed(goodPayload()), query: {} }));
});

test('one table per instance: first open table wins, closed ones are forgotten', () => {
  discord._configure({ enabled: true });
  const open = new Set(['M-111A', 'M-222B']);
  const isOpen = (g, c) => open.has(c);
  assert.deepStrictEqual(discord.bindTable('i-1', 'duraks', 'M-111A', isOpen), { ok: true });
  assert.strictEqual(discord.bindTable('i-1', 'duraks', 'M-222B', isOpen).error, 'taken');
  assert.deepStrictEqual(discord.lookupTables('i-1', ['duraks', 'meli'], isOpen), { duraks: 'M-111A', meli: null });
  open.delete('M-111A');
  assert.deepStrictEqual(discord.lookupTables('i-1', ['duraks'], isOpen), { duraks: null });
  assert.deepStrictEqual(discord.bindTable('i-1', 'duraks', 'M-222B', isOpen), { ok: true });
  assert.strictEqual(discord.bindTable('i-1', 'duraks', 'NOPE', isOpen).error, 'closed');
  assert.strictEqual(discord.bindTable('bad id!', 'duraks', 'M-222B', isOpen).error, 'bad');
});

test('socket rate-limit key: Discord user only when signed, the address otherwise', () => {
  const { socketIp } = require('../client-ip');
  discord._configure({ enabled: true, publicKeyHex: PUB_HEX, clientId: APP_ID });
  assert.strictEqual(socketIp({ handshake: { headers: signed(goodPayload()), address: '1.2.3.4' } }), 'discord:987654321098765432');
  const forged = signed(goodPayload());
  forged['x-signature-ed25519'] = '00'.repeat(64);
  assert.strictEqual(socketIp({ handshake: { headers: forged, address: '1.2.3.4' } }), '1.2.3.4');
  discord._configure({ enabled: false });
  assert.strictEqual(socketIp({ handshake: { headers: signed(goodPayload()), address: '1.2.3.4' } }), '1.2.3.4');
});

// ---------- the real server, off and on ----------
function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uzs-discord-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DURAKS_DATA_DIR: dir, CHALLENGES: '0', DISCORD_ACTIVITY: '', DISCORD_PUBLIC_KEY: '', DISCORD_CLIENT_ID: '', DISCORD_REQUIRE_SIGNATURE: '', TRUST_PROXY: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    const onData = (d) => { out += d; if (/running at/.test(out)) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${port}`, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } }); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}
const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' });

test('server with Discord OFF: headers and pages exactly as before', async () => {
  const s = await startServer({});
  try {
    for (const u of ['/', '/duraks', '/meli/', '/?' + LAUNCH, '/duraks?' + LAUNCH, '/meli/?' + LAUNCH]) {
      const r = await get(s.base + u, signed(goodPayload()));
      assert.strictEqual(r.status, 200, u);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self';/, u);
      assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN', u);
      const html = await r.text();
      assert.ok(!html.includes('/discord/'), u + ' must not load any Discord file');
    }
    assert.match(await (await get(s.base + '/?' + LAUNCH)).text(), /world-map\.js/, 'the front page, not the Activity');
    for (const u of ['/discord/', '/discord/client.js', '/api/discord/config', '/api/discord/table?instance=x']) {
      assert.strictEqual((await get(s.base + u)).status, 404, u);
    }
  } finally { s.stop(); }
});

test('server with Discord ON: only Discord pages may be framed by Discord', async () => {
  const s = await startServer({ DISCORD_ACTIVITY: '1', DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_CLIENT_ID: APP_ID });
  try {
    // the normal site: unchanged
    for (const u of ['/', '/duraks', '/meli/']) {
      const r = await get(s.base + u);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self';/, u);
      assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN', u);
      assert.ok(!(await r.text()).includes('/discord/client.js'), u);
    }
    // a forged signature changes nothing
    const forged = signed(goodPayload());
    forged['x-signature-ed25519'] = '00'.repeat(64);
    const rf = await get(s.base + '/duraks', forged);
    assert.strictEqual(rf.headers.get('x-frame-options'), 'SAMEORIGIN');
    // the Activity start page at "/" with Discord's launch parameters
    const r0 = await get(s.base + '/?' + LAUNCH);
    assert.strictEqual(r0.status, 200);
    assert.match(r0.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/discord\.com/);
    assert.strictEqual(r0.headers.get('x-frame-options'), null);
    assert.match(await r0.text(), /\/discord\/shell\.js/);
    // game pages inside the Activity get the helper
    for (const [u, g] of [['/duraks?' + LAUNCH, 'duraks'], ['/meli/?' + LAUNCH, 'meli']]) {
      const r = await get(s.base + u);
      assert.strictEqual(r.headers.get('x-frame-options'), null, u);
      assert.match(await r.text(), new RegExp(`/discord/client\\.js\\?v=[0-9a-f]+" data-game="${g}" data-client-id="${APP_ID}"`), u);
    }
    // "/" signed by Discord but without the launch parameters: still the Activity start page
    const rsr = await get(s.base + '/', signed(goodPayload()));
    assert.strictEqual(rsr.headers.get('x-frame-options'), null);
    assert.match(await rsr.text(), /\/discord\/shell\.js/);
    // signed request without launch parameters also counts
    const rs = await get(s.base + '/duraks', signed(goodPayload()));
    assert.strictEqual(rs.headers.get('x-frame-options'), null);
    // API
    const cfg = await (await get(s.base + '/api/discord/config')).json();
    assert.deepStrictEqual(Object.keys(cfg).sort(), ['clientId', 'enabled', 'loginAvailable', 'publicOrigin']);
    const chk = await (await get(s.base + '/api/discord/check', signed(goodPayload()))).json();
    assert.strictEqual(chk.signatureValid, true);
    const tables = await (await get(s.base + '/api/discord/table?instance=i-1234-gc-5678')).json();
    assert.deepStrictEqual(tables, { duraks: null, meli: null });
    const bind = await (await fetch(s.base + '/api/discord/table', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance: 'i-1', game: 'duraks', code: 'M-999Z' }) })).json();
    assert.strictEqual(bind.ok, false, 'a code that is not an open room is refused');
  } finally { s.stop(); }
});

test('server with DISCORD_REQUIRE_SIGNATURE=1: launch parameters alone are not enough', async () => {
  const s = await startServer({ DISCORD_ACTIVITY: '1', DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_CLIENT_ID: APP_ID, DISCORD_REQUIRE_SIGNATURE: '1' });
  try {
    const r = await get(s.base + '/duraks?' + LAUNCH);
    assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(!(await r.text()).includes('/discord/client.js'));
    assert.strictEqual((await get(s.base + '/api/discord/table?instance=x')).status, 401);
    const ok = await get(s.base + '/duraks?' + LAUNCH, signed(goodPayload()));
    assert.strictEqual(ok.headers.get('x-frame-options'), null);
  } finally { s.stop(); }
});

test('the switch tolerates quotes/spaces/true (Railway raw editor), and says so when it is not understood', async () => {
  const on = await startServer({ DISCORD_ACTIVITY: ' "true" ' });
  try { assert.strictEqual((await get(on.base + '/api/discord/config')).status, 200); } finally { on.stop(); }
  const off = await startServer({ DISCORD_ACTIVITY: 'enabled' });
  try { assert.strictEqual((await get(off.base + '/api/discord/config')).status, 404); } finally { off.stop(); }
});

'use strict';
// Discord login for the Activity, and linking Discord to an existing account.
// Only with DISCORD_ACTIVITY=1 AND DISCORD_CLIENT_SECRET set (Railway variable — the one secret here;
// it never leaves the server and is never logged).
//
//   Inside the Activity:  the start page asks Discord for a one-time code (the player clicks "Authorize"
//   once; later launches go through silently) -> POST /api/discord/auth -> we swap the code with Discord
//   for the player's Discord id + name.
//     * Discord already linked to an account -> logged in as that account.
//     * not linked yet -> the player chooses: a new account, or log in to an existing one (name +
//       password, or the account this browser is already logged into) which then gets Discord linked.
//   On the website:  "Piesaistīt Discord" in the account settings (logged in) -> Discord's page ->
//   /auth/discord/callback links it to that account. Works for Google-only accounts too.
//
// Rules: Discord is linked only to an account the player has just proven is theirs (password, a valid
// session, or being logged in on the website); never by matching names or e-mails. One Discord account
// <-> one site account. Unlinking keeps at least one way to log in (see users.unlinkOAuth).

const crypto = require('crypto');
const express = require('express');
const discord = require('./discord');
const { createRateLimiter } = require('./rate-limit');

const CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '').trim();
const API = 'https://discord.com/api';
const PENDING_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function available() {
  return discord.enabled && !!discord.publicConfig().clientId && !!CLIENT_SECRET;
}

// ---------- talking to Discord ----------
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: discord.publicConfig().clientId,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
  });
  if (redirectUri) body.set('redirect_uri', redirectUri);
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('token exchange failed: ' + r.status);
  const t = await r.json();
  if (!t || typeof t.access_token !== 'string') throw new Error('no access token');
  const u = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10000) });
  if (!u.ok) throw new Error('profile failed: ' + u.status);
  const me = await u.json();
  if (!me || !/^\d{5,30}$/.test(String(me.id || ''))) throw new Error('bad profile');
  return { id: String(me.id), name: String(me.global_name || me.username || '').slice(0, 40) };
}

// ---------- short-lived server-side state ----------
const pending = new Map(); // id -> { discordId, discordName, expiresAt }  (Activity: "not linked yet")
const states = new Map(); // state -> { username, returnTo, expiresAt }      (website linking)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, v] of states) if (v.expiresAt < now) states.delete(k);
}, 60 * 1000).unref();
const randomId = () => crypto.randomBytes(24).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function takePending(id) {
  const p = typeof id === 'string' && pending.get(id);
  if (!p || p.expiresAt < Date.now()) return null;
  return p;
}

function suggestName(users, discordName) {
  const base = String(discordName || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_. -]/g, '').trim().slice(0, 16);
  if (base.length >= 2 && !users.usernameProblem(base)) return base;
  for (let i = 0; i < 20; i++) {
    const cand = `${(base.replace(/[ .-]/g, '') || 'Speletajs').slice(0, 14)}${Math.floor(Math.random() * 900 + 100)}`;
    if (!users.usernameProblem(cand)) return cand;
  }
  return '';
}

function registerRoutes(app, { users, perMinute = 20 }) {
  if (!available()) return false;
  const limiter = createRateLimiter({ max: perMinute, windowMs: 60 * 1000, blockMs: 60 * 1000 });
  const passwordLimiter = createRateLimiter({ max: 8, windowMs: 60 * 1000, blockMs: 2 * 60 * 1000 });
  const json = express.json({ limit: '2kb' });
  const slow = (res) => res.status(429).json({ error: 'Pārāk daudz mēģinājumu — uzgaidi minūti.' });
  const loggedIn = (name) => ({ status: 'ok', username: users.canonicalName(name), token: users.createSessionToken(name) });
  // Discord linked to this account already, or this Discord to another account?
  const clash = (username, discordId) => {
    const owner = users.findUsernameByOAuth('discord', discordId);
    if (owner && users.canonicalName(owner) !== users.canonicalName(username)) return 'Šis Discord konts jau ir piesaistīts citam kontam.';
    const cur = users.linkedOAuthIds(username).discord;
    if (cur && cur !== discordId) return 'Šim kontam jau ir piesaistīts cits Discord konts.';
    return null;
  };

  // Inside the Activity: the one-time code from Discord's "Authorize".
  app.post('/api/discord/auth', json, async (req, res) => {
    if (!limiter.check(req.ip || 'x').allowed) return slow(res);
    const code = str((req.body || {}).code, 200);
    if (!/^[\w-]{10,200}$/.test(code)) return res.status(400).json({ error: 'bad' });
    let profile;
    try { profile = await exchangeCode(code, null); } catch (e) {
      console.warn('Discord login failed:', e.message);
      return res.status(502).json({ error: 'Discord pieteikšanās neizdevās — mēģini vēlreiz.' });
    }
    // When Discord's proxy signed this request, it must be the same Discord user.
    const signed = discord.verifyProxy(req.headers);
    if (signed && signed.user_id && String(signed.user_id) !== profile.id) return res.status(403).json({ error: 'Discord konts nesakrīt.' });
    const name = users.findUsernameByOAuth('discord', profile.id);
    res.set('Cache-Control', 'no-store');
    if (name) return res.json(loggedIn(name));
    const id = randomId();
    if (pending.size > 5000) pending.clear();
    pending.set(id, { discordId: profile.id, discordName: profile.name, expiresAt: Date.now() + PENDING_TTL_MS });
    res.json({ status: 'choose', pending: id, discordName: profile.name, suggested: suggestName(users, profile.name) });
  });

  // ... "not linked yet" -> a new account under a chosen name.
  app.post('/api/discord/create', json, async (req, res) => {
    if (!limiter.check(req.ip || 'x').allowed) return slow(res);
    const b = req.body || {};
    const p = takePending(b.pending);
    if (!p) return res.status(400).json({ error: 'Pieteikšanās sesija beigusies — mēģini vēlreiz.' });
    if (users.findUsernameByOAuth('discord', p.discordId)) return res.status(409).json({ error: 'Šis Discord konts jau ir piesaistīts.' });
    const name = str(b.name, 40).trim();
    const problem = users.usernameProblem(name);
    if (problem) return res.status(400).json({ error: problem });
    const rec = await users.createAccountFromOAuth(name, 'discord', p.discordId, null, false);
    if (!rec) return res.status(409).json({ error: 'Šis lietotājvārds jau ir aizņemts.' });
    pending.delete(b.pending);
    res.set('Cache-Control', 'no-store');
    res.json(loggedIn(rec.username));
  });

  // ... "not linked yet" -> link to an existing account: its password, or a session this browser holds.
  app.post('/api/discord/link', json, async (req, res) => {
    const b = req.body || {};
    const usePassword = typeof b.password === 'string' && b.password.length > 0;
    if (!(usePassword ? passwordLimiter : limiter).check(req.ip || 'x').allowed) return slow(res);
    const p = takePending(b.pending);
    if (!p) return res.status(400).json({ error: 'Pieteikšanās sesija beigusies — mēģini vēlreiz.' });
    const username = str(b.username, 40).trim();
    let ok = false;
    if (usePassword) ok = !!(await users.verifyLogin(username, b.password.slice(0, 200)));
    else ok = users.checkSessionToken(username, str(b.token, 200));
    if (!ok) return res.status(401).json({ error: usePassword ? 'Nepareizs lietotājvārds vai parole.' : 'Ielogošanās vairs nav derīga — ievadi paroli.' });
    const name = users.canonicalName(username);
    const problem = clash(name, p.discordId);
    if (problem) return res.status(409).json({ error: problem });
    users.linkOAuth(name, 'discord', p.discordId, null, false);
    pending.delete(b.pending);
    console.log(`Discord linked to account ${name} (Activity)`);
    res.set('Cache-Control', 'no-store');
    res.json(loggedIn(name));
  });

  // Website: start linking (logged in) -> the address of Discord's "allow?" page.
  const redirectUri = discord.PUBLIC_ORIGIN + '/auth/discord/callback';
  app.post('/api/discord/link-start', json, (req, res) => {
    if (!limiter.check(req.ip || 'x').allowed) return slow(res);
    const b = req.body || {};
    const username = str(b.username, 40);
    if (!users.checkSessionToken(username, str(b.token, 200))) return res.status(401).json({ error: 'Vispirms ielogojies.' });
    const state = randomId();
    if (states.size > 5000) states.clear();
    const returnTo = ['/duraks', '/meli/', '/'].includes(b.returnTo) ? b.returnTo : '/duraks';
    states.set(state, { username: users.canonicalName(username), returnTo, expiresAt: Date.now() + STATE_TTL_MS });
    const q = new URLSearchParams({ client_id: discord.publicConfig().clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state, prompt: 'consent' });
    res.set('Cache-Control', 'no-store');
    res.json({ url: 'https://discord.com/oauth2/authorize?' + q.toString() });
  });

  // Website: Discord sends the browser back here.
  app.get('/auth/discord/callback', async (req, res) => {
    const st = typeof req.query.state === 'string' && states.get(req.query.state);
    if (st) states.delete(req.query.state);
    const back = (st && st.returnTo) || '/duraks';
    const fail = (msg) => res.redirect(back + '?' + new URLSearchParams({ oauthError: msg }).toString());
    if (!st || st.expiresAt < Date.now()) return fail('Saite vairs nav derīga — mēģini piesaistīt Discord vēlreiz.');
    if (req.query.error || typeof req.query.code !== 'string') return fail('Discord piesaistīšana atcelta.');
    if (!limiter.check(req.ip || 'x').allowed) return fail('Pārāk daudz mēģinājumu — uzgaidi minūti.');
    let profile;
    try { profile = await exchangeCode(req.query.code.slice(0, 200), redirectUri); } catch (e) {
      console.warn('Discord link failed:', e.message);
      return fail('Discord piesaistīšana neizdevās — mēģini vēlreiz.');
    }
    const problem = clash(st.username, profile.id);
    if (problem) return fail(problem);
    users.linkOAuth(st.username, 'discord', profile.id, null, false);
    console.log(`Discord linked to account ${st.username} (website)`);
    res.redirect(back + '?discordLinked=1');
  });

  // Website: remove the link (keeps at least one way to log in).
  app.post('/api/discord/unlink', json, (req, res) => {
    if (!limiter.check(req.ip || 'x').allowed) return slow(res);
    const b = req.body || {};
    const username = str(b.username, 40);
    if (!users.checkSessionToken(username, str(b.token, 200))) return res.status(401).json({ error: 'Vispirms ielogojies.' });
    const r = users.unlinkOAuth(username, 'discord');
    res.set('Cache-Control', 'no-store');
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });

  return true;
}

module.exports = { registerRoutes, available, _suggestName: suggestName };

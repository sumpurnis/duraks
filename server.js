'use strict';

// Uzspēlēsim.lv — the site shell. One Node process, one Socket.io server.
//
//   site/       front page ( / )
//   platform/   accounts, Google/Facebook sign-in, mail, feedback board — shared by every game
//   games/duraks/   Duraks  ( /duraks )                 main Socket.io namespace
//   games/meli/     Meļi    ( /meli/ )                  Socket.io namespace /meli
//
// This file only wires those together. Game code lives in games/<game>/, account code in platform/.

require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DATA_DIR } = require('./platform/config');
const users = require('./platform/users');
const auth = require('./platform/auth');
const world = require('./platform/world');
const feedback = require('./platform/feedback');
const profanity = require('./platform/profanity');
const { createRateLimiter } = require('./platform/rate-limit');
const { TRUST_PROXY, socketIp } = require('./platform/client-ip');
const { createStaticFast, sendJson } = require('./platform/static-fast');
const discord = require('./platform/discord');
const discordAuth = require('./platform/discord-auth');
const gameLog = require('./platform/game-log');
const duraks = require('./games/duraks/server');
const { attachMeli, CLIENT_DIR: MELI_CLIENT_DIR } = require('./games/meli/server');

const app = express();
// Query strings are only ever flat strings (?v=, ?me=, ?q=&r=, ?return=): Node's built-in parser is
// enough and avoids the qs library's known denial-of-service issues.
app.set('query parser', 'simple');
const server = http.createServer(app);
// No message here needs more than a few KB (the longest is a 2000-character feedback post).
const io = new Server(server, { maxHttpBufferSize: 32 * 1024 });

// ---------- Socket safety net ----------
// Every handler of every game: a message without data gets {} (handlers unpack their data, and
// `undefined`/`null` used to throw and kill the whole process), and an exception — sync or async —
// is logged instead of crashing the server for everyone.
function guardSockets(nsp) {
  nsp.use((socket, next) => {
    const on = socket.on.bind(socket);
    socket.on = (event, fn) =>
      on(event, (...args) => {
        if (args[0] == null) args[0] = {};
        try {
          const r = fn(...args);
          if (r && typeof r.catch === 'function') r.catch((err) => console.error(`socket "${event}" failed:`, err));
        } catch (err) {
          console.error(`socket "${event}" failed:`, err);
        }
      });
    next();
  });
}
guardSockets(io);
guardSockets(io.of('/meli'));

// ---------- HTTP basics ----------
app.disable('x-powered-by');
// Behind Railway's proxy req.ip must come from X-Forwarded-For, or every visitor shares one address.
app.set('trust proxy', TRUST_PROXY ? 1 : false);
// Security headers. Every page loads its scripts from this site only and has no inline scripts or
// handlers, so a strict script policy works and blocks injected script even if escaping is missed.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
// Inside the Discord Activity (only with DISCORD_ACTIVITY=1, see platform/discord.js) a page may be shown
// in Discord's frame — by Discord only; every other site still can't frame this one.
const CSP_DISCORD = CSP.replace("frame-ancestors 'self'", 'frame-ancestors ' + discord.FRAME_ANCESTORS);
app.use((req, res, next) => {
  const inDiscord = discord.isDiscordRequest(req);
  res.locals.discord = inDiscord;
  res.setHeader('Content-Security-Policy', inDiscord ? CSP_DISCORD : CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!inDiscord) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Discord's proxy hides every address: a SIGNED Discord request is rate-limited by its Discord user.
  const dk = inDiscord && discord.discordKey(req.headers);
  if (dk) Object.defineProperty(req, 'ip', { value: dk, configurable: true });
  next();
});
// Files linked with ?v=<build> (the front page) never change under that exact URL: cache them for a year.
app.use((req, res, next) => {
  if (req.method === 'GET' && typeof req.query.v === 'string' && /\.(js|css|svg|png|webp|woff2?)$/.test(req.path)) res.locals.immutable = true;
  next();
});
const cacheHeaders = (res) => {
  if (res.locals.immutable) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
};

// ---------- Pages ----------
//
// "/"       front page: game picker + sign-up / log-in pop-up.
// "/duraks" the Duraks lobby (what used to be "/").
// "/meli/"  Meļi.
//
// Old Duraks links that carried a query string to "/" keep working: room invites and
// password-reset e-mails point at "/?room=…" / "/?reset=…", so those are passed on to /duraks.
const LEGACY_DURAKS_PARAMS = ['room', 'reset'];
// Text files go out compressed, pages link their scripts/styles with ?v=<content hash> (cached for a
// year), unchanged files answer 304. Same roots in the same order as the express.static mounts below,
// which still serve everything else (images, Range requests).
// Discord Activity: its start page and helper scripts (/discord/…) exist only with DISCORD_ACTIVITY=1.
const DISCORD_DIR = path.join(__dirname, 'platform', 'discord-public');
const DISCORD_GAME_PAGES = new Map([[path.resolve(duraks.PUBLIC_DIR, 'index.html'), 'duraks'], [path.resolve(MELI_CLIENT_DIR, 'index.html'), 'meli']]);
const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// A game page opened inside Discord also loads the Discord helper (one table per voice channel, links
// that open outside Discord). Outside Discord the page is exactly as before.
function discordInject(req, res, file) {
  const game = res.locals.discord && DISCORD_GAME_PAGES.get(path.resolve(file));
  if (!game) return '';
  const c = discord.publicConfig();
  return `<link rel="stylesheet" href="/discord/discord.css" />\n` +
    `<script src="/discord/client.js" data-game="${game}" data-client-id="${attr(c.clientId)}" data-public-origin="${attr(c.publicOrigin)}" defer></script>`;
}
const staticFast = createStaticFast([
  { prefix: '/', dir: duraks.PUBLIC_DIR, cacheControl: 'public, max-age=0' },
  { prefix: '/meli', dir: MELI_CLIENT_DIR, cacheControl: 'no-cache' },
  ...(discord.enabled ? [{ prefix: '/discord', dir: DISCORD_DIR, cacheControl: 'no-cache' }] : []),
  { prefix: '/', dir: path.join(__dirname, 'platform', 'public'), cacheControl: 'public, max-age=0' },
  { prefix: '/', dir: path.join(__dirname, 'site', 'public'), cacheControl: 'public, max-age=0' },
], { inject: discordInject });
staticFast.warm();
app.get('/', (req, res) => {
  if (LEGACY_DURAKS_PARAMS.some((k) => k in req.query)) {
    return res.redirect('/duraks' + req.originalUrl.slice(req.originalUrl.indexOf('?')));
  }
  // The Activity starts at "/" (Discord adds frame_id, instance_id, platform…): its start page, served
  // right here — no redirect, so the page keeps Discord as its referrer (the SDK hand-shake needs that).
  // A request Discord's proxy signed counts too, even if the launch parameters didn't reach the server
  // (the page itself reads them from its own address).
  discord.diagnose(req, '/');
  if (res.locals.discord && (discord.hasLaunchParams(req.query) || discord.verifyProxy(req.headers))) {
    return staticFast.sendPage(req, res, path.join(DISCORD_DIR, 'index.html'), '/', 'no-cache');
  }
  staticFast.sendPage(req, res, path.join(__dirname, 'site', 'public', 'landing.html'), '/');
});
app.use(staticFast.middleware);
duraks.mountRoutes(app, { sendPage: staticFast.sendPage, setHeaders: cacheHeaders }); // GET /duraks + Duraks' static files
if (discord.enabled) {
  app.get('/discord', (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect('/discord/' + (q === -1 ? '' : req.originalUrl.slice(q)));
  });
  app.use('/discord', express.static(DISCORD_DIR, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', res.locals.immutable ? 'public, max-age=31536000, immutable' : 'no-cache') }));
}
app.use('/meli', express.static(MELI_CLIENT_DIR, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', res.locals.immutable ? 'public, max-age=31536000, immutable' : 'no-cache') }));
// Everything below is served from the site root, so every URL stays as it always was
// (/board.html, /guest-nudge.js, /landing.js …).
app.use(express.static(path.join(__dirname, 'platform', 'public'), { setHeaders: cacheHeaders }));
app.use(express.static(path.join(__dirname, 'site', 'public'), { setHeaders: cacheHeaders }));

// ---------- Accounts ----------
// Google / Facebook sign-in routes (/auth/…).
auth.registerHttpRoutes(app);

// ---------- Games ----------
// Meļi shares the site's accounts: a client that connects to the /meli namespace with its saved session
// token plays under its account name. Its own limiter, so flaky reconnects there can't eat into the
// login budget of the main login.
const meliAuthLimiter = createRateLimiter({ max: 30, windowMs: 60 * 1000, blockMs: 60 * 1000 });
// New Meļi tables per address, so one person with many tabs/scripts can't fill the server ("server full").
const meliCreateLimiter = createRateLimiter({ max: 20, windowMs: 10 * 60 * 1000, blockMs: 10 * 60 * 1000 });
// A finished Meļi game, in the players' own stats (the profile window's Meļi tab): wins/losses incl.
// forfeits, streaks, today, the game log, and ELO for ranked tables. Same rules as Duraks: only
// signed-in players are recorded; ELO only at ranked tables (all signed in, no computer).
// Places: the winner is 1st; the others by cards left (fewer = better, equal = shared place); players
// who left / ran out of time share the last place.
function meliPlacements(seats) {
  const place = new Map();
  seats.forEach((s, i) => { if (s.winner) place.set(i, 1); });
  const stayed = seats.map((s, i) => ({ s, i })).filter(({ s }) => !s.winner && !s.out).sort((a, b) => a.s.cards - b.s.cards);
  let next = 2;
  stayed.forEach(({ s, i }, k) => {
    if (k > 0 && s.cards !== stayed[k - 1].s.cards) next = 2 + k;
    place.set(i, next);
  });
  const last = 2 + stayed.length;
  seats.forEach((s, i) => { if (!place.has(i)) place.set(i, last); });
  return place;
}
function recordMeliResult(r) {
  try {
    const seats = Array.isArray(r.seats) ? r.seats : [];
    if (seats.length < 2) return;
    const place = meliPlacements(seats);
    const pool = seats.length === 2 ? 'oneVOne' : 'multi';
    const rated = r.ranked && !r.vsAI && seats.every((s) => s.account);
    const elo = rated ? users.applyRankedGameResult(seats.map((s, i) => ({ username: s.name, placement: place.get(i) })), pool, 'meli') : null;
    const byForfeit = r.endDetail && r.endDetail !== 'empty-hand';
    seats.forEach((s, i) => {
      if (!s.account) return;
      const won = !!s.winner;
      const forfeit = won ? !!byForfeit : !!s.outDetail;
      users.recordResult(s.name, won, forfeit, 'meli');
      const e = elo && elo[users.canonicalName(s.name)];
      users.recordGameHistoryEntry(s.name, {
        outcome: won ? 'won' : 'lost',
        placement: seats.length > 2 ? place.get(i) : null,
        ranked: !!e,
        mode: seats.length === 2 ? '2p' : 'multi',
        totalPlayers: seats.length,
        deckSize: r.deck === 'half' ? 24 : 52,
        vsBots: !!r.vsAI,
        opponents: seats.filter((_, j) => j !== i).map((o) => o.name),
        eloPool: e ? pool : null,
        eloAfter: e ? e.after : null,
        eloChange: e ? e.delta : null,
        endReason: forfeit ? (won ? 'opponentLeft' : s.outDetail) : null,
      }, 'meli');
    });
  } catch (err) {
    console.error('Meļi result could not be recorded:', err);
  }
}

const meli = attachMeli(io, {
  statsFile: path.join(DATA_DIR, 'meli-stats.json'),
  // every game into the admin's game log (platform/game-log.js)
  cfg: { gameLog },
  // The front page's map: finished games wear roads and grow villages; connected players smoke.
  onResult: (r) => {
    const names = [r.winner, ...(r.losers || [r.loser])].filter((s) => s && !s.ai && s.account).map((s) => s.name);
    // the news line: the winner, and where the table's host finished
    const seats = Array.isArray(r.seats) ? r.seats : [];
    const place = seats.length ? meliPlacements(seats) : new Map();
    const hostIdx = seats.findIndex((s) => s.name === r.host);
    world.recordGame('meli', names, { vsBot: !!r.vsAI, winner: r.winner && r.winner.name, host: hostIdx >= 0 ? r.host : null, hostPlace: hostIdx >= 0 ? place.get(hostIdx) : null });
    recordMeliResult(r);
  },
  onPresence: (name, id, on) => (on ? world.seen(name, 'meli:' + id) : world.gone('meli:' + id)),
  canCreate: (socket) => meliCreateLimiter.check(socketIp(socket)).allowed,
  nameFilter: profanity.isOffensive,
  cleanChat: profanity.maskText,
  verifyAccount: (name, token, socket) => {
    if (!meliAuthLimiter.check(socketIp(socket)).allowed) return null;
    const rec = users.verifySessionToken(name, token);
    return rec ? rec.username : null;
  },
});

duraks.attach(io);

// ---------- Front-page map ----------
world.provide('meli', () =>
  [...meli.manager.rooms.values()]
    // a table whose player has left (still within the reconnect grace time) isn't shown as live
    .filter((r) => r.status === 'playing' && r.seats.some((s) => s && !s.ai && s.connected))
    .map((r) => ({ id: r.code, players: r.seats.filter((s) => s && !s.ai && s.account).map((s) => s.name), guests: r.seats.filter((s) => s && !s.ai && !s.account).length, vsBot: !!r.vsAI }))
);
world.seedGames('meli', Object.fromEntries(Object.entries(meli.manager.stats.data.players || {}).map(([n, p]) => [n, p.played || 0])));

// ---------- Offensive usernames ----------
// On every start, accounts whose name contains a rude word (platform/profanity.js) are renamed to a
// neutral "Spēlētājs1234" everywhere: accounts and game history, the map, Meļi stats, tournaments and
// the feedback board. The old name keeps working for logging in, and the player's first login after
// the change shows them a note. New names are refused at registration. Set RENAME_OFFENSIVE_USERNAMES=0
// to only list them in the log; ALLOWED_NAMES="Name1,Name2" exempts a real name the filter gets wrong.
for (const oldName of users.offensiveAccounts()) {
  if (process.env.RENAME_OFFENSIVE_USERNAMES === '0') {
    console.warn(`Offensive username (not renamed, RENAME_OFFENSIVE_USERNAMES=0): ${oldName}`);
    continue;
  }
  const newName = users.freeReplacementName();
  if (!users.renameAccount(oldName, newName)) continue;
  world.renameName(oldName, newName);
  duraks.renameUser(oldName, newName);
  feedback.renameAuthor(oldName, newName);
  const mp = meli.manager.stats.data.players || {};
  if (Object.prototype.hasOwnProperty.call(mp, oldName) && !Object.prototype.hasOwnProperty.call(mp, newName)) {
    mp[newName] = mp[oldName];
    delete mp[oldName];
    meli.manager.stats.persistSoon();
  }
  console.log(`Renamed offensive username «${oldName}» → «${newName}»`);
}

// GET /api/world?me=<name> — what the map draws. `me` only chooses where the view is centred.
// The map's regular check-in also keeps the visitor shown online while the front page is open (the page
// holds no permanent connection): header X-Uzs-Visit = a random id per browser tab, plus
// X-Uzs-User / X-Uzs-Token for a logged-in player (checked read-only), X-Uzs-Hidden: 1 for a background tab.
const worldLimiter = createRateLimiter({ max: 120, windowMs: 60 * 1000, blockMs: 60 * 1000 });
const VISIT_TTL_MS = 30 * 1000; // the map checks in every 10 s while visible
const VISIT_TTL_HIDDEN_MS = 75 * 1000; // and every 50 s in a background tab
function noteVisit(req) {
  const visit = String(req.get('x-uzs-visit') || '');
  if (!/^[A-Za-z0-9]{8,40}$/.test(visit)) return;
  let user = '';
  try { user = decodeURIComponent(String(req.get('x-uzs-user') || '')).slice(0, 20); } catch { user = ''; }
  const token = String(req.get('x-uzs-token') || '').slice(0, 200);
  const name = user && token && users.checkSessionToken(user, token) ? users.canonicalName(user) : null;
  const ttl = req.get('x-uzs-hidden') === '1' ? VISIT_TTL_HIDDEN_MS : VISIT_TTL_MS;
  world.touch(visit, name, req.ip || 'x', ttl); // one entry per tab: logging in or out just changes it
}
// GET /api/challenges — the "!" marks on the front page: is there a challenge this visitor hasn't
// tried yet today? Per game (only Duraks has challenges so far). Same login headers as /api/world.
app.get('/api/challenges', (req, res) => {
  if (!worldLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  let user = '';
  try { user = decodeURIComponent(String(req.get('x-uzs-user') || '')).slice(0, 20); } catch { user = ''; }
  const token = String(req.get('x-uzs-token') || '').slice(0, 200);
  const name = user && token && users.checkSessionToken(user, token) ? users.canonicalName(user) : null;
  res.set('Cache-Control', 'no-store');
  res.json({ duraks: { fresh: duraks.challenges.isNewFor(name), endsInMs: duraks.challenges.msToMidnight() } });
});

// Is this request from the admin's logged-in account? (X-Uzs-User + X-Uzs-Token, as the pages send them)
function isAdminRequest(req) {
  let user = '';
  try { user = decodeURIComponent(String(req.get('x-uzs-user') || '')).slice(0, 20); } catch { user = ''; }
  const token = String(req.get('x-uzs-token') || '').slice(0, 200);
  const admin = (process.env.ADMIN_USERNAME || 'zivs').toLowerCase();
  return !!(user && token && users.checkSessionToken(user, token) && String(users.canonicalName(user)).toLowerCase() === admin);
}
const adminLimiter = createRateLimiter({ max: 120, windowMs: 60 * 1000, blockMs: 60 * 1000 });

// GET /api/challenges/admin — the admin's view: target, tuned strength and real win rate per level.
app.get('/api/challenges/admin', (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin only' });
  res.set('Cache-Control', 'no-store');
  res.json(duraks.challenges.adminReport());
});

// The admin's game log (platform/game-log.js; the page is /admin-games.html): every game, newest first,
// and one game in full (players, the deal, every move, how it ended).
app.get('/api/admin/games', (req, res) => {
  if (!adminLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin only' });
  const q = (k, max) => (typeof req.query[k] === 'string' ? req.query[k].slice(0, max) : '');
  const game = ['duraks', 'meli'].includes(q('game', 10)) ? q('game', 10) : '';
  const status = ['live', 'finished', 'ended', 'interrupted'].includes(q('status', 12)) ? q('status', 12) : '';
  res.set('Cache-Control', 'no-store');
  sendJson(req, res, gameLog.list({ game, status, player: q('player', 20), before: q('before', 60), limit: Number(q('limit', 4)) || 50 }));
});
app.get('/api/admin/games/:id', (req, res) => {
  if (!adminLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'admin only' });
  const g = gameLog.get(String(req.params.id).slice(0, 60));
  if (!g) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store');
  sendJson(req, res, g);
});

// ---------- Discord Activity API (only with DISCORD_ACTIVITY=1) ----------
// One table per Discord instance: whoever starts a table in the Activity binds it to the instance, the
// others in the voice channel are offered that table. The table is an ordinary room with an ordinary
// code, so players on the website can join it too.
if (discord.enabled) {
  const discordLimiter = createRateLimiter({ max: 60, windowMs: 60 * 1000, blockMs: 60 * 1000 });
  const DISCORD_GAMES = ['duraks', 'meli'];
  const tableOpen = (game, code) => {
    if (game === 'duraks') return duraks.roomStatus(code) === 'waiting';
    if (game === 'meli') { const r = meli.manager.rooms.get(code); return !!r && r.status === 'waiting' && !r.solo; }
    return false;
  };
  // With DISCORD_REQUIRE_SIGNATURE=1 only requests signed by Discord's proxy get answers.
  const allowed = (req) => !discord.requireSignature || !!discord.verifyProxy(req.headers);
  app.get('/api/discord/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...discord.publicConfig(), loginAvailable: discordAuth.available() });
  });
  // Discord login in the Activity + linking Discord to an account (needs DISCORD_CLIENT_SECRET).
  discordAuth.registerRoutes(app, { users });
  // For checking the setup from inside the Activity: does Discord's signature arrive and check out?
  app.get('/api/discord/check', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const hasHeaders = !!req.get('x-discord-proxy-payload');
    res.json({ signatureConfigured: discord.signatureConfigured, signatureSent: hasHeaders, signatureValid: !!discord.verifyProxy(req.headers), requireSignature: discord.requireSignature });
  });
  app.get('/api/discord/table', (req, res) => {
    if (!discordLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
    if (!allowed(req)) return res.status(401).json({ error: 'discord only' });
    res.set('Cache-Control', 'no-store');
    res.json(discord.lookupTables(typeof req.query.instance === 'string' ? req.query.instance : '', DISCORD_GAMES, tableOpen));
  });
  app.post('/api/discord/table', express.json({ limit: '1kb' }), (req, res) => {
    if (!discordLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
    if (!allowed(req)) return res.status(401).json({ error: 'discord only' });
    const b = req.body || {};
    const game = DISCORD_GAMES.includes(b.game) ? b.game : null;
    if (!game) return res.status(400).json({ error: 'bad' });
    res.set('Cache-Control', 'no-store');
    res.json(discord.bindTable(typeof b.instance === 'string' ? b.instance : '', game, typeof b.code === 'string' ? b.code : '', tableOpen));
  });
  console.log(`Discord Activity: on (client id ${discord.publicConfig().clientId || 'NOT SET'}, signature check ${discord.signatureConfigured ? 'configured' : 'not configured'}${discord.requireSignature ? ', required' : ''}, Discord login ${discordAuth.available() ? 'on' : 'off — DISCORD_CLIENT_SECRET not set'})`);
} else {
  console.log('Discord Activity: off (DISCORD_ACTIVITY is not 1)');
}

app.get('/api/world', (req, res) => {
  if (!worldLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  noteVisit(req);
  const me = typeof req.query.me === 'string' ? req.query.me.slice(0, 20) : null;
  const q = Number(req.query.q), r = Number(req.query.r);
  const at = Number.isInteger(q) && Number.isInteger(r) && Math.abs(q) < 1000 && Math.abs(r) < 1000 && req.query.q !== undefined ? { q, r } : null;
  res.set('Cache-Control', 'no-store');
  sendJson(req, res, world.snapshot(me, at)); // polled every 10 s: gzip it
});

// POST /api/player/full { name, me, token } — extended stats for logged-in players: the same as the
// Duraks profile window (ELO, wins/losses incl. forfeits, streaks, today, recent games with ELO changes)
// plus Meļi. The token is checked read-only (no write to users.json per click).
app.post('/api/player/full', express.json({ limit: '2kb' }), (req, res) => {
  if (!worldLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  const b = req.body || {};
  const me = typeof b.me === 'string' ? b.me.slice(0, 20) : '';
  if (!me || !users.checkSessionToken(me, typeof b.token === 'string' ? b.token : '')) return res.status(401).json({ error: 'login' });
  const name = typeof b.name === 'string' ? b.name.slice(0, 20) : '';
  const stats = users.getStats(name);
  const map = world.playerInfo(name);
  if (!stats || !map) return res.status(404).json({ error: 'not found' });
  const history = users.getGameHistory(name, 50).map((e) => ({
    outcome: e.outcome, placement: e.placement || null, ranked: !!e.ranked, mode: e.mode, totalPlayers: e.totalPlayers,
    deckSize: e.deckSize, vsBots: !!e.vsBots, opponents: e.opponents || [], eloPool: e.eloPool || null,
    eloAfter: typeof e.eloAfter === 'number' ? e.eloAfter : null, eloChange: typeof e.eloChange === 'number' ? e.eloChange : null,
    endReason: e.endReason || null, timestamp: e.timestamp,
  }));
  const m = (meli.manager.stats.data.players || {})[name] || null;
  const mToday = m && m.daily && m.daily.date === new Date().toISOString().slice(0, 10) ? m.daily : null;
  const profile = users.getPublicProfile(name);
  res.set('Cache-Control', 'no-store');
  res.json({
    username: name, since: profile.since, ...map, stats, history,
    games: users.getProfileGames(name, 50),
    elo: profile.elo,
    meli: m ? { played: m.played || 0, won: m.won || 0, currentStreak: m.currentStreak || 0, longestStreak: m.longestStreak || 0,
      today: mToday ? { played: mToday.played, won: mToday.won } : { played: 0, won: 0 } } : { played: 0, won: 0, currentStreak: 0, longestStreak: 0, today: { played: 0, won: 0 } },
  });
});

// GET /api/player?name=<name> — the village card: public stats from both games + the map's level.
app.get('/api/player', (req, res) => {
  if (!worldLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 20) : '';
  const profile = users.getPublicProfile(name);
  const map = world.playerInfo(name);
  if (!profile || !map) return res.status(404).json({ error: 'not found' });
  const m = (meli.manager.stats.data.players || {})[name] || {};
  res.set('Cache-Control', 'no-store');
  res.json({ ...profile, meli: { played: m.played || 0, won: m.won || 0, longestStreak: m.longestStreak || 0 }, ...map });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Uzspēlēsim.lv running at http://localhost:${PORT}`);
});

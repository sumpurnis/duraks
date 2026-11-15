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
const { createRateLimiter } = require('./platform/rate-limit');
const { TRUST_PROXY, socketIp } = require('./platform/client-ip');
const duraks = require('./games/duraks/server');
const { attachMeli, CLIENT_DIR: MELI_CLIENT_DIR } = require('./games/meli/server');

const app = express();
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
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
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
app.get('/', (req, res) => {
  if (LEGACY_DURAKS_PARAMS.some((k) => k in req.query)) {
    return res.redirect('/duraks' + req.originalUrl.slice(req.originalUrl.indexOf('?')));
  }
  res.sendFile(path.join(__dirname, 'site', 'public', 'landing.html'));
});
duraks.mountRoutes(app); // GET /duraks + Duraks' static files
app.use('/meli', express.static(MELI_CLIENT_DIR, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
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
const meli = attachMeli(io, {
  statsFile: path.join(DATA_DIR, 'meli-stats.json'),
  // The front page's map: finished games wear roads and grow villages; connected players smoke.
  onResult: ({ winner, loser, vsAI }) => {
    const names = [winner, loser].filter((s) => s && !s.ai && s.account).map((s) => s.name);
    world.recordGame('meli', names, { vsBot: !!vsAI });
  },
  onPresence: (name, id, on) => (on ? world.seen(name, 'meli:' + id) : world.gone('meli:' + id)),
  canCreate: (socket) => meliCreateLimiter.check(socketIp(socket)).allowed,
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
    .filter((r) => r.status === 'playing')
    .map((r) => ({ id: r.code, players: r.seats.filter((s) => s && !s.ai && s.account).map((s) => s.name), guests: r.seats.filter((s) => s && !s.ai && !s.account).length, vsBot: !!r.vsAI }))
);
world.seedGames('meli', Object.fromEntries(Object.entries(meli.manager.stats.data.players || {}).map(([n, p]) => [n, p.played || 0])));

// GET /api/world?me=<name> — what the map draws. `me` only chooses where the view is centred.
const worldLimiter = createRateLimiter({ max: 120, windowMs: 60 * 1000, blockMs: 60 * 1000 });
app.get('/api/world', (req, res) => {
  if (!worldLimiter.check(req.ip || 'x').allowed) return res.status(429).json({ error: 'slow down' });
  const me = typeof req.query.me === 'string' ? req.query.me.slice(0, 20) : null;
  const q = Number(req.query.q), r = Number(req.query.r);
  const at = Number.isInteger(q) && Number.isInteger(r) && Math.abs(q) < 1000 && Math.abs(r) < 1000 && req.query.q !== undefined ? { q, r } : null;
  res.set('Cache-Control', 'no-store');
  res.json(world.snapshot(me, at));
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

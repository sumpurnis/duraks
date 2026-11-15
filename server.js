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
const duraks = require('./games/duraks/server');
const { attachMeli, CLIENT_DIR: MELI_CLIENT_DIR } = require('./games/meli/server');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
app.use(express.static(path.join(__dirname, 'platform', 'public')));
app.use(express.static(path.join(__dirname, 'site', 'public')));

// ---------- Accounts ----------
// Google / Facebook sign-in routes (/auth/…).
auth.registerHttpRoutes(app);

// ---------- Games ----------
// Meļi shares the site's accounts: a client that connects to the /meli namespace with its saved session
// token plays under its account name. Its own limiter, so flaky reconnects there can't eat into the
// login budget of the main login.
const meliAuthLimiter = createRateLimiter({ max: 30, windowMs: 60 * 1000, blockMs: 60 * 1000 });
const meli = attachMeli(io, {
  statsFile: path.join(DATA_DIR, 'meli-stats.json'),
  // The front page's map: finished games wear roads and grow villages; connected players smoke.
  onResult: ({ winner, loser, vsAI }) => {
    const names = [winner, loser].filter((s) => s && !s.ai && s.account).map((s) => s.name);
    world.recordGame('meli', names, { vsBot: !!vsAI });
  },
  onPresence: (name, id, on) => (on ? world.seen(name, 'meli:' + id) : world.gone('meli:' + id)),
  verifyAccount: (name, token, socket) => {
    if (!meliAuthLimiter.check(socket.handshake.address || socket.id).allowed) return null;
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
  res.set('Cache-Control', 'no-store');
  res.json(world.snapshot(me));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Uzspēlēsim.lv running at http://localhost:${PORT}`);
});

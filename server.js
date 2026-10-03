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
attachMeli(io, {
  statsFile: path.join(DATA_DIR, 'meli-stats.json'),
  verifyAccount: (name, token, socket) => {
    if (!meliAuthLimiter.check(socket.handshake.address || socket.id).allowed) return null;
    const rec = users.verifySessionToken(name, token);
    return rec ? rec.username : null;
  },
});

duraks.attach(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Uzspēlēsim.lv running at http://localhost:${PORT}`);
});

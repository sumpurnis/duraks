'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const { RuleError } = require('./engine');
const { RoomManager, RoomError } = require('./rooms');
const { MeliStats } = require('./stats');

const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function staticHandler(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(CLIENT_DIR, path.normalize(rel));
  if (!file.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/**
 * Registers every Meļi socket handler on `target`, which is either a whole Socket.io server
 * (standalone mode) or one namespace of a bigger server (mounted mode, e.g. inside Duraks).
 *
 * `verifyAccount(name, token, socket)` is optional. When given, a client that connects with
 * `auth: { username, token }` and passes the check becomes an *account* player: its name in rooms
 * is forced to the account name (so nobody can pose as somebody else's account) and the client is
 * told via the `account` event. Without it, or without valid credentials, names stay free-text
 * guest names exactly as before.
 */
function wireMeli(target, { cfg = {}, verifyAccount, statsFile = null } = {}) {
  const stats = new MeliStats(statsFile);
  const manager = new RoomManager(target, { ...cfg, stats });

  target.on('connection', (socket) => {
    socket.join('lobby');
    socket.emit('rooms', manager.listOpen());
    socket.emit('stats', stats.snapshot());

    let account = null;
    const auth = (socket.handshake && socket.handshake.auth) || {};
    if (verifyAccount && auth.username && auth.token) {
      try {
        account = verifyAccount(String(auth.username), String(auth.token), socket) || null;
      } catch (err) {
        console.error('Meļi account check failed:', err);
        account = null;
      }
    }
    socket.emit('account', account ? { username: account } : null);
    // `account` is set here by the server only (never taken from the client), so only real accounts count in the rankings.
    const named = (m) => ({ ...(m || {}), ...(account ? { name: account } : {}), account: !!account });

    const guard = (fn) => (msg) => {
      try {
        fn(msg);
      } catch (err) {
        if (err instanceof RoomError && (err.code === 'password' || err.code === 'password-wrong')) {
          socket.emit('room:password', { code: err.roomCode, wrong: err.code === 'password-wrong' });
        } else if (err instanceof RuleError) {
          socket.emit('notice', err.message);
        } else {
          console.error(err);
          socket.emit('notice', 'Server error.');
        }
      }
    };

    socket.on('room:create', guard((m) => manager.create(socket, named(m))));
    socket.on('room:join', guard((m) => manager.join(socket, named(m))));
    socket.on('room:leave', guard(() => manager.leave(socket)));
    socket.on('room:resume', guard((m) => manager.resume(socket, m || {})));
    socket.on('rematch', guard(() => manager.rematch(socket)));
    socket.on('rooms:refresh', () => {
      socket.emit('rooms', manager.listOpen());
      socket.emit('stats', stats.snapshot());
    });
    socket.on('play', guard((m) => manager.play(socket, m)));
    socket.on('challenge', guard(() => manager.challenge(socket)));
    socket.on('disconnect', () => manager.disconnect(socket));
  });

  return manager;
}

/** Mounted mode: attach Meļi to a namespace (default `/meli`) of an existing Socket.io server. */
function attachMeli(io, { namespace = '/meli', cfg = {}, verifyAccount, statsFile = null } = {}) {
  const nsp = io.of(namespace);
  const manager = wireMeli(nsp, { cfg, verifyAccount, statsFile });
  return { nsp, manager, dispose: () => manager.dispose() };
}

/** Standalone mode: builds a whole server instance. `cfg` is passed to the RoomManager. */
function createApp(cfg = {}) {
  const httpServer = http.createServer(staticHandler);
  const io = new Server(httpServer);
  const manager = wireMeli(io, { cfg });

  return {
    httpServer,
    io,
    manager,
    listen(port = 0) {
      return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port)));
    },
    close() {
      manager.dispose();
      io.close();
      if (httpServer.listening) httpServer.close();
    },
  };
}

if (require.main === module) {
  const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const cfg = {};
  const map = { aiDelay: 'MELI_AI_DELAY', revealPause: 'MELI_REVEAL_PAUSE', turnMs: 'MELI_TURN_MS', graceMs: 'MELI_GRACE_MS' };
  for (const [k, env] of Object.entries(map)) if (num(process.env[env]) !== undefined) cfg[k] = num(process.env[env]);
  const app = createApp(cfg);
  app.listen(Number(process.env.PORT) || 3000).then((port) => console.log(`Meļi running on http://localhost:${port}`));
}

module.exports = { createApp, attachMeli, wireMeli, CLIENT_DIR };

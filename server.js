'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game } = require('./server/game');
const users = require('./server/users');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MOVE_TIMEOUT_MS = 60000;
const DISCONNECT_GRACE_MS = 30000;
const ROOM_CLEANUP_MS = 5 * 60 * 1000;
const LOBBY_ROOM = 'lobby';

app.use(express.static(path.join(__dirname, 'public')));

// In-memory rooms, keyed by 4-char code. Players are identified by *username*
// (stable across reconnects/refreshes) — socketId is just where to reach them right now.
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function namesFor(room) {
  const map = {};
  for (const p of room.players) map[p.username] = p.username;
  return map;
}

function socketFor(room, username) {
  const p = room.players.find((pl) => pl.username === username);
  return p && p.connected ? p.socketId : null;
}

function clearMoveTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function armMoveTimer(code) {
  const room = rooms.get(code);
  if (!room || !room.game) return;
  clearMoveTimer(room);
  if (room.game.status !== 'active') return;
  if (room.players.some((p) => !p.connected)) return;

  const pending = room.game.pendingActor();
  if (!pending) return;

  room.turnToken = (room.turnToken || 0) + 1;
  const myToken = room.turnToken;

  room.timer = setTimeout(() => {
    const current = rooms.get(code);
    if (!current || current.turnToken !== myToken || !current.game) return;
    endByForfeit(current, pending.playerId, 'timeout');
  }, MOVE_TIMEOUT_MS);
}

function recordNormalResult(room) {
  if (room.statsRecorded) return;
  room.statsRecorded = true;
  const { winnerId, durakId, draw } = room.game;
  if (!draw) {
    if (winnerId) users.recordResult(winnerId, true, false);
    if (durakId) users.recordResult(durakId, false, false);
  }
}

function finishIfGameOver(room) {
  if (room.game && room.game.status === 'finished') recordNormalResult(room);
}

function endByForfeit(room, loserUsername, reason) {
  if (!room.game || room.game.status !== 'active') return;
  const winnerUsername = room.players.find((p) => p.username !== loserUsername)?.username;

  room.game.status = 'finished';
  room.game.winnerId = winnerUsername || null;
  room.game.durakId = loserUsername;
  room.game.log.push(`${loserUsername} zaudēja spēli (${reason})`);

  if (!room.statsRecorded) {
    room.statsRecorded = true;
    if (winnerUsername) users.recordResult(winnerUsername, true, true);
    users.recordResult(loserUsername, false, true);
  }

  clearMoveTimer(room);
  room.endReason = reason;
  broadcastState(room.code);
  scheduleRoomCleanup(room);
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => rooms.delete(room.code), ROOM_CLEANUP_MS);
}

function broadcastState(code) {
  const room = rooms.get(code);
  if (!room || !room.game) return;
  const names = namesFor(room);
  for (const p of room.players) {
    if (!p.connected) continue;
    const view = room.game.viewFor(p.username);
    io.to(p.socketId).emit('state', {
      ...view,
      names,
      endReason: room.endReason || null,
    });
  }
  armMoveTimer(code);
}

function sendError(socket, message) {
  socket.emit('errorMsg', message);
}

// ---------- Open-room browser (shown on the main page after login) ----------

function listOpenRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (room.game) continue; // already started, not joinable
    const host = room.players[0];
    if (!host || !host.connected) continue;
    out.push({ code: room.code, host: host.username, createdAt: room.createdAt });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

function broadcastOpenRooms() {
  io.to(LOBBY_ROOM).emit('openRoomsUpdated', listOpenRooms());
}

io.on('connection', (socket) => {
  let joinedCode = null;
  let playerId = null; // == username once authenticated
  let username = null;

  function onAuthenticated(rec) {
    username = rec.username;
    socket.join(LOBBY_ROOM);
    socket.emit('registered', rec);
    socket.emit('openRoomsUpdated', listOpenRooms());
  }

  socket.on('register', ({ username: name, password }) => {
    if (!password || password.length < users.MIN_PASSWORD_LEN) {
      return sendError(socket, `Parolei jābūt vismaz ${users.MIN_PASSWORD_LEN} rakstzīmes garai`);
    }
    const rec = users.createAccount(name, password);
    if (!rec) return sendError(socket, 'Šis lietotājvārds jau ir aizņemts (vai ir nederīgs)');
    onAuthenticated(rec);
  });

  socket.on('login', ({ username: name, password }) => {
    const rec = users.verifyLogin(name, password);
    if (!rec) return sendError(socket, 'Nepareizs lietotājvārds vai parole');
    onAuthenticated(rec);
  });

  socket.on('checkUsername', ({ username: name }) => {
    socket.emit('usernameStatus', { username: name, exists: users.usernameExists(name) });
  });

  socket.on('createRoom', () => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const code = makeRoomCode();
    playerId = username;
    joinedCode = code;
    rooms.set(code, {
      code,
      createdAt: Date.now(),
      players: [{ username, socketId: socket.id, connected: true }],
      game: null,
      timer: null,
      turnToken: 0,
      rematchVotes: {},
      statsRecorded: false,
      endReason: null,
    });
    socket.join(code);
    socket.leave(LOBBY_ROOM);
    socket.emit('roomCreated', { code });
    broadcastOpenRooms();
  });

  socket.on('joinRoom', ({ code }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const room = rooms.get(code);
    if (!room) return sendError(socket, 'Istaba nav atrasta vai jau beigusies');

    const existing = room.players.find((p) => p.username === username);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      playerId = username;
      joinedCode = code;
      socket.join(code);
      socket.leave(LOBBY_ROOM);

      if (room.disconnectTimer) {
        clearTimeout(room.disconnectTimer);
        room.disconnectTimer = null;
      }
      const opponentSocket = socketFor(room, room.players.find((p) => p.username !== username)?.username);
      if (opponentSocket) io.to(opponentSocket).emit('opponentReconnected');

      if (room.game) {
        socket.emit('gameStarted', { names: namesFor(room) });
        broadcastState(code);
      } else {
        socket.emit('roomCreated', { code });
      }
      return;
    }

    if (room.players.length >= 2) return sendError(socket, 'Istaba ir pilna');

    playerId = username;
    joinedCode = code;
    room.players.push({ username, socketId: socket.id, connected: true });
    socket.join(code);
    socket.leave(LOBBY_ROOM);

    room.game = new Game(room.players.map((p) => p.username));
    room.statsRecorded = false;
    room.endReason = null;
    io.to(code).emit('gameStarted', { names: namesFor(room) });
    broadcastState(code);
    broadcastOpenRooms();
  });

  socket.on('listOpenRooms', () => {
    socket.emit('openRoomsUpdated', listOpenRooms());
  });

  socket.on('attack', ({ cardId }) => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.attack(playerId, cardId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
  });

  socket.on('defend', ({ cardId, slotIndex }) => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.defend(playerId, cardId, slotIndex);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
  });

  socket.on('passTurn', () => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.passTurn(playerId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
  });

  socket.on('takeCards', () => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.takeCards(playerId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
  });

  socket.on('surrender', () => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    endByForfeit(room, playerId, 'surrender');
  });

  socket.on('chatMessage', ({ text }) => {
    if (!joinedCode || !username) return;
    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) return;
    io.to(joinedCode).emit('chatMessage', { from: username, text: clean, ts: Date.now() });
  });

  socket.on('rematchVote', ({ vote }) => {
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.rematchVotes = room.rematchVotes || {};

    if (vote === 'no') {
      io.to(room.code).emit('returnToLobby');
      clearMoveTimer(room);
      rooms.delete(room.code);
      broadcastOpenRooms();
      return;
    }

    room.rematchVotes[playerId] = 'yes';
    const opponent = room.players.find((p) => p.username !== playerId);
    if (!opponent) return;
    const opponentVote = room.rematchVotes[opponent.username];
    if (opponentVote === 'yes') {
      startRematch(room);
    } else {
      const oppSocket = socketFor(room, opponent.username);
      if (oppSocket) io.to(oppSocket).emit('rematchRequested', { fromUsername: username });
    }
  });

  socket.on('getProfile', ({ username: target }) => {
    const stats = users.getStats(target);
    if (!stats) return sendError(socket, 'Profils nav atrasts');
    socket.emit('profileData', { username: target, stats });
  });

  socket.on('disconnect', () => {
    if (!joinedCode || !rooms.has(joinedCode)) return;
    const room = rooms.get(joinedCode);
    const p = room.players.find((pl) => pl.username === playerId);
    if (p) p.connected = false;

    const opponent = room.players.find((pl) => pl.username !== playerId);
    if (opponent && opponent.connected) {
      io.to(opponent.socketId).emit('opponentDisconnected', { gracePeriodMs: DISCONNECT_GRACE_MS });
    }

    if (room.game && room.game.status === 'active') {
      clearMoveTimer(room);
      room.disconnectTimer = setTimeout(() => {
        const stillGone = room.players.find((pl) => pl.username === playerId && !pl.connected);
        if (stillGone) endByForfeit(room, playerId, 'disconnect');
      }, DISCONNECT_GRACE_MS);
    } else if (!room.players.some((pl) => pl.connected)) {
      rooms.delete(joinedCode);
      broadcastOpenRooms();
    }
  });
});

function startRematch(room) {
  clearMoveTimer(room);
  room.rematchVotes = {};
  room.statsRecorded = false;
  room.endReason = null;
  room.game = new Game(room.players.map((p) => p.username));
  io.to(room.code).emit('gameStarted', { names: namesFor(room) });
  broadcastState(room.code);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Duraks MVP running at http://localhost:${PORT}`);
});

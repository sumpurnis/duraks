'use strict';

/**
 * server/multi-rooms.js
 *
 * Room/socket handling for the 2-4 player Duraks mode (games/duraks-multi.js
 * + ai-multi.js). Deliberately isolated from the 2-player game's room
 * system in server.js — its own Map, its own event names (all prefixed
 * 'multi*'), its own timers. Nothing in here reads or writes server.js's
 * `rooms` Map, and nothing in server.js's 2-player handlers touches this
 * module's state.
 *
 * Everything goes through one room model now (createMultiRoom/
 * joinMultiRoom): any mix of real players and AI seats, from a solo
 * human vs bots (totalPlayers:N, aiCount:N-1 — starts immediately, since
 * the creator alone already fills every human slot) up to a full room of
 * real players. A room sits in 'waiting' status, listed publicly (unless
 * created private, see below), until enough humans have joined to fill
 * every non-AI seat, at which point it starts automatically. The creator
 * can cancel a still-waiting room at any time. A room can optionally be
 * made private at creation — it's excluded from the public list, and a
 * server-generated password (shown to the creator, and to anyone who
 * successfully joins) is required to join it by code instead.
 *
 * Both registered users and guests (no account) can create and join
 * rooms - a guest gets a random "Viesis-XXXX" identity generated once per
 * connection and reused for every multi-mode action from that socket,
 * mirroring the existing single-player guest flow.
 *
 * Simplification worth knowing about: mid-game disconnect or move-timeout
 * handling for a room (multi-human) game ends the whole game rather than
 * trying to gracefully continue with fewer humans - the engine has no
 * "forfeit one seat and keep going" concept, and building one was out of
 * scope for this pass. Solo-vs-bots games (always exactly one human) are
 * unaffected by this - that path already worked this way.
 */

const { Game } = require('./games/duraks-multi');
const { chooseMove } = require('./ai-multi');

const MULTI_MOVE_TIMEOUT_MS = 60000;
const MULTI_CLEANUP_MS = 5 * 60 * 1000;
const MULTI_BOT_MOVE_DELAY_MS = [1000, 2000];
const MULTI_LOBBY_ROOM = 'lobby';
const BOT_NAMES = ['Dators 1 \u{1F916}', 'Dators 2 \u{1F916}', 'Dators 3 \u{1F916}'];
const GUEST_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const multiRooms = new Map();

function isBot(playerId) {
  return BOT_NAMES.includes(playerId);
}

function makeMultiRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'M-' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (multiRooms.has(code));
  return code;
}

function isNameInUseByAnyRoom(name) {
  for (const room of multiRooms.values()) {
    if (room.humans.some((h) => h.username === name)) return true;
  }
  return false;
}

function makeGuestUsername(usersModule) {
  let name;
  let attempts = 0;
  do {
    const suffix = Array.from({ length: 4 }, () => GUEST_CHARS[Math.floor(Math.random() * GUEST_CHARS.length)]).join('');
    name = `Viesis-${suffix}`;
    attempts++;
  } while (
    attempts < 20 &&
    ((usersModule && usersModule.usernameExists && usersModule.usernameExists(name)) || isNameInUseByAnyRoom(name))
  );
  return name;
}

function randomDelay() {
  const [min, max] = MULTI_BOT_MOVE_DELAY_MS;
  return min + Math.random() * (max - min);
}

function namesFor(room) {
  const map = {};
  for (const h of room.humans) map[h.username] = h.username;
  for (const bot of room.bots) map[bot] = bot;
  return map;
}

function clearMultiMoveTimer(room) {
  if (room.moveTimer) {
    clearTimeout(room.moveTimer);
    room.moveTimer = null;
  }
}

function scheduleMultiCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => multiRooms.delete(room.code), MULTI_CLEANUP_MS);
}

function serializeOpenRoom(room) {
  return {
    code: room.code,
    totalPlayers: room.totalPlayers,
    aiCount: room.aiCount,
    humanSlotsNeeded: room.humanSlotsNeeded,
    humansJoined: room.humans.length,
    humanNames: room.humans.map((h) => h.username),
    creatorUsername: room.creatorUsername,
    isPrivate: !!room.isPrivate,
  };
}

function listOpenMultiRooms() {
  return Array.from(multiRooms.values())
    .filter((r) => r.status === 'waiting')
    .map(serializeOpenRoom);
}

// True if this username is currently part of any room that's still
// waiting for players or has an active game in progress — used to limit
// each user to one active room at a time (creating or joining a second
// one is blocked while this is true).
function userHasActiveRoom(username) {
  for (const room of multiRooms.values()) {
    if (room.status === 'waiting' || room.status === 'active') {
      if (room.humans.some((h) => h.username === username)) return true;
    }
  }
  return false;
}

function makeRoomPassword() {
  return Array.from({ length: 6 }, () => GUEST_CHARS[Math.floor(Math.random() * GUEST_CHARS.length)]).join('');
}

module.exports = function registerMultiHandlers(io, socket, { getUsername, users }) {
  let multiJoinedCode = null;
  let multiGuestUsername = null;

  function effectiveUsername() {
    const real = getUsername();
    if (real) return real;
    if (!multiGuestUsername) multiGuestUsername = makeGuestUsername(users);
    return multiGuestUsername;
  }

  function currentRoom() {
    return multiJoinedCode ? multiRooms.get(multiJoinedCode) : null;
  }

  function sendMultiError(msg) {
    socket.emit('errorMsg', msg);
  }

  function broadcastMultiOpenRooms() {
    io.to(MULTI_LOBBY_ROOM).emit('multiRoomsData', listOpenMultiRooms());
  }

  // Personal history log for a multiplayer game, called once right as the
  // game reaches 'finished' status (from any of the several paths that
  // can cause that — normal round resolution, surrender, move timeout, or
  // a disconnect). Guarded by room.historyRecorded so it's safe even if
  // called more than once for the same room. Placement: safeOrder gives
  // the order players went safe (1st entry = best), durakId is always
  // last place; a true draw (nobody left active, no durak) records no
  // placement. Bots are never recorded — only room.humans.
  function recordMultiGameHistory(room) {
    if (room.historyRecorded) return;
    room.historyRecorded = true;
    const game = room.game;
    if (!game || game.status !== 'finished') return;

    const placementOf = {};
    game.safeOrder.forEach((username, idx) => {
      placementOf[username] = idx + 1;
    });
    if (game.durakId) placementOf[game.durakId] = room.totalPlayers;
    const isDraw = !game.durakId && game.activePlayers.length === 0;
    const vsBots = room.bots.length > 0;

    for (const h of room.humans) {
      const username = h.username;
      const placement = placementOf[username] || null;
      let outcome;
      if (isDraw) outcome = 'draw';
      else if (game.durakId === username) outcome = 'lost';
      else if (placement === 1) outcome = 'won';
      else outcome = 'placed';

      users.recordGameHistoryEntry(username, {
        mode: 'multi',
        totalPlayers: room.totalPlayers,
        deckSize: room.deckSize || 52,
        ranked: false,
        outcome,
        placement,
        vsBots,
        opponents: game.players.filter((p) => p !== username),
      });
    }
  }

  function broadcastMultiState(room) {
    for (const h of room.humans) {
      const sock = io.sockets.sockets.get(h.socketId);
      if (!sock) continue;
      const view = room.game.viewFor(h.username);
      sock.emit('multiState', { ...view, names: namesFor(room) });
    }
    armMultiMoveTimer(room);
  }

  function armMultiMoveTimer(room) {
    clearMultiMoveTimer(room);
    if (room.game.status !== 'active') return;
    const actors = room.game.pendingActors();
    const pendingHumans = room.humans.filter((h) => actors.some((a) => a.playerId === h.username));
    if (pendingHumans.length === 0) return;
    room.moveTimer = setTimeout(() => {
      if (room.game.status !== 'active') return;
      const stalled = pendingHumans[0];
      room.game.status = 'finished';
      room.game.durakId = stalled.username;
      room.game.log.push(`${stalled.username} nereaģēja laikā — spēle beigusies`);
      broadcastMultiState(room);
      recordMultiGameHistory(room);
      scheduleMultiCleanup(room);
    }, MULTI_MOVE_TIMEOUT_MS);
  }

  function driveBots(room) {
    if (room.game.status !== 'active') {
      broadcastMultiState(room);
      if (room.game.status === 'finished') {
        recordMultiGameHistory(room);
        scheduleMultiCleanup(room);
      }
      return;
    }

    if (room.game.isRoundResolvable()) {
      broadcastMultiState(room);
      resolveWithPause(room, pauseCountFor(room), () => room.game.tryResolveRound());
      return;
    }

    if (room.game.isTakeResolvable()) {
      broadcastMultiState(room);
      resolveWithPause(room, pauseCountFor(room), () => room.game.tryResolveTake());
      return;
    }

    const actors = room.game.pendingActors();
    const botActor = actors.find((a) => isBot(a.playerId));
    if (!botActor) {
      broadcastMultiState(room);
      return;
    }
    room.botTimer = setTimeout(() => {
      if (!multiRooms.has(room.code) || room.game.status !== 'active') return;
      const action = chooseMove(room.game, botActor.playerId);
      applyAction(room, botActor.playerId, action);
      broadcastMultiState(room);
      driveBots(room);
    }, randomDelay());
  }

  function pauseCountFor(room) {
    const activeBots = room.bots.filter((b) => room.game.activePlayers.includes(b) && b !== room.game.defenderId);
    return Math.max(1, activeBots.length);
  }

  function resolveWithPause(room, pausesLeft, resolveFn) {
    room.botTimer = setTimeout(() => {
      if (!multiRooms.has(room.code) || room.game.status !== 'active') return;
      if (pausesLeft > 1) {
        resolveWithPause(room, pausesLeft - 1, resolveFn);
        return;
      }
      resolveFn();
      broadcastMultiState(room);
      driveBots(room);
    }, randomDelay());
  }

  function applyAction(room, playerId, action) {
    if (!action) return { error: 'Bots neatrada derīgu gājienu' };
    if (action.type === 'attack') return room.game.attack(playerId, action.cardId);
    if (action.type === 'defend') return room.game.defend(playerId, action.cardId, action.slotIndex);
    if (action.type === 'declineThrowIn') return room.game.declineThrowIn(playerId);
    if (action.type === 'take') return room.game.takeCards(playerId);
    return { error: `Nezināma darbība: ${action.type}` };
  }

  function startMultiRoomGame(room) {
    room.status = 'active';
    room.bots = BOT_NAMES.slice(0, room.aiCount);
    const seating = [...room.humans.map((h) => h.username), ...room.bots];
    room.game = new Game(seating, { deferAutoResolve: true, deckSize: room.deckSize || 52 });

    for (const h of room.humans) {
      const sock = io.sockets.sockets.get(h.socketId);
      if (sock) sock.emit('multiGameStarted', { names: namesFor(room), code: room.code, you: h.username });
    }
    broadcastMultiOpenRooms();
    broadcastMultiState(room);
    driveBots(room);
  }

  function joinRoomBookkeeping(room, username) {
    room.humans.push({ username, socketId: socket.id, connected: true });
    multiJoinedCode = room.code;
    socket.join(room.code);
    socket.leave(MULTI_LOBBY_ROOM);
  }

  function broadcastWaitingRoom(room) {
    for (const h of room.humans) {
      const sock = io.sockets.sockets.get(h.socketId);
      if (sock) {
        sock.emit('multiRoomWaiting', {
          ...serializeOpenRoom(room),
          yourUsername: h.username,
          isCreator: h.username === room.creatorUsername,
          password: room.isPrivate ? room.password : undefined,
        });
      }
    }
  }

  socket.on('createMultiRoom', ({ totalPlayers, aiCount, isPrivate, deckSize }) => {
    const username = effectiveUsername();
    if (userHasActiveRoom(username)) {
      return sendMultiError('Tev jau ir aktīva istaba — vispirms to pamet vai atcel');
    }
    const n = parseInt(totalPlayers, 10);
    const ai = parseInt(aiCount, 10);
    const deck = parseInt(deckSize, 10) === 36 ? 36 : 52;
    if (!Number.isInteger(n) || n < 2 || n > 4) {
      return sendMultiError('Spēlētāju skaitam jābūt no 2 līdz 4');
    }
    if (!Number.isInteger(ai) || ai < 0 || ai > n - 1) {
      return sendMultiError('Nederīgs datora pretinieku skaits');
    }
    if (deck === 36 && n !== 2) {
      return sendMultiError('36 kāršu kava ir pieejama tikai 2 spēlētājiem');
    }

    const code = makeMultiRoomCode();
    const room = {
      code,
      status: 'waiting',
      createdAt: Date.now(),
      totalPlayers: n,
      aiCount: ai,
      deckSize: deck,
      humanSlotsNeeded: n - ai,
      creatorUsername: username,
      isPrivate: !!isPrivate,
      password: isPrivate ? makeRoomPassword() : null,
      humans: [],
      bots: [],
      game: null,
      moveTimer: null,
      botTimer: null,
      cleanupTimer: null,
    };
    multiRooms.set(code, room);
    joinRoomBookkeeping(room, username);

    if (room.humans.length >= room.humanSlotsNeeded) {
      startMultiRoomGame(room);
    } else {
      broadcastWaitingRoom(room);
      broadcastMultiOpenRooms();
    }
  });

  socket.on('listMultiRooms', () => {
    socket.emit('multiRoomsData', listOpenMultiRooms());
  });

  socket.on('joinMultiRoom', ({ code, password }) => {
    const username = effectiveUsername();
    const room = multiRooms.get(code);
    if (!room) return sendMultiError('Istaba nav atrasta');
    if (room.status !== 'waiting') return sendMultiError('Šai istabai vairs nevar pievienoties');
    if (room.humans.some((h) => h.username === username)) return sendMultiError('Tu jau esi šajā istabā');
    if (userHasActiveRoom(username)) {
      return sendMultiError('Tev jau ir aktīva istaba — vispirms to pamet vai atcel');
    }
    if (room.isPrivate && String(password || '').trim().toUpperCase() !== room.password) {
      return sendMultiError('Nepareiza parole');
    }
    if (room.humans.length >= room.humanSlotsNeeded) return sendMultiError('Istaba jau ir pilna');

    joinRoomBookkeeping(room, username);

    if (room.humans.length >= room.humanSlotsNeeded) {
      startMultiRoomGame(room);
    } else {
      broadcastWaitingRoom(room);
      broadcastMultiOpenRooms();
    }
  });

  socket.on('cancelMultiRoom', (data) => {
    const requestedCode = data && data.code ? data.code : multiJoinedCode;
    const room = requestedCode ? multiRooms.get(requestedCode) : null;
    if (!room || room.status !== 'waiting') return sendMultiError('Nav ko atcelt');
    const username = effectiveUsername();
    if (room.creatorUsername !== username) return sendMultiError('Tikai izveidotājs var atcelt istabu');

    for (const h of room.humans) {
      const sock = io.sockets.sockets.get(h.socketId);
      if (sock) {
        sock.emit('multiRoomCancelled');
        sock.leave(room.code);
        sock.join(MULTI_LOBBY_ROOM);
      }
    }
    multiRooms.delete(room.code);
    if (multiJoinedCode === room.code) multiJoinedCode = null;
    broadcastMultiOpenRooms();
  });

  socket.on('multiAttack', ({ cardId }) => {
    const room = currentRoom();
    if (!room) return;
    const res = room.game.attack(effectiveUsername(), cardId);
    if (res.error) return sendMultiError(res.error);
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiDefend', ({ cardId, slotIndex }) => {
    const room = currentRoom();
    if (!room) return;
    const res = room.game.defend(effectiveUsername(), cardId, slotIndex);
    if (res.error) return sendMultiError(res.error);
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiDeclineThrowIn', () => {
    const room = currentRoom();
    if (!room) return;
    const res = room.game.declineThrowIn(effectiveUsername());
    if (res.error) return sendMultiError(res.error);
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiTakeCards', () => {
    const room = currentRoom();
    if (!room) return;
    const res = room.game.takeCards(effectiveUsername());
    if (res.error) return sendMultiError(res.error);
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiSurrender', () => {
    const room = currentRoom();
    if (!room || !room.game || room.game.status !== 'active') return;
    const username = effectiveUsername();
    if (!room.game.activePlayers.includes(username)) return; // already safe — nothing to surrender
    room.game.status = 'finished';
    room.game.durakId = username;
    room.game.log.push(`${username} padevās`);
    broadcastMultiState(room);
    clearMultiMoveTimer(room);
    recordMultiGameHistory(room);
    scheduleMultiCleanup(room);
  });

  socket.on('multiLeaveRoom', () => {
    const room = currentRoom();
    if (room) {
      const username = effectiveUsername();
      // Leaving after already going safe (won, or finished ahead of the
      // durak) shouldn't affect anyone else's game — just remove this
      // human from the room so the server stops sending them updates,
      // and let the remaining active players continue normally.
      if (room.game && room.game.status === 'active' && !room.game.activePlayers.includes(username)) {
        room.humans = room.humans.filter((h) => h.username !== username);
      }
      socket.leave(room.code);
      socket.join(MULTI_LOBBY_ROOM);
    }
    multiJoinedCode = null;
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (!room) return;
    const username = effectiveUsername();

    if (room.status === 'waiting') {
      room.humans = room.humans.filter((h) => h.socketId !== socket.id);
      if (username === room.creatorUsername || room.humans.length === 0) {
        for (const h of room.humans) {
          const sock = io.sockets.sockets.get(h.socketId);
          if (sock) sock.emit('multiRoomCancelled');
        }
        multiRooms.delete(room.code);
      } else {
        broadcastWaitingRoom(room);
      }
      broadcastMultiOpenRooms();
      return;
    }

    if (!room.game || room.game.status !== 'active') return;
    room.game.status = 'finished';
    room.game.durakId = username;
    clearMultiMoveTimer(room);
    if (room.botTimer) clearTimeout(room.botTimer);
    recordMultiGameHistory(room);
    scheduleMultiCleanup(room);
  });
};

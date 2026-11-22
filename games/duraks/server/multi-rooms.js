'use strict';

/**
 * games/duraks/server/multi-rooms.js
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
const challenges = require('./challenges');
const { chooseChallengeMove, seededRng, hashSeed } = require('./challenge-ai');
const CHALLENGE_BOT = 'Izaicinājums \u{1F916}';

const MULTI_MOVE_TIMEOUT_MS = 60000;
const MULTI_CLEANUP_MS = 5 * 60 * 1000;
const MULTI_BOT_MOVE_DELAY_MS = [1000, 2000];
const MULTI_LOBBY_ROOM = 'lobby';
const BOT_NAMES = ['Dators 1 \u{1F916}', 'Dators 2 \u{1F916}', 'Dators 3 \u{1F916}'];
const GUEST_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const multiRooms = new Map();

function isBot(playerId) {
  return BOT_NAMES.includes(playerId) || playerId === CHALLENGE_BOT;
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
    ranked: !!room.ranked,
    allowTransfer: !!room.allowTransfer,
  };
}

function listOpenMultiRooms() {
  return Array.from(multiRooms.values())
    .filter((r) => r.status === 'waiting' && !r.hidden)
    .map(serializeOpenRoom);
}

// True if this username is currently part of any room that's still
// waiting for players or has an active game in progress — used to limit
// each user to one active room at a time (creating or joining a second
// one is blocked while this is true).
function userHasActiveRoom(username) {
  for (const room of multiRooms.values()) {
    const isWaitingRoom = room.status === 'waiting';
    const isOngoingGame = room.game && room.game.status === 'active';
    if ((isWaitingRoom || isOngoingGame) && room.humans.some((h) => h.username === username)) {
      return true;
    }
  }
  return false;
}

function makeRoomPassword() {
  return Array.from({ length: 6 }, () => GUEST_CHARS[Math.floor(Math.random() * GUEST_CHARS.length)]).join('');
}

// The functions that run a room (start it, drive the computer, record the result) are made inside
// each connection's handler below but only use the server-wide things passed in, so the latest set
// is kept here for rooms the server starts by itself (tournament games, see createTournamentRoom).
let roomOps = null;

module.exports = function registerMultiHandlers(io, socket, { getUsername, users, world, canCreateRoom, cleanChat, onTournamentResult, tournamentInfo }) {
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

  // The room this player is in, only while its game is running. Moves sent to a room that is
  // still waiting for players (room.game === null) used to crash the server.
  function activeRoom() {
    const room = currentRoom();
    return room && room.game && room.game.status === 'active' ? room : null;
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
  function broadcastMultiLeaderboards() {
    io.to(MULTI_LOBBY_ROOM).emit('leaderboardsData', users.getLeaderboards());
  }

  // Rough "did they have a real defense and take anyway?" check — same
  // approximate heuristic as server.js's 2-player path (per-slot existence,
  // not a true simultaneous-assignment solver). See that copy's comment
  // for the full rationale; kept duplicated here since the two modules
  // don't otherwise share game-engine helpers.
  function isAvoidableTake(game, playerId) {
    const openSlots = game.table.filter((s) => !s.defend);
    if (openSlots.length === 0) return false;
    const hand = game.hands[playerId] || [];
    return openSlots.every((slot) => hand.some((card) => game.beats(slot.attack, card)));
  }

  function recordMultiGameHistory(room) {
    if (room.historyRecorded) return;
    room.historyRecorded = true;
    const game = room.game;
    if (!game || game.status !== 'finished') return;
    const durationMs = room.startedAt ? Date.now() - room.startedAt : undefined;
    const endReason = room.endReason || 'normal';

    const placementOf = {};
    game.safeOrder.forEach((username, idx) => {
      placementOf[username] = idx + 1;
    });
    if (game.durakId) placementOf[game.durakId] = room.totalPlayers;
    // Any human not yet placed didn't go safe through normal play and
    // isn't the durak — a survivor of a forced finish (surrender/
    // timeout/disconnect), which ends the whole game immediately rather
    // than letting them keep playing to a natural placement. Treat them
    // as a winner: unambiguous for 2 players, a reasonable simplification
    // for 3-4 (co-winners) given the alternative is leaving them
    // unaccounted for entirely.
    for (const h of room.humans) {
      if (!(h.username in placementOf)) placementOf[h.username] = 1;
    }
    const isDraw = !game.durakId && game.activePlayers.length === 0;
    const vsBots = room.bots.length > 0;

    // Which independent ELO pool this table's result feeds — 2-player
    // tables update the 'oneVOne' rating, 3-4 player tables update
    // 'multi'; see the ELO_POOLS comment in users.js for why they're kept
    // separate rather than one shared number.
    const eloPool = room.totalPlayers === 2 ? 'oneVOne' : 'multi';

    let eloResult = null;
    if (room.ranked && !isDraw) {
      const placements = room.humans.map((h) => ({
        username: h.username,
        placement: placementOf[h.username] || room.totalPlayers,
      }));
      eloResult = users.applyRankedGameResult(placements, eloPool);
    }

    // Feed the classic games-played/won/lost stats and TOP10 leaderboard
    // too — these predate the history log and were never wired up when
    // multiplayer room creation became the path for every game (including
    // 1v1, once room creation was unified), so they'd otherwise silently
    // never move for any game played through this system.
    if (vsBots) {
      users.recordVsBotGameCompleted();
    } else {
      users.recordGameCompleted();
    }

    // The front page's map: road wear between the players, village growth.
    if (world) world.recordGame('duraks', room.humans.map((h) => h.username), { vsBot: vsBots });

    for (const h of room.humans) {
      const username = h.username;
      const placement = placementOf[username] || null;
      let outcome;
      if (isDraw) outcome = 'draw';
      else if (game.durakId === username) outcome = 'lost';
      else if (placement === 1) outcome = 'won';
      else outcome = 'placed';

      if (!vsBots && !isDraw) {
        users.recordResult(username, outcome === 'won', false);
      }

      const eloEntry = eloResult && eloResult[username];

      if (room.challenge) {
        const c = room.challenge;
        const result = challenges.recordResult(username, c.date, c.level, outcome === 'won', c.moves);
        const sock = io.sockets.sockets.get(h.socketId);
        if (sock && result) sock.emit('challengeResult', { ...result, level: c.level, moves: c.moves, status: challenges.statusFor(username) });
      }

      users.recordGameHistoryEntry(username, {
        challenge: room.challenge ? { date: room.challenge.date, level: room.challenge.level } : undefined,
        mode: 'multi',
        totalPlayers: room.totalPlayers,
        deckSize: room.deckSize || 52,
        ranked: !!room.ranked,
        outcome,
        placement,
        vsBots,
        opponents: game.players.filter((p) => p !== username),
        eloPool: room.ranked ? eloPool : undefined,
        eloBefore: eloEntry ? eloEntry.before : undefined,
        eloAfter: eloEntry ? eloEntry.after : undefined,
        eloChange: eloEntry ? eloEntry.delta : undefined,
        endReason,
        durationMs,
        avoidableTakes: (room.avoidableTakes && room.avoidableTakes[username]) || 0,
      });
    }

    broadcastMultiLeaderboards();

    // A tournament game: the series score is kept by the tournament (games/duraks/server/index.js).
    if (room.tournamentMatch && onTournamentResult && !isDraw) {
      const winner = game.players.find((p) => p !== game.durakId) || null;
      if (winner) {
        try { onTournamentResult(room.tournamentMatch, winner, isBot(winner), room.code); } catch (err) { console.error('tournament result failed:', err); }
      }
    }
  }

  function broadcastMultiState(room) {
    // Arm first, so every client gets the same deadline the server enforces.
    armMultiMoveTimer(room);
    const turnTimer = room.moveDeadline
      ? { playerId: room.moveTimedPlayer, deadline: room.moveDeadline, totalMs: MULTI_MOVE_TIMEOUT_MS, serverNow: Date.now() }
      : null;
    for (const h of room.humans) {
      const sock = io.sockets.sockets.get(h.socketId);
      if (!sock) continue;
      const view = room.game.viewFor(h.username);
      const tInfo = room.tournamentMatch && tournamentInfo ? tournamentInfo(room.tournamentMatch) : null;
      sock.emit('multiState', { ...view, names: namesFor(room), turnTimer, tournamentInfo: tInfo });
    }
  }

  function armMultiMoveTimer(room) {
    clearMultiMoveTimer(room);
    const prevDeadline = room.moveDeadline;
    const prevKey = room.moveTimerKey;
    room.moveDeadline = null;
    room.moveTimedPlayer = null;
    room.moveTimerKey = null;
    if (room.game.status !== 'active') return;
    const actors = room.game.pendingActors();
    const pendingHumans = room.humans.filter((h) => actors.some((a) => a.playerId === h.username));
    if (pendingHumans.length === 0) return;
    // The clock belongs to the one player shown as "Tagad" when that is a
    // human; otherwise to the first human the game is waiting on.
    const now = room.game.turnInfo().now;
    const stalledId = now && pendingHumans.some((h) => h.username === now.playerId)
      ? now.playerId
      : pendingHumans[0].username;
    // Keep the running clock while the same player still faces the same
    // decision (e.g. a bot throws in while I'm still defending); restart it
    // once the timed player has acted (hand size changes) or someone else is up.
    const kind = (room.game.pendingActors().find((a) => a.playerId === stalledId) || {}).kind;
    const key = stalledId + '|' + kind + '|' + room.game.hands[stalledId].length;
    const keep = prevKey === key && prevDeadline && prevDeadline - Date.now() > 1000;
    room.moveDeadline = keep ? prevDeadline : Date.now() + MULTI_MOVE_TIMEOUT_MS;
    room.moveTimedPlayer = stalledId;
    room.moveTimerKey = key;
    room.moveTimer = setTimeout(() => {
      if (room.game.status !== 'active') return;
      const stalled = { username: stalledId };
      room.game.status = 'finished';
      room.game.durakId = stalled.username;
      room.game.log.push(`${stalled.username} nereaģēja laikā — spēle beigusies`);
      room.endReason = 'timeout';
      broadcastMultiState(room);
      recordMultiGameHistory(room);
      scheduleMultiCleanup(room);
    }, room.moveDeadline - Date.now());
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
      const action = room.challenge ? challengeMove(room, botActor.playerId) : chooseMove(room.game, botActor.playerId);
      applyAction(room, botActor.playerId, action);
      broadcastMultiState(room);
      driveBots(room);
    }, randomDelay());
  }

  // The challenge computer: the same moves by the player always get the same answers, because every
  // decision's randomness comes from the day's deal, the level and the decision's number.
  function challengeMove(room, botId) {
    const c = room.challenge;
    const rng = seededRng(hashSeed(`${c.seed}:${c.level}:${c.decisions++}`));
    return chooseChallengeMove(room.game, botId, c.skill, rng);
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
    if (action.type === 'transfer') return room.game.transferCards(playerId, action.cardId);
    if (action.type === 'declineThrowIn') return room.game.declineThrowIn(playerId);
    if (action.type === 'take') return room.game.takeCards(playerId);
    return { error: `Nezināma darbība: ${action.type}` };
  }

  function startMultiRoomGame(room) {
    room.status = 'active';
    room.startedAt = Date.now();
    room.bots = room.challenge ? [CHALLENGE_BOT] : BOT_NAMES.slice(0, room.aiCount);
    const seating = [...room.humans.map((h) => h.username), ...room.bots];
    room.game = new Game(seating, {
      deferAutoResolve: true,
      deckSize: room.deckSize || 52,
      allowTransfer: !!room.allowTransfer,
      deck: room.challenge ? room.challenge.deck : undefined,
    });

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
    // someone joining later sees what was said at the table so far
    if (room.chatLog && room.chatLog.length) socket.emit('multiChatHistory', room.chatLog);
  }

  // Table chat: everyone at the table (guests too), while waiting, playing and after the game.
  socket.on('multiChat', ({ text } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const clean = cleanChat ? cleanChat(text) : String(text || '').trim().slice(0, 300);
    if (!clean) return;
    const msg = { from: effectiveUsername(), text: clean, ts: Date.now() };
    room.chatLog = (room.chatLog || []).concat(msg).slice(-50);
    io.to(room.code).emit('multiChat', msg);
  });

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

  socket.on('createMultiRoom', ({ totalPlayers, aiCount, isPrivate, deckSize, ranked, allowTransfer }) => {
    const username = effectiveUsername();
    if (userHasActiveRoom(username)) {
      return sendMultiError('Tev jau ir aktīva istaba — vispirms to pamet vai atcel');
    }
    if (canCreateRoom && !canCreateRoom()) {
      return sendMultiError('Pārāk daudz jaunu spēļu īsā laikā — uzgaidi dažas minūtes.');
    }
    const n = parseInt(totalPlayers, 10);
    const ai = parseInt(aiCount, 10);
    const deck = parseInt(deckSize, 10) === 36 ? 36 : 52;
    const isRanked = !!ranked;
    // "Padošana" (perevodnoy transfer rule) — supported by the engine for
    // any player count (2-4). The 3-4 player cascade (chained transfers,
    // e.g. 1->2->3->1 in a 3-player room) has been verified against the
    // engine directly, so it's offered here for any room size.
    const isTransferable = !!allowTransfer;
    if (!Number.isInteger(n) || n < 2 || n > 4) {
      return sendMultiError('Spēlētāju skaitam jābūt no 2 līdz 4');
    }
    if (!Number.isInteger(ai) || ai < 0 || ai > n - 1) {
      return sendMultiError('Nederīgs datora pretinieku skaits');
    }
    if (deck === 36 && n !== 2) {
      return sendMultiError('36 kāršu kava ir pieejama tikai 2 spēlētājiem');
    }
    if (isRanked && ai > 0) {
      return sendMultiError('Ranked istabās nevar būt datora pretinieki');
    }
    if (isRanked && !getUsername()) {
      return sendMultiError('Ranked istabas var izveidot tikai reģistrēti lietotāji');
    }

    // Remember these choices for next time, but only for registered users
    // (guests have no account to attach them to). This only stores a
    // snapshot for pre-filling the modal later — it never auto-creates a
    // room by itself.
    if (getUsername()) {
      users.saveLastRoomSettings(username, {
        totalPlayers: n,
        aiCount: ai,
        deckSize: deck,
        isPrivate: !!isPrivate,
        ranked: isRanked,
        allowTransfer: isTransferable,
      });
    }

    const code = makeMultiRoomCode();
    const room = {
      code,
      status: 'waiting',
      createdAt: Date.now(),
      totalPlayers: n,
      aiCount: ai,
      deckSize: deck,
      ranked: isRanked,
      allowTransfer: isTransferable,
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

  roomOps = { startMultiRoomGame, broadcastMultiState };

  // ---- tournament games: the server made the room (createTournamentRoom); the player's page joins it ----
  socket.on('joinMultiTournament', ({ code } = {}) => {
    const username = getUsername();
    const room = multiRooms.get(String(code || ''));
    if (!username || !room || !room.tournamentMatch) return sendMultiError('Turnīra spēle nav atrasta');
    const seat = room.humans.find((h) => h.username === username);
    if (!seat) return sendMultiError('Tu neesi šīs turnīra spēles dalībnieks');
    const prev = currentRoom();
    if (prev && prev !== room) socket.leave(prev.code);
    const moved = seat.socketId !== socket.id; // a reload or a new tab: tell this page about the game
    seat.socketId = socket.id;
    seat.connected = true;
    multiJoinedCode = room.code;
    socket.join(room.code);
    socket.leave(MULTI_LOBBY_ROOM);
    if (room.game) {
      if (moved) socket.emit('multiGameStarted', { names: namesFor(room), code: room.code, you: username });
      broadcastMultiState(room);
    }
  });

  // ---- challenges ("Izaicinājumi") ----
  socket.on('getChallenges', () => {
    socket.emit('challengesData', challenges.statusFor(getUsername()));
  });

  socket.on('startChallenge', ({ level } = {}) => {
    const username = getUsername();
    if (!username) return sendMultiError('Izaicinājumi ir reģistrētiem spēlētājiem — ielogojies.');
    if (userHasActiveRoom(username)) return sendMultiError('Tev jau ir aktīva istaba — vispirms to pamet vai atcel');
    const start = challenges.startAttempt(username, String(level || ''));
    if (start.error) return sendMultiError(start.error);
    const code = makeMultiRoomCode();
    const room = {
      code,
      status: 'waiting',
      createdAt: Date.now(),
      totalPlayers: 2,
      aiCount: 1,
      deckSize: 36,
      ranked: false,
      allowTransfer: false,
      humanSlotsNeeded: 1,
      creatorUsername: username,
      isPrivate: true,
      password: null,
      humans: [],
      bots: [],
      game: null,
      moveTimer: null,
      botTimer: null,
      cleanupTimer: null,
      challenge: { date: start.date, level: start.level, seed: start.seed, skill: start.skill, deck: start.deck, attempt: start.attempt, decisions: 0, moves: 0 },
    };
    multiRooms.set(code, room);
    joinRoomBookkeeping(room, username);
    socket.emit('challengeStarted', { level: start.level, attempt: start.attempt, status: challenges.statusFor(username) });
    startMultiRoomGame(room);
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
      // the page asks for the password (a table link never carries it); `wrong` = one was given
      return socket.emit('multiNeedPassword', { code: room.code, wrong: !!String(password || '').trim() });
    }
    if (room.ranked && !getUsername()) {
      return sendMultiError('Ranked istabām var pievienoties tikai reģistrēti lietotāji');
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
    const room = activeRoom();
    if (!room) return;
    const res = room.game.attack(effectiveUsername(), cardId);
    if (res.error) return sendMultiError(res.error);
    if (room.challenge) room.challenge.moves++;
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiDefend', ({ cardId, slotIndex }) => {
    const room = activeRoom();
    if (!room) return;
    const res = room.game.defend(effectiveUsername(), cardId, slotIndex);
    if (res.error) return sendMultiError(res.error);
    if (room.challenge) room.challenge.moves++;
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiTransferCards', ({ cardId }) => {
    const room = activeRoom();
    if (!room) return;
    const res = room.game.transferCards(effectiveUsername(), cardId);
    if (res.error) return sendMultiError(res.error);
    if (room.challenge) room.challenge.moves++;
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiDeclineThrowIn', () => {
    const room = activeRoom();
    if (!room) return;
    const res = room.game.declineThrowIn(effectiveUsername());
    if (res.error) return sendMultiError(res.error);
    if (room.challenge) room.challenge.moves++;
    broadcastMultiState(room);
    driveBots(room);
  });

  socket.on('multiTakeCards', () => {
    const room = activeRoom();
    if (!room) return;
    const username = effectiveUsername();
    if (room.game.status === 'active' && isAvoidableTake(room.game, username)) {
      room.avoidableTakes = room.avoidableTakes || {};
      room.avoidableTakes[username] = (room.avoidableTakes[username] || 0) + 1;
    }
    const res = room.game.takeCards(username);
    if (res.error) return sendMultiError(res.error);
    if (room.challenge) room.challenge.moves++;
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
    room.endReason = 'surrender';
    broadcastMultiState(room);
    clearMultiMoveTimer(room);
    recordMultiGameHistory(room);
    scheduleMultiCleanup(room);
  });

  // A player leaves a room: by the "leave" button or by closing the page. Both end the same way —
  // a waiting room gives the seat back (or is cancelled when its creator leaves), and a running game
  // the player is still in ends as their loss. Before, the button only detached the player, so the
  // game kept running with nobody there ("plays against the computer" stuck on the front page) and a
  // left waiting room kept the seat taken.
  function leaveRoom(room, reason) {
    const username = effectiveUsername();
    if (room.status === 'waiting') {
      room.humans = room.humans.filter((h) => h.socketId !== socket.id && h.username !== username);
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
    if (!room.game.activePlayers.includes(username)) {
      // already safe (won, or finished ahead of the durak): the others play on without them
      room.humans = room.humans.filter((h) => h.username !== username);
      return;
    }
    room.game.status = 'finished';
    room.game.durakId = username;
    room.game.log.push(`${username} pameta spēli`);
    room.endReason = reason;
    clearMultiMoveTimer(room);
    if (room.botTimer) clearTimeout(room.botTimer);
    broadcastMultiState(room);
    recordMultiGameHistory(room);
    scheduleMultiCleanup(room);
  }

  socket.on('multiLeaveRoom', () => {
    const room = currentRoom();
    if (room) {
      leaveRoom(room, 'surrender');
      socket.leave(room.code);
      socket.join(MULTI_LOBBY_ROOM);
    }
    multiJoinedCode = null;
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (room) leaveRoom(room, 'disconnect');
  });
};

/**
 * A tournament game on the same round table as every other game (2 players: two people, or one person
 * against the computer). Started straight away; each player's page then joins it with
 * 'joinMultiTournament' (the server tells it to with 'tournamentGameStarting'). The result goes back
 * to the tournament through onTournamentResult. Returns the room code, or null if no connection has
 * set up the room functions yet.
 */
module.exports.createTournamentRoom = function createTournamentRoom({ humans, vsBot, deckSize, tournamentMatch }) {
  if (!roomOps) return null;
  const code = makeMultiRoomCode();
  const room = {
    code,
    status: 'waiting',
    hidden: true,
    createdAt: Date.now(),
    totalPlayers: 2,
    aiCount: vsBot ? 1 : 0,
    deckSize: deckSize === 36 ? 36 : 52,
    ranked: false,
    allowTransfer: false,
    humanSlotsNeeded: humans.length,
    creatorUsername: humans[0].username,
    isPrivate: true,
    password: null,
    humans: humans.map((h) => ({ username: h.username, socketId: h.socketId, connected: true })),
    bots: [],
    game: null,
    moveTimer: null,
    botTimer: null,
    cleanupTimer: null,
    tournamentMatch,
  };
  multiRooms.set(code, room);
  return code;
};
module.exports.startTournamentRoom = function startTournamentRoom(code) {
  const room = multiRooms.get(code);
  if (!room || !roomOps || room.game) return false;
  roomOps.startMultiRoomGame(room);
  return true;
};

// Games being played right now, for the front page's map (platform/world.js).
module.exports.listActive = function listActive() {
  return Array.from(multiRooms.values())
    .filter((r) => r.game && r.game.status === 'active')
    .map((r) => ({ id: r.code, players: r.humans.map((h) => h.username), vsBot: r.bots.length > 0 }));
};

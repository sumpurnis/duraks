'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game } = require('./server/game');
const users = require('./server/users');
const { chooseMove } = require('./server/ai');
const tournaments = require('./server/tournament/store');
const { generateBracket } = require('./server/tournament/bracket-generator');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MOVE_TIMEOUT_MS = 60000;
const DISCONNECT_GRACE_MS = 30000;
const ROOM_CLEANUP_MS = 5 * 60 * 1000;
const LOBBY_ROOM = 'lobby';
const AI_ID = 'Dators 🤖';
const ADMIN_USERNAME = 'zivs';
const AI_MOVE_DELAY_MS = [500, 1100]; // randomized range, feels less instant/robotic

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
  if (room.vsAI) return;
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

/** Scans a tournament's bracket for any match that's ready to play (both
 *  sides resolved, not yet started or already finished) where one side is
 *  human and the other a bot, and immediately starts it. Human-vs-human
 *  matches are deliberately left alone — auto-starting those needs both
 *  players online at once, which isn't wired up yet. Bot-vs-bot matches
 *  (possible deeper in the bracket) are also left alone for the same
 *  reason — there's no human to trigger them. */
/** Scans a tournament's bracket for any match that's ready to play (both
 *  sides resolved, not yet started or already finished):
 *   - human vs bot -> starts a real game against the AI
 *   - bot vs bot -> no human to play it out, so it's resolved instantly
 *     with a random winner (no game simulated) — this can cascade (the
 *     newly-freed slot might make another match ready), so this loops
 *     until a full pass makes no further progress
 *   - human vs human -> left alone; auto-starting those needs both
 *     players online at once, which isn't wired up yet
 */
/** Scans a tournament's bracket for any match that's ready to play (both
 *  sides resolved, not yet started or already finished). If either side is
 *  a bot — bot vs bot, or human vs bot — it's resolved instantly with a
 *  random winner, no game played at all. This can cascade (the newly-freed
 *  slot might make another match ready), so this loops until a full pass
 *  makes no further progress. Human-vs-human matches are left alone —
 *  auto-starting those needs both players online at once, which isn't
 *  wired up yet. */
/** Scans a tournament's bracket for any match that's ready to play (both
 *  sides resolved, not yet started or already finished):
 *   - bot vs bot -> no human involved, resolved instantly with a random
 *     winner, no game played. Can cascade (the newly-freed slot might make
 *     another match ready), so this loops until a full pass makes no
 *     further progress.
 *   - human vs bot -> a real game is played out in full against the AI,
 *     exactly as it would be against a human opponent.
 *   - human vs human -> left alone; auto-starting those needs both
 *     players online at once, which isn't wired up yet.
 */
function autoStartReadyBotMatches(tournamentId) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const t = tournaments.getTournament(tournamentId);
    if (!t || !t.bracket) return;
    for (const match of t.bracket.allMatches) {
      if (match.status === 'completed' || match.status === 'in_progress') continue;
      if (!match.player1 || !match.player2) continue;

      if (isBotParticipant(match.player1) && isBotParticipant(match.player2)) {
        tournaments.autoResolveMatchRandomly(tournamentId, match.id);
        io.to(LOBBY_ROOM).emit('tournamentUpdated', { id: tournamentId });
        progressed = true;
        continue;
      }

      const humanUsername = [match.player1, match.player2].find((p) => !isBotParticipant(p));
      const botUsername = [match.player1, match.player2].find((p) => isBotParticipant(p));
      if (!humanUsername || !botUsername) continue; // human vs human, not auto-started
      startTournamentGameForHuman(humanUsername, tournamentId, match.id);
      // Not marked as "progressed" — starting a game doesn't complete a
      // match by itself, so it can't cascade further within this loop.
    }
  }
}

function recordNormalResult(room) {
  if (room.statsRecorded) return;
  room.statsRecorded = true;
  if (!room.vsAI) {
    users.recordGameCompleted();
    const { winnerId, durakId, draw } = room.game;
    if (!draw) {
      if (winnerId) users.recordResult(winnerId, true, false);
      if (durakId) users.recordResult(durakId, false, false);
    }
    broadcastLeaderboards();
  }
  handleTournamentGameResult(room, room.game.winnerId);
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
    if (!room.vsAI) {
      users.recordGameCompleted();
      if (winnerUsername) users.recordResult(winnerUsername, true, true);
      users.recordResult(loserUsername, false, true);
      broadcastLeaderboards();
    }
    handleTournamentGameResult(room, winnerUsername);
  }

  clearMoveTimer(room);
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.endReason = reason;
  broadcastState(room.code);
  scheduleRoomCleanup(room);
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => rooms.delete(room.code), ROOM_CLEANUP_MS);
}

function getTournamentInfoForRoom(room) {
  if (!room.tournamentMatch) return null;
  const { tournamentId, matchId } = room.tournamentMatch;
  const t = tournaments.getTournament(tournamentId);
  const match = t && t.bracket && tournaments.findMatch(t, matchId);
  if (!t || !match) return null;

  const roundsTotal = t.bracket.rounds.length;
  const roundLabel = match.isThirdPlaceMatch
    ? '3. vietas spēle'
    : match.roundNumber === roundsTotal ? 'Fināls' : `${match.roundNumber}. kārta`;

  return {
    tournamentId: t.id,
    tournamentName: t.name,
    roundLabel,
    player1: match.player1,
    player2: match.player2,
    player1Wins: match.player1Wins,
    player2Wins: match.player2Wins,
    requiredWins: match.requiredWins,
  };
}

function broadcastState(code) {
  const room = rooms.get(code);
  if (!room || !room.game) return;
  const names = namesFor(room);
  const tournamentInfo = getTournamentInfoForRoom(room);
  for (const p of room.players) {
    if (!p.connected) continue;
    const view = room.game.viewFor(p.username);
    io.to(p.socketId).emit('state', {
      ...view,
      names,
      endReason: room.endReason || null,
      tournamentInfo,
    });
  }
  armMoveTimer(code);
}

// ---------- Tournament match <-> real game wiring ----------
// A tournament bracket match is a Bo3/Bo5 series, not a single game — this
// section starts the next game in that series (auto-starting it whenever
// the opponent is a bot, since that side never needs to "be online") and
// feeds finished games' results back into the series score. A forfeit or
// loss here only ever costs the series score one point, never the whole
// series — see handleTournamentGameResult below.

function isBotParticipant(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('Bots-');
}

/** Creates a real Duraks room for `humanUsername` against the AI, tagged
 *  with which tournament series it belongs to. Reuses the exact same AI
 *  opponent as the normal "Spēlēt pret datoru" button — the bracket's
 *  fabricated bot name is just bookkeeping for seeding/placement, the
 *  actual opponent in-game is always the one AI. */
function startTournamentGameForHuman(humanUsername, tournamentId, matchId) {
  const socketId = userSockets.get(humanUsername);
  if (!socketId) return false; // human isn't currently connected — can't push them into a game
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return false;

  const code = makeRoomCode();
  rooms.set(code, {
    code,
    createdAt: Date.now(),
    players: [
      { username: humanUsername, socketId: socket.id, connected: true },
      { username: AI_ID, socketId: null, connected: false },
    ],
    game: null,
    timer: null,
    aiTimer: null,
    turnToken: 0,
    rematchVotes: {},
    statsRecorded: false,
    endReason: null,
    vsAI: true,
    tournamentMatch: { tournamentId, matchId },
  });
  const room = rooms.get(code);
  room.game = new Game(room.players.map((p) => p.username));
  maybeTriggerAI(room); // in case the AI goes first
  tournaments.markMatchInProgress(tournamentId, matchId);

  // Tell the client which room to join — the client re-emits 'joinRoom',
  // which is what actually sets joinedCode/playerId correctly (those are
  // local to that connection's own closure, unreachable from here).
  socket.emit('tournamentGameStarting', { code, vsBot: true });
  return true;
}

/** Creates a real Duraks room between two humans for a tournament match,
 *  pushing both into it at once. Both players must currently be connected
 *  — this is the "auto-create when it's tournament time and both paired
 *  players are online" behavior from the original spec, triggered here by
 *  either player clicking "Sākt spēli" once their opponent is known. */
function startTournamentGameForHumans(player1Username, player2Username, tournamentId, matchId) {
  const socket1Id = userSockets.get(player1Username);
  const socket2Id = userSockets.get(player2Username);
  if (!socket1Id || !socket2Id) return false;
  const socket1 = io.sockets.sockets.get(socket1Id);
  const socket2 = io.sockets.sockets.get(socket2Id);
  if (!socket1 || !socket2) return false;

  const code = makeRoomCode();
  rooms.set(code, {
    code,
    createdAt: Date.now(),
    players: [
      { username: player1Username, socketId: socket1.id, connected: true },
      { username: player2Username, socketId: socket2.id, connected: true },
    ],
    game: null,
    timer: null,
    turnToken: 0,
    rematchVotes: {},
    statsRecorded: false,
    endReason: null,
    tournamentMatch: { tournamentId, matchId },
  });
  const room = rooms.get(code);
  room.game = new Game(room.players.map((p) => p.username));
  tournaments.markMatchInProgress(tournamentId, matchId);

  socket1.emit('tournamentGameStarting', { code, vsBot: false });
  socket2.emit('tournamentGameStarting', { code, vsBot: false });
  return true;
}

/** Called after any game finishes (normal win or forfeit) that was tagged
 *  as part of a tournament series. No-ops instantly for ordinary games. */
function handleTournamentGameResult(room, winnerUsername) {
  if (!room.tournamentMatch || !winnerUsername) return;
  const { tournamentId, matchId } = room.tournamentMatch;

  // The AI plays under AI_ID in-game, but the bracket bookkeeping uses
  // whichever fabricated bot name originally filled that slot — translate
  // an AI win back into "the bot side of this match won".
  const t = tournaments.getTournament(tournamentId);
  const match = t && tournaments.findMatch(t, matchId);
  if (!match) return;
  const seriesWinnerId = winnerUsername === AI_ID
    ? (isBotParticipant(match.player1) ? match.player1 : match.player2)
    : winnerUsername;

  let updated;
  try {
    updated = tournaments.recordSeriesGameResult(tournamentId, matchId, seriesWinnerId, room.code);
  } catch (err) {
    console.error('Failed to record tournament series result:', err.message);
    return;
  }

  io.to(LOBBY_ROOM).emit('tournamentUpdated', { id: tournamentId });

  if (!updated.seriesComplete) {
    // Bo3/Bo5 auto-continue: immediately start the next game in the series.
    const humanUsername = [match.player1, match.player2].find((p) => !isBotParticipant(p));
    if (humanUsername) startTournamentGameForHuman(humanUsername, tournamentId, matchId);
  } else {
    autoStartReadyBotMatches(tournamentId);
  }
}

// ---------- AI opponent ("Spēlēt pret datoru") ----------

function maybeTriggerAI(room) {
  if (!room.vsAI || !room.game || room.game.status !== 'active') return;
  const pending = room.game.pendingActor();
  if (!pending || pending.playerId !== AI_ID) return;

  const delay = AI_MOVE_DELAY_MS[0] + Math.random() * (AI_MOVE_DELAY_MS[1] - AI_MOVE_DELAY_MS[0]);
  room.aiTimer = setTimeout(() => performAIMove(room.code), delay);
}

function performAIMove(code) {
  const room = rooms.get(code);
  if (!room || !room.game || room.game.status !== 'active') return;

  const move = chooseMove(room.game, AI_ID);
  if (!move) return;

  let result;
  if (move.type === 'attack') result = room.game.attack(AI_ID, move.cardId);
  else if (move.type === 'defend') result = room.game.defend(AI_ID, move.cardId, move.slotIndex);
  else if (move.type === 'pass') result = room.game.passTurn(AI_ID);
  else if (move.type === 'take') result = room.game.takeCards(AI_ID);
  if (!result || result.error) return; // shouldn't happen — AI only picks legal moves

  finishIfGameOver(room);
  broadcastState(code);
  maybeTriggerAI(room); // AI may owe another action (e.g. defend a second open slot)
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

function broadcastLeaderboards() {
  io.to(LOBBY_ROOM).emit('leaderboardsData', users.getLeaderboards());
}

// ---------- Tournaments (kept in server/tournament/, deliberately separate
// from the game engine — this section is just the socket glue) ----------

const TOURNAMENT_SWEEP_MS = 20000;

function serializeTournament(t, forUsername) {
  const isMember = t.createdBy === forUsername || t.hasJoined(forUsername);
  return {
    id: t.id,
    name: t.name,
    createdBy: t.createdBy,
    isPrivate: t.isPrivate,
    // Only members (creator or joined participants) get to see/re-share the code.
    inviteCode: isMember ? t.inviteCode : null,
    requiredRank: t.requiredRank,
    maxParticipants: t.maxParticipants,
    minParticipants: t.minParticipants,
    seriesFormat: t.seriesFormat,
    registrationEndTime: t.registrationEndTime.toISOString(),
    startTime: t.startTime.toISOString(),
    status: t.status,
    cancelReason: t.cancelReason || null,
    participants: t.participants.map((p) => ({ playerId: p.playerId, joinedAt: p.joinedAt })),
    participantCount: t.participants.length,
    bracket: t.bracket,
    isRegistrationOpen: t.isRegistrationOpen(),
    hasJoined: t.hasJoined(forUsername),
    isCreator: t.createdBy === forUsername,
    isAdmin: forUsername === ADMIN_USERNAME,
    // Prize pool is intentionally omitted from the client payload — feature
    // is built server-side (server/tournament/prize-pool.js) but stays
    // invisible in the UI for now, per current product decision.
  };
}

function sendTournamentsTo(socket, forUsername) {
  socket.emit('tournamentsData', tournaments.listForUser(forUsername).map((t) => serializeTournament(t, forUsername)));
}

// Sweeps for tournaments whose registration window has passed: generates
// the bracket if the minimum was met, otherwise cancels it. This covers the
// "automatically once it's tournament time" half of the original spec —
// automatically creating the underlying Duraks game rooms for round-1
// matches once both paired players are online is the next phase, not yet
// wired here (see chat reply).
setInterval(() => {
  const due = tournaments
    .listAll()
    .filter((t) => t.status === 'registration' && Date.now() >= t.registrationEndTime.getTime());
  for (const t of due) {
    try {
      if (t.canGenerateBracket()) {
        tournaments.closeRegistrationAndGenerateBracket(t.id, generateBracket);
        autoStartReadyBotMatches(t.id);
      } else {
        tournaments.cancelTournament(t.id, 'not_enough_participants');
      }
    } catch (err) {
      console.error('Tournament auto-close failed for', t.id, err.message);
    }
  }
}, TOURNAMENT_SWEEP_MS);

// Testing helper: lets a tournament creator fill remaining slots with fake
// bot participants (varied fabricated stats) instead of needing multiple
// real accounts to test the create -> register -> close -> bracket flow.
const BOT_NAME_POOL = [
  'Bots-Rūdis', 'Bots-Kārlis', 'Bots-Mirdza', 'Bots-Jānis', 'Bots-Liene',
  'Bots-Pēteris', 'Bots-Inese', 'Bots-Andris', 'Bots-Zane', 'Bots-Uldis',
  'Bots-Gunārs', 'Bots-Sarmīte', 'Bots-Valdis', 'Bots-Ilze', 'Bots-Māris',
];

function makeBotParticipant(index) {
  const name = BOT_NAME_POOL[index % BOT_NAME_POOL.length] + (index >= BOT_NAME_POOL.length ? `-${index}` : '');
  const hasRecord = Math.random() > 0.3;
  const gamesPlayed = hasRecord ? Math.floor(Math.random() * 40) + 1 : 0;
  const winRate = hasRecord ? Math.random() : null;
  const won = hasRecord ? Math.round(gamesPlayed * winRate) : 0;
  return {
    id: name,
    rating: tournaments.statsToRating({ played: gamesPlayed, won }),
    gamesPlayed,
    winRate,
  };
}

// Tracks each logged-in user's current live socket, so server-initiated
// actions (like auto-starting the next game in a tournament series) can
// reach the right client without that client having asked first.
const userSockets = new Map();

io.on('connection', (socket) => {
  let joinedCode = null;
  let playerId = null; // == username once authenticated
  let username = null;

  function onAuthenticated(rec) {
    username = rec.username;
    userSockets.set(username, socket.id);
    socket.join(LOBBY_ROOM);
    socket.emit('registered', rec);
    socket.emit('openRoomsUpdated', listOpenRooms());
    socket.emit('leaderboardsData', users.getLeaderboards());
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

  // ---------- Tournaments ----------

  socket.on('listTournaments', () => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    sendTournamentsTo(socket, username);
  });

  socket.on('createTournament', (config) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const stats = users.getStats(username);
    if (!tournaments.canCreateTournament(stats)) {
      return sendError(
        socket,
        `Lai izveidotu turnīru, nepieciešams nospēlēt vismaz ${tournaments.MIN_GAMES_TO_CREATE} spēles`
      );
    }
    try {
      const name = String(config && config.name || '').trim().slice(0, 60);
      if (!name) return sendError(socket, 'Turnīra nosaukums nedrīkst būt tukšs');

      const maxParticipants = parseInt(config && config.maxParticipants, 10);
      if (!Number.isInteger(maxParticipants) || maxParticipants < tournaments.ABSOLUTE_MIN_PARTICIPANTS) {
        return sendError(socket, `Maksimālajam dalībnieku skaitam jābūt vismaz ${tournaments.ABSOLUTE_MIN_PARTICIPANTS}`);
      }

      const registrationEndTime = new Date(config && config.registrationEndTime);
      const startTime = new Date(config && config.startTime);
      if (isNaN(registrationEndTime.getTime()) || registrationEndTime.getTime() <= Date.now()) {
        return sendError(socket, 'Reģistrācijas beigu laikam jābūt nākotnē');
      }
      if (isNaN(startTime.getTime()) || startTime.getTime() < registrationEndTime.getTime()) {
        return sendError(socket, 'Turnīra sākuma laikam jābūt vēlākam vai vienādam ar reģistrācijas beigu laiku');
      }

      const isPrivate = !!(config && config.isPrivate);
      const seriesFormat = config && config.seriesFormat === 'bo5' ? 'bo5' : 'bo3';

      const t = tournaments.createTournament({
        name,
        createdBy: username,
        isPrivate,
        maxParticipants,
        // minParticipants intentionally omitted — always defaults to the
        // fixed floor of 3 (ABSOLUTE_MIN_PARTICIPANTS), not organizer-set.
        seriesFormat,
        registrationEndTime,
        startTime,
      });
      // The organizer is a competitor too by default, not just an admin —
      // this also matters for the bot-fill testing flow to make sense at
      // all (a tournament with no human participant has nobody to auto-start
      // a bot match against).
      const creatorPlayer = {
        id: username,
        rating: tournaments.statsToRating(stats),
        gamesPlayed: stats ? stats.played : 0,
        winRate: stats && stats.played > 0 ? stats.won / stats.played : null,
      };
      tournaments.joinTournament(t.id, creatorPlayer);
      socket.emit('tournamentCreated', serializeTournament(t, username));
      sendTournamentsTo(socket, username);
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id: t.id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('joinTournament', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    try {
      const stats = users.getStats(username);
      const player = { id: username, rating: tournaments.statsToRating(stats), gamesPlayed: stats ? stats.played : 0, winRate: stats && stats.played > 0 ? stats.won / stats.played : null };
      const t = tournaments.joinTournament(id, player);
      sendTournamentsTo(socket, username);
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id: t.id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('joinTournamentByCode', ({ code }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournamentByInviteCode(code);
    if (!t) return sendError(socket, 'Nav atrasts turnīrs ar šādu ielūguma kodu');
    try {
      const stats = users.getStats(username);
      const player = { id: username, rating: tournaments.statsToRating(stats), gamesPlayed: stats ? stats.played : 0, winRate: stats && stats.played > 0 ? stats.won / stats.played : null };
      tournaments.joinTournament(t.id, player);
      sendTournamentsTo(socket, username);
      socket.emit('tournamentDetail', serializeTournament(tournaments.getTournament(t.id), username));
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id: t.id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('leaveTournament', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    try {
      tournaments.leaveTournament(id, username);
      sendTournamentsTo(socket, username);
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('fillTournamentWithBots', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournament(id);
    if (!t) return sendError(socket, 'Turnīrs nav atrasts');
    if (t.createdBy !== username) return sendError(socket, 'Tikai organizators var pievienot botus');
    if (t.status !== 'registration') return sendError(socket, 'Reģistrācija vairs nav atvērta');
    try {
      let botIndex = 0;
      let guard = 0;
      while (t.participants.length < t.maxParticipants && guard < 500) {
        guard++;
        const bot = makeBotParticipant(botIndex++);
        if (t.hasJoined(bot.id)) continue; // extremely unlikely name collision, just skip and try the next
        tournaments.joinTournament(id, bot);
      }
      sendTournamentsTo(socket, username);
      socket.emit('tournamentDetail', serializeTournament(tournaments.getTournament(id), username));
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('leaveTournamentMidway', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournament(id);
    if (!t) return sendError(socket, 'Turnīrs nav atrasts');
    if (t.status !== 'active') return sendError(socket, 'Turnīrs vairs nav aktīvs');
    if (!t.bracket) return sendError(socket, 'Šim turnīram vēl nav izspēles');
    tournaments.withdrawFromTournament(id, username);
    sendTournamentsTo(socket, username);
    io.to(LOBBY_ROOM).emit('tournamentUpdated', { id });
    io.to(LOBBY_ROOM).emit('tournamentPlayerWithdrew', { id, username, tournamentName: t.name });
    autoStartReadyBotMatches(id); // withdrawal may have just freed up a bot-involved match
  });

  socket.on('startTournamentMatch', ({ id, matchId }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournament(id);
    if (!t || !t.bracket) return sendError(socket, 'Turnīrs nav atrasts');
    const match = tournaments.findMatch(t, matchId);
    if (!match) return sendError(socket, 'Mačs nav atrasts');
    if (match.status === 'completed' || match.status === 'in_progress') {
      return sendError(socket, 'Šis mačs jau ir sācies vai pabeigts');
    }
    if (!match.player1 || !match.player2) return sendError(socket, 'Pretinieks vēl nav zināms');
    if (match.player1 !== username && match.player2 !== username) {
      return sendError(socket, 'Tu neesi šī mača dalībnieks');
    }

    const opponent = match.player1 === username ? match.player2 : match.player1;
    if (isBotParticipant(opponent)) {
      // Bots resolve on their own via autoStartReadyBotMatches — this
      // button shouldn't normally be reachable for a bot match, but handle
      // it gracefully just in case the client's view was stale.
      startTournamentGameForHuman(username, id, matchId);
      return;
    }
    if (!userSockets.has(opponent)) {
      return sendError(socket, `${opponent} vēl nav tiešsaistē — uzgaidi, kamēr viņš/viņa ienāk spēlē`);
    }

    const started = startTournamentGameForHumans(match.player1, match.player2, id, matchId);
    if (!started) return sendError(socket, 'Neizdevās sākt spēli — pamēģini vēlreiz');
    io.to(LOBBY_ROOM).emit('tournamentUpdated', { id });
  });

  socket.on('closeTournamentRegistration', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournament(id);
    if (!t) return sendError(socket, 'Turnīrs nav atrasts');
    if (t.createdBy !== username) return sendError(socket, 'Tikai organizators var slēgt reģistrāciju');
    try {
      tournaments.closeRegistrationAndGenerateBracket(id, generateBracket);
      autoStartReadyBotMatches(id);
      sendTournamentsTo(socket, username);
      io.to(LOBBY_ROOM).emit('tournamentUpdated', { id });
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on('getTournamentDetail', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const t = tournaments.getTournament(id);
    if (!t) return sendError(socket, 'Turnīrs nav atrasts');
    if (t.isPrivate && t.createdBy !== username && !t.hasJoined(username)) {
      return sendError(socket, 'Šis ir privāts turnīrs');
    }
    socket.emit('tournamentDetail', serializeTournament(t, username));
  });

  socket.on('getTournamentResults', () => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    socket.emit('tournamentResultsData', tournaments.getTournamentResults(username));
  });

  socket.on('deleteTournament', ({ id }) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    if (username !== ADMIN_USERNAME) return sendError(socket, 'Tikai administrators var dzēst turnīrus');
    const existed = tournaments.deleteTournament(id);
    if (!existed) return sendError(socket, 'Turnīrs nav atrasts');
    sendTournamentsTo(socket, username);
    io.to(LOBBY_ROOM).emit('tournamentUpdated', { id, deleted: true });
  });

  socket.on('deleteAllCompletedTournaments', () => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    if (username !== ADMIN_USERNAME) return sendError(socket, 'Tikai administrators var dzēst turnīrus');
    const count = tournaments.deleteAllCompleted();
    sendTournamentsTo(socket, username);
    socket.emit('adminBulkDeleteResult', { count });
    io.to(LOBBY_ROOM).emit('tournamentUpdated', { bulkDeleted: true });
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

  socket.on('playVsAI', () => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const code = makeRoomCode();
    playerId = username;
    joinedCode = code;
    rooms.set(code, {
      code,
      createdAt: Date.now(),
      players: [
        { username, socketId: socket.id, connected: true },
        { username: AI_ID, socketId: null, connected: false },
      ],
      game: null,
      timer: null,
      aiTimer: null,
      turnToken: 0,
      rematchVotes: {},
      statsRecorded: false,
      endReason: null,
      vsAI: true,
    });
    const room = rooms.get(code);
    socket.join(code);
    socket.leave(LOBBY_ROOM);

    room.game = new Game(room.players.map((p) => p.username));
    socket.emit('gameStarted', { names: namesFor(room) });
    broadcastState(code);
    maybeTriggerAI(room);
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

  socket.on('getLeaderboards', () => {
    socket.emit('leaderboardsData', users.getLeaderboards());
  });

  socket.on('attack', ({ cardId }) => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.attack(playerId, cardId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
    maybeTriggerAI(room);
  });

  socket.on('defend', ({ cardId, slotIndex }) => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.defend(playerId, cardId, slotIndex);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
    maybeTriggerAI(room);
  });

  socket.on('passTurn', () => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.passTurn(playerId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
    maybeTriggerAI(room);
  });

  socket.on('takeCards', () => {
    const room = rooms.get(joinedCode);
    if (!room || !room.game) return;
    const result = room.game.takeCards(playerId);
    if (result.error) return sendError(socket, result.error);
    finishIfGameOver(room);
    broadcastState(joinedCode);
    maybeTriggerAI(room);
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
      if (room.aiTimer) clearTimeout(room.aiTimer);
      rooms.delete(room.code);
      broadcastOpenRooms();
      return;
    }

    if (room.vsAI) {
      startRematch(room);
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
    if (username && userSockets.get(username) === socket.id) userSockets.delete(username);
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
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.rematchVotes = {};
  room.statsRecorded = false;
  room.endReason = null;
  room.game = new Game(room.players.map((p) => p.username));
  io.to(room.code).emit('gameStarted', { names: namesFor(room) });
  broadcastState(room.code);
  maybeTriggerAI(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Duraks MVP running at http://localhost:${PORT}`);
});

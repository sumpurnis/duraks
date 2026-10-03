'use strict';
/**
 * Rooms for Meļi: a room is either a human-vs-computer game (starts at once) or a human-vs-human
 * game (waits for a second player). Seat index == engine player index.
 *
 *  - Server is authoritative; each human only ever receives their own view.
 *  - Reconnect: every seat has a secret token; a dropped player has `graceMs` to come back.
 *  - Human-vs-human games have a per-turn timer; running out of time forfeits.
 *  - Rematch needs both players to agree (computer games restart at once).
 */
const crypto = require('node:crypto');
const { MeliGame, RuleError } = require('./engine');
const ai = require('./ai');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const randomString = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
// Announcement versions players may pick. 'suit-rank' is implemented but switched off for now.
const ANNOUNCE_ENABLED = ['suit'];
const HAND_SIZES = new Set([12, 26]); // cards each: 24-card game (9 to Ace) or 52-card game (whole deck);
const AI_SEAT = 1;

class RoomError extends RuleError {
  constructor(message, code, roomCode) {
    super(message);
    this.code = code;
    this.roomCode = roomCode;
  }
}

const DEFAULT_CFG = {
  aiDelay: 1100, // ms the computer "thinks"
  revealPause: 2600, // ms the computer waits after a reveal before moving
  turnMs: 60000, // human-vs-human move limit
  graceMs: 30000, // time a dropped player has to reconnect
  finishedTtlMs: 10 * 60000, // how long a finished room stays for rematch
  maxRooms: 500,
  rng: Math.random,
};

class RoomManager {
  constructor(io, cfg = {}) {
    this.io = io;
    this.cfg = { ...DEFAULT_CFG, ...cfg };
    this.rooms = new Map(); // code -> room
    this.bySocket = new Map(); // socket.id -> { code, seat }
  }

  // ------------------------------------------------------------------ helpers

  cleanName(name) {
    const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '';
    return s || `Viesis-${1000 + Math.floor(Math.random() * 9000)}`;
  }

  makeSeat(socket, name, account = false) {
    return {
      ai: false,
      account: !!account,
      name: this.cleanName(name),
      token: crypto.randomBytes(16).toString('hex'),
      socketId: socket.id,
      connected: true,
      left: false,
      dropTimer: null,
    };
  }

  lookup(socket) {
    const ref = this.bySocket.get(socket.id);
    const room = ref && this.rooms.get(ref.code);
    if (!room) {
      if (ref) this.bySocket.delete(socket.id);
      throw new RoomError('You are not in a game.', 'none');
    }
    return { room, idx: ref.seat };
  }

  assertFree(socket) {
    const ref = this.bySocket.get(socket.id);
    if (!ref) return;
    const room = this.rooms.get(ref.code);
    if (room && room.status === 'over') this.leave(socket, true); // a finished game never blocks a new one
    else if (room) throw new RoomError('You are already in a game. Leave it first.', 'busy');
    else this.bySocket.delete(socket.id);
  }

  emitSeat(room, idx, event, payload) {
    const s = room.seats[idx];
    if (s && !s.ai && s.connected && s.socketId) this.io.to(s.socketId).emit(event, payload);
  }

  emitHumans(room, event, payload) {
    room.seats.forEach((_, i) => this.emitSeat(room, i, event, payload));
  }

  joinedPayload(room, idx) {
    return {
      code: room.code,
      token: room.seats[idx].token,
      seat: idx,
      status: room.status,
      vsAI: room.vsAI,
      password: idx === 0 ? room.password : null,
      announce: room.announce,
      handSize: room.handSize,
    };
  }

  viewFor(room, idx) {
    const g = room.game;
    const me = room.seats[idx];
    const opp = room.seats[1 - idx];
    const turnMs = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
    return {
      ...g.view(idx),
      room: {
        code: room.code,
        status: room.status,
        vsAI: room.vsAI,
        private: !!room.password,
        handSize: room.handSize,
        myName: me.name,
        opp: opp ? { name: opp.name, ai: !!opp.ai, connected: !!opp.connected, left: !!opp.left } : null,
        turnMs,
        endDetail: room.endDetail,
        rematch: { you: !!room.rematch[idx], opp: !!room.rematch[1 - idx] },
      },
    };
  }

  broadcast(room) {
    room.seats.forEach((s, i) => {
      if (s && !s.ai && s.connected) this.emitSeat(room, i, 'state', this.viewFor(room, i));
    });
  }

  // ------------------------------------------------------------------ lobby

  listOpen() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.status !== 'waiting' || room.vsAI || !room.seats[0].connected) continue;
      out.push({
        code: room.code,
        host: room.seats[0].name,
        announce: room.announce,
        handSize: room.handSize,
        private: !!room.password,
      });
    }
    return out;
  }

  publishLobby() {
    this.io.to('lobby').emit('rooms', this.listOpen());
  }

  // ------------------------------------------------------------------ create / join / leave

  create(socket, msg = {}) {
    this.assertFree(socket);
    if (this.rooms.size >= this.cfg.maxRooms) throw new RoomError('The server is full. Try again later.', 'full');

    const vsAI = !!msg.vsAI;
    const code = (() => {
      let c;
      do c = randomString(5);
      while (this.rooms.has(c));
      return c;
    })();

    const room = {
      code,
      vsAI,
      announce: ANNOUNCE_ENABLED.includes(msg.announce) ? msg.announce : 'suit',
      handSize: HAND_SIZES.has(Number(msg.handSize)) ? Number(msg.handSize) : 12,
      password: !vsAI && msg.private ? randomString(6) : null,
      seats: [this.makeSeat(socket, msg.name, msg.account), null],
      game: null,
      status: 'waiting',
      endDetail: null,
      rematch: [false, false],
      turnDeadline: null,
      turnTimer: null,
      aiTimer: null,
      cleanupTimer: null,
    };
    this.rooms.set(code, room);
    this.bySocket.set(socket.id, { code, seat: 0 });
    socket.emit('room:joined', this.joinedPayload(room, 0));

    if (vsAI) {
      room.seats[1] = { ai: true, name: 'Dators', token: null, socketId: null, connected: true, left: false, dropTimer: null };
      this.startGame(room);
    }
    this.publishLobby();
  }

  join(socket, msg = {}) {
    const code = String(msg.code || '').trim().toUpperCase().slice(0, 8);
    const room = this.rooms.get(code);
    if (!room || room.status !== 'waiting' || room.vsAI) throw new RoomError('That game is no longer open.', 'gone');
    this.assertFree(socket);
    if (!room.seats[0].connected) throw new RoomError('The host is reconnecting. Try again in a moment.', 'busy');

    if (room.password) {
      if (msg.password === undefined || msg.password === null || msg.password === '') {
        throw new RoomError('This game is private. Enter its password.', 'password', code);
      }
      if (String(msg.password).trim().toUpperCase() !== room.password) {
        throw new RoomError('Wrong password.', 'password-wrong', code);
      }
    }

    room.seats[1] = this.makeSeat(socket, msg.name, msg.account);
    this.bySocket.set(socket.id, { code, seat: 1 });
    socket.emit('room:joined', this.joinedPayload(room, 1));
    this.startGame(room);
    this.publishLobby();
  }

  /** Voluntary leave. Mid-game this is a forfeit. */
  leave(socket, silent = false) {
    const { room, idx } = this.lookup(socket);
    const seat = room.seats[idx];

    if (room.status === 'playing') {
      if (room.vsAI) {
        this.destroy(room);
      } else {
        this.forfeit(room, idx, 'left');
      }
    }
    if (this.rooms.has(room.code)) {
      if (room.status === 'waiting') {
        this.destroy(room);
      } else {
        seat.left = true;
        clearTimeout(seat.dropTimer);
        this.bySocket.delete(socket.id);
        seat.socketId = null;
        seat.connected = false;
        if (room.seats.every((s) => !s || s.ai || s.left)) this.destroy(room);
        else this.broadcast(room);
      }
    }
    this.bySocket.delete(socket.id);
    if (!silent) socket.emit('room:left');
    this.publishLobby();
  }

  disconnect(socket) {
    const ref = this.bySocket.get(socket.id);
    if (!ref) return;
    const room = this.rooms.get(ref.code);
    this.bySocket.delete(socket.id);
    if (!room) return;
    const seat = room.seats[ref.seat];
    if (!seat || seat.socketId !== socket.id) return; // already replaced by a resume

    seat.connected = false;
    seat.socketId = null;
    clearTimeout(seat.dropTimer);
    seat.dropTimer = setTimeout(() => this.dropExpired(room, ref.seat), this.cfg.graceMs);
    this.broadcast(room);
    this.publishLobby();
  }

  dropExpired(room, idx) {
    const seat = room.seats[idx];
    if (!this.rooms.has(room.code) || !seat || seat.connected) return;
    if (room.status === 'waiting' || (room.status === 'playing' && room.vsAI)) {
      this.destroy(room);
    } else if (room.status === 'playing') {
      this.forfeit(room, idx, 'disconnect');
      seat.left = true;
    } else {
      seat.left = true;
      if (room.seats.every((s) => !s || s.ai || s.left)) this.destroy(room);
      else this.broadcast(room);
    }
    this.publishLobby();
  }

  resume(socket, msg = {}) {
    const room = this.rooms.get(String(msg.code || '').toUpperCase());
    const idx = room ? room.seats.findIndex((s) => s && !s.ai && s.token && s.token === msg.token) : -1;
    if (!room || idx < 0 || room.seats[idx].left) {
      socket.emit('room:gone');
      return;
    }
    const seat = room.seats[idx];
    if (seat.socketId && seat.socketId !== socket.id) this.bySocket.delete(seat.socketId); // stale socket
    clearTimeout(seat.dropTimer);
    seat.socketId = socket.id;
    seat.connected = true;
    this.bySocket.set(socket.id, { code: room.code, seat: idx });
    socket.emit('room:joined', this.joinedPayload(room, idx));
    if (room.game) this.broadcast(room);
    this.publishLobby();
  }

  // ------------------------------------------------------------------ game flow

  startGame(room) {
    room.game = new MeliGame({
      announce: room.announce,
      handSize: room.handSize,
      deck: room.handSize === 12 ? 'half' : 'full', // 24-card game = the 24 strongest cards (9 to Ace)
      starter: this.cfg.rng() < 0.5 ? 0 : 1,
    });
    room.status = 'playing';
    room.endDetail = null;
    room.rematch = [false, false];
    clearTimeout(room.cleanupTimer);
    this.armTurn(room);
    this.broadcast(room);
    this.scheduleAI(room, this.cfg.aiDelay);
  }

  play(socket, msg) {
    if (!msg || typeof msg.cardId !== 'string' || !msg.claim || typeof msg.claim !== 'object') {
      throw new RoomError('Malformed move.', 'bad');
    }
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'playing') throw new RoomError('No game in progress.', 'none');
    const str = (v) => (v === undefined || v === null ? undefined : String(v));
    const result = room.game.play(idx, msg.cardId, { rank: str(msg.claim.rank), suit: str(msg.claim.suit) });
    this.afterMove(room, result);
  }

  challenge(socket) {
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'playing') throw new RoomError('No game in progress.', 'none');
    this.afterMove(room, room.game.challenge(idx));
  }

  afterMove(room, result) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.aiTimer);
    room.turnDeadline = null;
    if (room.game.phase === 'over') {
      room.status = 'over';
      room.endDetail = 'empty-hand';
      this.finished(room);
      this.scheduleCleanup(room);
    } else {
      this.armTurn(room);
    }
    this.broadcast(room);
    if (result && result.reveal) this.emitHumans(room, 'reveal', result.reveal);
    this.scheduleAI(room, result && result.reveal ? this.cfg.revealPause : this.cfg.aiDelay);
  }

  /** A game just ended: count it once for the lobby statistics. */
  finished(room) {
    const stats = this.cfg.stats;
    if (!stats || room.recordedGame === room.game) return;
    room.recordedGame = room.game;
    const w = room.game.winner;
    if (w !== 0 && w !== 1) return;
    stats.record({ winner: room.seats[w], loser: room.seats[1 - w], vsAI: room.vsAI });
    this.io.to('lobby').emit('stats', stats.snapshot());
  }

  /** "Padoties": give up this game. The room stays open, so a rematch is possible. */
  surrender(socket) {
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'playing') throw new RoomError('No game in progress.', 'none');
    this.forfeit(room, idx, 'surrender');
  }

  armTurn(room) {
    clearTimeout(room.turnTimer);
    room.turnDeadline = null;
    if (room.vsAI || room.status !== 'playing' || room.game.phase !== 'play') return;
    const idx = room.game.turn;
    room.turnDeadline = Date.now() + this.cfg.turnMs;
    room.turnTimer = setTimeout(() => this.forfeit(room, idx, 'timeout'), this.cfg.turnMs);
  }

  forfeit(room, idx, detail) {
    if (room.status !== 'playing') return;
    clearTimeout(room.turnTimer);
    clearTimeout(room.aiTimer);
    room.turnDeadline = null;
    room.game.forfeit(idx);
    room.status = 'over';
    room.endDetail = detail;
    this.finished(room);
    this.scheduleCleanup(room);
    this.broadcast(room);
  }

  scheduleAI(room, delay) {
    clearTimeout(room.aiTimer);
    const g = room.game;
    if (!room.vsAI || room.status !== 'playing' || g.turn !== AI_SEAT) return;
    room.aiTimer = setTimeout(() => {
      if (room.status !== 'playing' || g.turn !== AI_SEAT) return;
      try {
        const m = ai.decide(g, AI_SEAT);
        const result = m.action === 'challenge' ? g.challenge(AI_SEAT) : g.play(AI_SEAT, m.cardId, m.claim);
        this.afterMove(room, result);
      } catch (err) {
        console.error('AI move failed:', err);
        this.emitHumans(room, 'notice', 'The computer hit an internal error. Please start a new game.');
      }
    }, delay);
  }

  rematch(socket) {
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'over') throw new RoomError('The game is not finished yet.', 'bad');
    const other = room.seats[1 - idx];
    if (!other.ai && other.left) throw new RoomError('Your opponent has left the game.', 'gone');
    room.rematch[idx] = true;
    if (other.ai) room.rematch[1 - idx] = true;
    if (room.rematch[0] && room.rematch[1]) this.startGame(room);
    else this.broadcast(room);
  }

  // ------------------------------------------------------------------ cleanup

  scheduleCleanup(room) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => this.destroy(room), this.cfg.finishedTtlMs);
  }

  destroy(room) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.aiTimer);
    clearTimeout(room.cleanupTimer);
    for (const s of room.seats) {
      if (!s) continue;
      clearTimeout(s.dropTimer);
      if (s.socketId) this.bySocket.delete(s.socketId);
    }
    this.rooms.delete(room.code);
    this.publishLobby();
  }

  dispose() {
    for (const room of [...this.rooms.values()]) this.destroy(room);
  }
}

module.exports = { RoomManager, RoomError, DEFAULT_CFG };

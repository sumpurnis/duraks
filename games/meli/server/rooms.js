'use strict';
/**
 * Rooms for Meļi: 2 to 6 seats, any of them (but the host's) may be the computer.
 *
 *  - A room where every other seat is the computer ("solo") starts at once and is never listed.
 *  - Otherwise it waits for people. It starts when every seat is taken, or earlier when at least two
 *    seats are taken and everybody sitting there has ticked "ready" (the early start).
 *  - Seat index == engine player index == turn order. An early start drops the empty seats.
 *  - Server is authoritative; each person only ever receives their own view.
 *  - Reconnect: every seat has a secret token; a dropped player has `graceMs` to come back.
 *  - Games with more than one person have a per-turn timer. Running out of time, leaving or staying
 *    disconnected forfeits: that player is out and the others play on (the last one left wins).
 *  - Rematch needs every remaining person to agree (the computer always agrees).
 *  - Table chat for everyone at the table, guests too (the host site masks rude words).
 *  - Ranked tables (ELO): signed-in players only, no computer seats. The host site rates the result.
 */
const crypto = require('node:crypto');
const { MeliGame, RuleError, MIN_PLAYERS, MAX_PLAYERS } = require('./engine');
const ai = require('./ai');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const randomString = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
// Announcement versions players may pick. 'suit-rank' is implemented but switched off for now.
const ANNOUNCE_ENABLED = ['suit'];
const DECKS = new Set(['half', 'full']); // 24 cards (9 to Ace) or the whole 52-card deck
const CHAT_LOG = 50;
const CHAT_MAX = 300;
const CHAT_GAP_MS = 400;

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
  turnMs: 60000, // move limit in games with more than one person
  graceMs: 30000, // time a dropped player has to reconnect
  finishedTtlMs: 10 * 60000, // how long a finished room stays for rematch
  maxRooms: 500,
  challenge: 'next', // who may call bluff: 'next' (the player whose turn it is) or 'any'
  cleanChat: (s) => s, // the host site passes its rude-word masking here
  rng: Math.random,
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
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
      ready: false,
      dropTimer: null,
      lastChat: 0,
    };
  }

  aiSeat(name) {
    return { ai: true, account: false, name, token: null, socketId: null, connected: true, left: false, ready: true, dropTimer: null };
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

  humans(room) {
    return room.seats.filter((s) => s && !s.ai);
  }

  filled(room) {
    return room.seats.filter(Boolean).length;
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
      solo: room.solo,
      vsAI: room.vsAI,
      announce: room.announce,
      deck: room.deck,
      ranked: room.ranked,
    };
  }

  /** The waiting room as one seated person sees it. */
  waitingFor(room, idx) {
    const filled = this.filled(room);
    const people = this.humans(room);
    return {
      code: room.code,
      total: room.seats.length,
      filled,
      aiCount: room.seats.filter((s) => s && s.ai).length,
      deck: room.deck,
      announce: room.announce,
      ranked: room.ranked,
      private: !!room.password,
      password: room.password, // only ever sent to people already at the table
      isHost: idx === room.host,
      you: idx,
      seats: room.seats.map((s, i) => (s ? { name: s.name, ai: !!s.ai, ready: !!s.ready, host: i === room.host, connected: !!s.connected } : null)),
      ready: people.filter((s) => s.ready).length,
      people: people.length,
      canStartEarly: filled >= MIN_PLAYERS && filled < room.seats.length,
    };
  }

  broadcastWaiting(room) {
    room.seats.forEach((s, i) => {
      if (s && !s.ai) this.emitSeat(room, i, 'room:waiting', this.waitingFor(room, i));
    });
  }

  viewFor(room, idx) {
    const g = room.game;
    const me = room.seats[idx];
    const turnMs = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
    const people = room.seats.filter((s) => !s.ai && !s.left);
    return {
      ...g.view(idx),
      room: {
        code: room.code,
        status: room.status,
        solo: room.solo,
        vsAI: room.vsAI,
        private: !!room.password,
        ranked: room.ranked,
        deck: room.deck,
        myName: me.name,
        seats: room.seats.map((s, i) => ({
          name: s.name,
          ai: !!s.ai,
          connected: !!s.connected,
          left: !!s.left,
          out: !!g.out[i],
          outDetail: room.outDetail[i] || null,
        })),
        turnMs,
        endDetail: room.endDetail,
        rematch: {
          you: room.rematch.has(idx),
          agreed: people.filter((s) => room.rematch.has(room.seats.indexOf(s))).map((s) => s.name),
          waiting: people.filter((s) => !room.rematch.has(room.seats.indexOf(s))).map((s) => s.name),
          possible: room.seats.filter((s) => s.ai || !s.left).length >= MIN_PLAYERS,
        },
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
      if (room.status !== 'waiting' || room.solo) continue;
      const host = room.seats[room.host];
      if (!host || !host.connected || this.filled(room) >= room.seats.length) continue;
      out.push({
        code: room.code,
        host: host.name,
        total: room.seats.length,
        filled: this.filled(room),
        people: this.humans(room).length,
        aiCount: room.seats.filter((s) => s && s.ai).length,
        announce: room.announce,
        deck: room.deck,
        ranked: room.ranked,
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

    // Old clients sent { vsAI, handSize: 12|26 }; new ones { totalPlayers, aiCount, deck }.
    const total = clampInt(msg.totalPlayers, MIN_PLAYERS, MAX_PLAYERS, MIN_PLAYERS);
    const aiCount = msg.vsAI && msg.aiCount === undefined ? total - 1 : clampInt(msg.aiCount, 0, total - 1, 0);
    const deck = DECKS.has(msg.deck) ? msg.deck : Number(msg.handSize) === 26 ? 'full' : 'half';
    const solo = aiCount === total - 1;

    let code;
    do code = randomString(5);
    while (this.rooms.has(code));

    const seats = Array(total).fill(null);
    seats[0] = this.makeSeat(socket, msg.name, msg.account);
    for (let i = 1; i <= aiCount; i++) seats[i] = this.aiSeat(aiCount === 1 ? 'Dators' : `Dators ${i}`);

    const room = {
      code,
      solo,
      vsAI: aiCount > 0,
      // ELO: only for signed-in hosts at a table without the computer (the server sets msg.account)
      ranked: !!msg.ranked && !!msg.account && aiCount === 0,
      announce: ANNOUNCE_ENABLED.includes(msg.announce) ? msg.announce : 'suit',
      deck,
      password: !solo && msg.private ? randomString(6) : null,
      seats,
      host: 0,
      game: null,
      status: 'waiting',
      endDetail: null,
      outDetail: {},
      rematch: new Set(),
      chatLog: [],
      turnDeadline: null,
      turnTimer: null,
      aiTimer: null,
      cleanupTimer: null,
    };
    this.rooms.set(code, room);
    this.bySocket.set(socket.id, { code, seat: 0 });
    socket.emit('room:joined', this.joinedPayload(room, 0));

    if (solo) this.startGame(room);
    else this.broadcastWaiting(room);
    this.publishLobby();
  }

  join(socket, msg = {}) {
    const code = String(msg.code || '').trim().toUpperCase().slice(0, 8);
    const room = this.rooms.get(code);
    if (!room || room.status !== 'waiting' || room.solo) throw new RoomError('That game is no longer open.', 'gone');
    const mine = this.bySocket.get(socket.id);
    if (mine && mine.code === code) return; // already sitting here
    this.assertFree(socket);
    const free = room.seats.indexOf(null);
    if (free < 0) throw new RoomError('That game is full.', 'gone');
    if (!room.seats[room.host] || !room.seats[room.host].connected) throw new RoomError('The host is reconnecting. Try again in a moment.', 'busy');
    if (room.ranked && !msg.account) throw new RoomError('This table is ranked: log in to join.', 'ranked');

    if (room.password) {
      if (msg.password === undefined || msg.password === null || msg.password === '') {
        throw new RoomError('This game is private. Enter its password.', 'password', code);
      }
      if (String(msg.password).trim().toUpperCase() !== room.password) {
        throw new RoomError('Wrong password.', 'password-wrong', code);
      }
    }

    room.seats[free] = this.makeSeat(socket, msg.name, msg.account);
    this.bySocket.set(socket.id, { code, seat: free });
    this.resetReady(room); // the table changed: everybody agrees again
    socket.emit('room:joined', this.joinedPayload(room, free));
    socket.emit('chat:history', room.chatLog);
    if (this.filled(room) === room.seats.length) this.startGame(room);
    else this.broadcastWaiting(room);
    this.publishLobby();
  }

  resetReady(room) {
    room.seats.forEach((s) => { if (s && !s.ai) s.ready = false; });
  }

  /** "Ready": start now with the players already seated, once every one of them agrees. */
  ready(socket, msg = {}) {
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'waiting') throw new RoomError('The game has already started.', 'bad');
    room.seats[idx].ready = !!(msg && msg.ready);
    const people = this.humans(room);
    if (this.filled(room) >= MIN_PLAYERS && people.every((s) => s.ready && s.connected)) {
      this.startGame(room);
      this.publishLobby();
    } else {
      this.broadcastWaiting(room);
    }
  }

  /** Voluntary leave. In a waiting room the host's leave cancels the room; mid-game it is a forfeit. */
  leave(socket, silent = false) {
    const { room, idx } = this.lookup(socket);
    const seat = room.seats[idx];
    this.bySocket.delete(socket.id);

    if (room.status === 'waiting') {
      clearTimeout(seat.dropTimer);
      if (idx === room.host) {
        this.cancel(room, socket.id);
      } else {
        room.seats[idx] = null;
        this.resetReady(room);
        this.broadcastWaiting(room);
      }
    } else {
      if (room.status === 'playing') {
        if (room.solo) {
          this.destroy(room);
        } else {
          this.forfeit(room, idx, 'left');
        }
      }
      if (this.rooms.has(room.code)) {
        seat.left = true;
        clearTimeout(seat.dropTimer);
        seat.socketId = null;
        seat.connected = false;
        room.rematch.delete(idx);
        if (room.seats.every((s) => s.ai || s.left)) this.destroy(room);
        else if (!this.maybeRematch(room)) this.broadcast(room);
      }
    }
    if (!silent) socket.emit('room:left');
    this.publishLobby();
  }

  /** The host closed a waiting room: everyone else is told. */
  cancel(room, exceptSocketId) {
    room.seats.forEach((s, i) => {
      if (s && !s.ai && s.socketId && s.socketId !== exceptSocketId) this.emitSeat(room, i, 'room:cancelled', { code: room.code });
    });
    this.destroy(room);
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
    seat.dropTimer = setTimeout(() => this.dropExpired(room, seat), this.cfg.graceMs);
    if (room.status === 'waiting') {
      seat.ready = false;
      this.broadcastWaiting(room);
    } else {
      this.broadcast(room);
    }
    this.publishLobby();
  }

  dropExpired(room, seat) {
    if (!this.rooms.has(room.code) || seat.connected) return;
    const idx = room.seats.indexOf(seat);
    if (idx < 0) return;
    if (room.status === 'waiting') {
      if (idx === room.host) this.cancel(room);
      else {
        room.seats[idx] = null;
        this.resetReady(room);
        this.broadcastWaiting(room);
      }
    } else if (room.status === 'playing' && room.solo) {
      this.destroy(room);
    } else {
      if (room.status === 'playing') this.forfeit(room, idx, 'disconnect');
      seat.left = true;
      room.rematch.delete(idx);
      if (!this.rooms.has(room.code)) return;
      if (room.seats.every((s) => s.ai || s.left)) this.destroy(room);
      else if (!this.maybeRematch(room)) this.broadcast(room);
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
    socket.emit('chat:history', room.chatLog);
    if (room.game && room.status !== 'waiting') this.broadcast(room);
    else this.broadcastWaiting(room);
    this.publishLobby();
  }

  // ------------------------------------------------------------------ chat

  chat(socket, msg = {}) {
    const { room, idx } = this.lookup(socket);
    const seat = room.seats[idx];
    const raw = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX) : '';
    if (!raw) return;
    const now = Date.now();
    if (now - (seat.lastChat || 0) < CHAT_GAP_MS) return; // flood guard
    seat.lastChat = now;
    let text = raw;
    try { text = this.cfg.cleanChat(raw); } catch { /* keep the raw text */ }
    const entry = { from: seat.name, text, at: now };
    room.chatLog.push(entry);
    if (room.chatLog.length > CHAT_LOG) room.chatLog.shift();
    this.emitHumans(room, 'chat', entry);
  }

  // ------------------------------------------------------------------ game flow

  /** Start (or restart) with the seats that are taken; empty and departed seats are dropped. */
  // ------------------------------------------------------------------ the admin's game log
  // (cfg.gameLog from the host site: { start, move, end }; absent in the standalone server and tests)

  logStart(room) {
    const log = this.cfg.gameLog;
    room.logId = null;
    if (!log) return;
    const cs = (c) => (c ? (c.rank || '') + c.suit : '');
    try {
      room.logId = log.start({
        game: 'meli',
        mode: room.ranked && !room.vsAI ? 'ranked' : 'casual',
        players: room.seats.map((s) => ({ name: s.name, kind: s.ai ? 'bot' : s.account ? 'user' : 'guest' })),
        opts: { code: room.code, deck: room.deck, seats: room.seats.length, announce: room.announce, private: !!room.private },
        setup: { hands: Object.fromEntries(room.seats.map((s, i) => [s.name, (room.game.hands[i] || []).map(cs)])) },
      });
    } catch (err) { console.error('game log start failed:', err.message); }
  }

  logMove(room, text) {
    if (room.logId && this.cfg.gameLog) this.cfg.gameLog.move(room.logId, text);
  }

  logResult(room, result) {
    if (!room.logId || !result) return;
    const g = room.game;
    const name = (i) => (room.seats[i] ? room.seats[i].name : '?');
    const cs = (c) => (c ? (c.rank || '') + c.suit : '');
    if (result.type === 'played') {
      const top = g.pile[g.pile.length - 1];
      if (top) this.logMove(room, `${name(top.player)} noliek ${cs(top.card)} kā ${cs(top.claim)}`);
    } else if (result.type === 'reveal' && result.reveal) {
      const r = result.reveal;
      if (r.final) this.logMove(room, `${name(r.accused)} noliek pēdējo kārti ${cs(r.actual)} kā ${cs(r.claim)}`);
      else this.logMove(room, `${name(r.challenger)}: «Neticu!»`);
      this.logMove(room, `${r.lie ? 'Meli' : 'Taisnība'} (${cs(r.actual)}) — ${name(r.loser)} paņem ${r.taken} ${r.taken === 1 ? 'kārti' : 'kārtis'}`);
    }
  }

  logEnd(room, status, reason) {
    if (!room.logId || !this.cfg.gameLog) return;
    const g = room.game;
    const id = room.logId;
    room.logId = null;
    const winner = g && g.winner !== null && g.winner !== undefined && room.seats[g.winner] ? room.seats[g.winner].name : null;
    try {
      this.cfg.gameLog.end(id, {
        status,
        reason,
        result: { winner, cardsLeft: g ? Object.fromEntries(room.seats.map((s, i) => [s.name, (g.hands[i] || []).length])) : null, out: room.outDetail ? Object.fromEntries(Object.entries(room.outDetail).map(([i, d]) => [room.seats[i] ? room.seats[i].name : i, d])) : null },
      });
    } catch (err) { console.error('game log end failed:', err.message); }
  }

  startGame(room) {
    const keep = room.seats.filter((s) => s && (s.ai || !s.left));
    room.seats = keep;
    room.seats.forEach((s, i) => {
      s.ready = !!s.ai;
      if (!s.ai && s.socketId) this.bySocket.set(s.socketId, { code: room.code, seat: i });
    });
    room.host = Math.max(0, room.seats.findIndex((s) => !s.ai));
    room.vsAI = room.seats.some((s) => s.ai);
    room.game = new MeliGame({
      players: room.seats.length,
      announce: room.announce,
      deck: room.deck,
      challenge: this.cfg.challenge,
      starter: Math.floor(this.cfg.rng() * room.seats.length),
    });
    room.status = 'playing';
    room.endDetail = null;
    room.outDetail = {};
    this.logStart(room);
    room.rematch = new Set();
    clearTimeout(room.cleanupTimer);
    this.armTurn(room);
    this.emitHumans(room, 'room:started', { code: room.code });
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
    this.logResult(room, result);
    if (room.game.phase === 'over') {
      room.status = 'over';
      room.endDetail = room.game.endReason === 'forfeit' ? room.endDetail || 'left' : 'empty-hand';
      this.logEnd(room, room.endDetail === 'empty-hand' ? 'finished' : 'ended', room.endDetail);
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
    const g = room.game;
    const w = g.winner;
    if (!room.seats[w]) return;
    // Everything the host site needs to rate and log the game (players' stats, ELO, history, the map).
    stats.record({
      winner: room.seats[w],
      losers: room.seats.filter((_, i) => i !== w),
      vsAI: room.vsAI,
      ranked: room.ranked && !room.vsAI,
      players: room.seats.length,
      deck: room.deck,
      endDetail: room.endDetail,
      seats: room.seats.map((s, i) => ({
        name: s.name,
        account: !!s.account && !s.ai,
        ai: !!s.ai,
        winner: i === w,
        cards: g.hands[i].length,
        out: !!g.out[i],
        outDetail: room.outDetail[i] || null,
      })),
    });
    this.io.to('lobby').emit('stats', stats.snapshot());
  }

  /** "Padoties": give up this game. You are out; the room stays, so a rematch is possible. */
  surrender(socket) {
    const { room, idx } = this.lookup(socket);
    if (room.status !== 'playing') throw new RoomError('No game in progress.', 'none');
    this.forfeit(room, idx, 'surrender');
  }

  armTurn(room) {
    clearTimeout(room.turnTimer);
    room.turnDeadline = null;
    if (room.solo || room.status !== 'playing' || room.game.phase !== 'play') return;
    const idx = room.game.turn;
    const seat = room.seats[idx];
    if (!seat || seat.ai) return;
    room.turnDeadline = Date.now() + this.cfg.turnMs;
    room.turnTimer = setTimeout(() => this.forfeit(room, idx, 'timeout'), this.cfg.turnMs);
  }

  forfeit(room, idx, detail) {
    if (room.status !== 'playing' || room.game.out[idx]) return;
    clearTimeout(room.turnTimer);
    clearTimeout(room.aiTimer);
    room.turnDeadline = null;
    const r = room.game.forfeit(idx);
    room.outDetail[idx] = detail;
    this.logMove(room, `${room.seats[idx] ? room.seats[idx].name : '?'} izstājas (${detail})`);
    if (r.over) {
      room.status = 'over';
      room.endDetail = detail;
      this.logEnd(room, 'ended', detail);
      this.finished(room);
      this.scheduleCleanup(room);
    } else if (room.seats.every((s, i) => s.ai || room.game.out[i])) {
      // Only computers are left playing: nobody to play for, so the game ends here — the computer with
      // the fewest cards wins. (It used to close the room without a word: the player who gave up was
      // left looking at a frozen table.) The player sees the usual end screen, the room closes later.
      const g = room.game;
      let best = -1;
      g.hands.forEach((h, i) => { if (!g.out[i] && (best < 0 || h.length < g.hands[best].length)) best = i; });
      g.phase = 'over';
      g.winner = best;
      g.endReason = 'forfeit';
      g.turn = null;
      room.status = 'over';
      room.endDetail = detail;
      this.logEnd(room, 'ended', detail);
      this.finished(room);
      this.scheduleCleanup(room);
    } else {
      this.armTurn(room);
    }
    this.broadcast(room);
    this.scheduleAI(room, this.cfg.aiDelay);
  }

  scheduleAI(room, delay) {
    clearTimeout(room.aiTimer);
    const g = room.game;
    if (!g || room.status !== 'playing' || g.phase !== 'play') return;
    const me = g.turn;
    if (!room.seats[me] || !room.seats[me].ai) return;
    room.aiTimer = setTimeout(() => {
      if (room.status !== 'playing' || g.turn !== me) return;
      try {
        const m = ai.decide(g, me);
        const result = m.action === 'challenge' ? g.challenge(me) : g.play(me, m.cardId, m.claim);
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
    const stay = room.seats.filter((s) => s.ai || !s.left);
    if (stay.length < MIN_PLAYERS) throw new RoomError('Your opponent has left the game.', 'gone');
    room.rematch.add(idx);
    if (!this.maybeRematch(room)) this.broadcast(room);
  }

  /** Start the rematch once every remaining person has agreed. True when it started. */
  maybeRematch(room) {
    if (room.status !== 'over' || !room.rematch.size) return false;
    if (room.seats.filter((s) => s.ai || !s.left).length < MIN_PLAYERS) return false;
    const people = room.seats.map((s, i) => [s, i]).filter(([s]) => !s.ai && !s.left);
    if (!people.length || !people.every(([, i]) => room.rematch.has(i))) return false;
    this.startGame(room);
    return true;
  }

  // ------------------------------------------------------------------ cleanup

  scheduleCleanup(room) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => this.destroy(room), this.cfg.finishedTtlMs);
  }

  destroy(room) {
    // a game still running when its room closes (e.g. only computers were left playing)
    if (room.logId) this.logEnd(room, 'ended', room.status === 'playing' ? 'only-bots-left' : 'closed');
    clearTimeout(room.turnTimer);
    clearTimeout(room.aiTimer);
    clearTimeout(room.cleanupTimer);
    for (const s of room.seats) {
      if (!s) continue;
      clearTimeout(s.dropTimer);
      if (s.socketId && this.bySocket.get(s.socketId) && this.bySocket.get(s.socketId).code === room.code) this.bySocket.delete(s.socketId);
    }
    this.rooms.delete(room.code);
    this.publishLobby();
  }

  dispose() {
    for (const room of [...this.rooms.values()]) this.destroy(room);
  }
}

module.exports = { RoomManager, RoomError, DEFAULT_CFG };

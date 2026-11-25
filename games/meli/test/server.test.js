'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server/index');

const FAST = { aiDelay: 0, revealPause: 0 };
const SUITS = ['♠', '♥', '♦', '♣'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts an app, hands `fn` helpers, always cleans up. */
async function withApp(cfg, fn) {
  const app = createApp({ ...FAST, ...cfg });
  const port = await app.listen(0);
  const sockets = [];
  const client = () => {
    const s = connect(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    s.log = { notices: [], states: [], reveals: [], chat: [] };
    s.on('notice', (m) => s.log.notices.push(m));
    s.on('state', (v) => (s.log.states.push(v), (s.last = v)));
    s.on('reveal', (r) => s.log.reveals.push(r));
    s.on('room:waiting', (w) => (s.wait = w));
    s.on('chat', (c) => s.log.chat.push(c));
    sockets.push(s);
    return s;
  };
  try {
    await fn({ app, port, client });
  } finally {
    sockets.forEach((s) => s.close());
    app.close();
  }
}

const once = (s, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (x) => (clearTimeout(t), res(x)));
  });

async function until(s, pred, ms = 3000, what = 'last') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (s[what] && pred(s[what])) return s[what];
    await sleep(10);
  }
  throw new Error('condition not reached; last: ' + JSON.stringify(s[what] && (what === 'last' ? { phase: s.last.phase, turn: s.last.turn, room: s.last.room } : s[what])));
}

const claimFor = (v, c, honest) => {
  const suit = v.lockedSuit || (honest ? c.suit : SUITS.find((x) => x !== c.suit));
  return v.announce === 'suit' ? { suit } : { rank: honest ? c.rank : c.rank === 'A' ? 'K' : 'A', suit };
};

/** Make one scripted move for a socket whose turn it is. */
function move(s, { challengeRate = 0.3 } = {}) {
  const v = s.last;
  if (v.canChallenge && Math.random() < challengeRate) return s.emit('challenge');
  const legit = v.lockedSuit ? v.hand.filter((c) => c.suit === v.lockedSuit) : v.hand;
  const honest = legit.length > 0 && Math.random() < 0.6;
  const c = honest ? legit[0] : v.hand[0];
  s.emit('play', { cardId: c.id, claim: claimFor(v, c, honest && c.suit === (v.lockedSuit || c.suit)) });
}

/** Every socket plays on its own turn until the game ends for all of them. */
async function playOut(socks, ms = 30000) {
  const end = Date.now() + ms;
  const seen = new Map();
  while (Date.now() < end) {
    if (socks.every((s) => s.last && s.last.phase === 'over')) return;
    for (const s of socks) {
      const v = s.last;
      if (v && v.phase === 'play' && v.canPlay) {
        const sig = `${v.round}/${v.pile.count}/${v.counts.join(',')}`;
        if (seen.get(s) !== sig) {
          seen.set(s, sig);
          move(s);
        }
      }
    }
    await sleep(5);
  }
  throw new Error('game did not finish');
}

const noLeak = (v) => assert.ok(!('hands' in v) && !JSON.stringify(v.room.seats).includes('hand'), 'view must not leak hidden info');

/** Host creates, the others join (in order). Returns the room code. */
async function seat(host, others, opts = {}) {
  host.emit('room:create', { name: 'Host', ...opts });
  const { code } = await once(host, 'room:joined');
  let i = 0;
  for (const s of others) {
    s.emit('room:join', { code, name: `P${++i}` });
    await once(s, 'room:joined');
  }
  return code;
}

// ----------------------------------------------------------------------------- solo

test('vs computer: the old 2-player request still works and plays to the end; Play again restarts at once', async () => {
  await withApp({}, async ({ client }) => {
    const s = client();
    s.emit('room:create', { name: 'Tester', vsAI: true, handSize: 12 });
    const joined = await once(s, 'room:joined');
    assert.equal(joined.solo, true);
    assert.equal(joined.deck, 'half');
    await until(s, (v) => v.phase === 'play');
    assert.equal(s.last.players, 2);
    await playOut([s]);
    noLeak(s.last);
    assert.equal(s.last.room.seats[1].ai, true);
    assert.equal(s.log.notices.length, 0, s.log.notices.join('; '));
    s.emit('rematch');
    await until(s, (v) => v.phase === 'play');
  });
});

test('vs computer with 5 computers: a 6-player game runs to completion', async () => {
  await withApp({}, async ({ client }) => {
    const s = client();
    s.emit('room:create', { name: 'Solo', totalPlayers: 6, aiCount: 5, deck: 'half' });
    const j = await once(s, 'room:joined');
    assert.equal(j.solo, true);
    await until(s, (v) => v.phase === 'play');
    assert.equal(s.last.players, 6);
    assert.deepEqual(s.last.room.seats.map((x) => x.name), ['Solo', 'Dators 1', 'Dators 2', 'Dators 3', 'Dators 4', 'Dators 5']);
    await playOut([s]);
    assert.equal(s.log.notices.length, 0, s.log.notices.join('; '));
  });
});

test('computer-only rooms are never listed and cannot be joined', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { totalPlayers: 3, aiCount: 2 });
    const j = await once(a, 'room:joined');
    await sleep(50);
    b.emit('rooms:refresh');
    assert.deepEqual(await once(b, 'rooms'), []);
    b.emit('room:join', { code: j.code });
    assert.match(await once(b, 'notice'), /no longer open/);
  });
});

// ----------------------------------------------------------------------------- tables with people

test('2 players: create, list with seats, join starts the game, separate views', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'Anna' });
    const ja = await once(a, 'room:joined');
    assert.equal(ja.status, 'waiting');
    await until(a, (w) => w.code === ja.code, 3000, 'wait');
    assert.equal(a.wait.isHost, true);
    b.emit('rooms:refresh');
    const list = await once(b, 'rooms');
    assert.equal(list.length, 1);
    assert.equal(list[0].host, 'Anna');
    assert.equal(list[0].filled, 1);
    assert.equal(list[0].total, 2);
    assert.equal('password' in list[0], false);
    b.emit('room:join', { code: ja.code, name: 'Bob' });
    await once(b, 'room:joined');
    await until(a, (v) => v.phase === 'play');
    await until(b, (v) => v.phase === 'play');
    assert.equal(a.last.you, 0);
    assert.equal(b.last.you, 1);
    assert.notDeepEqual(a.last.hand, b.last.hand);
    noLeak(a.last);
    b.emit('rooms:refresh');
    assert.deepEqual(await once(b, 'rooms'), [], 'a started room leaves the list');
  });
});

test('4 seats, 3 people + 1 computer: the full table starts by itself and plays out; rematch needs everyone', async () => {
  await withApp({}, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    await seat(h, [p1, p2], { totalPlayers: 4, aiCount: 1 });
    await until(h, (v) => v.phase === 'play');
    assert.equal(h.last.players, 4);
    assert.equal(h.last.room.seats.filter((s) => s.ai).length, 1);
    await playOut([h, p1, p2]);
    const w = h.last.winner;
    assert.equal(h.last.counts[w], 0);
    h.emit('rematch');
    await until(p1, (v) => v.room.rematch.agreed.includes('Host'));
    assert.deepEqual(p1.last.room.rematch.waiting.sort(), ['P1', 'P2']);
    p1.emit('rematch');
    p2.emit('rematch');
    await until(h, (v) => v.phase === 'play');
  });
});

test('early start: everybody seated ticks ready; a newcomer resets the ticks', async () => {
  await withApp({}, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    const code = await seat(h, [p1], { totalPlayers: 5 });
    await until(h, (w) => w.filled === 2 && w.canStartEarly, 3000, 'wait');
    h.emit('room:ready', { ready: true });
    await until(p1, (w) => w.ready === 1, 3000, 'wait');
    assert.equal(p1.wait.seats[0].ready, true);
    // a third player sits down: the ticks start over
    p2.emit('room:join', { code, name: 'P2' });
    await until(h, (w) => w.filled === 3 && w.ready === 0, 3000, 'wait');
    for (const s of [h, p1]) s.emit('room:ready', { ready: true });
    await until(p2, (w) => w.ready === 2, 3000, 'wait');
    assert.equal(h.last, undefined, 'not started while someone is not ready');
    p2.emit('room:ready', { ready: true });
    await until(h, (v) => v.phase === 'play');
    assert.equal(h.last.players, 3, 'empty seats are dropped');
    assert.deepEqual(h.last.room.seats.map((s) => s.name), ['Host', 'P1', 'P2']);
    await playOut([h, p1, p2]);
  });
});

test('only the next player may call bluff', async () => {
  await withApp({ turnMs: 60000 }, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    await seat(h, [p1, p2], { totalPlayers: 3 });
    await until(h, (v) => v.phase === 'play');
    const socks = [h, p1, p2];
    const first = socks.find((s) => s.last.canPlay);
    move(first, { challengeRate: 0 });
    const nextIdx = (first.last.you + 1) % 3;
    const next = socks.find((s) => s.last.you === nextIdx);
    const third = socks.find((s) => s !== first && s !== next);
    await until(next, (v) => v.canChallenge);
    assert.equal(third.last.canChallenge, false);
    third.emit('challenge');
    assert.match(await once(third, 'notice'), /not your turn/);
  });
});

test('private rooms: listed with a lock, need the password; the password is shown only at the table', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A', private: true, totalPlayers: 3 });
    const { code } = await once(a, 'room:joined');
    const w = await until(a, (x) => x.password, 3000, 'wait');
    b.emit('rooms:refresh');
    const list = await once(b, 'rooms');
    assert.equal(list[0].private, true);
    assert.equal(JSON.stringify(list).includes(w.password), false);
    b.emit('room:join', { code });
    assert.deepEqual(await once(b, 'room:password'), { code, wrong: false });
    b.emit('room:join', { code, password: 'NOPE' });
    assert.deepEqual(await once(b, 'room:password'), { code, wrong: true });
    b.emit('room:join', { code, password: w.password.toLowerCase() });
    await once(b, 'room:joined');
    assert.equal((await until(b, (x) => x.code === code, 3000, 'wait')).password, w.password);
  });
});

test('one room per socket; joining your own table again is harmless; a full table cannot be joined', async () => {
  await withApp({}, async ({ client }) => {
    const [a, b, c] = [client(), client(), client()];
    a.emit('room:create', { name: 'A', totalPlayers: 3 });
    const { code } = await once(a, 'room:joined');
    a.emit('room:create', {});
    assert.match(await once(a, 'notice'), /already in a game/);
    a.emit('room:join', { code });
    await sleep(80);
    assert.equal(a.log.notices.length, 1);
    b.emit('room:join', { code, name: 'B' });
    await once(b, 'room:joined');
    c.emit('room:join', { code, name: 'C' });
    await once(c, 'room:joined');
    const d = client();
    d.emit('room:join', { code });
    assert.match(await once(d, 'notice'), /no longer open/);
  });
});

test('moves are validated: not your turn, malformed, not in a game', async () => {
  await withApp({}, async ({ client }) => {
    const [a, b] = [client(), client()];
    await seat(a, [b]);
    await until(a, (v) => v.phase === 'play');
    const waiting = a.last.canPlay ? b : a;
    waiting.emit('play', { cardId: waiting.last.hand[0].id, claim: { suit: '♠' } });
    assert.match(await once(waiting, 'notice'), /not your turn/);
    waiting.emit('play', { nonsense: true });
    assert.match(await once(waiting, 'notice'), /Malformed/);
    const c = client();
    c.emit('challenge');
    assert.match(await once(c, 'notice'), /not in a game/);
  });
});

test('move timer: with 2 players the slow one loses; with 3 the slow one is out and the others play on', async () => {
  await withApp({ turnMs: 150 }, async ({ client }) => {
    const [a, b] = [client(), client()];
    await seat(a, [b]);
    await until(a, (v) => v.phase === 'play');
    const slow = a.last.canPlay ? a : b;
    const fast = slow === a ? b : a;
    assert.ok(slow.last.room.turnMs > 0 && slow.last.room.turnMs <= 150);
    await until(fast, (v) => v.phase === 'over');
    assert.equal(fast.last.winner, fast.last.you);
    assert.equal(fast.last.room.endDetail, 'timeout');
  });
  await withApp({ turnMs: 200 }, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    await seat(h, [p1, p2], { totalPlayers: 3 });
    await until(h, (v) => v.phase === 'play');
    const socks = [h, p1, p2];
    const slow = socks.find((s) => s.last.canPlay);
    const other = socks.find((s) => s !== slow);
    await until(other, (v) => v.out[slow.last.you]);
    assert.equal(other.last.phase, 'play', 'the game goes on without them');
    assert.equal(other.last.room.seats[slow.last.you].outDetail, 'timeout');
    assert.equal(other.last.counts[slow.last.you], 0);
  });
});

test('leaving mid-game: out of the game, the others play on; the last one left wins', async () => {
  await withApp({}, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    await seat(h, [p1, p2], { totalPlayers: 3 });
    await until(h, (v) => v.phase === 'play');
    p2.emit('room:leave');
    await once(p2, 'room:left');
    await until(h, (v) => v.out[2] && v.room.seats[2].left);
    assert.equal(h.last.phase, 'play');
    p1.emit('room:leave');
    await until(h, (v) => v.phase === 'over');
    assert.equal(h.last.winner, 0);
    assert.equal(h.last.room.rematch.possible, false);
  });
});

test('a dropped player can resume within the grace period; a bad token cannot', async () => {
  await withApp({ graceMs: 1000 }, async ({ client }) => {
    const [a, b] = [client(), client()];
    a.emit('room:create', { name: 'A' });
    const ja = await once(a, 'room:joined');
    b.emit('room:join', { code: ja.code, name: 'B' });
    await until(a, (v) => v.phase === 'play');
    const hand = a.last.hand;
    a.close();
    await until(b, (v) => !v.room.seats[0].connected);
    const x = client();
    x.emit('room:resume', { code: ja.code, token: 'bad' });
    await once(x, 'room:gone');
    const a2 = client();
    a2.emit('room:resume', { code: ja.code, token: ja.token });
    await once(a2, 'room:joined');
    await until(a2, (v) => v.phase === 'play');
    assert.deepEqual(a2.last.hand, hand);
    await until(b, (v) => v.room.seats[0].connected);
  });
});

test('no resume in time: with 2 players the dropped one forfeits', async () => {
  await withApp({ graceMs: 100 }, async ({ client }) => {
    const [a, b] = [client(), client()];
    await seat(a, [b]);
    await until(b, (v) => v.phase === 'play');
    a.close();
    await until(b, (v) => v.phase === 'over');
    assert.equal(b.last.winner, b.last.you);
    assert.equal(b.last.room.endDetail, 'disconnect');
  });
});

test('waiting room: a guest leaving frees the seat; the host leaving cancels it for everyone', async () => {
  await withApp({}, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    await seat(h, [p1, p2], { totalPlayers: 4 });
    await until(h, (w) => w.filled === 3, 3000, 'wait');
    p2.emit('room:leave');
    await once(p2, 'room:left');
    await until(h, (w) => w.filled === 2, 3000, 'wait');
    h.emit('room:leave');
    await once(p1, 'room:cancelled');
    p1.emit('rooms:refresh');
    assert.deepEqual(await once(p1, 'rooms'), []);
  });
});

test('host dropping from a waiting room removes it from the list', async () => {
  await withApp({ graceMs: 100 }, async ({ client }) => {
    const [a, b] = [client(), client()];
    a.emit('room:create', { name: 'A' });
    await once(a, 'room:joined');
    a.close();
    await sleep(250);
    b.emit('rooms:refresh');
    assert.deepEqual(await once(b, 'rooms'), []);
  });
});

test('names are sanitised, unknown options fall back, and the room limit is enforced', async () => {
  await withApp({ maxRooms: 1 }, async ({ client }) => {
    const [a, b] = [client(), client()];
    a.emit('room:create', { name: '  <b>Eve</b>\n  ', totalPlayers: 99, aiCount: -3, deck: 'huge', announce: 'bogus' });
    const j = await once(a, 'room:joined');
    assert.equal(j.deck, 'half');
    assert.equal(j.announce, 'suit');
    const w = await until(a, (x) => x.code, 3000, 'wait');
    assert.equal(w.total, 6, 'player count is clamped to 2..6');
    assert.equal(w.aiCount, 0);
    b.emit('room:join', { code: j.code, name: 'x'.repeat(100) });
    await until(b, (x) => x.code, 3000, 'wait');
    assert.equal(b.wait.seats[0].name, 'bEve/b');
    assert.equal(b.wait.seats[1].name.length, 20);
    const c = client();
    c.emit('room:create', {});
    assert.match(await once(c, 'notice'), /full/);
  });
});

test('surrender: with 2 players the other one wins; the room stays and rematch works', async () => {
  await withApp({}, async ({ client }) => {
    const [a, b] = [client(), client()];
    await seat(a, [b]);
    await until(a, (v) => v.phase === 'play');
    a.emit('surrender');
    await until(b, (v) => v.phase === 'over');
    assert.equal(b.last.winner, 1);
    assert.equal(b.last.room.endDetail, 'surrender');
    a.emit('rematch');
    b.emit('rematch');
    await until(a, (v) => v.phase === 'play');
  });
});

test('table chat: everyone at the table gets it, rude words are masked, newcomers get the history', async () => {
  await withApp({ cleanChat: (s) => s.replace(/rupjs/g, 'r****') }, async ({ client }) => {
    const [h, p1, p2] = [client(), client(), client()];
    const code = await seat(h, [p1], { totalPlayers: 3 });
    h.emit('chat', { text: '  sveiki, rupjs vārds  ' });
    const m = await once(p1, 'chat');
    assert.equal(m.from, 'Host');
    assert.equal(m.text, 'sveiki, r**** vārds');
    p2.emit('room:join', { code, name: 'P2' });
    const hist = await once(p2, 'chat:history');
    assert.deepEqual(hist.map((x) => x.text), ['sveiki, r**** vārds']);
    const outsider = client();
    outsider.emit('chat', { text: 'hi' });
    assert.match(await once(outsider, 'notice'), /not in a game/);
  });
});

test('ranked: guests cannot host it; the finished game reports seats, places data and forfeits', async () => {
  await withApp({}, async ({ app, client }) => {
    const results = [];
    const rec = app.manager.stats.record.bind(app.manager.stats);
    app.manager.stats.record = (r) => { results.push(r); rec(r); };
    const [h, p1, p2] = [client(), client(), client()];
    h.emit('room:create', { name: 'Host', totalPlayers: 3, ranked: true });
    await once(h, 'room:joined');
    const w = await until(h, (x) => x.code, 3000, 'wait');
    assert.equal(w.ranked, false, 'no account: never ranked');
    for (const [s, n] of [[p1, 'P1'], [p2, 'P2']]) { s.emit('room:join', { code: w.code, name: n }); await once(s, 'room:joined'); }
    await until(h, (v) => v.phase === 'play');
    p2.emit('room:leave');
    await until(h, (v) => v.out[2]);
    await playOut([h, p1]);
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.players, 3);
    assert.equal(r.seats.length, 3);
    assert.equal(r.seats.filter((s) => s.winner).length, 1);
    assert.equal(r.seats[2].out, true);
    assert.equal(r.seats[2].outDetail, 'left');
    assert.equal(typeof r.seats[0].cards, 'number');
  });
});

test('game log hook: start with players and the deal, every move, the end with the winner', async () => {
  const recs = { start: null, moves: [], end: null };
  const gameLog = {
    start: (info) => { recs.start = info; return 'g1'; },
    move: (id, text) => { assert.equal(id, 'g1'); recs.moves.push(text); },
    end: (id, info) => { assert.equal(id, 'g1'); recs.end = info; },
  };
  await withApp({ gameLog }, async ({ client }) => {
    const s = client();
    s.emit('room:create', { name: 'Logger', vsAI: true, handSize: 8 });
    await once(s, 'room:joined');
    await until(s, (v) => v.phase === 'play');
    await playOut([s]);
  });
  assert.equal(recs.start.game, 'meli');
  assert.deepEqual(recs.start.players.map((p) => p.kind), ['guest', 'bot']);
  assert.equal(Object.keys(recs.start.setup.hands).length, 2);
  assert.ok(recs.moves.some((m) => / noliek .+ kā /.test(m)), recs.moves.slice(0, 3).join(' | '));
  assert.equal(recs.end.status, 'finished');
  assert.ok(['Logger', 'Dators'].some((n) => String(recs.end.result.winner).startsWith(n)));
});

test('surrender vs 2+ computers: the game ends (a computer wins) instead of freezing; rematch works', async () => {
  await withApp({}, async ({ client }) => {
    const s = client();
    s.emit('room:create', { name: 'Quitter', totalPlayers: 3, aiCount: 2, deck: 'half' });
    await once(s, 'room:joined');
    await until(s, (v) => v.phase === 'play');
    s.emit('surrender');
    await until(s, (v) => v.phase === 'over');
    assert.notEqual(s.last.winner, 0);
    assert.equal(s.last.room.endDetail, 'surrender');
    s.emit('rematch');
    await until(s, (v) => v.phase === 'play' && !v.out[0]);
  });
});

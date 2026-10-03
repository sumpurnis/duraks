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
    s.log = { notices: [], states: [], reveals: [] };
    s.on('notice', (m) => s.log.notices.push(m));
    s.on('state', (v) => (s.log.states.push(v), (s.last = v)));
    s.on('reveal', (r) => s.log.reveals.push(r));
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

/** Wait until the socket's latest state satisfies pred. */
async function until(s, pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (s.last && pred(s.last)) return s.last;
    await sleep(10);
  }
  throw new Error('condition not reached; last state: ' + JSON.stringify(s.last && { phase: s.last.phase, turn: s.last.turn, room: s.last.room }));
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

/** Both sockets play on their own turns until the game ends. */
async function playOut(a, b, ms = 20000) {
  const end = Date.now() + ms;
  let lastSig = '';
  while (Date.now() < end) {
    if (a.last && a.last.phase === 'over' && b.last && b.last.phase === 'over') return;
    for (const s of [a, b]) {
      const v = s.last;
      if (v && v.phase === 'play' && v.canPlay) {
        const sig = `${v.round}/${v.pile.count}/${v.hand.length}/${v.oppCount}/${s === a}`;
        if (sig !== lastSig) {
          lastSig = sig;
          move(s);
        }
      }
    }
    await sleep(5);
  }
  throw new Error('game did not finish');
}

const noLeak = (v) => assert.ok(!('hands' in v) && !('opponentHand' in v) && !('opp' in v && v.opp.hand), 'view must not leak hidden info');

// ----------------------------------------------------------------------------- vs computer

for (const announce of ['suit']) {
  test(`vs computer (announce=${announce}): quick games run to completion`, async () => {
    await withApp({}, async ({ client }) => {
      for (let i = 0; i < 3; i++) {
        const s = client();
        s.emit('room:create', { name: 'Tester', vsAI: true, announce, handSize: 12 });
        const joined = await once(s, 'room:joined');
        assert.equal(joined.vsAI, true);
        assert.equal(joined.password, null);
        await until(s, (v) => v.phase === 'play');
        const end = Date.now() + 25000;
        while (Date.now() < end && s.last.phase !== 'over') {
          if (s.last.canPlay) move(s);
          await sleep(5);
        }
        assert.equal(s.last.phase, 'over');
        noLeak(s.last);
        assert.equal(s.last.room.opp.ai, true);
        assert.equal(s.log.notices.length, 0, s.log.notices.join('; '));

        // "Play again" restarts at once, without the AI having to agree
        s.emit('rematch');
        await until(s, (v) => v.phase === 'play');
        s.emit('room:leave');
        await once(s, 'room:left');
      }
    });
  });
}

test('computer rooms are never listed and cannot be joined', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { vsAI: true });
    const j = await once(a, 'room:joined');
    await sleep(50);
    b.emit('rooms:refresh');
    assert.deepEqual(await once(b, 'rooms'), []);
    b.emit('room:join', { code: j.code });
    assert.match(await once(b, 'notice'), /no longer open/);
  });
});

// ----------------------------------------------------------------------------- vs player

test('player vs player: create, list, join, separate views', async () => {
  await withApp({}, async ({ client }) => {
    const host = client();
    const guest = client();
    const watcher = client();
    const feed = [];
    watcher.on('rooms', (l) => feed.push(l));
    await sleep(100);

    host.emit('room:create', { name: 'Anna', announce: 'suit-rank', handSize: 12 }); // switched off: must come back as 'suit'
    const hj = await once(host, 'room:joined');
    assert.equal(hj.status, 'waiting');
    assert.equal(hj.seat, 0);
    assert.match(hj.code, /^[A-Z2-9]{5}$/);

    await sleep(100);
    const list = feed[feed.length - 1];
    assert.deepEqual(list, [{ code: hj.code, host: 'Anna', announce: 'suit', handSize: 12, private: false }]);

    guest.emit('room:join', { code: hj.code.toLowerCase(), name: 'Bruno' });
    const gj = await once(guest, 'room:joined');
    assert.equal(gj.seat, 1);
    assert.notEqual(gj.token, hj.token);

    await until(host, (v) => v.phase === 'play');
    await until(guest, (v) => v.phase === 'play');
    assert.equal(host.last.room.opp.name, 'Bruno');
    assert.equal(guest.last.room.opp.name, 'Anna');
    assert.equal(host.last.you, 0);
    assert.equal(guest.last.you, 1);
    assert.equal(host.last.hand.length, 12);
    assert.equal(guest.last.hand.length, 12);
    const ids = new Set([...host.last.hand, ...guest.last.hand].map((c) => c.id));
    assert.equal(ids.size, 24, 'hands are disjoint');
    assert.notEqual(host.last.canPlay, guest.last.canPlay, 'exactly one player may move');
    noLeak(host.last);
    noLeak(guest.last);
    await sleep(100);
    assert.deepEqual(feed[feed.length - 1], [], 'started games leave the list');
  });
});

test('player vs player: full scripted game, then rematch needs both players', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A', announce: 'suit', handSize: 12 });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await playOut(a, b);

    assert.equal(a.last.winner, 1 - b.last.winner === 0 ? a.last.winner : a.last.winner);
    assert.notEqual(a.last.winner, null);
    assert.equal(a.last.winner, b.last.winner);
    const winnerSock = a.last.winner === a.last.you ? a : b;
    assert.equal(winnerSock.last.hand.length, 0);
    assert.equal(a.log.notices.length + b.log.notices.length, 0, [...a.log.notices, ...b.log.notices].join('; '));
    assert.ok(a.log.reveals.length > 0 && a.log.reveals.length === b.log.reveals.length, 'both players see every reveal');

    a.emit('rematch');
    await until(b, (v) => v.room.rematch.opp === true);
    assert.equal(a.last.phase, 'over', 'one vote is not enough');
    b.emit('rematch');
    await until(a, (v) => v.phase === 'play');
    await until(b, (v) => v.phase === 'play');
    assert.equal(a.last.hand.length, 12);
    await playOut(a, b);
  });
});

test('private rooms: listed with a lock, need the generated password', async () => {
  await withApp({}, async ({ client }) => {
    const host = client();
    const guest = client();
    host.emit('room:create', { name: 'H', private: true, handSize: 12 });
    const hj = await once(host, 'room:joined');
    assert.match(hj.password, /^[A-Z2-9]{6}$/);

    guest.emit('rooms:refresh');
    const list = await once(guest, 'rooms');
    assert.equal(list[0].private, true);
    assert.ok(!JSON.stringify(list).includes(hj.password), 'the password is never listed');

    guest.emit('room:join', { code: hj.code, name: 'G' });
    assert.deepEqual(await once(guest, 'room:password'), { code: hj.code, wrong: false });
    guest.emit('room:join', { code: hj.code, name: 'G', password: 'NOPE12' });
    assert.deepEqual(await once(guest, 'room:password'), { code: hj.code, wrong: true });

    guest.emit('room:join', { code: hj.code, name: 'G', password: hj.password.toLowerCase() });
    const gj = await once(guest, 'room:joined');
    assert.equal(gj.password, null, 'only the host is told the password');
    await until(guest, (v) => v.phase === 'play');
    assert.equal(guest.last.room.private, true);
  });
});

test('one room per socket; no joining your own or a full room', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    const c = client();
    a.emit('room:create', { name: 'A' });
    const { code } = await once(a, 'room:joined');

    a.emit('room:create', { name: 'A2' });
    assert.match(await once(a, 'notice'), /already in a game/);
    a.emit('room:join', { code });
    assert.match(await once(a, 'notice'), /already in a game/);

    b.emit('room:join', { code, name: 'B' });
    await once(b, 'room:joined');
    c.emit('room:join', { code, name: 'C' });
    assert.match(await once(c, 'notice'), /no longer open/);

    c.emit('room:join', { code: 'ZZZZZ' });
    assert.match(await once(c, 'notice'), /no longer open/);
  });
});

test('moves are validated: not your turn, malformed, not in a game', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    const lone = client();
    lone.emit('challenge');
    assert.match(await once(lone, 'notice'), /not in a game/);

    a.emit('room:create', { name: 'A', announce: 'suit' });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await until(a, (v) => v.phase === 'play');
    await until(b, (v) => v.phase === 'play');
    const idle = a.last.canPlay ? b : a;
    idle.emit('play', { cardId: idle.last.hand[0].id, claim: { suit: '♠' } });
    assert.match(await once(idle, 'notice'), /not your turn/i);
    idle.emit('play', { nope: true });
    assert.match(await once(idle, 'notice'), /Malformed/);
    idle.emit('challenge');
    assert.equal((await once(idle, 'notice')).length > 0, true);
  });
});

// ----------------------------------------------------------------------------- timers, leaving, reconnecting

test('running out of the move timer forfeits', async () => {
  await withApp({ turnMs: 150 }, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A' });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await until(a, (v) => v.phase === 'play');
    const slow = a.last.canPlay ? a : b;
    const fast = slow === a ? b : a;
    assert.ok(slow.last.room.turnMs > 0 && slow.last.room.turnMs <= 150);
    await until(fast, (v) => v.phase === 'over');
    assert.equal(fast.last.winner, fast.last.you);
    assert.equal(fast.last.room.endDetail, 'timeout');
    await until(slow, (v) => v.phase === 'over');
    assert.equal(slow.last.room.endDetail, 'timeout');
  });
});

test('leaving mid-game forfeits; the other player can leave afterwards', async () => {
  await withApp({}, async ({ client, app }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A' });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await until(b, (v) => v.phase === 'play');

    a.emit('room:leave');
    await once(a, 'room:left');
    await until(b, (v) => v.phase === 'over');
    assert.equal(b.last.winner, b.last.you);
    assert.equal(b.last.room.endDetail, 'left');
    assert.equal(b.last.room.opp.left, true);

    b.emit('rematch');
    assert.match(await once(b, 'notice'), /left/);
    b.emit('room:leave');
    await once(b, 'room:left');
    await sleep(20);
    assert.equal(app.manager.rooms.size, 0, 'room is cleaned up when both are gone');
  });
});

test('a dropped player can resume within the grace period', async () => {
  await withApp({ graceMs: 400 }, async ({ client, port }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A' });
    const hj = await once(a, 'room:joined');
    b.emit('room:join', { code: hj.code, name: 'B' });
    await until(a, (v) => v.phase === 'play');
    const handBefore = a.last.hand.map((c) => c.id).sort();

    a.close();
    await until(b, (v) => v.room.opp.connected === false);

    const a2 = client();
    a2.emit('room:resume', { code: hj.code, token: hj.token });
    const again = await once(a2, 'room:joined');
    assert.equal(again.seat, 0);
    await until(a2, (v) => v.phase === 'play');
    assert.deepEqual(a2.last.hand.map((c) => c.id).sort(), handBefore, 'same hand after resuming');
    await until(b, (v) => v.room.opp.connected === true);

    await sleep(600);
    assert.equal(b.last.phase, 'play', 'grace timer was cancelled by the resume');
  });
});

test('a bad token cannot resume a seat', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    a.emit('room:create', { name: 'A' });
    const hj = await once(a, 'room:joined');
    const thief = client();
    thief.emit('room:resume', { code: hj.code, token: 'f'.repeat(32) });
    await once(thief, 'room:gone');
    thief.emit('room:resume', { code: 'NOPE1', token: hj.token });
    await once(thief, 'room:gone');
  });
});

test('no resume in time: the dropped player forfeits', async () => {
  await withApp({ graceMs: 100 }, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A' });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await until(b, (v) => v.phase === 'play');
    a.close();
    await until(b, (v) => v.phase === 'over');
    assert.equal(b.last.winner, b.last.you);
    assert.equal(b.last.room.endDetail, 'disconnect');
  });
});

test('host dropping from a waiting room removes it from the list', async () => {
  await withApp({ graceMs: 100 }, async ({ client, app }) => {
    const host = client();
    const watcher = client();
    host.emit('room:create', { name: 'H' });
    await once(host, 'room:joined');
    await sleep(30);
    assert.equal(app.manager.listOpen().length, 1);
    host.close();
    await sleep(300);
    assert.equal(app.manager.rooms.size, 0);
    watcher.emit('rooms:refresh');
    assert.deepEqual(await once(watcher, 'rooms'), []);
  });
});

test('cancelling a waiting room removes it at once', async () => {
  await withApp({}, async ({ client, app }) => {
    const host = client();
    host.emit('room:create', { name: 'H' });
    await once(host, 'room:joined');
    host.emit('room:leave');
    await once(host, 'room:left');
    assert.equal(app.manager.rooms.size, 0);
  });
});

test('names are sanitised and the room limit is enforced', async () => {
  await withApp({ maxRooms: 1 }, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: '  <b>Eve</b>\n  ', handSize: 99, announce: 'bogus' });
    const j = await once(a, 'room:joined');
    assert.equal(j.handSize, 12, 'unknown sizes fall back to the 24-card game');
    assert.equal(j.announce, 'suit');
    b.emit('room:join', { code: j.code, name: 'x'.repeat(100) });
    await until(a, (v) => v.phase === 'play');
    assert.equal(a.last.room.myName, 'bEve/b');
    assert.equal(a.last.room.opp.name.length, 20);

    const c = client();
    c.emit('room:create', {});
    assert.match(await once(c, 'notice'), /full/);
  });
});

test('surrender ends the game for the opponent, keeps the room, and rematch still works', async () => {
  await withApp({}, async ({ client }) => {
    const a = client();
    const b = client();
    a.emit('room:create', { name: 'A' });
    const { code } = await once(a, 'room:joined');
    b.emit('room:join', { code, name: 'B' });
    await until(a, (v) => v.phase === 'play');
    await until(b, (v) => v.phase === 'play');

    a.emit('surrender');
    await until(b, (v) => v.phase === 'over');
    await until(a, (v) => v.phase === 'over');
    assert.equal(b.last.winner, b.last.you);
    assert.equal(a.last.room.endDetail, 'surrender');
    assert.equal(a.last.room.opp.left, false, 'surrendering does not leave the room');

    a.emit('rematch');
    b.emit('rematch');
    await until(a, (v) => v.phase === 'play');
    a.emit('surrender');
    a.emit('surrender');
    await until(a, (v) => v.phase === 'over');
    await sleep(30);
    assert.match(a.log.notices.join(' '), /No game in progress/, 'a second surrender is rejected');
  });
});

test('surrender against the computer counts as a loss and Play again restarts', async () => {
  await withApp({}, async ({ client }) => {
    const s = client();
    s.emit('room:create', { name: 'S', vsAI: true });
    await until(s, (v) => v.phase === 'play');
    s.emit('surrender');
    await until(s, (v) => v.phase === 'over');
    assert.equal(s.last.winner, 1 - s.last.you);
    s.emit('rematch');
    await until(s, (v) => v.phase === 'play');
  });
});

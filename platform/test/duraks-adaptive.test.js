'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('../../games/duraks/server/adaptive-ai');
const { Game } = require('../../games/duraks/server/games/duraks-multi');
const { chooseMove } = require('../../games/duraks/server/ai-multi');
const { apply, legalMoves, seededRng } = require('../../games/duraks/server/challenge-ai');

A._useMemoryStore();

/** Plays a whole game: the host by the ordinary computer (or `hostMove`), the rest adaptive. */
function playGame(state, { players = 2, deckSize = 36, seed = 1, hostMove, check } = {}) {
  const ids = ['H', ...['B1', 'B2', 'B3'].slice(0, players - 1)];
  const g = new Game(ids, { deferAutoResolve: true, deckSize, allowTransfer: seed % 2 === 0 });
  const rng = seededRng(seed);
  for (let step = 0; step < 900 && g.status === 'active'; step++) {
    if (g.isRoundResolvable()) { g.tryResolveRound(); continue; }
    if (g.isTakeResolvable()) { A.noteTake(state, g); g.tryResolveTake(); continue; }
    const a = g.pendingActors()[0];
    let mv;
    if (a.playerId === 'H') {
      mv = (hostMove && hostMove(g)) || chooseMove(g, 'H');
      const note = A.observe(state, g, 'H', mv.type);
      const r = apply(g, 'H', mv);
      assert.ok(!(r && r.error), r && r.error);
      A.count(state, note);
      continue;
    }
    if (check) check(g, a.playerId);
    mv = A.chooseAdaptiveMove(state, g, a.playerId, rng);
    assert.ok(mv, 'the computer always finds a move');
    const r = apply(g, a.playerId, mv);
    assert.ok(!(r && r.error), r && r.error);
  }
  assert.strictEqual(g.status, 'finished');
  return g;
}

test('a new player gets exactly the old computer', () => {
  const s = A.startGame('nobody-yet');
  assert.strictEqual(s.strength, 0);
  assert.strictEqual(s.habitWeight, 0);
});

test('the dealt-out guess keeps every count right and never uses the real hidden cards it cannot know', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const state = A.startGame('H');
    state.strength = 0.5;
    playGame(state, {
      players: 2 + (seed % 3),
      deckSize: seed % 2 ? 36 : 52,
      seed,
      check(g, me) {
        const d = A.determinize(g, me, state.known, seededRng(seed * 7));
        assert.ok(d);
        for (const p of g.players) assert.strictEqual(d.hands[p].length, g.hands[p].length);
        assert.deepStrictEqual(d.hands[me], g.hands[me]);
        assert.strictEqual(d.deck.length, g.deck.length);
        if (g.deck.length) assert.strictEqual(d.deck[d.deck.length - 1].id, g.trumpCard.id);
        const ids = [...Object.values(d.hands).flat(), ...d.deck, ...d.discard, ...d.table.flatMap((s) => [s.attack, s.defend].filter(Boolean))].map((c) => c.id);
        assert.strictEqual(new Set(ids).size, g.deckSize);
        // cards it saw being picked up stay where they went
        for (const [p, set] of Object.entries(state.known)) {
          if (p === me) continue;
          for (const c of g.hands[p]) if (set.has(c.id)) assert.ok(d.hands[p].some((x) => x.id === c.id));
        }
      },
    });
  }
});

test('the guess changes with the shuffle (it does not just copy the real hands)', () => {
  const g = new Game(['H', 'B1'], { deferAutoResolve: true, deckSize: 36 });
  const d1 = A.determinize(g, 'B1', {}, seededRng(1));
  const d2 = A.determinize(g, 'B1', {}, seededRng(2));
  const key = (d) => d.hands.H.map((c) => c.id).sort().join();
  assert.notStrictEqual(key(d1), key(d2));
});

test('strength moves slowly, only after a few games, and stays in range', () => {
  const name = 'winner';
  let last = 0;
  for (let i = 0; i < 40; i++) {
    const s = A.recordGame(name, { durak: false, draw: false, totalPlayers: 2, counts: {} });
    if (i < 2) assert.strictEqual(s, 0);
    assert.ok(s - last <= A.STEP + 1e-9, 'never more than one step per game');
    assert.ok(s >= last);
    last = s;
  }
  assert.strictEqual(last, A.MAX_STRENGTH);
  for (let i = 0; i < 80; i++) last = A.recordGame(name, { durak: true, draw: false, totalPlayers: 2, counts: {} });
  assert.strictEqual(last, A.MIN_STRENGTH);
  assert.strictEqual(A.settingsFor(name).habitWeight > 0, true);
});

test('results near the target leave the strength about where it is', () => {
  const name = 'even';
  // 3 players: not being the durak about 70% of the time is the target
  const pattern = [false, false, true, false, false, false, true, false, false, true];
  let s = 0;
  for (let i = 0; i < 30; i++) s = A.recordGame(name, { durak: pattern[i % 10], draw: false, totalPlayers: 3, counts: {} });
  assert.ok(Math.abs(s) < 0.05, `stayed near 0, got ${s}`);
});

test('the host\'s habits are learned from their own decisions', () => {
  const state = A.startGame('H'); // the table's host is H; their record is kept as 'taker'
  // a host who takes whenever they are attacked, even when they could beat everything
  for (let seed = 1; seed <= 6; seed++) {
    playGame(state, { seed, hostMove: (g) => (g.defenderId === 'H' && g.table.some((s) => !s.defend) && !g.pendingTake ? { type: 'take' } : null) });
  }
  assert.ok(state.counts.dc > 0);
  assert.strictEqual(state.counts.at, state.counts.dc);
  for (let i = 0; i < 10; i++) A.recordGame('taker', { durak: true, draw: false, totalPlayers: 2, counts: state.counts });
  const s = A.settingsFor('taker');
  assert.ok(s.habits.take > 0.9, `take habit ${s.habits.take}`);
  assert.ok(Math.abs(s.habitWeight - 0.35) < 1e-9);
});

test('only the host\'s moves are counted, and only once the game accepts them', () => {
  const state = A.startGame('H');
  const g = new Game(['H', 'B1'], { deferAutoResolve: true, deckSize: 36 });
  assert.strictEqual(A.observe(state, g, 'B1', 'take'), null);
  A.count(state, null);
  assert.deepStrictEqual(state.counts, { dc: 0, at: 0, tc: 0, td: 0, xc: 0, xt: 0 });
  assert.strictEqual(A.observe(null, g, 'H', 'take'), null);
});

test('a stronger computer beats the ordinary one more often', () => {
  const games = 60;
  function hostWins(strength) {
    let wins = 0;
    for (let seed = 1; seed <= games; seed++) {
      const state = A.startGame('H');
      state.strength = strength;
      const g = playGame(state, { seed: seed + 1000, players: 3 });
      if (g.durakId && g.durakId !== 'H') wins++;
    }
    return wins / games;
  }
  const weak = hostWins(-0.25);
  const strong = hostWins(0.8);
  assert.ok(weak > strong + 0.15, `weak ${weak} vs strong ${strong}`);
});

test('every move it picks is a legal one', () => {
  const state = A.startGame('H');
  state.strength = 0.8;
  playGame(state, {
    players: 4,
    deckSize: 52,
    seed: 77,
    check(g, me) {
      assert.ok(legalMoves(g, me).length > 0);
    },
  });
});

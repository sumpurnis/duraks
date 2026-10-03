'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MeliGame, RuleError, SUITS } = require('../server/engine');
const ai = require('../server/ai');

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mk = (seed, extra = {}) => new MeliGame({ rng: mulberry32(seed), announce: 'suit', ...extra });
const total = (g) => g.hands[0].length + g.hands[1].length + g.pile.length;
const otherSuit = (s) => SUITS.find((x) => x !== s);

test('suit-only: starter chooses the suit, it locks, and claims carry no rank', () => {
  const g = mk(1);
  const c = g.hands[0][0];
  g.play(0, c.id, { suit: otherSuit(c.suit) }); // a bluff: announces another suit
  assert.equal(g.lockedSuit, otherSuit(c.suit));
  const v = g.view(1);
  assert.equal(v.announce, 'suit');
  assert.deepEqual(v.pile.claims, [{ by: 'opp', rank: null, suit: otherSuit(c.suit) }]);
});

test('suit-only: later cards are implicitly announced as the locked suit; other suits are rejected', () => {
  const g = mk(2);
  const c = g.hands[0][0];
  g.play(0, c.id, { suit: c.suit });
  const reply = g.hands[1][0];
  assert.throws(() => g.play(1, reply.id, { suit: otherSuit(c.suit) }), /locked/);
  g.play(1, reply.id); // no claim at all: means "the locked suit"
  assert.equal(g.pile[1].claim.suit, c.suit);
  assert.equal(g.pile[1].claim.rank, null);
});

test('suit-only: the starter must name a valid suit', () => {
  const g = mk(3);
  assert.throws(() => g.play(0, g.hands[0][0].id, { suit: 'x' }), RuleError);
  assert.throws(() => g.play(0, g.hands[0][0].id), /Announce a suit/);
});

test('suit-only: a card of the announced suit is honest even if the rank is "wrong" (no rank exists)', () => {
  const g = mk(4);
  const c = g.hands[0][0];
  g.play(0, c.id, { suit: c.suit });
  const r = g.challenge(1);
  assert.equal(r.reveal.lie, false);
  assert.equal(r.reveal.claim.rank, null);
  assert.equal(r.reveal.loser, 1, 'wrong challenger picks up the pile');
  assert.equal(g.turn, 0, 'honest player starts the next round');
  assert.equal(total(g), 52);
});

test('suit-only: placing a card of another suit is a lie; liar takes the pile and the caller starts', () => {
  const g = mk(5);
  const c = g.hands[0][0];
  g.play(0, c.id, { suit: otherSuit(c.suit) });
  const r = g.challenge(1);
  assert.equal(r.reveal.lie, true);
  assert.equal(r.reveal.loser, 0);
  assert.equal(g.hands[0].length, 26);
  assert.equal(g.turn, 1);
  assert.equal(g.lockedSuit, null);
});

test('suit-only: emptying the hand honestly wins; with a lie you pick up the pile', () => {
  let g = mk(6, { handSize: 1 });
  let c = g.hands[0][0];
  assert.equal(g.play(0, c.id, { suit: c.suit }).over, true);
  assert.equal(g.winner, 0);

  g = mk(7, { handSize: 1 });
  c = g.hands[0][0];
  const r = g.play(0, c.id, { suit: otherSuit(c.suit) });
  assert.equal(r.over, false);
  assert.equal(g.hands[0].length, 1);
  assert.equal(g.turn, 1);
});

test('invalid announce mode is rejected', () => {
  assert.throws(() => new MeliGame({ announce: 'rank' }), RangeError);
});

for (const [handSize, games] of [[10, 200], [26, 60]]) {
  test(`suit-only AI-vs-AI: ${games} games with ${handSize} cards each finish legally and conserve cards`, () => {
    const lens = [];
    for (let seed = 1; seed <= games; seed++) {
      const rng = mulberry32(seed);
      const g = new MeliGame({ rng, announce: 'suit', handSize });
      let steps = 0;
      while (g.phase === 'play') {
        const me = g.turn;
        const m = ai.decide(g, me, rng);
        if (m.action === 'challenge') g.challenge(me);
        else g.play(me, m.cardId, m.claim);
        assert.equal(total(g), handSize * 2, `conservation (seed ${seed})`);
        if (++steps > 30000) assert.fail(`did not finish (seed ${seed})`);
      }
      assert.equal(g.hands[g.winner].length, 0);
      lens.push(steps);
    }
    lens.sort((a, b) => a - b);
    console.log(`      suit-only ${handSize} cards: median ${lens[lens.length >> 1]} moves, p90 ${lens[Math.floor(lens.length * 0.9)]}, max ${lens[lens.length - 1]}`);
  });
}

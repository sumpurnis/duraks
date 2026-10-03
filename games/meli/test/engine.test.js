'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MeliGame, RuleError, SUITS, RANKS } = require('../server/engine');
const ai = require('../server/ai');

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const truth = (c) => ({ rank: c.rank, suit: c.suit });
const total = (g) => g.hands[0].length + g.hands[1].length + g.pile.length;

/** Find a card in `p`'s hand matching a predicate. */
const find = (g, p, fn) => g.hands[p].find(fn);

test('invalid hand sizes are rejected; undefined options fall back to defaults', () => {
  assert.throws(() => new MeliGame({ handSize: 27 }), RangeError);
  assert.throws(() => new MeliGame({ handSize: 0 }), RangeError);
  assert.equal(new MeliGame({ handSize: undefined }).hands[0].length, 26);
});

test('deals 26 unique cards each, covering the full deck', () => {
  const g = new MeliGame({ rng: mulberry32(1) });
  assert.equal(g.hands[0].length, 26);
  assert.equal(g.hands[1].length, 26);
  const ids = new Set([...g.hands[0], ...g.hands[1]].map((c) => c.id));
  assert.equal(ids.size, 52);
  assert.equal(g.turn, 0);
});

test('first card sets the suit lock; later claims in another suit are rejected', () => {
  const g = new MeliGame({ rng: mulberry32(2) });
  const c = g.hands[0][0];
  g.play(0, c.id, truth(c));
  assert.equal(g.lockedSuit, c.suit);
  assert.equal(g.turn, 1);
  const other = SUITS.find((s) => s !== c.suit);
  const reply = g.hands[1][0];
  assert.throws(() => g.play(1, reply.id, { rank: '5', suit: other }), RuleError);
  // the same card claimed in the locked suit is fine (this is a bluff if it differs)
  g.play(1, reply.id, { rank: '5', suit: c.suit });
  assert.equal(g.pile.length, 2);
});

test('played card leaves the hand; turn order is enforced', () => {
  const g = new MeliGame({ rng: mulberry32(3) });
  const c = g.hands[0][5];
  assert.throws(() => g.play(1, g.hands[1][0].id, truth(g.hands[1][0])), /not your turn/);
  g.play(0, c.id, truth(c));
  assert.equal(g.hands[0].length, 25);
  assert.ok(!g.hands[0].some((x) => x.id === c.id));
  assert.throws(() => g.play(0, g.hands[0][0].id, truth(g.hands[0][0])), /not your turn/);
});

test('view hides the opponent hand and the identity of pile cards', () => {
  const g = new MeliGame({ rng: mulberry32(4) });
  const c = g.hands[0][0];
  g.play(0, c.id, { rank: 'K', suit: c.suit });
  const v = g.view(1);
  assert.equal(v.oppCount, 25);
  assert.equal(v.hand.length, 26);
  assert.deepEqual(Object.keys(v.pile.claims[0]).sort(), ['by', 'rank', 'suit']);
  assert.equal(JSON.stringify(v).includes(c.id) && c.id !== 'K' + c.suit, g.hands[1].some((x) => x.id === c.id));
});

test('challenging a lie: liar takes the pile, challenger starts the next round', () => {
  const g = new MeliGame({ rng: mulberry32(5) });
  const c = g.hands[0][0];
  const wrongRank = RANKS.find((r) => r !== c.rank);
  g.play(0, c.id, { rank: wrongRank, suit: c.suit }); // lie
  const before = g.hands[0].length;
  const r = g.challenge(1);
  assert.equal(r.reveal.lie, true);
  assert.equal(r.reveal.loser, 0);
  assert.equal(g.hands[0].length, before + 1);
  assert.equal(g.pile.length, 0);
  assert.equal(g.lockedSuit, null);
  assert.equal(g.turn, 1, 'challenger starts');
  assert.equal(g.round, 2);
  assert.equal(total(g), 52);
});

test('challenging the truth: challenger takes the pile, honest player starts', () => {
  const g = new MeliGame({ rng: mulberry32(6) });
  const c = g.hands[0][0];
  g.play(0, c.id, truth(c));
  const reply = g.hands[1][0];
  g.play(1, reply.id, { rank: reply.rank, suit: g.lockedSuit }); // may or may not be a lie
  // player 0 challenges player 1's card
  const wasLie = !(reply.suit === g.lockedSuit);
  const before0 = g.hands[0].length;
  const r = g.challenge(0);
  assert.equal(r.reveal.lie, wasLie);
  if (wasLie) {
    assert.equal(g.turn, 0);
    assert.equal(g.hands[1].length, 25 + 2);
  } else {
    assert.equal(g.turn, 1);
    assert.equal(g.hands[0].length, before0 + 2);
  }
  assert.equal(total(g), 52);
});

test('cannot challenge an empty pile, out of turn, or after game over', () => {
  const g = new MeliGame({ rng: mulberry32(7) });
  assert.throws(() => g.challenge(0), /nothing to challenge/);
  assert.throws(() => g.challenge(1), /not your turn/);
});

test('emptying your hand with an honest last card wins the game', () => {
  const g = new MeliGame({ rng: mulberry32(8), handSize: 1 });
  const c = g.hands[0][0];
  const r = g.play(0, c.id, truth(c));
  assert.equal(r.over, true);
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
  assert.throws(() => g.challenge(1), /over/);
});

test('emptying your hand with a lie: you pick up the pile and play continues', () => {
  const g = new MeliGame({ rng: mulberry32(9), handSize: 1 });
  const c = g.hands[0][0];
  const r = g.play(0, c.id, { rank: RANKS.find((x) => x !== c.rank), suit: c.suit });
  assert.equal(r.over, false);
  assert.equal(r.reveal.final, true);
  assert.equal(r.reveal.lie, true);
  assert.equal(g.phase, 'play');
  assert.equal(g.hands[0].length, 1);
  assert.equal(g.turn, 1, 'the player who caught the lie starts');
  assert.equal(total(g), 2);
});

for (const [handSize, games] of [[10, 200], [26, 60]]) {
  test(`AI-vs-AI: ${games} games with ${handSize} cards each always finish, never break a rule, conserve 52 cards`, () => {
    let longest = 0;
    for (let seed = 1; seed <= games; seed++) {
      const rng = mulberry32(seed);
      const g = new MeliGame({ rng, handSize });
      const deckSize = handSize * 2;
      let steps = 0;
      while (g.phase === 'play') {
        const me = g.turn;
        const move = ai.decide(g, me, rng);
        if (move.action === 'challenge') g.challenge(me);
        else g.play(me, move.cardId, move.claim);
        assert.equal(total(g), deckSize, `card conservation broke (seed ${seed})`);
        if (++steps > 30000) assert.fail(`game did not finish (seed ${seed})`);
      }
      longest = Math.max(longest, steps);
      assert.ok(g.winner === 0 || g.winner === 1);
      assert.equal(g.hands[g.winner].length, 0, 'winner has no cards left');
    }
    console.log(`      longest game with ${handSize} cards: ${longest} moves`);
  });
}

test('forfeit: the other player wins and the game is over', () => {
  const g = new MeliGame({ rng: mulberry32(11), handSize: 5 });
  const r = g.forfeit(0);
  assert.deepEqual(r, { type: 'forfeit', over: true, player: 0 });
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 1);
  assert.equal(g.endReason, 'forfeit');
  assert.equal(g.view(1).canPlay, false);
  assert.throws(() => g.play(1, g.hands[1][0].id, { rank: g.hands[1][0].rank, suit: g.hands[1][0].suit }), RuleError);
});

test('half deck: the 24 strongest cards (9 to Ace in every suit), 12 each', () => {
  const g = new MeliGame({ rng: mulberry32(21), handSize: 12, deck: 'half' });
  const all = [...g.hands[0], ...g.hands[1]];
  assert.equal(all.length, 24);
  assert.equal(new Set(all.map((c) => c.id)).size, 24);
  assert.ok(all.every((c) => ['9', '10', 'J', 'Q', 'K', 'A'].includes(c.rank)));
  assert.deepEqual(g.ranks, ['9', '10', 'J', 'Q', 'K', 'A']);
  assert.deepEqual(g.view(0).ranks, g.ranks);
  assert.throws(() => new MeliGame({ handSize: 13, deck: 'half' }), RangeError);
  assert.throws(() => new MeliGame({ deck: 'nope' }), RangeError);
  // announcing a rank that does not exist in this deck is rejected
  g.turn = 0;
  assert.throws(() => g.play(0, g.hands[0][0].id, { rank: '2', suit: g.hands[0][0].suit }), RuleError);
});

test('half deck AI-vs-AI games finish in both modes', () => {
  for (const announce of ['suit', 'suit-rank']) {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const g = new MeliGame({ rng, handSize: 12, deck: 'half', announce });
      let steps = 0;
      while (g.phase === 'play') {
        const m = ai.decide(g, g.turn, rng);
        if (m.action === 'challenge') g.challenge(g.turn); else g.play(g.turn, m.cardId, m.claim);
        if (++steps > 20000) assert.fail(`did not finish (${announce}, seed ${seed})`);
      }
    }
  }
});

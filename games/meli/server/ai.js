'use strict';
/**
 * Simple opponent. It only looks at information a real player would have:
 * its own hand, the lock, and the public claims in the pile.
 */
const { SUITS, RANKS } = require('./engine');

// Tunable so game pace / difficulty can be adjusted without touching the logic.
const tuning = {
  truthRate: 0.65, // chance to play honestly when it can
  base: 0.05, // base chance to call bluff
  perCard: 0.015, // + this per card already in the pile
  cap: 0.3, // never above this (unless the lie is provable)
  suitWeight: 0.2, // suit-only mode: + this * (how unlikely an honest card looks)
};

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const same = (a, b) => a.rank === b.rank && a.suit === b.suit;

// =============== announce: 'suit-rank' ===============

function shouldChallengeRank(game, me, rng) {
  const top = game.pile[game.pile.length - 1];

  // Provably false: I'm holding the card they announced.
  if (game.hands[me].some((c) => same(c, top.claim))) return true;
  // Provably suspicious: the same card was already announced earlier this round.
  if (game.pile.slice(0, -1).some((e) => same(e.claim, top.claim))) return true;

  // Otherwise suspicion grows with the size of the pile (more to win, more to lose).
  return rng() < Math.min(tuning.cap, tuning.base + tuning.perCard * game.pile.length);
}

function bluffClaim(game, me, card, rng) {
  const claimed = new Set(game.pile.map((e) => e.claim.rank + e.claim.suit));

  // Safest lie: announce a card I still hold. The opponent cannot disprove it by
  // checking their own hand, and it has not been announced earlier this round.
  const safe = game.hands[me].filter(
    (c) => c.id !== card.id && !claimed.has(c.id) && (!game.lockedSuit || c.suit === game.lockedSuit)
  );
  if (safe.length) {
    const c = pick(safe, rng);
    return { rank: c.rank, suit: c.suit };
  }

  // Otherwise any unannounced card of the locked suit that isn't the one I'm placing.
  const suit = game.lockedSuit || pick(SUITS, rng);
  const free = game.ranks.filter((r) => !claimed.has(r + suit) && !(r === card.rank && suit === card.suit));
  return { rank: pick(free.length ? free : game.ranks, rng), suit };
}

function choosePlayRank(game, me, rng) {
  const selectable = game.hands[me];
  const legit = game.lockedSuit ? selectable.filter((c) => c.suit === game.lockedSuit) : selectable;

  if (legit.length && rng() < tuning.truthRate) {
    const card = pick(legit, rng);
    return { cardId: card.id, claim: { rank: card.rank, suit: card.suit } };
  }
  // Prefer to bluff with a card that is NOT in the locked suit (keeps legit cards for later).
  const offSuit = game.lockedSuit ? selectable.filter((c) => c.suit !== game.lockedSuit) : [];
  const card = pick(offSuit.length ? offSuit : selectable, rng);
  return { cardId: card.id, claim: bluffClaim(game, me, card, rng) };
}

// =============== announce: 'suit' ===============

function shouldChallengeSuit(game, me, rng) {
  const S = game.lockedSuit;
  const mine = game.hands[me].filter((c) => c.suit === S).length;
  const minePlaced = game.pile.filter((e) => e.player === me && e.card.suit === S).length;
  const theirs = game.pile.filter((e) => e.player !== me).length;
  const outside = 13 - mine - minePlaced; // cards of that suit that could be in the opponent's hand or pile cards

  // Provable: the opponent announced more cards than can possibly be of that suit.
  if (theirs > outside) return true;

  // How plausible is an honest card? Roughly outside / (cards not in my hand).
  const priorTruth = outside / Math.max(1, 52 - game.hands[me].length);
  const p = tuning.base + tuning.perCard * game.pile.length + tuning.suitWeight * (1 - priorTruth);
  return rng() < Math.min(tuning.cap, p);
}

function choosePlaySuit(game, me, rng) {
  const hand = game.hands[me];
  const selectable = hand;

  let suit = game.lockedSuit;
  if (!suit) {
    // Starter: announce the suit I hold most of, so the round suits me.
    const counts = SUITS.map((s) => hand.filter((c) => c.suit === s).length);
    const best = Math.max(...counts);
    suit = pick(SUITS.filter((s, i) => counts[i] === best), rng);
  }

  const inSuit = selectable.filter((c) => c.suit === suit);
  if (inSuit.length && rng() < tuning.truthRate) return { cardId: pick(inSuit, rng).id, claim: { suit } };

  // Bluff: dump a card that is NOT of the announced suit (if there is one).
  const off = selectable.filter((c) => c.suit !== suit);
  return { cardId: pick(off.length ? off : selectable, rng).id, claim: { suit } };
}

// =============== entry point ===============

function decide(game, me, rng = Math.random) {
  const suitOnly = game.opts.announce === 'suit';
  if (game.pile.length && (suitOnly ? shouldChallengeSuit : shouldChallengeRank)(game, me, rng)) {
    return { action: 'challenge' };
  }
  return { action: 'play', ...(suitOnly ? choosePlaySuit : choosePlayRank)(game, me, rng) };
}

module.exports = { decide, tuning };

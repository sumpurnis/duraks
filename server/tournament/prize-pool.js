/**
 * prize-pool.js
 * Turns a tournament's coin prize pool + placement shares into actual
 * per-placement payouts. Kept separate from bracket-generator.js since the
 * payout table only needs to be computed once (at bracket generation, or at
 * tournament completion — whichever your app calls it from) and then looked
 * up as each match resolves a placement.
 */

/**
 * @param {import('./tournament').Tournament} tournament
 * @returns {Object<number, number>} placement -> coin amount, e.g. { 1: 500, 2: 300, 3: 150, 4: 50 }
 */
function calculatePrizePayouts(tournament) {
  const payouts = {};
  for (const [placement, share] of Object.entries(tournament.prizeDistribution)) {
    payouts[placement] = Math.floor(tournament.prizePool * share);
  }
  return payouts;
}

/**
 * The set of placements a bracket of this size will actually produce:
 * 1 (winner), 2 (runner-up), 3 (third place), and 4 only if there were
 * enough participants for a real semifinal-loser third-place match to also
 * leave a distinct 4th place. Below that, everyone left over is grouped by
 * the round they were eliminated in rather than getting a numbered slot.
 */
function getAwardablePlacements(participantCount) {
  if (participantCount <= 2) return [1, 2];
  return [1, 2, 3, 4];
}

/**
 * Warns (rather than throws — prize config is set independently of final
 * headcount) if the organizer configured a payout for a placement that this
 * tournament's actual field size will never produce.
 */
function findUnusablePrizeShares(tournament) {
  const awardable = getAwardablePlacements(tournament.participants.length);
  return Object.keys(tournament.prizeDistribution)
    .map(Number)
    .filter((placement) => !awardable.includes(placement));
}

function awardPrize(tournament, playerId, placement) {
  const payouts = calculatePrizePayouts(tournament);
  const amount = payouts[placement] ?? 0;
  return { playerId, placement, amount };
}

if (typeof module !== 'undefined') {
  module.exports = { calculatePrizePayouts, getAwardablePlacements, findUnusablePrizeShares, awardPrize };
}

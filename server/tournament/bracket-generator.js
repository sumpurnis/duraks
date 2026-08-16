/**
 * bracket-generator.js
 * Turns a tournament's registered participants into a single-elimination
 * bracket: dynamic sizing (no padding to power-of-2), a random bye when the
 * field is odd, best-of-3/5 series per matchup, and a mandatory third-place
 * match between the two semifinal losers.
 *
 * Only round 1 gets concrete player-vs-player pairings at generation time.
 * Every later round is generated as a full skeleton, but its slots are
 * "winner of match X" placeholders until that match actually finishes —
 * that's what your bracket UI should render as "TBD" / "Winner of M2".
 */

/**
 * Ranks participants for seeding.
 * - Players with a real record (games played > 0) are sorted by a
 *   confidence-weighted win rate, so a 100% rate over 2 games doesn't
 *   outrank a 70% rate over 50 games.
 * - Players with no record are shuffled and placed after the ranked group.
 */
function seedParticipants(participants) {
  const CONFIDENCE_CAP_GAMES = 20; // games played beyond this add no extra weight

  const withRecord = participants.filter((p) => p.winRate !== null && p.gamesPlayed > 0);
  const withoutRecord = participants.filter((p) => !(p.winRate !== null && p.gamesPlayed > 0));

  withRecord.sort((a, b) => {
    const confidenceA = Math.min(a.gamesPlayed, CONFIDENCE_CAP_GAMES) / CONFIDENCE_CAP_GAMES;
    const confidenceB = Math.min(b.gamesPlayed, CONFIDENCE_CAP_GAMES) / CONFIDENCE_CAP_GAMES;
    return b.winRate * confidenceB - a.winRate * confidenceA;
  });

  shuffleInPlace(withoutRecord);

  return [...withRecord, ...withoutRecord];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * @param {import('./tournament').Tournament} tournament
 * @returns {{ rounds: Array, finalMatch: Object, thirdPlaceMatch: Object|null, allMatches: Object[] }}
 */
function generateBracket(tournament) {
  if (!tournament.canGenerateBracket()) {
    throw new Error(
      `Need at least ${tournament.minParticipants} participants to generate a bracket ` +
        `(have ${tournament.participants.length})`
    );
  }

  const requiredWins = tournament.seriesFormat === 'bo5' ? 3 : 2;
  const seeded = seedParticipants(tournament.participants);

  let matchIdCounter = 1;
  const allMatches = [];

  // Round 1 slots are seeded players, paired high vs low (best vs worst,
  // 2nd-best vs 2nd-worst, ...) so top seeds don't meet early.
  let currentSlots = buildSeededPairs(seeded).map((participant) => ({
    source: { type: 'seed', participant }
  }));

  const rounds = [];
  let roundNumber = 1;

  while (currentSlots.length > 1) {
    const isOdd = currentSlots.length % 2 === 1;
    let byeSlot = null;
    let pairSlots = currentSlots;

    if (isOdd) {
      // Never hand the same slot a bye two rounds in a row — otherwise a
      // player can get randomly selected repeatedly and coast to the final
      // without ever playing a match. Only fall back to an already-byed
      // slot if literally every slot has one (shouldn't happen in practice).
      const eligibleForBye = currentSlots.filter((s) => !s.hadBye);
      const byePool = eligibleForBye.length > 0 ? eligibleForBye : currentSlots;
      const chosen = byePool[Math.floor(Math.random() * byePool.length)];
      byeSlot = { ...chosen, hadBye: true };
      pairSlots = currentSlots.filter((s) => s !== chosen);
    }

    const matches = [];
    for (let i = 0; i < pairSlots.length; i += 2) {
      const p1Slot = pairSlots[i];
      const p2Slot = pairSlots[i + 1];

      const match = {
        id: `m${matchIdCounter++}`,
        roundNumber,
        isThirdPlaceMatch: false,
        player1Source: p1Slot.source,
        player2Source: p2Slot.source,
        player1: p1Slot.source.type === 'seed' ? p1Slot.source.participant.playerId : null,
        player2: p2Slot.source.type === 'seed' ? p2Slot.source.participant.playerId : null,
        requiredWins,
        player1Wins: 0,
        player2Wins: 0,
        gameIds: [],
        status: 'pending', // pending (inputs not resolved) | ready | in_progress | completed
        winner: null,
        loser: null,
        nextSeriesId: null, // where the winner advances to
        loserNextSeriesId: null // only set for semifinal matches -> third-place match
      };

      // Wire up the previous round's matches to feed into this one.
      if (p1Slot.source.type === 'winner_of') {
        findMatch(allMatches, p1Slot.source.matchId).nextSeriesId = match.id;
      }
      if (p2Slot.source.type === 'winner_of') {
        findMatch(allMatches, p2Slot.source.matchId).nextSeriesId = match.id;
      }

      matches.push(match);
      allMatches.push(match);
    }

    const nextSlots = matches.map((m) => ({ source: { type: 'winner_of', matchId: m.id } }));
    let byeParticipant = null;
    if (byeSlot) {
      byeParticipant =
        byeSlot.source.type === 'seed' ? byeSlot.source.participant.playerId : null;
      // A bye slot just carries its source straight through to the next round
      // (whether that source is an original seed or, in a later round, a
      // still-unresolved match winner).
      nextSlots.push(byeSlot);
    }

    rounds.push({ roundNumber, matches, byeParticipant });
    currentSlots = nextSlots;
    roundNumber++;
  }

  const finalRound = rounds[rounds.length - 1];
  const semifinalRound = rounds.length >= 2 ? rounds[rounds.length - 2] : null;
  const thirdPlaceMatch = buildThirdPlaceMatch(semifinalRound, finalRound, requiredWins, () => `m${matchIdCounter++}`);
  if (thirdPlaceMatch) allMatches.push(thirdPlaceMatch);

  return {
    rounds,
    finalMatch: finalRound.matches[0],
    thirdPlaceMatch,
    allMatches
  };
}

/** Pairs a seeded (best-to-worst) list as 1v N, 2 v N-1, 3 v N-2, ... */
function buildSeededPairs(seeded) {
  const n = seeded.length;
  const ordered = new Array(n);
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) {
    ordered[i * 2] = seeded[i];
    ordered[i * 2 + 1] = seeded[n - 1 - i];
  }
  if (n % 2 === 1) ordered[n - 1] = seeded[half]; // middle seed, only relevant pre-bye-removal
  return ordered;
}

function findMatch(matches, id) {
  const match = matches.find((m) => m.id === id);
  if (!match) throw new Error(`Bracket linking error: no match with id ${id}`);
  return match;
}

/**
 * Creates the mandatory third-place match between the two semifinal losers.
 * Handles the edge cases that fall out of a dynamic bracket with random byes:
 *  - 2 real semifinal matches -> normal third-place match between both losers.
 *  - 1 real semifinal match (the other semifinalist reached the final via a
 *    bye and never played) -> that lone loser is automatically 3rd place,
 *    no match needed.
 *  - 0 real semifinal matches can't happen as long as minParticipants >= 3.
 */
function buildThirdPlaceMatch(semifinalRound, finalRound, requiredWins, nextId) {
  if (!semifinalRound) return null;
  const semifinalMatches = semifinalRound.matches;

  if (semifinalMatches.length === 2) {
    const match = {
      id: nextId(),
      roundNumber: finalRound.roundNumber,
      isThirdPlaceMatch: true,
      player1Source: { type: 'loser_of', matchId: semifinalMatches[0].id },
      player2Source: { type: 'loser_of', matchId: semifinalMatches[1].id },
      player1: null,
      player2: null,
      requiredWins,
      player1Wins: 0,
      player2Wins: 0,
      gameIds: [],
      status: 'pending',
      winner: null,
      loser: null,
      nextSeriesId: null,
      loserNextSeriesId: null
    };
    semifinalMatches[0].loserNextSeriesId = match.id;
    semifinalMatches[1].loserNextSeriesId = match.id;
    return match;
  }

  if (semifinalMatches.length === 1) {
    // No second semifinal loser exists — mark it so the advancement logic
    // knows to place this loser straight into 3rd, with no match to play.
    semifinalMatches[0].loserNextSeriesId = 'auto-third-place';
    return null;
  }

  return null; // unreachable given ABSOLUTE_MIN_PARTICIPANTS = 3
}

if (typeof module !== 'undefined') {
  module.exports = { generateBracket, seedParticipants };
}

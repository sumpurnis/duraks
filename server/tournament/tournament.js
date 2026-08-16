/**
 * tournament.js
 * Core Tournament model: registration window, participant list, eligibility,
 * and prize pool configuration. Bracket generation lives in bracket-generator.js.
 *
 * Adapted from the standalone demo version with two additions needed for
 * the real Duraks integration:
 *   - isPrivate / inviteCode: private tournaments are invisible in the
 *     public list and can only be joined by whoever has the code.
 *   - createdBy is a Duraks username (string), and participants are joined
 *     using a `rating`-shaped player object adapted from Duraks stats (see
 *     server/tournament/store.js — statsToRating()) since Duraks doesn't
 *     have a native ELO/rating number.
 */

'use strict';

// Hard floor — no tournament may ever be configured below this, regardless
// of what the organizer requests.
const ABSOLUTE_MIN_PARTICIPANTS = 3;

class Tournament {
  /**
   * @param {Object} config
   * @param {string} config.id
   * @param {string} config.name
   * @param {string} config.createdBy - Duraks username of the organizer
   * @param {boolean} [config.isPrivate=false]
   * @param {string|null} [config.inviteCode=null] - required if isPrivate
   * @param {number} [config.requiredRank=0] - minimum rating to join
   * @param {number} config.maxParticipants - fixed slot count set by the organizer
   * @param {number} [config.minParticipants=3] - never allowed below ABSOLUTE_MIN_PARTICIPANTS
   * @param {'bo3'|'bo5'} [config.seriesFormat='bo3']
   * @param {Date|string} config.registrationEndTime
   * @param {Date|string} config.startTime
   * @param {number} [config.prizePool=0] - total coins for this tournament (UI-hidden for now)
   * @param {Object<number,number>} [config.prizeDistribution] - placement -> share of pool (must sum to 1)
   */
  constructor({
    id,
    name,
    createdBy,
    isPrivate = false,
    inviteCode = null,
    requiredRank = 0,
    maxParticipants,
    minParticipants = ABSOLUTE_MIN_PARTICIPANTS,
    seriesFormat = 'bo3',
    registrationEndTime,
    startTime,
    prizePool = 0,
    prizeDistribution = { 1: 0.5, 2: 0.3, 3: 0.15, 4: 0.05 }
  }) {
    if (!maxParticipants || maxParticipants < ABSOLUTE_MIN_PARTICIPANTS) {
      throw new Error(`maxParticipants must be at least ${ABSOLUTE_MIN_PARTICIPANTS}`);
    }
    if (minParticipants < ABSOLUTE_MIN_PARTICIPANTS) {
      throw new Error(`minParticipants can never be set below ${ABSOLUTE_MIN_PARTICIPANTS}`);
    }
    if (minParticipants > maxParticipants) {
      throw new Error('minParticipants cannot exceed maxParticipants');
    }
    if (seriesFormat !== 'bo3' && seriesFormat !== 'bo5') {
      throw new Error(`seriesFormat must be 'bo3' or 'bo5', got '${seriesFormat}'`);
    }
    if (isPrivate && !inviteCode) {
      throw new Error('Private tournaments require an inviteCode');
    }
    const distTotal = Object.values(prizeDistribution).reduce((sum, share) => sum + share, 0);
    if (Math.abs(distTotal - 1) > 0.001) {
      throw new Error(`prizeDistribution shares must sum to 1 (got ${distTotal})`);
    }

    this.id = id;
    this.name = name;
    this.createdBy = createdBy;
    this.isPrivate = isPrivate;
    this.inviteCode = isPrivate ? inviteCode : null;
    this.requiredRank = requiredRank;
    this.maxParticipants = maxParticipants;
    this.minParticipants = minParticipants;
    this.seriesFormat = seriesFormat;
    this.registrationEndTime = new Date(registrationEndTime);
    this.startTime = new Date(startTime);
    this.prizePool = prizePool;
    this.prizeDistribution = prizeDistribution;

    this.status = 'registration'; // registration | active | completed | cancelled
    this.participants = []; // { playerId, rating, gamesPlayed, winRate, joinedAt }
    this.bracket = null; // populated by bracket-generator.js when registration closes
    this.createdAt = new Date();
  }

  isRegistrationOpen() {
    return (
      this.status === 'registration' &&
      Date.now() < this.registrationEndTime.getTime() &&
      this.participants.length < this.maxParticipants
    );
  }

  isPlayerEligible(player) {
    return (player.rating ?? 0) >= this.requiredRank;
  }

  hasJoined(playerId) {
    return this.participants.some((p) => p.playerId === playerId);
  }

  /**
   * @param {Object} player - { id, rating, gamesPlayed, winRate }
   */
  join(player) {
    if (this.status !== 'registration') {
      throw new Error('Registration is not open for this tournament');
    }
    if (Date.now() >= this.registrationEndTime.getTime()) {
      throw new Error('Registration window has closed');
    }
    if (this.participants.length >= this.maxParticipants) {
      throw new Error('Tournament is full');
    }
    if (this.hasJoined(player.id)) {
      throw new Error('Player has already joined this tournament');
    }
    if (!this.isPlayerEligible(player)) {
      throw new Error(`Player does not meet the required rank (${this.requiredRank}+)`);
    }

    this.participants.push({
      playerId: player.id,
      rating: player.rating ?? 0,
      gamesPlayed: player.gamesPlayed ?? 0,
      // null = no recorded games yet -> seeded randomly instead of by win rate
      winRate: player.gamesPlayed > 0 ? player.winRate ?? 0 : null,
      joinedAt: new Date()
    });
    return true;
  }

  leave(playerId) {
    if (this.status !== 'registration') {
      throw new Error('Cannot leave after registration has closed');
    }
    const before = this.participants.length;
    this.participants = this.participants.filter((p) => p.playerId !== playerId);
    return this.participants.length < before;
  }

  /** Registration can only close into a valid bracket if the floor is met. */
  canGenerateBracket() {
    return this.participants.length >= this.minParticipants;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { Tournament, ABSOLUTE_MIN_PARTICIPANTS };
}

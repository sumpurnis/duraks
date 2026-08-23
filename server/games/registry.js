'use strict';

/**
 * server/games/registry.js
 *
 * A catalog of playable games, decoupled from the room/socket plumbing in
 * server.js. Right now it lists exactly one game — the existing 52-card
 * Duraks — but this is the seam for adding future games (Duraks variants
 * like a 36-card deck, or entirely unrelated card games) without having to
 * restructure server.js again.
 *
 * Each entry:
 *   id          - stable string key, stored on tournaments/rooms
 *   name        - display name
 *   description - short human-readable blurb
 *   public      - whether regular (non-admin) users can select this game.
 *                 Everything except the base game is currently hidden from
 *                 public view per product decision — the selector UI only
 *                 shows for the admin account until a variant is ready.
 *   createEngine(playerUsernames) - returns a fresh game engine instance
 *                 for a room. All engines are expected to implement the
 *                 same shape as the existing Duraks Game class (attack,
 *                 defend, passTurn, takeCards, viewFor, status/winnerId/
 *                 durakId/etc.) — server.js calls these generically.
 */

const duraks52 = require('./duraks52');
const duraks36 = require('./duraks36');

const DEFAULT_GAME_ID = 'duraks-52';

const GAMES = {
  'duraks-52': {
    id: 'duraks-52',
    name: 'Duraks (52 kārtis)',
    description: 'Klasiskais Duraks ar pilnu 52 kāršu kavu.',
    public: true,
    createEngine: (playerUsernames) => new duraks52.Game(playerUsernames),
  },

  'duraks-36': {
    id: 'duraks-36',
    name: 'Duraks (36 kārtis)',
    description: 'Duraks variants ar mazāku, 36 kāršu kavu (6 līdz A).',
    public: false,
    createEngine: (playerUsernames) => new duraks36.Game(playerUsernames),
  },

  // Future entries go here.
};

function listAllGames() {
  return Object.values(GAMES);
}

function listPublicGames() {
  return listAllGames().filter((g) => g.public);
}

function isValidGameId(id) {
  return Object.prototype.hasOwnProperty.call(GAMES, id);
}

function getGame(id) {
  return GAMES[id] || GAMES[DEFAULT_GAME_ID];
}

module.exports = {
  DEFAULT_GAME_ID,
  listAllGames,
  listPublicGames,
  isValidGameId,
  getGame,
};

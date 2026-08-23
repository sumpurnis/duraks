'use strict';

/**
 * reset-data.js
 * One-time maintenance script: deletes ALL tournaments (finished and
 * ongoing) and resets ALL player statistics back to zero. User accounts
 * themselves (usernames, passwords) are kept — only their stats are wiped.
 *
 * Usage:
 *   1. Stop the server first (avoids a write race with a live process).
 *   2. node reset-data.js
 *   3. Start the server again.
 *
 * This does NOT run automatically as part of the server or the app — it's
 * a manual command you run yourself when you actually want to do this.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'server', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOURNAMENTS_FILE = path.join(DATA_DIR, 'tournaments.json');
const TOURNAMENT_RESULTS_FILE = path.join(DATA_DIR, 'tournament-results.json');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function blankStats() {
  return {
    played: 0,
    won: 0,
    lost: 0,
    wonByForfeit: 0,
    lostByForfeit: 0,
    currentStreak: 0,
    longestStreak: 0,
    daily: { date: todayStr(), played: 0, won: 0, lost: 0, currentStreak: 0, longestStreak: 0 },
  };
}

function resetUserStats() {
  if (!fs.existsSync(USERS_FILE)) {
    console.log('No users.json found — nothing to reset there.');
    return 0;
  }
  const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  const users = raw.users || raw; // back-compat with the older flat-file shape
  let count = 0;
  for (const username of Object.keys(users)) {
    users[username].stats = blankStats(); // account itself (password, email, createdAt) untouched
    count++;
  }
  const output = raw.users ? { users, global: { allTimePlayed: 0, daily: { date: todayStr(), played: 0 } } } : users;
  fs.writeFileSync(USERS_FILE, JSON.stringify(output, null, 2));
  return count;
}

function deleteIfExists(filePath, label) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`Deleted ${label}.`);
    return true;
  }
  console.log(`No ${label} found — nothing to delete.`);
  return false;
}

function main() {
  console.log('Resetting Duraks data...\n');

  const userCount = resetUserStats();
  console.log(`Reset stats for ${userCount} account(s) — logins/passwords kept intact.`);

  deleteIfExists(TOURNAMENTS_FILE, 'tournaments.json (all tournaments, finished and ongoing)');
  deleteIfExists(TOURNAMENT_RESULTS_FILE, 'tournament-results.json (placement history)');

  console.log('\nDone. Restart the server to pick up the clean state.');
}

main();

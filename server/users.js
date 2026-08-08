'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'users.json');
const MIN_PASSWORD_LEN = 4;

function blankStats() {
  return { played: 0, won: 0, lost: 0, wonByForfeit: 0, lostByForfeit: 0 };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let users = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
}

function normalize(username) {
  return String(username || '').trim().slice(0, 20);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function setPassword(record, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  record.salt = salt;
  record.hash = hashPassword(password, salt);
}

function verifyPassword(record, password) {
  if (!record.salt || !record.hash) return false;
  const candidate = hashPassword(password, record.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function toPublic(username, record) {
  // Never send salt/hash to the client.
  return { username, email: record.email || null, stats: { ...blankStats(), ...record.stats } };
}

function usernameExists(username) {
  return !!users[normalize(username)];
}

// Creates a brand-new account. Returns the public record, or null if the
// name is invalid, the password is too short, or the name is already taken.
function createAccount(username, password) {
  const name = normalize(username);
  if (!name) return null;
  if (!password || password.length < MIN_PASSWORD_LEN) return null;
  if (users[name]) return null;

  const record = { createdAt: Date.now(), email: null, stats: blankStats() };
  setPassword(record, password);
  users[name] = record;
  save();
  return toPublic(name, record);
}

// Verifies an existing account's password. Returns the public record, or
// null if the account doesn't exist or the password is wrong.
function verifyLogin(username, password) {
  const name = normalize(username);
  const record = users[name];
  if (!record) return null;
  if (!verifyPassword(record, password)) return null;
  return toPublic(name, record);
}

function recordResult(username, didWin, isForfeit) {
  const name = normalize(username);
  if (!name || !users[name]) return;
  const stats = { ...blankStats(), ...users[name].stats };
  stats.played += 1;
  if (didWin) {
    stats.won += 1;
    if (isForfeit) stats.wonByForfeit += 1;
  } else {
    stats.lost += 1;
    if (isForfeit) stats.lostByForfeit += 1;
  }
  users[name].stats = stats;
  save();
}

function getStats(username) {
  const name = normalize(username);
  return users[name] ? { ...blankStats(), ...users[name].stats } : null;
}

module.exports = { usernameExists, createAccount, verifyLogin, recordResult, getStats, MIN_PASSWORD_LEN };

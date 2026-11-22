'use strict';

// The player's real address, for rate limits and the anomaly report.
//
// On Railway every connection arrives through its proxy, so the TCP address is the proxy's and all
// players would share one rate-limit bucket. The proxy puts the client's address in X-Forwarded-For;
// we take the LAST entry (the one the proxy itself added — anything before it came from the client
// and can be faked). Only trusted when running behind a proxy: on Railway (RAILWAY_* variables are
// set) or when TRUST_PROXY=1. Locally the header is ignored, so nobody can fake an address there.

const discord = require('./discord');

const TRUST_PROXY =
  process.env.TRUST_PROXY === '1' ||
  (process.env.TRUST_PROXY !== '0' && !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID));

function lastForwarded(value) {
  if (!TRUST_PROXY || !value) return null;
  const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Address of a Socket.io client (falls back to the socket id so a limiter key always exists).
 * A player inside the Discord Activity arrives through Discord's proxy, which hides every address, so
 * there a SIGNED Discord request is keyed by its Discord user id instead ("discord:<id>"); an unsigned
 * or forged one keeps the address as usual. Off unless DISCORD_ACTIVITY=1 (see discord.js).
 */
function socketIp(socket) {
  const h = (socket && socket.handshake) || {};
  const dk = discord.discordKey(h.headers);
  if (dk) return dk;
  return lastForwarded(h.headers && h.headers['x-forwarded-for']) || h.address || (socket && socket.id) || 'unknown';
}

module.exports = { TRUST_PROXY, socketIp };

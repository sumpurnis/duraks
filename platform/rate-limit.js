'use strict';

// Minimal in-memory sliding-window rate limiter — no dependency, no
// persistence needed. Used to slow down brute-force login/register
// attempts and profile-scraping, not to be a precise/distributed limiter
// (fine for a single Node process; resets if the server restarts).
//
// check(key) returns { allowed: true } or { allowed: false, retryAfterMs }.
// Once a key exceeds `max` hits inside `windowMs`, it's blocked for
// `blockMs` before it can try again.
function createRateLimiter({ max, windowMs, blockMs }) {
  const hits = new Map();

  function check(key) {
    const now = Date.now();
    const entry = hits.get(key);

    if (entry && entry.blockedUntil && now < entry.blockedUntil) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    }

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
      return { allowed: true };
    }

    entry.count += 1;
    if (entry.count > max) {
      entry.blockedUntil = now + blockMs;
      return { allowed: false, retryAfterMs: blockMs };
    }
    return { allowed: true };
  }

  // Periodic sweep so the map doesn't grow forever with stale keys.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs && (!entry.blockedUntil || now > entry.blockedUntil)) {
        hits.delete(key);
      }
    }
  }, windowMs);
  sweep.unref();

  return { check };
}

module.exports = { createRateLimiter };

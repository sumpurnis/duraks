'use strict';
// Discord Activity support (the games running inside a Discord voice channel).
//
// OFF unless DISCORD_ACTIVITY=1. While off, every function here answers "not Discord" and the site
// behaves exactly as without this file.
//
// Settings (Railway variables):
//   DISCORD_ACTIVITY=1            turn it on
//   DISCORD_CLIENT_ID=…           the Discord application's ID (public; the Discord SDK needs it)
//   DISCORD_PUBLIC_KEY=…          the application's public key (hex, Developer Portal → General).
//                                 With "Proxy Authentication" on in the portal, every request that comes
//                                 through Discord carries a signed note saying which Discord user sent it.
//   DISCORD_REQUIRE_SIGNATURE=1   only signed requests count as Discord (blocks other people's Discord
//                                 apps that point at this site). Turn on after checking that the
//                                 signature arrives (GET /api/discord/check from inside the Activity).
//   PUBLIC_URL                    this site's public address, for links that open outside Discord.
//
// How a request is recognised as Discord:
//   * signed: X-Discord-Proxy-Payload + X-Signature-Ed25519 + X-Signature-Timestamp, checked with the
//     public key (Ed25519 over the decoded payload bytes; created_at must equal the timestamp header,
//     expires_at not passed, application_id = DISCORD_CLIENT_ID);
//   * or (unless DISCORD_REQUIRE_SIGNATURE=1) Discord's launch parameters in the URL
//     (frame_id + instance_id + platform), which the Activity pages keep in their address.
// Only a recognised Discord page may be shown inside Discord (frame-ancestors); everything else keeps
// the site's "not inside other sites" rule. Only a SIGNED request changes the rate-limit key (to the
// Discord user id): a header anyone can type never does.

const crypto = require('crypto');

// Switches: "1" (also true/yes/on, any case, spaces or quotes around it are ignored — Railway's raw editor
// can keep quotes) turns a setting on; anything else leaves it off.
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim().replace(/^["']|["']$/g, '').trim());
const ENABLED = flag(process.env.DISCORD_ACTIVITY);
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const CLIENT_ID = /^\d{5,30}$/.test(clean(process.env.DISCORD_CLIENT_ID)) ? clean(process.env.DISCORD_CLIENT_ID) : '';
const REQUIRE_SIGNATURE = flag(process.env.DISCORD_REQUIRE_SIGNATURE);
const PUBLIC_ORIGIN = (process.env.PUBLIC_URL || 'https://uzspelesim.lv').replace(/\/$/, '');
// Who may show a Discord page in a frame: Discord itself (web, desktop, PTB/Canary) and the Activity's
// own proxy domain (the Activity frame sits on <app id>.discordsays.com).
const FRAME_ANCESTORS = "'self' https://discord.com https://*.discord.com https://discordapp.com https://*.discordapp.com https://*.discordsays.com";

// Ed25519 public key from its raw 32 bytes (hex), via the fixed SPKI prefix — no extra packages.
function loadPublicKey(hex) {
  const h = String(hex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(h, 'hex')]), format: 'der', type: 'spki' });
  } catch { return null; }
}
let publicKey = loadPublicKey(clean(process.env.DISCORD_PUBLIC_KEY));
let clientId = CLIENT_ID;
let enabled = ENABLED;
let requireSignature = REQUIRE_SIGNATURE;

function header(headers, name) {
  if (!headers) return '';
  const v = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function decodeSignature(s) {
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Buffer.from(s, 'hex');
  try { const b = Buffer.from(s, 'base64'); return b.length === 64 ? b : null; } catch { return null; }
}

// A verified payload is cached by its exact header values until it expires (pages make many requests).
const verified = new Map(); // `${sig}|${ts}|${payload}` -> { payload, until }
const MAX_CACHE = 5000;

/** The signed Discord payload of a request ({ user_id, channel_id, guild_id, … }), or null. */
function verifyProxy(headers, now = Date.now()) {
  if (!enabled || !publicKey) return null;
  const payloadB64 = header(headers, 'x-discord-proxy-payload');
  const sig = header(headers, 'x-signature-ed25519');
  const ts = header(headers, 'x-signature-timestamp');
  if (!payloadB64 || !sig || !ts || payloadB64.length > 4096 || sig.length > 200 || ts.length > 20) return null;
  const key = `${sig}|${ts}|${payloadB64}`;
  const hit = verified.get(key);
  if (hit) {
    if (hit.until > now) return hit.payload;
    verified.delete(key);
    return null;
  }
  const bytes = Buffer.from(payloadB64, 'base64');
  const signature = decodeSignature(sig);
  if (!bytes.length || !signature) return null;
  // the signature first, before any field is trusted
  let ok = false;
  try { ok = crypto.verify(null, bytes, publicKey, signature); } catch { ok = false; }
  if (!ok) return null;
  let p;
  try { p = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  if (String(p.created_at) !== ts) return null;
  const toMs = (v) => { const n = Number(v); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN; };
  const created = toMs(p.created_at), expires = toMs(p.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return null;
  if (created > now + 60 * 1000 || expires <= now) return null;
  if (clientId && p.application_id !== undefined && String(p.application_id) !== clientId) return null;
  if (p.user_id !== undefined && !/^\d{5,30}$/.test(String(p.user_id))) return null;
  if (verified.size >= MAX_CACHE) verified.clear();
  verified.set(key, { payload: p, until: expires });
  return p;
}

/** Discord's launch parameters in a URL query (the Activity keeps them in every page address). */
function hasLaunchParams(query) {
  if (!query) return false;
  const s = (k) => (typeof query[k] === 'string' ? query[k] : '');
  return /^[\w.:-]{1,200}$/.test(s('frame_id')) && /^[\w.:-]{1,200}$/.test(s('instance_id')) && (s('platform') === 'desktop' || s('platform') === 'mobile');
}

/** Is this HTTP request a Discord Activity page/request? */
function isDiscordRequest(req) {
  if (!enabled) return false;
  if (verifyProxy(req.headers)) return true;
  return !requireSignature && hasLaunchParams(req.query);
}

/** Rate-limit / anti-abuse key for a signed Discord request ("discord:<user id>"), else null. */
function discordKey(headers) {
  const p = verifyProxy(headers);
  return p && p.user_id ? 'discord:' + p.user_id : null;
}

// ---------- one table per Discord instance (everyone in the voice channel lands at it) ----------
// game:instance -> { code, at }. The game modules are asked whether the room is still open.
const TABLE_TTL_MS = 12 * 60 * 60 * 1000;
const tables = new Map();
const validInstance = (s) => typeof s === 'string' && /^[\w.:-]{1,200}$/.test(s);
const validCode = (s) => typeof s === 'string' && /^[A-Z0-9-]{3,12}$/.test(s);

function sweepTables(now = Date.now()) {
  for (const [k, t] of tables) if (now - t.at > TABLE_TTL_MS) tables.delete(k);
}

/**
 * The open table of this instance for each game: { duraks: 'M-777N' | null, meli: … }.
 * isOpen(game, code) -> true while that room still takes players.
 */
function lookupTables(instance, games, isOpen) {
  const out = {};
  for (const g of games) {
    out[g] = null;
    if (!validInstance(instance)) continue;
    const t = tables.get(g + ':' + instance);
    if (!t) continue;
    if (isOpen(g, t.code)) out[g] = t.code;
    else tables.delete(g + ':' + instance);
  }
  return out;
}

/** Remembers a newly made table for the instance — unless the instance already has an open one. */
function bindTable(instance, game, code, isOpen) {
  if (!validInstance(instance) || !validCode(code)) return { ok: false, error: 'bad' };
  if (!isOpen(game, code)) return { ok: false, error: 'closed' };
  const k = game + ':' + instance;
  const cur = tables.get(k);
  if (cur && cur.code !== code && isOpen(game, cur.code)) return { ok: false, error: 'taken', code: cur.code };
  sweepTables();
  if (tables.size > 20000) return { ok: false, error: 'full' };
  tables.set(k, { code, at: Date.now() });
  return { ok: true };
}

/** What the browser side needs (nothing secret). */
function publicConfig() {
  return { enabled, clientId, publicOrigin: PUBLIC_ORIGIN };
}

/** For tests only: change the settings without restarting. */
function _configure(o = {}) {
  if ('enabled' in o) enabled = !!o.enabled;
  if ('clientId' in o) clientId = o.clientId || '';
  if ('publicKeyHex' in o) publicKey = loadPublicKey(o.publicKeyHex);
  if ('requireSignature' in o) requireSignature = !!o.requireSignature;
  verified.clear();
  tables.clear();
}

// Say so in the deploy log when the switch is set but not understood (e.g. DISCORD_ACTIVITY=enabled).
if (!ENABLED && clean(process.env.DISCORD_ACTIVITY) && !/^(0|false|no|off)$/i.test(clean(process.env.DISCORD_ACTIVITY))) {
  console.warn(`Discord Activity: OFF — DISCORD_ACTIVITY is set but not to 1 (it has ${String(process.env.DISCORD_ACTIVITY).length} characters)`);
}

module.exports = {
  get enabled() { return enabled; },
  get signatureConfigured() { return !!publicKey; },
  get requireSignature() { return requireSignature; },
  FRAME_ANCESTORS,
  PUBLIC_ORIGIN,
  verifyProxy,
  hasLaunchParams,
  isDiscordRequest,
  discordKey,
  lookupTables,
  bindTable,
  publicConfig,
  _configure,
};

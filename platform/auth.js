'use strict';

// Accounts for the whole site (Duraks, Meļi and any later game): register / log in / log out,
// "remember me" session tokens, password reset, e-mail, and Google / Facebook sign-in.
//
// Nothing in here knows about a particular game. A game that needs to react to a login passes hooks:
//   beforeRegistered(socket, rec)  right after the account is known, before the client is told
//   afterRegistered(socket, rec)   after the client got its `registered` event
// The public feedback board lives here too, since every game's lobby shows it.

const crypto = require('crypto');
const users = require('./users');
const mailer = require('./mailer');
const oauth = require('./oauth');
const { createRateLimiter } = require('./rate-limit');
const { registerFeedbackHandlers } = require('./feedback');

// Brute-force / scraping protection. Keyed by IP where possible (falls back
// to socket id if a proxy hides it) — a few honest mistyped-password
// retries are fine, but repeated automated attempts get slowed way down.
const loginLimiter = createRateLimiter({ max: 8, windowMs: 60 * 1000, blockMs: 2 * 60 * 1000 });
const registerLimiter = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000, blockMs: 10 * 60 * 1000 });
// Covers forgotPassword — generous enough for a genuine "tried the wrong
// email twice" case, tight enough to blunt using this as a free way to
// spam someone's inbox.
const forgotLimiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 });

function sendError(socket, message) {
  socket.emit('errorMsg', message);
}

// ---------- Google / Facebook login (OAuth2, plain HTTP redirects) ----------
//
// This is the one part of auth that can't go through Socket.io — the
// provider itself has to redirect the browser back to us with a `code`.
// Once that round-trip is done, control is handed back to the normal
// socket-based auth: a successful login redirects to `/?oauthUser=...
// &oauthToken=...`, which the client picks up exactly like a saved
// "remember me" token (see loginWithToken) and clears from the URL; a
// brand-new signup (no existing account matched) redirects to
// `/?oauthChoose=<pendingToken>&suggested=...` instead, so the client can
// show a one-field "pick a username" form before the account is created.
//
// oauthStates guards against CSRF (a forged callback hit without ever
// having started the flow); oauthPending holds a just-verified provider
// identity just long enough for that username step. Both are small,
// short-lived, and only ever touched from these routes — an in-memory Map
// is enough, no need for a persisted store.
const oauthStates = new Map(); // state -> { provider, expiresAt }
const oauthPending = new Map(); // pendingToken -> { provider, providerId, email, expiresAt }
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expiresAt < now) oauthStates.delete(k);
  for (const [k, v] of oauthPending) if (v.expiresAt < now) oauthPending.delete(k);
}, 5 * 60 * 1000).unref();

function suggestUsernameFrom(name) {
  const base = String(name || 'Spēlētājs')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents so e.g. "Jānis" -> "Janis"
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16) || 'Speletajs';
  return users.usernameExists(base) ? `${base}${Math.floor(Math.random() * 900 + 100)}` : base;
}

// Where a finished login sends the browser back to. Default is the Duraks lobby (the old behaviour,
// so its own Google/Facebook buttons keep working untouched); the landing page asks for "/" and
// can add a "next" page to continue to once logged in. Only these exact paths are accepted, so
// the redirect can never be pointed at another site.
const OAUTH_RETURN_PATHS = new Set(['/', '/duraks', '/meli/']);
function pickReturnPath(v, fallback) {
  return typeof v === 'string' && OAUTH_RETURN_PATHS.has(v) ? v : fallback;
}
function oauthRedirectUrl(entry, params) {
  const base = (entry && entry.returnTo) || '/duraks';
  const qs = new URLSearchParams(params);
  if (entry && entry.next) qs.set('next', entry.next);
  return base + '?' + qs.toString();
}


/** The Google / Facebook redirect routes (/auth/providers, /auth/:provider, /auth/:provider/callback). */
function registerHttpRoutes(app) {
  app.get('/auth/providers', (req, res) => {
    res.json({ google: oauth.isConfigured('google'), facebook: oauth.isConfigured('facebook') });
  });

  app.get('/auth/:provider', (req, res) => {
    const { provider } = req.params;
    if (!oauth.PROVIDERS[provider]) return res.status(404).send('Nezināms pieteikšanās veids');
    if (!oauth.isConfigured(provider)) {
      return res.redirect(
        oauthRedirectUrl(
          { returnTo: pickReturnPath(req.query.return, '/duraks'), next: pickReturnPath(req.query.next, null) },
          { oauthError: `${provider} pieteikšanās šeit vēl nav iestatīta` },
        ),
      );
    }
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, {
      provider,
      returnTo: pickReturnPath(req.query.return, '/duraks'),
      next: pickReturnPath(req.query.next, null),
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });
    res.redirect(oauth.buildAuthUrl(provider, state));
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const { provider } = req.params;
    const { code, state, error } = req.query;
    if (!oauth.PROVIDERS[provider]) return res.status(404).send('Nezināms pieteikšanās veids');
    const stateEntry = state && oauthStates.get(state);
    const back = stateEntry && stateEntry.provider === provider ? stateEntry : null;
    if (error) return res.redirect(oauthRedirectUrl(back, { oauthError: 'Pieteikšanās atcelta' }));

    if (!stateEntry || stateEntry.provider !== provider || stateEntry.expiresAt < Date.now()) {
      return res.redirect(oauthRedirectUrl(null, { oauthError: 'Pieteikšanās saite vairs nav derīga, mēģini vēlreiz' }));
    }
    oauthStates.delete(state);

    if (!code) return res.redirect(oauthRedirectUrl(stateEntry, { oauthError: 'Pieteikšanās neizdevās' }));

    try {
      const profile = await oauth.exchangeCodeForProfile(provider, code);
      if (!profile.id) throw new Error('provider returned no id');

      let name = users.findUsernameByOAuth(provider, profile.id);

      if (!name && profile.email) {
        const emailMatch = users.findUsernameByEmail(profile.email);
        if (emailMatch) {
          users.linkOAuth(emailMatch, provider, profile.id, profile.email);
          name = emailMatch;
        }
      }

      if (name) {
        const token = users.createSessionToken(name);
        return res.redirect(oauthRedirectUrl(stateEntry, { oauthUser: name, oauthToken: token }));
      }

      const pendingToken = crypto.randomBytes(24).toString('hex');
      oauthPending.set(pendingToken, {
        provider,
        providerId: profile.id,
        email: profile.email,
        expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
      });
      const suggested = suggestUsernameFrom(profile.name);
      return res.redirect(oauthRedirectUrl(stateEntry, { oauthChoose: pendingToken, suggested }));
    } catch (err) {
      console.error(`${provider} OAuth callback failed:`, err);
      return res.redirect(oauthRedirectUrl(stateEntry, { oauthError: 'Pieteikšanās neizdevās, mēģini vēlreiz' }));
    }
  });
}

/** Auth + feedback events for one socket. Returns { getUsername } for the game code to use. */
function registerSocketHandlers(io, socket, hooks = {}) {
  let username = null; // set once this socket has logged in
  const getUsername = () => username;

  // Public feedback board (platform/feedback.js) — shares nothing with any game but the username getter,
  // so a post/comment is attributed to the logged-in account automatically.
  registerFeedbackHandlers(io, socket, { getUsername });

  // onAuthenticated logs the socket in and tells the client a session
  // token to remember it by. `token` is either a freshly-minted one
  // (register/login) or the same token the client already had (a
  // loginWithToken reconnect) — either way it's the only thing ever
  // persisted client-side now; the account password itself never is.
  function onAuthenticated(rec, token) {
    username = rec.username;
    if (hooks.beforeRegistered) hooks.beforeRegistered(socket, rec);
    // Fed into the anomaly-detection tool (platform/tools/anomaly-report.js)
    // to flag accounts that always connect from the same IP as each other —
    // one signal among several, not proof by itself (shared households,
    // NAT, and VPNs all produce the same signal innocently).
    users.recordLoginIp(username, socket.handshake.address);
    socket.emit('registered', { ...rec, sessionToken: token || null });
    if (hooks.afterRegistered) hooks.afterRegistered(socket, rec);
  }

  socket.on('register', ({ username: name, password, email }) => {
    const rl = registerLimiter.check(socket.handshake.address || socket.id);
    if (!rl.allowed) return sendError(socket, 'Pārāk daudz mēģinājumu. Pamēģini vēlreiz pēc brīža.');
    if (!password || password.length < users.MIN_PASSWORD_LEN) {
      return sendError(socket, `Parolei jābūt vismaz ${users.MIN_PASSWORD_LEN} rakstzīmes garai`);
    }
    // Email is temporarily optional at registration (the field is hidden
    // in the UI while the email-sending flow is still being finished —
    // see public/client.js). If one is provided anyway, still validate it.
    if (email && !users.isValidEmail(email)) {
      return sendError(socket, 'Nederīga e-pasta adrese');
    }
    if (email && users.findUsernameByEmail(email)) {
      return sendError(socket, 'Šis e-pasts jau tiek izmantots citam kontam');
    }
    const rec = users.createAccount(name, password, email);
    if (!rec) return sendError(socket, 'Šis lietotājvārds jau ir aizņemts (vai ir nederīgs)');
    const token = users.createSessionToken(rec.username);
    onAuthenticated(rec, token);
  });

  socket.on('login', ({ username: name, password }) => {
    const rl = loginLimiter.check(socket.handshake.address || socket.id);
    if (!rl.allowed) return sendError(socket, 'Pārāk daudz mēģinājumu. Pamēģini vēlreiz pēc brīža.');
    const rec = users.verifyLogin(name, password);
    if (!rec) return sendError(socket, 'Nepareizs lietotājvārds vai parole');
    const token = users.createSessionToken(rec.username);
    onAuthenticated(rec, token);
  });

  // Token-based "remember me" reconnect — used instead of storing the
  // account password in localStorage. Rate-limited the same as a normal
  // login since a leaked/guessed token attempt looks identical.
  socket.on('loginWithToken', ({ username: name, token }) => {
    const rl = loginLimiter.check(socket.handshake.address || socket.id);
    if (!rl.allowed) return sendError(socket, 'Pārāk daudz mēģinājumu. Pamēģini vēlreiz pēc brīža.');
    const rec = users.verifySessionToken(name, token);
    if (!rec) return sendError(socket, 'Sesija vairs nav derīga, lūdzu piesakies no jauna');
    onAuthenticated(rec, token);
  });

  // Explicit logout: invalidate just this one device's token so a stolen
  // token can't be used again, without touching the account's other
  // logged-in devices.
  socket.on('logout', ({ username: name, token } = {}) => {
    if (name && token) users.invalidateSessionToken(name, token);
  });

  socket.on('checkUsername', ({ username: name }) => {
    socket.emit('usernameStatus', { username: name, exists: users.usernameExists(name) });
  });

  // ---------- Account recovery (forgot password / forgot username) ----------
  //
  // Both handlers always emit the same "sent" event whether or not the
  // email actually matched an account — never reveal which emails are
  // registered (a classic account-enumeration leak) by responding
  // differently for a match vs a miss.

  function publicBaseUrl() {
    const h = socket.handshake.headers || {};
    const origin = h.origin || h.referer;
    if (origin) return origin.replace(/\/$/, '');
    return (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  }

  socket.on('forgotPassword', ({ email } = {}) => {
    const rl = forgotLimiter.check(socket.handshake.address || socket.id);
    if (!rl.allowed) return sendError(socket, 'Pārāk daudz mēģinājumu. Pamēģini vēlreiz pēc brīža.');
    const name = users.findUsernameByEmail(email);
    if (name) {
      const token = users.createPasswordResetToken(name);
      const link = `${publicBaseUrl()}/?reset=${token}`;
      mailer
        .sendPasswordResetEmail(users.normalizeEmail(email), name, link)
        .catch((err) => console.error('Neizdevās nosūtīt paroles atiestatīšanas e-pastu:', err));
    }
    socket.emit('forgotPasswordSent');
  });

// Lets the reset-password screen confirm a token is still valid before
  // showing the "choose a new password" form (e.g. a stale/already-used
  // link should say so immediately, not after the person fills it in).
  socket.on('checkResetToken', ({ token } = {}) => {
    const name = users.findUsernameByResetToken(token);
    socket.emit('resetTokenStatus', { valid: !!name });
  });

  socket.on('resetPassword', ({ token, newPassword } = {}) => {
    if (!newPassword || newPassword.length < users.MIN_PASSWORD_LEN) {
      return sendError(socket, `Parolei jābūt vismaz ${users.MIN_PASSWORD_LEN} rakstzīmes garai`);
    }
    const ok = users.resetPasswordWithToken(token, newPassword);
    if (!ok) return sendError(socket, 'Šī saite ir nederīga vai vairs nav spēkā. Pieprasi jaunu.');
    socket.emit('passwordResetDone');
  });

  // Lets an already-logged-in account add or change its email — the only
  // way an account created before email was required ever gets one on
  // file, and needed for the recovery flow above to work for them.
  socket.on('updateEmail', ({ email } = {}) => {
    if (!username) return sendError(socket, 'Vispirms ielogojies');
    const result = users.updateEmail(username, email);
    if (!result.ok) return sendError(socket, result.error);
    socket.emit('emailUpdated', { email: result.email });
  });

  // Final step of a brand-new Google/Facebook signup: the person has just
  // picked a username for the account we're about to create from their
  // verified OAuth identity (see the /auth/:provider/callback route above,
  // which is what put this pendingToken in oauthPending in the first
  // place).
  socket.on('completeOAuthSignup', ({ pendingToken, username: name } = {}) => {
    const pending = pendingToken && oauthPending.get(pendingToken);
    if (!pending || pending.expiresAt < Date.now()) {
      return sendError(socket, 'Šī pieteikšanās sesija vairs nav derīga. Mēģini pieteikties vēlreiz.');
    }
    const rec = users.createAccountFromOAuth(name, pending.provider, pending.providerId, pending.email);
    if (!rec) return sendError(socket, 'Šis lietotājvārds jau ir aizņemts (vai ir nederīgs)');
    oauthPending.delete(pendingToken);
    const token = users.createSessionToken(rec.username);
    onAuthenticated(rec, token);
  });
  return { getUsername };
}

module.exports = { registerHttpRoutes, registerSocketHandlers, sendError };

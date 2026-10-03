'use strict';

// Minimal, dependency-free OAuth2 "Authorization Code" flow for Google and
// Facebook login. Deliberately not pulling in a framework like Passport —
// both providers follow the exact same three-step shape, so a small
// hand-rolled version stays easy to read and audit:
//
//   1. Send the browser to the provider's "authorize" URL.
//   2. The provider redirects back to our callback route with a `code`.
//   3. We exchange that code server-side for an access token, then call
//      the provider's "who am I" endpoint with it to get their id, email
//      and name.
//
// Configuration is entirely via environment variables. A provider whose
// vars aren't set is simply not offered (isConfigured() returns false) —
// there's no hard requirement to set up both.
//
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET
//   PUBLIC_URL — this app's own base URL (e.g. https://duraks.up.railway.app),
//                used to build each provider's redirect_uri. This MUST
//                exactly match the redirect URI registered in that
//                provider's developer console — unlike the password-reset
//                email link, this can't be guessed from the request, since
//                the provider itself validates it. Defaults to
//                http://localhost:3000 for local dev.

const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

const PROVIDERS = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile',
    redirectPath: '/auth/google/callback',
  },
  facebook: {
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/token',
    profileUrl: 'https://graph.facebook.com/me',
    scope: 'email public_profile',
    redirectPath: '/auth/facebook/callback',
  },
};

function isConfigured(provider) {
  const p = PROVIDERS[provider];
  return !!(p && p.clientId && p.clientSecret);
}

function redirectUri(provider) {
  return `${PUBLIC_URL}${PROVIDERS[provider].redirectPath}`;
}

function buildAuthUrl(provider, state) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: p.scope,
    state,
  });
  return `${p.authUrl}?${params.toString()}`;
}

// Exchanges an authorization `code` for the person's provider id, email
// and name. Throws on any failure — callers should catch and show a
// generic "login failed" outcome rather than leaking provider errors.
async function exchangeCodeForProfile(provider, code) {
  const p = PROVIDERS[provider];
  const tokenParams = new URLSearchParams({
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: redirectUri(provider),
    code,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenParams.toString(),
  });
  if (!tokenRes.ok) throw new Error(`${provider} token exchange failed: HTTP ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error(`${provider} token exchange returned no access_token`);

  const profileUrl =
    provider === 'facebook'
      ? `${p.profileUrl}?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`
      : p.profileUrl;
  const profileHeaders = provider === 'facebook' ? {} : { Authorization: `Bearer ${accessToken}` };
  const profileRes = await fetch(profileUrl, { headers: profileHeaders });
  if (!profileRes.ok) throw new Error(`${provider} profile fetch failed: HTTP ${profileRes.status}`);
  const profile = await profileRes.json();

  return {
    id: String(profile.id || profile.sub || ''),
    email: profile.email || null,
    name: profile.name || null,
  };
}

module.exports = { PROVIDERS, isConfigured, buildAuthUrl, exchangeCodeForProfile };

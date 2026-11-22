// Uzspēlēsim.lv front page: the player profile window, opened from a village on the map (logged-in players).
//
// The window itself (Kopā + one tab per game) is the shared /profile-window.js, the same one the Duraks
// lobby uses; styles: duraks-profile.css (the Duraks look, scoped .dk) + /profile-window.css.
// Data: POST /api/player/full with the saved login.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);

  let req = 0;
  let lastFocus = null;
  function close() {
    if (el('profileModal').classList.contains('hidden')) return;
    el('profileModal').classList.add('hidden');
    req++;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  el('profileCloseBtn').addEventListener('click', close);
  el('profileModal').addEventListener('click', (e) => {
    if (e.target.id === 'profileModal') close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // The saved login (the same keys every game page uses). Read directly as well, so an older cached
  // landing.js without UzsSite.creds() can't make a logged-in player look logged out.
  function savedLogin() {
    if (window.UzsSite && window.UzsSite.creds) { const c = window.UzsSite.creds(); if (c) return c; }
    try {
      const me = localStorage.getItem('duraks_username'), token = localStorage.getItem('duraks_token');
      return me && token ? { me, token } : null;
    } catch (e) { return null; }
  }

  // Returns false when there is no saved login (the map then shows the short card instead).
  function open(name) {
    const creds = savedLogin();
    if (!creds) return false;
    lastFocus = document.activeElement;
    const my = ++req;
    fetch('/api/player/full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, me: creds.me, token: creds.token }),
      cache: 'no-store',
    })
      .then((r) => (r.status === 401 ? { login: true } : r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        if (my !== req) return;
        const toast = (msg) => { const t = el('toast'); if (!t) return; t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3500); };
        if (!d) return toast('Profils šobrīd nav pieejams — vai serveris ir restartēts pēc atjaunināšanas?');
        if (d.login) { toast('Sesija vairs nav derīga, lūdzu piesakies no jauna'); if (window.UzsSite) window.UzsSite.openModal('login'); return; }
        // the shared window (platform/public/profile-window.js): Kopā + one tab per game
        window.UzsProfileWindow.render(el('profileBody'), d.games ? d : { username: d.username, stats: d.stats, history: d.history, eloByPool: d.elo }, { defaultTab: 'all' });
        el('profileModal').classList.remove('hidden');
        el('profileCloseBtn').focus();
      });
    return true;
  }

  window.UzsProfile = { open, close };
})();

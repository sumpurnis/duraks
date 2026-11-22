// Added to the Duraks / Meļi page only when it is opened inside the Discord Activity (the server puts the
// script tag in; on the normal site this file is never loaded). It does not touch the game itself:
//   * the page knows the real site's address (share links point at uzspelesim.lv, not at Discord's proxy);
//   * a table started here becomes this voice channel's table (the others are offered it);
//   * links: "← Uzspēlēsim.lv" goes back to the Activity's game picker, other pages and sites open
//     outside Discord (Discord does not let the Activity frame load them).
(function () {
  'use strict';
  var me = document.currentScript;
  var game = (me && me.getAttribute('data-game')) || '';
  var publicOrigin = (me && me.getAttribute('data-public-origin')) || location.origin;
  var params = new URLSearchParams(location.search);
  var instanceId = params.get('instance_id') || '';
  var LAUNCH_KEYS = ['frame_id', 'instance_id', 'platform', 'guild_id', 'channel_id', 'location_id', 'custom_id', 'referrer_id', 'mobile_app_version'];

  window.UZS_SITE_ORIGIN = publicOrigin;
  document.documentElement.classList.add('uzs-discord');

  var shell = null;
  try { if (window.parent !== window && window.parent.UzsDiscordShell) shell = window.parent.UzsDiscordShell; } catch (e) { shell = null; }

  function launchQuery() {
    var q = new URLSearchParams();
    LAUNCH_KEYS.forEach(function (k) { if (params.has(k)) q.set(k, params.get(k)); });
    return q.toString();
  }
  function goHome() {
    if (shell) shell.home();
    else location.href = '/discord/?' + launchQuery();
  }
  function openExternal(url) {
    if (shell) return shell.openExternal(url);
    window.open(url, '_blank', 'noopener');
  }

  // ---- links ----
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    var u;
    try { u = new URL(href, location.href); } catch (err) { return; }
    e.preventDefault();
    if (u.origin === location.origin) {
      if (u.pathname === '/' || u.pathname.indexOf('/discord') === 0) return goHome();
      if (u.pathname === '/duraks' || u.pathname.indexOf('/meli/') === 0) {
        // another game page: keep Discord's parameters in the address
        var q = new URLSearchParams(u.search);
        new URLSearchParams(launchQuery()).forEach(function (v, k) { q.set(k, v); });
        location.href = u.pathname + '?' + q.toString() + u.hash;
        return;
      }
      // any other page of the site (feedback board, privacy…): on the real site, outside Discord
      return openExternal(publicOrigin + u.pathname + u.search + u.hash);
    }
    openExternal(u.href);
  }, true);

  // ---- this voice channel's table ----
  var bound = '';
  document.addEventListener('uzs:table', function (e) {
    var d = e.detail || {};
    if (!d.creator || !d.code || d.game !== game || !instanceId || bound === d.code) return;
    bound = d.code;
    fetch('/api/discord/table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: instanceId, game: game, code: d.code }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (res && res.ok && shell && shell.tableMade) shell.tableMade(game, d.code);
    }).catch(function () { bound = ''; });
  });
})();

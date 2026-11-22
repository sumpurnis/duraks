// The Discord Activity's start page. It stays loaded for the whole session: it holds the Discord SDK
// connection (Discord only accepts the hand-shake from the page it opened) and shows the chosen game in
// a frame inside itself. The game page talks to it through window.UzsDiscordShell (same site).
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var instanceId = params.get('instance_id') || '';
  var picker = document.getElementById('picker');
  var frame = document.getElementById('gameFrame');
  var sdk = null;
  var sdkReady = false; // the hand-shake with Discord finished (never, outside Discord)
  var tables = { duraks: null, meli: null };
  var inGame = false;

  // ---- Discord SDK (outside Discord, e.g. a local test, the page works without it) ----
  fetch('/api/discord/config', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (cfg && cfg.publicOrigin) window.UZS_SITE_ORIGIN = cfg.publicOrigin;
      if (!cfg || !cfg.clientId || !window.DiscordEmbeddedSDK) return;
      try {
        sdk = new window.DiscordEmbeddedSDK.DiscordSDK(cfg.clientId, { disableConsoleLogOverride: true });
        sdk.ready().then(function () { sdkReady = true; document.documentElement.classList.add('uzs-sdk-ready'); }, function () {});
      } catch (e) {
        sdk = null; // not inside Discord (no frame_id…): links simply open in a new tab
        console.warn('Discord SDK not started:', e && e.message);
      }
    })
    .catch(function () {});

  function openExternal(url) {
    var u;
    try { u = new URL(url, window.UZS_SITE_ORIGIN || location.origin); } catch (e) { return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    if (sdk && sdkReady) {
      sdk.commands.openExternalLink({ url: u.href }).catch(function () {});
    } else {
      window.open(u.href, '_blank', 'noopener');
    }
  }

  // ---- the open tables of this voice channel ----
  function renderTables() {
    ['duraks', 'meli'].forEach(function (g) {
      var sub = document.querySelector('[data-sub="' + g + '"]');
      if (!sub) return;
      sub.textContent = tables[g] ? 'Galds šajā kanālā: ' + tables[g] + ' — pievienoties' : (g === 'duraks' ? '2–4 spēlētāji' : '2–6 spēlētāji');
      sub.parentNode.classList.toggle('has-table', !!tables[g]);
    });
  }
  function refreshTables() {
    if (inGame || document.hidden || !instanceId) return;
    fetch('/api/discord/table?instance=' + encodeURIComponent(instanceId), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { tables.duraks = d.duraks || null; tables.meli = d.meli || null; renderTables(); } })
      .catch(function () {});
  }
  refreshTables();
  setInterval(refreshTables, 5000);
  document.addEventListener('visibilitychange', refreshTables);

  // ---- open a game in the frame (with Discord's parameters, so it is recognised as the Activity) ----
  function play(game) {
    var q = new URLSearchParams(location.search);
    q.delete('table');
    if (tables[game]) q.set('table', tables[game]);
    frame.src = (game === 'duraks' ? '/duraks' : '/meli/') + '?' + q.toString();
    frame.classList.remove('hidden');
    picker.classList.add('hidden');
    inGame = true;
  }
  function home() {
    frame.classList.add('hidden');
    frame.src = 'about:blank';
    picker.classList.remove('hidden');
    inGame = false;
    refreshTables();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.dgame'), function (b) {
    b.addEventListener('click', function () { play(b.getAttribute('data-game')); });
  });

  window.UzsDiscordShell = {
    instanceId: instanceId,
    home: home,
    openExternal: openExternal,
    // a game page tells us its new table, so the picker shows it to the others right away
    tableMade: function (game, code) { if (game in tables) { tables[game] = code; renderTables(); } },
  };
})();

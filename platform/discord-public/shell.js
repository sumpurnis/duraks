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
  var loginAvailable = false;
  var clientId = '';
  var tables = { duraks: null, meli: null };
  var inGame = false;

  // A small grey status line: what happened with the Discord connection and login (for setting up).
  function status(msg) { var el = document.getElementById('dstatus'); if (el) el.textContent = msg ? 'Discord: ' + msg : ''; }

  // ---- Discord SDK (outside Discord, e.g. a local test, the page works without it) ----
  fetch('/api/discord/config', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (cfg && cfg.publicOrigin) window.UZS_SITE_ORIGIN = cfg.publicOrigin;
      if (!cfg || !cfg.clientId) return status('serverim nav iestatīts DISCORD_CLIENT_ID');
      if (!window.DiscordEmbeddedSDK) return status('SDK fails neielādējās');
      clientId = cfg.clientId;
      loginAvailable = !!cfg.loginAvailable;
      showAccount();
      status('savienojas…');
      try {
        sdk = new window.DiscordEmbeddedSDK.DiscordSDK(cfg.clientId, { disableConsoleLogOverride: true });
        var slow = setTimeout(function () { if (!sdkReady) status('neatbild (savienojums ar Discord neizveidojās)'); }, 8000);
        sdk.ready().then(function () {
          clearTimeout(slow);
          sdkReady = true;
          status(cfg.loginAvailable ? 'savienots' : 'savienots (pieteikšanās serverī nav ieslēgta)');
          document.documentElement.classList.add('uzs-sdk-ready');
          if (loginAvailable) discordLogin();
        }, function () {});
      } catch (e) {
        sdk = null; // not inside Discord (no frame_id…): links simply open in a new tab
        console.warn('Discord SDK not started:', e && e.message);
        status('SDK nestartēja — ' + ((e && e.message) || 'nezināma kļūda'));
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

  // ---- account: Discord login (the games pick up the saved login, same keys as the website) ----
  var USER_KEY = 'duraks_username', TOKEN_KEY = 'duraks_token';
  function store(op, k, v) {
    try {
      if (op === 'get') return localStorage.getItem(k);
      if (op === 'set') localStorage.setItem(k, v);
    } catch (e) { /* storage blocked: the player stays a guest */ }
    return null;
  }
  var $ = function (id) { return document.getElementById(id); };
  var pendingId = null;

  function showAccount() {
    var name = store('get', USER_KEY);
    var hasToken = !!store('get', TOKEN_KEY);
    $('acctName').textContent = name && hasToken ? name : 'Viesis';
    $('acctLogin').classList.toggle('hidden', !loginAvailable || !!(name && hasToken && linkedHere));
  }
  var linkedHere = false; // this Discord account is linked to the saved login
  function loggedIn(r) {
    store('set', USER_KEY, r.username);
    store('set', TOKEN_KEY, r.token);
    linkedHere = true;
    closePanel();
    showAccount();
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Neizdevās — mēģini vēlreiz.'); return d; }); });
  }
  function discordLogin() {
    if (!sdk || !sdkReady || !clientId) return status(sdk ? 'vēl nav savienots — uzgaidi brīdi' : 'nav savienots ar Discord');
    status('gaida atļauju (Authorize)…');
    sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] })
      .then(function (r) { return post('/api/discord/auth', { code: r.code }); })
      .then(function (d) {
        if (d.status === 'ok') { status('ielogojies'); return loggedIn(d); }
        if (d.status === 'choose') { status('konts vēl nav piesaistīts'); openPanel(d); }
      })
      .catch(function (e) {
        var m = (e && (e.message || e.code)) || 'nezināma kļūda';
        console.warn('Discord login:', m);
        status('pieteikšanās neizdevās — ' + m);
        showAccount(); // declined or failed: guest, with the "Ielogoties ar Discord" link
      });
  }
  function openPanel(d) {
    pendingId = d.pending;
    $('authTitle').textContent = 'Sveiks' + (d.discordName ? ', ' + d.discordName : '') + '!';
    $('authNewName').value = d.suggested || '';
    var saved = store('get', USER_KEY), savedToken = store('get', TOKEN_KEY);
    var cur = $('authLinkCurrent');
    cur.classList.toggle('hidden', !(saved && savedToken));
    cur.textContent = 'Piesaistīt kontam «' + (saved || '') + '»';
    $('authUser').value = saved || '';
    $('authPass').value = '';
    setError('');
    $('authPanel').classList.remove('hidden');
  }
  function closePanel() { $('authPanel').classList.add('hidden'); pendingId = null; }
  function setError(msg) { var e = $('authError'); e.textContent = msg; e.classList.toggle('hidden', !msg); }
  function busy(btn, on) { btn.disabled = on; }
  function act(btn, url, body) {
    if (!pendingId) return;
    busy(btn, true);
    setError('');
    body.pending = pendingId;
    post(url, body).then(loggedIn, function (e) { setError(e.message); }).then(function () { busy(btn, false); });
  }
  $('authCreate').addEventListener('click', function () {
    var name = $('authNewName').value.trim();
    if (!name) return setError('Ievadi lietotājvārdu.');
    act(this, '/api/discord/create', { name: name });
  });
  $('authLink').addEventListener('click', function () {
    var u = $('authUser').value.trim(), p = $('authPass').value;
    if (!u || !p) return setError('Ievadi lietotājvārdu un paroli.');
    act(this, '/api/discord/link', { username: u, password: p });
  });
  $('authLinkCurrent').addEventListener('click', function () {
    act(this, '/api/discord/link', { username: store('get', USER_KEY) || '', token: store('get', TOKEN_KEY) || '' });
  });
  $('authGuest').addEventListener('click', function () { closePanel(); showAccount(); });
  $('acctLogin').addEventListener('click', discordLogin);
  showAccount();

  window.UzsDiscordShell = {
    instanceId: instanceId,
    home: home,
    openExternal: openExternal,
    // a game page tells us its new table, so the picker shows it to the others right away
    tableMade: function (game, code) { if (game in tables) { tables[game] = code; renderTables(); } },
  };
})();

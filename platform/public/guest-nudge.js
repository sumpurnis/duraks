// Gentle "create an account" prompt for guests on a game page (Duraks, Meļi).
// Shared by both games: one account works on every game on Uzspēlēsim.lv.
//
// It never blocks play. It shows once per browser session, a few seconds after the page loads,
// only while the player is still in the lobby (never in the middle of a game), and only to people
// who are not logged in. "Turpināt kā viesim" dismisses it for the rest of the session.
(function () {
  'use strict';

  var USER_KEY = 'duraks_username';
  var TOKEN_KEY = 'duraks_token';
  var DISMISS_KEY = 'uzspelesim.nudgeDismissed';
  var SHOW_AFTER_MS = 6000;

  // Not inside the landing page's preview frame.
  if (window.top !== window.self) return;
  if (new URLSearchParams(location.search).has('preview')) return;

  function store(kind, op, key, value) {
    try {
      var s = kind === 'local' ? window.localStorage : window.sessionStorage;
      if (op === 'get') return s.getItem(key);
      if (op === 'set') s.setItem(key, value);
    } catch (e) { /* storage blocked: act like a fresh visitor */ }
    return null;
  }

  function loggedIn() {
    return !!(store('local', 'get', USER_KEY) && store('local', 'get', TOKEN_KEY));
  }

  function lobbyVisible() {
    var lobby = document.getElementById('lobby');
    return !!lobby && !lobby.classList.contains('hidden') && lobby.offsetParent !== null;
  }

  if (loggedIn() || store('session', 'get', DISMISS_KEY)) return;

  var CSS =
    '.gn-card{position:fixed;right:16px;bottom:16px;z-index:9999;width:min(340px,calc(100vw - 32px));' +
    'box-sizing:border-box;padding:18px 18px 16px;border-radius:14px;color:#faf6ec;' +
    'background:linear-gradient(180deg,#234a3c,#0f2b22);border:1px solid rgba(201,162,75,.6);' +
    'box-shadow:0 10px 30px rgba(0,0,0,.55);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '.gn-card h2{margin:0 0 6px;font-family:Georgia,"Times New Roman",serif;font-size:1.15rem;color:#e2c374;padding-right:28px}' +
    '.gn-card p{margin:0 0 12px;font-size:.88rem;line-height:1.45;color:#c9d6cf}' +
    '.gn-x{position:absolute;top:6px;right:6px;width:44px;height:44px;border:0;border-radius:50%;background:transparent;' +
    'color:#e2c374;font-size:1.5rem;line-height:1;cursor:pointer}' +
    '.gn-btn{display:block;box-sizing:border-box;width:100%;margin:0 0 8px;padding:11px 14px;border-radius:8px;text-align:center;' +
    'text-decoration:none;font:600 .92rem -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer}' +
    '.gn-primary{border:0;background:linear-gradient(180deg,#e2c374,#c9a24b);color:#2a2005}' +
    '.gn-secondary{background:transparent;border:1px solid #c9a24b;color:#e2c374}' +
    '.gn-link{display:block;width:100%;margin:2px 0 0;padding:10px;border:0;background:none;color:#9db3a8;' +
    'font:.82rem -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-decoration:underline;cursor:pointer}' +
    '.gn-btn:focus-visible,.gn-x:focus-visible,.gn-link:focus-visible{outline:3px solid #e2c374;outline-offset:2px}';

  var card = null;
  var watchTimer = null;

  function remove() {
    if (watchTimer) clearInterval(watchTimer);
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  function dismiss() {
    store('session', 'set', DISMISS_KEY, '1');
    remove();
  }

  function show(googleOn) {
    if (card || loggedIn() || !lobbyVisible()) return;
    var next = encodeURIComponent(location.pathname === '/' ? '/duraks' : location.pathname);

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    card = document.createElement('div');
    card.className = 'gn-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Izveido kontu');
    card.innerHTML =
      '<button type="button" class="gn-x" aria-label="Aizvērt">×</button>' +
      '<h2>Saglabā savu progresu</h2>' +
      '<p>Izveido bezmaksas kontu — viens konts darbojas visās Uzspēlēsim.lv spēlēs.</p>' +
      '<a class="gn-btn gn-primary" href="/?auth=signup&next=' + next + '">Reģistrēties</a>' +
      (googleOn ? '<a class="gn-btn gn-secondary" href="/auth/google?return=/&next=' + next + '">Turpināt ar Google</a>' : '') +
      '<a class="gn-btn gn-secondary" href="/?auth=login&next=' + next + '">Man jau ir konts</a>' +
      '<button type="button" class="gn-link">Turpināt kā viesim</button>';
    document.body.appendChild(card);
    card.querySelector('.gn-x').addEventListener('click', dismiss);
    card.querySelector('.gn-link').addEventListener('click', dismiss);

    // If the player logs in on the page meanwhile, or walks into a game, get out of the way.
    watchTimer = setInterval(function () {
      if (loggedIn() || !lobbyVisible()) remove();
    }, 1500);
  }

  setTimeout(function () {
    if (loggedIn() || !lobbyVisible()) return;
    fetch('/auth/providers')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (p) { show(!!(p && p.google)); });
  }, SHOW_AFTER_MS);
})();

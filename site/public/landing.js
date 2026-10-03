// Uzspēlēsim.lv landing page.
//
// Account handling deliberately reuses Duraks' existing auth, nothing new on the server:
//   - the same Socket.io events (register / login / loginWithToken / completeOAuthSignup / forgotPassword),
//   - the same localStorage keys, so logging in here also logs you in on /duraks and /meli,
//   - the same server-side Google/Facebook OAuth routes (/auth/google, /auth/facebook).
// The only addition is `?return=/` on those routes, so the finished login comes back to this page.
// The game buttons are plain links to /duraks and /meli/ (each game has its own page).
(function () {
  'use strict';

  var USER_KEY = 'duraks_username';
  var TOKEN_KEY = 'duraks_token';
  var SESSION_EXPIRED_MSG = 'Sesija vairs nav derīga, lūdzu piesakies no jauna';
  var NEXT_OK = { '/duraks': true, '/meli/': true };

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  function ls(op, key, value) {
    try {
      if (op === 'get') return localStorage.getItem(key);
      if (op === 'set') localStorage.setItem(key, value);
      if (op === 'del') localStorage.removeItem(key);
    } catch (e) { /* storage blocked: behave like a guest */ }
    return null;
  }

  // A page to continue to once logged in (set by the game pages' sign-up prompt). Whitelisted.
  var next = (function () {
    var v = params.get('next');
    if (v === '/meli') v = '/meli/';
    return v && NEXT_OK[v] ? v : null;
  })();

  // ---------------------------------------------------------------- toast
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 4500);
  }

  // ---------------------------------------------------------------- account state
  // This page keeps NO permanent socket: it connects only to verify a saved login, log in, register
  // or log out, then hangs up, so it never holds the account's "latest connection" away from a game.
  var socket = io({ autoConnect: false });
  var me = null;
  var autoLoginTried = false;
  var releaseTimer = null;

  function renderAccount() {
    $('guestArea').classList.toggle('hidden', !!me);
    $('userArea').classList.toggle('hidden', !me);
    $('userName').textContent = me || '';
  }
  function useSocket(fn) {
    clearTimeout(releaseTimer);
    if (socket.connected) fn();
    else { socket.once('connect', fn); socket.connect(); }
  }
  function release(delay) {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(function () { socket.disconnect(); }, delay || 200);
  }

  socket.on('registered', function (rec) {
    me = rec.username;
    ls('set', USER_KEY, me);
    // sessionToken is only present on register/login/loginWithToken; a plain token reconnect keeps the old one.
    if (rec.sessionToken) ls('set', TOKEN_KEY, rec.sessionToken);
    renderAccount();
    closeModal();
    release();
    if (next) location.assign(next); // sent here from a game's sign-up prompt: go back to that game
  });

  socket.on('errorMsg', function (msg) {
    if (msg === SESSION_EXPIRED_MSG && autoLoginTried && !me) {
      // A stale saved login: forget it quietly, the visitor is simply a guest.
      ls('del', USER_KEY);
      ls('del', TOKEN_KEY);
      autoLoginTried = false;
      renderAccount();
      release();
      return;
    }
    if (!$('authOverlay').classList.contains('hidden')) showError(msg);
    else toast(msg);
  });

  socket.on('forgotPasswordSent', function () {
    showStatus('Ja šāds e-pasts ir reģistrēts, mēs tam nosūtījām paroles atiestatīšanas saiti.');
  });

  function verifySavedLogin() {
    var u = ls('get', USER_KEY);
    var t = ls('get', TOKEN_KEY);
    if (!(u && t)) return;
    me = u; // shown at once so the header does not flicker; corrected below if the token is stale
    autoLoginTried = true;
    useSocket(function () { socket.emit('loginWithToken', { username: u, token: t }); });
  }

  $('logoutBtn').addEventListener('click', function () {
    var creds = { username: ls('get', USER_KEY), token: ls('get', TOKEN_KEY) };
    ls('del', USER_KEY);
    ls('del', TOKEN_KEY);
    me = null;
    renderAccount();
    useSocket(function () { socket.emit('logout', creds); release(400); });
  });

  // Logging in or out in another tab of the site (or a game page) keeps this header in step.
  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== USER_KEY && e.key !== TOKEN_KEY) return;
    me = ls('get', USER_KEY) && ls('get', TOKEN_KEY) ? ls('get', USER_KEY) : null;
    renderAccount();
  });

  // ---------------------------------------------------------------- pop-up
  var mode = null; // 'signup' | 'login' | 'forgot' | 'oauth'
  var oauthPending = null; // pending token from a first-time Google/Facebook sign-up
  var lastFocus = null;

  function showError(msg) {
    $('amStatus').classList.add('hidden');
    var e = $('amError');
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function showStatus(msg) {
    $('amError').classList.add('hidden');
    var s = $('amStatus');
    s.textContent = msg;
    s.classList.remove('hidden');
  }
  function clearMessages() {
    $('amError').classList.add('hidden');
    $('amStatus').classList.add('hidden');
  }

  function setMode(m) {
    mode = m;
    clearMessages();
    var signup = m === 'signup';
    var login = m === 'login';
    var forgot = m === 'forgot';
    var oauth = m === 'oauth';

    $('amTitle').textContent = signup ? 'Izveido kontu' : login ? 'Laipni lūgts atpakaļ' : forgot ? 'Atjaunot paroli' : 'Izvēlies lietotājvārdu';
    $('fUserRow').classList.toggle('hidden', forgot);
    $('fPassRow').classList.toggle('hidden', forgot || oauth);
    $('fConfirmRow').classList.toggle('hidden', !signup);
    $('fEmailRow').classList.toggle('hidden', !forgot);
    $('amOAuth').classList.toggle('hidden', !(signup || login) || !providersOn);
    $('fPassLabel').textContent = signup ? 'Izvēlies paroli' : 'Parole';
    $('fPass').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('amSubmit').textContent = signup ? 'Reģistrēties' : login ? 'Pieslēgties' : forgot ? 'Nosūtīt saiti' : 'Turpināt';
    $('amForgot').classList.toggle('hidden', !login);
    var sw = $('amSwitch');
    sw.classList.toggle('hidden', oauth);
    sw.textContent = signup ? 'Jau ir konts? Pieslēgties' : login ? 'Pirmo reizi? Reģistrēties' : 'Atpakaļ uz pieslēgšanos';
    $('amGuest').classList.toggle('hidden', oauth);

    var first = forgot ? $('fEmail') : $('fUser');
    setTimeout(function () { first.focus(); }, 0);
  }

  function openModal(m) {
    lastFocus = document.activeElement;
    $('fPass').value = '';
    $('fConfirm').value = '';
    $('authOverlay').classList.remove('hidden');
    setMode(m);
  }
  function closeModal() {
    if ($('authOverlay').classList.contains('hidden')) return;
    $('authOverlay').classList.add('hidden');
    release(500);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  $('loginOpen').addEventListener('click', function () { openModal('login'); });
  $('signupOpen').addEventListener('click', function () { openModal('signup'); });
  $('amClose').addEventListener('click', closeModal);
  $('amGuest').addEventListener('click', function () {
    closeModal();
    $('games').scrollIntoView();
  });
  $('amForgot').addEventListener('click', function () { setMode('forgot'); });
  $('amSwitch').addEventListener('click', function () {
    // signup -> login, login -> signup, forgot -> back to login
    setMode(mode === 'login' ? 'signup' : 'login');
  });
  $('authOverlay').addEventListener('mousedown', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  $('amForm').addEventListener('submit', function (e) {
    e.preventDefault();
    clearMessages();
    var user = $('fUser').value.trim();
    var pass = $('fPass').value;

    if (mode === 'forgot') {
      var email = $('fEmail').value.trim();
      if (!email) return showError('Ievadi e-pasta adresi');
      useSocket(function () { socket.emit('forgotPassword', { email: email }); });
      return;
    }
    if (!user) return showError('Ievadi lietotājvārdu');

    if (mode === 'oauth') {
      useSocket(function () { socket.emit('completeOAuthSignup', { pendingToken: oauthPending, username: user }); });
    } else if (mode === 'signup') {
      if (pass.length < 8) return showError('Parolei jābūt vismaz 8 rakstzīmes garai');
      if (pass !== $('fConfirm').value) return showError('Paroles nesakrīt');
      useSocket(function () { socket.emit('register', { username: user, password: pass, email: '' }); });
    } else {
      if (!pass) return showError('Ievadi paroli');
      useSocket(function () { socket.emit('login', { username: user, password: pass }); });
    }
  });

  // ---------------------------------------------------------------- Google / Facebook
  var providersOn = false;
  // Google/Facebook come back to this page (return=/), then on to the game the visitor was heading for (next).
  var returnQs = '?return=/' + (next ? '&next=' + encodeURIComponent(next) : '');
  $('googleLoginBtn').setAttribute('href', '/auth/google' + returnQs);
  $('facebookLoginBtn').setAttribute('href', '/auth/facebook' + returnQs);

  fetch('/auth/providers')
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (p) {
      $('googleLoginBtn').classList.toggle('hidden', !p.google);
      $('facebookLoginBtn').classList.toggle('hidden', !p.facebook);
      providersOn = !!(p.google || p.facebook);
      if (mode === 'signup' || mode === 'login') $('amOAuth').classList.toggle('hidden', !providersOn);
    });

  // ---------------------------------------------------------------- coming back from Google/Facebook
  function stripParams(keys) {
    var url = new URL(location.href);
    keys.forEach(function (k) { url.searchParams.delete(k); });
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  }

  var oUser = params.get('oauthUser');
  var oToken = params.get('oauthToken');
  var oChoose = params.get('oauthChoose');
  var oError = params.get('oauthError');
  var wanted = params.get('auth');

  if (oUser && oToken) {
    ls('set', USER_KEY, oUser);
    ls('set', TOKEN_KEY, oToken);
    stripParams(['oauthUser', 'oauthToken']);
    // the socket's connect handler logs in with the saved token
  } else if (oChoose) {
    oauthPending = oChoose;
    var suggested = params.get('suggested') || '';
    stripParams(['oauthChoose', 'suggested']);
    openModal('oauth');
    $('fUser').value = suggested;
  } else if (oError) {
    stripParams(['oauthError']);
    toast(oError);
  } else if (wanted === 'signup' || wanted === 'login') {
    stripParams(['auth']);
    openModal(wanted);
  }

  // ---------------------------------------------------------------- start
  me = ls('get', USER_KEY) && ls('get', TOKEN_KEY) ? ls('get', USER_KEY) : null;
  renderAccount();
  verifySavedLogin();
})();

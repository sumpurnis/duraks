'use strict';

// Sign-in for a game lobby that is not Duraks (Meļi). It is the same flow as the Duraks lobby:
// the same Socket.io events on the main namespace, the same Google/Facebook server routes, and the
// same localStorage keys, so one account works in every game.
//
// `socket` is deliberately global: board-preview-client.js (the feedback column) uses it too.
// This socket is anonymous. It only logs in for the moment a visitor signs in or registers, and the
// page reloads straight after, so it never holds the account's "latest connection" away from a game.
const socket = io();

(function () {
  var USER_KEY = 'duraks_username';
  var TOKEN_KEY = 'duraks_token';
  var el = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var RETURN = location.pathname.indexOf('/meli') === 0 ? '/meli/' : '/duraks';
  var authMode = null;

  function ls(op, k, v) {
    try {
      if (op === 'get') return localStorage.getItem(k);
      if (op === 'set') localStorage.setItem(k, v);
      if (op === 'del') localStorage.removeItem(k);
    } catch (e) { /* storage blocked: stays a guest */ }
    return null;
  }

  function showError(msg) {
    var e = el('lobbyError');
    e.textContent = msg;
    e.classList.remove('hidden');
  }

  // ---- username -> password -> register / log in
  el('continueBtn').addEventListener('click', function () {
    var name = el('nameInput').value.trim();
    if (!name) return showError('Ievadi lietotājvārdu');
    socket.emit('checkUsername', { username: name });
  });
  el('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('continueBtn').click(); });

  socket.on('usernameStatus', function (r) {
    el('continueBtn').classList.add('hidden');
    el('passwordFields').classList.remove('hidden');
    if (r.exists) {
      authMode = 'login';
      el('passwordLabel').textContent = 'Parole';
      el('confirmField').classList.add('hidden');
      el('authBtn').textContent = 'Ielogoties';
    } else {
      authMode = 'register';
      el('passwordLabel').textContent = 'Izvēlies paroli';
      el('confirmField').classList.remove('hidden');
      el('authBtn').textContent = 'Reģistrēties';
    }
    el('passwordInput').value = '';
    el('confirmInput').value = '';
    el('passwordInput').focus();
  });

  function submitAuth() {
    var name = el('nameInput').value.trim();
    var password = el('passwordInput').value;
    if (authMode === 'register') {
      if (password.length < 8) return showError('Parolei jābūt vismaz 8 rakstzīmes garai');
      if (password !== el('confirmInput').value) return showError('Paroles nesakrīt');
      socket.emit('register', { username: name, password: password, email: '' });
    } else {
      socket.emit('login', { username: name, password: password });
    }
  }
  el('authBtn').addEventListener('click', submitAuth);
  el('confirmInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
  el('passwordInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && authMode === 'login') submitAuth(); });

  socket.on('registered', function (rec) {
    ls('set', USER_KEY, rec.username);
    if (rec.sessionToken) ls('set', TOKEN_KEY, rec.sessionToken);
    location.reload(); // the page starts again as this account
  });

  socket.on('errorMsg', function (msg) { showError(msg); });

  // ---- forgot password
  el('forgotLink').addEventListener('click', function (e) {
    e.preventDefault();
    el('recoveryEmailInput').value = '';
    el('recoveryStatus').classList.add('hidden');
    el('recoveryModal').classList.remove('hidden');
    el('recoveryEmailInput').focus();
  });
  el('recoveryCloseBtn').addEventListener('click', function () { el('recoveryModal').classList.add('hidden'); });
  el('recoverPasswordBtn').addEventListener('click', function () {
    var email = el('recoveryEmailInput').value.trim();
    if (!email) { el('recoveryStatus').textContent = 'Ievadi e-pasta adresi'; el('recoveryStatus').classList.remove('hidden'); return; }
    socket.emit('forgotPassword', { email: email });
  });
  socket.on('forgotPasswordSent', function () {
    var p = el('recoveryStatus');
    p.textContent = 'Ja šis e-pasts pieder kādam kontam, uz to nosūtījām paroles atiestatīšanas saiti (derīga 1 stundu).';
    p.classList.remove('hidden');
  });

  // ---- Google / Facebook (server-side redirect flow, same routes as Duraks)
  ['googleLoginBtn', 'facebookLoginBtn'].forEach(function (id) {
    var a = el(id);
    a.setAttribute('href', a.getAttribute('href') + '?return=' + RETURN);
  });
  fetch('/auth/providers')
    .then(function (r) { return r.json(); })
    .then(function (p) {
      if (p.google) el('googleLoginBtn').classList.remove('hidden');
      if (p.facebook) el('facebookLoginBtn').classList.remove('hidden');
      if (p.google || p.facebook) el('oauthButtons').classList.remove('hidden');
    })
    .catch(function () { /* no providers configured: buttons stay hidden */ });

  function stripParams(keys) {
    var url = new URL(location.href);
    keys.forEach(function (k) { url.searchParams.delete(k); });
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  }
  var oUser = params.get('oauthUser');
  var oToken = params.get('oauthToken');
  var oChoose = params.get('oauthChoose');
  var oError = params.get('oauthError');
  if (oUser && oToken) {
    ls('set', USER_KEY, oUser);
    ls('set', TOKEN_KEY, oToken);
    stripParams(['oauthUser', 'oauthToken', 'next']);
    location.reload();
  } else if (oChoose) {
    el('oauthUsernameInput').value = params.get('suggested') || '';
    el('oauthChooseUsernameModal').classList.remove('hidden');
    stripParams(['oauthChoose', 'suggested', 'next']);
    el('oauthUsernameSubmitBtn').addEventListener('click', function () {
      var chosen = el('oauthUsernameInput').value.trim();
      if (!chosen) return showError('Ievadi lietotājvārdu');
      socket.emit('completeOAuthSignup', { pendingToken: oChoose, username: chosen });
    });
  } else if (oError) {
    stripParams(['oauthError']);
    showError(oError);
  }

  // ---- log out ("mainīt")
  window.meliLobby = window.meliLobby || {};
  window.meliLobby.logout = function () {
    var creds = { username: ls('get', USER_KEY), token: ls('get', TOKEN_KEY) };
    ls('del', USER_KEY);
    ls('del', TOKEN_KEY);
    var done = function () { location.reload(); };
    if (socket.connected) { socket.emit('logout', creds); setTimeout(done, 250); } else done();
  };
})();

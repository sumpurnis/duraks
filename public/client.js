'use strict';

// Card deck selection — plumbing for a future "choose your card design"
// profile setting (not built yet, and no UI exposes this today). The CSS
// default is already the current deck (cards-sprite-hq.png); setting
// data-card-deck="classic" on <html> switches every card-face element and
// its aspect-ratio over to the original deck (cards-sprite-classic.png)
// via the [data-card-deck="classic"] rules in style.css. Reads from
// localStorage only for now — once there's an actual profile UI for this,
// swap the read/write here for the server-stored preference (the same
// pattern users.js already uses for lastRoomSettings) so it follows the
// account across devices instead of just this browser.
const CARD_DECK_KEY = 'duraks_card_deck';
function applyCardDeckPreference() {
  const deck = localStorage.getItem(CARD_DECK_KEY);
  if (deck === 'classic') {
    document.documentElement.dataset.cardDeck = 'classic';
  } else {
    delete document.documentElement.dataset.cardDeck;
  }
}
applyCardDeckPreference();

// Mobile browsers (especially Chrome/Brave on Android) report `100vh` against
// the viewport size with the address bar collapsed, not what's actually
// visible — this pushes bottom UI (action buttons) below the visible area
// until the page is scrolled. `dvh` in CSS handles this in modern browsers;
// this is a belt-and-suspenders JS fallback using the more precise
// visualViewport API, exposed as --app-vh for anywhere CSS needs it.
function updateAppViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-vh', h * 0.01 + 'px');
}
updateAppViewportHeight();
window.addEventListener('resize', updateAppViewportHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateAppViewportHeight);
  window.visualViewport.addEventListener('scroll', updateAppViewportHeight);
}

const RANKS_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS_ORDER.map((r, i) => [r, i + 2]));

function cardFaceClass(card) {
  return `card-face card-face-${card.rank}-${card.suit}`;
}
const USER_KEY = 'duraks_username';
// A server-issued session token, not the account password — the browser
// never stores the password itself, only this random single-purpose token
// (see loginWithToken below). Losing this token only exposes this one
// "stay logged in" session, and it can be revoked without changing the
// account password.
const TOKEN_KEY = 'duraks_token';
const DRAG_THRESHOLD_PX = 6;

const socket = io();

const el = (id) => document.getElementById(id);
const lobbyScreen = el('lobby');
const gameScreen = el('game');

let myId = null;
let myUsername = null;
let selectedCardId = null;
let lastState = null;
let authMode = null; // 'login' | 'register'
let chatOpen = false;
let unreadChat = 0;
let vsAI = false;
let isGuestSession = false;
let guestUsername = null;
let currentGameOverTournamentId = null; // set by showGameOver when the finished game was part of a tournament

const urlParams = new URLSearchParams(window.location.search);
const urlRoomCode = (urlParams.get('room') || '').toUpperCase() || null;

// ================= Auth =================

const SESSION_EXPIRED_MSG = 'Sesija vairs nav derīga, lūdzu piesakies no jauna';
let autoLoginAttempted = false;

function tryAutoLogin() {
  const savedUser = localStorage.getItem(USER_KEY);
  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedUser && savedToken) {
    autoLoginAttempted = true;
    socket.emit('loginWithToken', { username: savedUser, token: savedToken });
  }
}

el('continueBtn').addEventListener('click', () => {
  const name = el('nameInput').value.trim();
  if (!name) return showLobbyError('Ievadi lietotājvārdu');
  socket.emit('checkUsername', { username: name });
});
el('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('continueBtn').click(); });

socket.on('usernameStatus', ({ exists }) => {
  el('continueBtn').classList.add('hidden');
  el('passwordFields').classList.remove('hidden');
  if (exists) {
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

el('authBtn').addEventListener('click', submitAuth);
el('confirmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
el('passwordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && authMode === 'login') submitAuth(); });

function submitAuth() {
  const name = el('nameInput').value.trim();
  const password = el('passwordInput').value;
  if (authMode === 'register') {
    const confirm = el('confirmInput').value;
    if (password.length < 8) return showLobbyError('Parolei jābūt vismaz 8 rakstzīmes garai');
    if (password !== confirm) return showLobbyError('Paroles nesakrīt');
    socket.emit('register', { username: name, password });
  } else {
    socket.emit('login', { username: name, password });
  }
}

el('switchUserLink').addEventListener('click', (e) => {
  e.preventDefault();
  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (myUsername && savedToken) socket.emit('logout', { username: myUsername, token: savedToken });
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
  myUsername = null;
  window.lastRoomSettings = null;
  el('playStep').classList.add('hidden');
  el('authStep').classList.remove('hidden');
  el('passwordFields').classList.add('hidden');
  el('continueBtn').classList.remove('hidden');
  el('nameInput').value = '';
  el('nameInput').focus();
});

socket.on('registered', (rec) => {
  myUsername = rec.username;
  autoLoginAttempted = false;
  localStorage.setItem(USER_KEY, myUsername);
  // sessionToken is only present on register/login/loginWithToken (not on
  // every 'registered'-shaped payload elsewhere), so don't clobber an
  // already-stored token with nothing if this event ever fires without one.
  if (rec.sessionToken) localStorage.setItem(TOKEN_KEY, rec.sessionToken);
  el('currentUsername').textContent = myUsername;
  el('authStep').classList.add('hidden');
  el('playStep').classList.remove('hidden');
  el('lobbyError').classList.add('hidden');

  // Read by multi-client.js to pre-fill the room-creation modal with this
  // registered user's last-used settings. null for a brand-new account
  // (nothing hosted yet) — the modal just falls back to its own defaults.
  window.lastRoomSettings = rec.lastRoomSettings || null;

  if (urlRoomCode) socket.emit('joinRoom', { code: urlRoomCode });
});

// ================= Open rooms browser (old 2p-only room system) =================
// Retired: room creation now always goes through the unified multi-room
// modal (see multi-client.js), which supports plain 2-player rooms too.
// The server still emits openRoomsUpdated for backward compatibility, but
// there's no UI here to render it into anymore, and no UI path left that
// creates a room this system would ever list.

tryAutoLogin();


function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ================= Statistika / leaderboards (lobby) =================

let lastLeaderboards = null;
let leaderboardScope = 'today';

function holderHtml(entry) {
  if (!entry) return '—';
  return `<span class="clickable-name" data-username="${escapeHtml(entry.username)}">${escapeHtml(entry.username)}</span> (${entry.value})`;
}

function renderLeaderboards() {
  if (!lastLeaderboards) return;
  const d = lastLeaderboards;

  el('gamesToday').textContent = d.games.today;
  el('gamesAllTime').textContent = d.games.allTime;
  el('gamesVsBotToday').textContent = d.gamesVsBot.today;
  el('gamesVsBotAllTime').textContent = d.gamesVsBot.allTime;
  el('pageVisitsToday').textContent = d.pageVisits.today;
  el('pageVisitsAllTime').textContent = d.pageVisits.allTime;

  el('streakToday').innerHTML = holderHtml(d.longestStreak.today);
  el('streakAllTime').innerHTML = holderHtml(d.longestStreak.allTime);
  el('mostPlayedToday').innerHTML = holderHtml(d.mostPlayed.today);
  el('mostPlayedAllTime').innerHTML = holderHtml(d.mostPlayed.allTime);

  const list = el('topWinRateList');
  const rows = d.topWinRate[leaderboardScope] || [];
  if (rows.length === 0) {
    list.innerHTML = '<li class="muted small">Vēl nav datu…</li>';
  } else {
    list.innerHTML = rows
      .map(
        (r, i) => `
      <li class="top-list-row">
        <span class="top-rank">${i + 1}.</span>
        <span class="top-name clickable-name" data-username="${escapeHtml(r.username)}">${escapeHtml(r.username)}</span>
        <span class="top-pct">${r.winPct}%</span>
        <span class="top-played">(${r.played})</span>
      </li>`
      )
      .join('');
  }
}

socket.on('leaderboardsData', (data) => {
  lastLeaderboards = data;
  renderLeaderboards();
});

document.querySelectorAll('#topScopeTabs .stats-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    leaderboardScope = btn.dataset.scope;
    document.querySelectorAll('#topScopeTabs .stats-tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderLeaderboards();
  });
});

el('statsPanel').addEventListener('click', (e) => {
  const target = e.target.closest('.clickable-name[data-username]');
  if (!target) return;
  socket.emit('getProfile', { username: target.dataset.username });
});

// ================= Lobby / rooms =================
// createBtn's click handler now lives in multi-client.js — it opens the
// multiplayer room creation modal (which covers plain 2-player rooms too,
// via totalPlayers:2, aiCount:0), replacing the old direct createRoom call.

el('playGuestBtn').addEventListener('click', () => {
  vsAI = true;
  socket.emit('playVsAIGuest');
});

socket.on('guestPlayStarted', ({ username: name }) => {
  isGuestSession = true;
  guestUsername = name;
});

function showLobbyError(msg) {
  const e = el('lobbyError');
  e.textContent = msg;
  e.classList.remove('hidden');
}

socket.on('roomCreated', ({ code }) => {
  el('waiting').classList.remove('hidden');
  el('roomCode').textContent = code;
  const link = `${window.location.origin}/?room=${code}`;
  el('shareLinkInput').value = link;
  history.replaceState(null, '', `?room=${code}`);
});

el('copyLinkBtn').addEventListener('click', async () => {
  const input = el('shareLinkInput');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('Saite nokopēta!');
  } catch {
    document.execCommand('copy');
    showToast('Saite nokopēta!');
  }
});

socket.on('errorMsg', (msg) => {
  // A stale/expired/revoked "remember me" token failing quietly on page
  // load shouldn't greet the person with an error toast — just drop back
  // to the normal login screen and forget the dead token.
  if (autoLoginAttempted && msg === SESSION_EXPIRED_MSG) {
    autoLoginAttempted = false;
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY);
    return;
  }
  autoLoginAttempted = false;
  showLobbyError(msg);
  showToast(msg);
});

socket.on('gameStarted', ({ names }) => {
  myId = myUsername || guestUsername;
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  el('gameOverModal').classList.add('hidden');
  el('connectionBanner').classList.add('hidden');
  resetRematchUI();
  if (vsAI) {
    history.replaceState(null, '', window.location.pathname);
  } else {
    history.replaceState(null, '', `?room=${el('roomCode').textContent || urlRoomCode || ''}`);
  }
  el('myName').textContent = names[myId] || myUsername || guestUsername || 'Tu';
  const oppId = Object.keys(names).find((id) => id !== myId);
  el('opponentName').textContent = names[oppId] || 'Pretinieks';
});

socket.on('opponentDisconnected', () => {
  const banner = el('connectionBanner');
  banner.textContent = 'Pretinieks atslēdzās — gaidām atgriešanos…';
  banner.className = 'connection-banner';
  banner.classList.remove('hidden');
});

socket.on('opponentReconnected', () => {
  const banner = el('connectionBanner');
  banner.textContent = 'Pretinieks atgriezās!';
  banner.className = 'connection-banner reconnected';
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 3000);
});

// ================= Chat =================

el('chatToggleBtn').addEventListener('click', () => {
  chatOpen = !chatOpen;
  el('chatPanel').classList.toggle('hidden', !chatOpen);
  if (chatOpen) {
    unreadChat = 0;
    updateChatBadge();
    el('chatInput').focus();
  }
});
el('chatCloseBtn').addEventListener('click', () => {
  chatOpen = false;
  el('chatPanel').classList.add('hidden');
});

function updateChatBadge() {
  let badge = el('chatToggleBtn').querySelector('.chat-badge');
  if (unreadChat > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'chat-badge';
      el('chatToggleBtn').appendChild(badge);
    }
    badge.textContent = unreadChat > 9 ? '9+' : String(unreadChat);
  } else if (badge) {
    badge.remove();
  }
}

function sendChat() {
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text });
  input.value = '';
}
el('chatSendBtn').addEventListener('click', sendChat);
el('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

socket.on('chatMessage', ({ from, text }) => {
  const wrap = el('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (from === myUsername ? ' own' : '');
  div.innerHTML = `<span class="who">${escapeHtml(from)}:</span> ${escapeHtml(text)}`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;

  if (!chatOpen) {
    unreadChat += 1;
    updateChatBadge();
  }
});

socket.on('roomCreated', () => {
  el('chatMessages').innerHTML = '';
  unreadChat = 0;
  updateChatBadge();
});

// ================= Game state rendering =================

socket.on('state', (state) => {
  lastState = state;
  myId = state.you;
  render(state);
});

let activeDragCancel = null; // set while a card drag/tap gesture is in progress

function render(state) {
  if (activeDragCancel) activeDragCancel();
  el('deckCount').textContent = state.deckCount;
  el('myName').textContent = (state.names && state.names[myId]) || myUsername || 'Tu';
  const oppId = state.opponent;
  el('opponentName').textContent = (state.names && state.names[oppId]) || 'Pretinieks';

  const trumpEl = el('trumpCard');
  trumpEl.innerHTML = '';
  trumpEl.appendChild(cardChip(state.trumpCard));

  const banner = el('roleBanner');
  const isAttacker = state.yourRole === 'attacker';
  banner.textContent = isAttacker ? 'Tu uzbrūc' : 'Tu aizsargājies';
  banner.className = 'role-banner-onboard ' + (isAttacker ? 'attacker' : 'defender');

  renderOpponentHand(state);
  renderTable(state);
  renderHand(state);
  renderActions(state);

  if (state.status === 'finished') showGameOver(state);
}

function cardChip(card) {
  const span = document.createElement('span');
  span.className = `card mini ${cardFaceClass(card)}`;
  span.style.position = 'static';
  span.style.transform = 'none';
  return span;
}

function renderOpponentHand(state) {
  const container = el('opponentHand');
  container.innerHTML = '';
  for (let i = 0; i < state.opponentCount; i++) {
    const back = document.createElement('div');
    back.className = 'card-back-mini';
    container.appendChild(back);
  }
}

// Mirrors server-side Game#beats().
function cardBeats(attackCard, defendCard, trumpSuit) {
  if (defendCard.suit === attackCard.suit) {
    return RANK_VALUE[defendCard.rank] > RANK_VALUE[attackCard.rank];
  }
  return defendCard.suit === trumpSuit && attackCard.suit !== trumpSuit;
}

function renderTable(state) {
  const container = el('tableSlots');
  container.innerHTML = '';

  if (state.table.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = state.yourRole === 'attacker' && state.status === 'active'
      ? 'Velc vai pieskaries kārtij no rokas, lai uzbruktu'
      : 'Gaidi pretinieka uzbrukumu…';
    container.appendChild(hint);
    return;
  }

  state.table.forEach((slot, idx) => {
    const slotDiv = document.createElement('div');
    slotDiv.className = 'slot';

    const atk = document.createElement('div');
    atk.className = `card mini ${cardFaceClass(slot.attack)}`;
    slotDiv.appendChild(atk);

    if (slot.defend) {
      const def = document.createElement('div');
      def.className = `card mini defend-offset ${cardFaceClass(slot.defend)}`;
      slotDiv.appendChild(def);
    } else if (state.yourRole === 'defender' && state.status === 'active') {
      slotDiv.dataset.open = 'true';
      slotDiv.dataset.index = String(idx);
      slotDiv.dataset.attack = JSON.stringify(slot.attack);
      slotDiv.style.cursor = 'pointer';
      slotDiv.title = 'Klikšķini vai velc kārti šeit, lai aizsargātos';
      slotDiv.addEventListener('click', () => trySelectedDefend(idx));
    }

    container.appendChild(slotDiv);
  });
}

function trySelectedDefend(slotIndex) {
  if (!selectedCardId) {
    showToast('Vispirms izvēlies kārti no rokas (vai velc to tieši uz pretinieka kārti)');
    return;
  }
  socket.emit('defend', { cardId: selectedCardId, slotIndex });
  selectedCardId = null;
}

function renderHand(state) {
  const container = el('handCards');
  container.innerHTML = '';
  const ranksOnTable = new Set();
  state.table.forEach((s) => {
    ranksOnTable.add(s.attack.rank);
    if (s.defend) ranksOnTable.add(s.defend.rank);
  });

  const canAttack = state.yourRole === 'attacker' && state.status === 'active';
  const canDefend = state.yourRole === 'defender' && state.status === 'active' && state.table.some((s) => !s.defend);

  state.hand.forEach((card) => {
    const div = document.createElement('div');
    div.className = `card ${cardFaceClass(card)}`;

    let kind = null;
    if (canAttack && (state.table.length === 0 || ranksOnTable.has(card.rank))) {
      kind = 'attack';
    } else if (canDefend) {
      // Every card in the defender's hand stays fully visible and selectable,
      // same as the attacker's — whether a specific card can actually beat an
      // open attack is checked at drop/select time (cardBeats) and by the
      // server, not by dimming cards out of the hand up front.
      kind = 'defend';
    }
    div.classList.add('playable');
    if (!kind) div.classList.add('disabled');

    if (card.id === selectedCardId) {
      div.classList.add('selected');
    }

    if (kind) attachCardInteraction(div, card, kind);

    container.appendChild(div);
  });
}

function renderActions(state) {
  const passBtn = el('passBtn');
  const takeBtn = el('takeBtn');
  const surrenderBtn = el('surrenderBtn');
  passBtn.classList.add('hidden');
  takeBtn.classList.add('hidden');

  if (state.status !== 'active') {
    surrenderBtn.classList.add('hidden');
    return;
  }
  surrenderBtn.classList.remove('hidden');

  const allDefended = state.table.length > 0 && state.table.every((s) => s.defend);
  if (state.yourRole === 'attacker' && allDefended) passBtn.classList.remove('hidden');
  if (state.yourRole === 'defender' && state.table.some((s) => !s.defend)) takeBtn.classList.remove('hidden');
}

el('passBtn').addEventListener('click', () => socket.emit('passTurn'));
el('takeBtn').addEventListener('click', () => socket.emit('takeCards'));
el('surrenderBtn').addEventListener('click', () => {
  if (confirm('Vai tiešām vēlies padoties? Pretinieks tiks pasludināts par uzvarētāju.')) {
    socket.emit('surrender');
  }
});

// ================= Custom pointer-based drag & drop =================
// Overlap is checked pixel-for-pixel against the actual table card element
// (or the table area, for an opening attack) — a single pixel of overlap
// with a legal target is enough. An illegal or missed drop springs back.

function rectsOverlap(r1, r2) {
  return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
}

function clearDropHighlights() {
  el('tableFelt').classList.remove('drag-target');
  document.querySelectorAll('#tableSlots .slot').forEach((s) => s.classList.remove('drag-target'));
}

function updateDropTargets(ghostRect, card, kind) {
  clearDropHighlights();
  if (kind === 'attack') {
    if (rectsOverlap(ghostRect, el('tableFelt').getBoundingClientRect())) {
      el('tableFelt').classList.add('drag-target');
    }
  } else if (kind === 'defend') {
    document.querySelectorAll('#tableSlots .slot[data-open="true"]').forEach((slotEl) => {
      const attackCard = JSON.parse(slotEl.dataset.attack);
      if (rectsOverlap(ghostRect, slotEl.getBoundingClientRect()) && cardBeats(attackCard, card, lastState.trumpSuit)) {
        slotEl.classList.add('drag-target');
      }
    });
  }
}

function resolveDropTarget(ghostRect, card, kind) {
  if (kind === 'attack') {
    return rectsOverlap(ghostRect, el('tableFelt').getBoundingClientRect()) ? { type: 'attack' } : null;
  }
  let found = null;
  document.querySelectorAll('#tableSlots .slot[data-open="true"]').forEach((slotEl) => {
    if (found) return;
    const attackCard = JSON.parse(slotEl.dataset.attack);
    if (rectsOverlap(ghostRect, slotEl.getBoundingClientRect()) && cardBeats(attackCard, card, lastState.trumpSuit)) {
      found = { type: 'defend', slotIndex: Number(slotEl.dataset.index) };
    }
  });
  return found;
}

function handleCardTap(card, kind) {
  if (kind === 'attack') {
    socket.emit('attack', { cardId: card.id });
    selectedCardId = null;
  } else if (kind === 'defend') {
    selectedCardId = selectedCardId === card.id ? null : card.id;
    render(lastState);
  }
}

function attachCardInteraction(cardEl, card, kind) {
  cardEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const originRect = cardEl.getBoundingClientRect();
    let moved = false;
    let ghost = null;
    let cancelled = false;

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (ghost) ghost.remove();
      clearDropHighlights();
      if (activeDragCancel === cancel) activeDragCancel = null;
    }
    activeDragCancel = cancel;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        moved = true;
        ghost = cardEl.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = originRect.width + 'px';
        ghost.style.height = originRect.height + 'px';
        document.body.appendChild(ghost);
        cardEl.classList.add('drag-source-hidden');
      }
      if (moved) {
        ghost.style.left = (originRect.left + dx) + 'px';
        ghost.style.top = (originRect.top + dy) + 'px';
        updateDropTargets(ghost.getBoundingClientRect(), card, kind);
      }
    }

    function finish() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (cancelled) return; // a re-render already tore this gesture down
      activeDragCancel = null;

      if (!moved) {
        handleCardTap(card, kind);
        return;
      }

      const target = resolveDropTarget(ghost.getBoundingClientRect(), card, kind);
      clearDropHighlights();

      if (target) {
        if (kind === 'attack') socket.emit('attack', { cardId: card.id });
        else socket.emit('defend', { cardId: card.id, slotIndex: target.slotIndex });
        ghost.remove();
        cardEl.classList.remove('drag-source-hidden');
      } else {
        ghost.style.transition = 'left 0.22s ease, top 0.22s ease';
        ghost.style.left = originRect.left + 'px';
        ghost.style.top = originRect.top + 'px';
        setTimeout(() => {
          ghost.remove();
          cardEl.classList.remove('drag-source-hidden');
        }, 230);
      }
    }

    function onUp() { finish(); }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

// ================= Profile modal =================

el('myName').addEventListener('click', () => {
  if (myId) socket.emit('getProfile', { username: myId });
});
el('opponentName').addEventListener('click', () => {
  if (!lastState || !lastState.opponent) return;
  if (vsAI) return showToast('Datoram nav profila statistikas');
  socket.emit('getProfile', { username: lastState.opponent });
});

socket.on('profileData', ({ username: name, stats, history, eloByPool }) => {
  el('profileTitle').textContent = name;
  const eb = eloByPool || {};
  el('statEloOneVOne').textContent = typeof eb.oneVOne === 'number' ? eb.oneVOne : '—';
  el('statEloMulti').textContent = typeof eb.multi === 'number' ? eb.multi : '—';
  el('statPlayed').textContent = stats.played;
  el('statWon').textContent = stats.won;
  el('statLost').textContent = stats.lost;
  el('statWonForfeit').textContent = stats.wonByForfeit;
  el('statLostForfeit').textContent = stats.lostByForfeit;
  el('statCurrentStreak').textContent = stats.currentStreak;
  el('statLongestStreak').textContent = stats.longestStreak;
  el('statPlayedToday').textContent = stats.today.played;
  el('statWonToday').textContent = stats.today.won;
  el('statLostToday').textContent = stats.today.lost;
  el('statLongestStreakToday').textContent = stats.today.longestStreak;
  renderProfileHistory((history || []).slice(0, 15));
  renderEloChart(history || []);
  el('profileModal').classList.remove('hidden');
});

function profileRelativeTime(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `pirms ${secs}s`;
  if (secs < 3600) return `pirms ${Math.floor(secs / 60)}min`;
  if (secs < 86400) return `pirms ${Math.floor(secs / 3600)}h`;
  return `pirms ${Math.floor(secs / 86400)}d`;
}

const PROFILE_OUTCOME_LABELS = { won: 'Uzvara', lost: 'Zaudējums', placed: 'Ievietojās', draw: 'Neizšķirts' };

const ELO_MIDPOINT = 1000;

// Two independent rating pools, drawn as separately-colored, independently
// toggleable lines on ONE shared chart (shared time axis, shared value
// axis) — rather than one blended number, or two entirely separate
// charts. Colors must match the --elo-onevone/--elo-multi custom
// properties in style.css (used for the checkbox swatches); kept as plain
// hex here rather than var() because these get baked into inline SVG
// attribute strings, not CSS.
const ELO_POOL_META = {
  oneVOne: { label: '1v1', color: '#e8b84b' },
  multi: { label: '3-4 spēlētāji', color: '#5ac8e0' },
};

// Which pools are currently checked on — persists across chart re-renders
// within the session (not per-profile) so flipping between two players'
// profiles keeps whatever view you last chose.
let eloPoolVisible = { oneVOne: true, multi: true };
// Cached so toggling a checkbox re-draws instantly from what profileData
// already delivered, instead of round-tripping to the server again.
let lastProfileHistory = [];

// A ranked game's history entry carries eloPool going forward; older
// entries (recorded before the pool split) fall back to inferring it from
// totalPlayers, so existing history doesn't just vanish from the chart.
function eloEntriesForPool(history, pool) {
  return history
    .filter((e) => {
      if (typeof e.eloAfter !== 'number') return false;
      const entryPool = e.eloPool || (e.totalPlayers === 2 ? 'oneVOne' : 'multi');
      return entryPool === pool;
    })
    .slice()
    .reverse(); // oldest -> newest, for left-to-right plotting
}

function renderEloChart(history) {
  lastProfileHistory = history;
  const container = el('profileEloChart');

  const checkedPools = Object.keys(ELO_POOL_META).filter((pool) => eloPoolVisible[pool]);
  if (checkedPools.length === 0) {
    container.innerHTML = '<p class="muted small">Atzīmē vismaz vienu skatu augstāk, lai redzētu grafiku</p>';
    return;
  }

  const series = checkedPools
    .map((pool) => ({ pool, meta: ELO_POOL_META[pool], entries: eloEntriesForPool(history, pool) }))
    .filter((s) => s.entries.length >= 2);

  if (series.length === 0) {
    container.innerHTML = '<p class="muted small">Nepietiek ranked spēļu grafikam izvēlētajā skatā (vajag vismaz 2)</p>';
    return;
  }

  const width = 300;
  const height = 90;
  const padTop = 10;
  const padBottom = 10;
  const padSide = 6;

  // X-axis is per-series game *index*, evenly spread across the full
  // width — same as the original single-line chart, not real elapsed
  // time. A handful of games played in one sitting (common — someone
  // plays 5 ranked games in 10 minutes, then comes back two days later)
  // would otherwise all collapse into a sliver of a real time axis,
  // turning most of the line into near-vertical spikes between that
  // cluster and the next one. Index-based spacing keeps every step
  // reading as "the next game", which is what makes the trend legible.
  // The y-domain still stays shared across every visible series, so two
  // lines on the same chart remain honestly comparable in height, even
  // though they aren't aligned to the same real moments in time.
  const allValues = series.flatMap((s) => s.entries.map((e) => e.eloAfter));
  // The y-scale always includes 1000, even if every game so far has been
  // entirely above or below it, so the midpoint reference line is always
  // visible for context rather than clipped off the chart.
  const domainMin = Math.min(Math.min.apply(null, allValues), ELO_MIDPOINT);
  const domainMax = Math.max(Math.max.apply(null, allValues), ELO_MIDPOINT);
  const vRange = Math.max(1, domainMax - domainMin);

  function xForIndex(i, count) {
    if (count === 1) return width / 2;
    return padSide + (i / (count - 1)) * (width - 2 * padSide);
  }
  function yFor(v) {
    return height - padBottom - ((v - domainMin) / vRange) * (height - padTop - padBottom);
  }

  let svgSeries = '';
  let legendHtml = '';

  series.forEach((s) => {
    const values = s.entries.map((e) => e.eloAfter);
    const minVal = Math.min.apply(null, values);
    const maxVal = Math.max.apply(null, values);
    // First occurrence of this series' min/max — marked directly on the
    // chart (rather than just quoted in a legend row) so it's unambiguous
    // *where in time* that peak/dip actually happened.
    let minIdx = 0;
    let maxIdx = 0;
    values.forEach((v, i) => {
      if (v < values[minIdx]) minIdx = i;
      if (v > values[maxIdx]) maxIdx = i;
    });
    const hasDistinctExtremes = minVal !== maxVal;

    const points = s.entries.map((e, i) => xForIndex(i, s.entries.length).toFixed(1) + ',' + yFor(e.eloAfter).toFixed(1)).join(' ');

    const dots = s.entries.map((e, i) => {
      const isLast = i === s.entries.length - 1;
      const r = isLast ? 3 : 1.6;
      const cx = xForIndex(i, s.entries.length).toFixed(1);
      const cy = yFor(e.eloAfter).toFixed(1);
      const change = e.eloChange;
      const changeLabel = typeof change === 'number' ? ' (' + (change > 0 ? '+' : '') + change + ')' : '';
      let extremeLabel = '';
      if (hasDistinctExtremes && i === maxIdx) extremeLabel = ' · augstākais';
      else if (hasDistinctExtremes && i === minIdx) extremeLabel = ' · zemākais';
      const tooltip = s.meta.label + ' ELO: ' + e.eloAfter + changeLabel + extremeLabel;
      // A larger, invisible hit-circle carries the native mouse-over
      // tooltip (<title>) so hovering doesn't require pinpointing the
      // tiny visible dot — the visible dot is drawn on top, purely
      // decorative.
      let marker = '';
      if (hasDistinctExtremes && i === maxIdx) {
        marker = '<text x="' + cx + '" y="' + (Number(cy) - 4) + '" text-anchor="middle" font-size="7" fill="' + s.meta.color + '" pointer-events="none">▲</text>';
      } else if (hasDistinctExtremes && i === minIdx) {
        marker = '<text x="' + cx + '" y="' + (Number(cy) + 10) + '" text-anchor="middle" font-size="7" fill="' + s.meta.color + '" pointer-events="none">▼</text>';
      }
      return (
        '<circle cx="' + cx + '" cy="' + cy + '" r="7" fill="transparent" stroke="none">' +
        '<title>' + tooltip + '</title>' +
        '</circle>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + s.meta.color + '" pointer-events="none" />' +
        marker
      );
    }).join('');

    svgSeries +=
      '<polyline points="' + points + '" fill="none" stroke="' + s.meta.color + '" stroke-width="2" vector-effect="non-scaling-stroke" />' +
      dots;

    legendHtml +=
      '<div class="profile-elo-series-legend">' +
      '<p class="profile-elo-series-legend-title" style="color:' + s.meta.color + '"><span class="elo-swatch elo-swatch-' + s.pool + '"></span>' + s.meta.label + '</p>' +
      '<div class="profile-elo-chart-labels">' +
      '<div class="profile-elo-stat profile-elo-stat-low"><span class="profile-elo-stat-label">▼ Zemākais</span><span class="profile-elo-stat-value">' + minVal + '</span></div>' +
      '<div class="profile-elo-stat profile-elo-stat-high"><span class="profile-elo-stat-label">▲ Augstākais</span><span class="profile-elo-stat-value">' + maxVal + '</span></div>' +
      '<div class="profile-elo-stat profile-elo-stat-current"><span class="profile-elo-stat-label">Tagad</span><span class="profile-elo-stat-value">' + values[values.length - 1] + '</span></div>' +
      '</div></div>';
  });

  const y1000 = yFor(ELO_MIDPOINT).toFixed(1);
  const midLine =
    '<line x1="' + padSide + '" y1="' + y1000 + '" x2="' + (width - padSide) + '" y2="' + y1000 +
    '" stroke="rgba(250,246,236,0.32)" stroke-width="1" stroke-dasharray="3,3" vector-effect="non-scaling-stroke" />' +
    '<text x="' + (width - padSide) + '" y="' + (Number(y1000) - 3) + '" text-anchor="end" font-size="7" fill="rgba(250,246,236,0.55)">' + ELO_MIDPOINT + '</text>';

  container.innerHTML =
    '<svg viewBox="0 0 ' + width + ' ' + height + '" class="profile-elo-chart-svg" preserveAspectRatio="none">' +
    midLine + svgSeries +
    '</svg>' +
    legendHtml;
}

document.querySelectorAll('#profileEloToggles input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    eloPoolVisible[cb.dataset.pool] = cb.checked;
    renderEloChart(lastProfileHistory);
  });
});

function renderProfileHistory(history) {
  const container = el('profileHistoryList');
  container.innerHTML = '';
  if (!history || history.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'Nav vēl izspēlētu spēļu…';
    container.appendChild(p);
    return;
  }
  history.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'profile-history-row profile-history-' + (entry.outcome || 'lost');

    if (Array.isArray(entry.opponents) && entry.opponents.length > 0) {
      row.title = 'Pretinieki: ' + entry.opponents.join(', ');
    }

    const outcomeLabel = PROFILE_OUTCOME_LABELS[entry.outcome] || entry.outcome;
    const placementLabel = entry.placement ? ` (${entry.placement}. vieta)` : '';
    const rankedLabel = entry.ranked ? ' 🏅' : '';
    const modeLabel = entry.mode === '2p' ? '2 spēlētāji' : `${entry.totalPlayers} spēlētāji`;
    const deckLabel = entry.deckSize === 36 ? ' · 36 kārtis' : '';
    const vsBotsLabel = entry.vsBots ? ' · pret datoru' : '';
    const eloLabel = typeof entry.eloChange === 'number'
      ? ` · ELO ${entry.eloChange > 0 ? '+' : ''}${entry.eloChange}`
      : '';

    const outcomeSpan = document.createElement('span');
    outcomeSpan.className = 'profile-history-outcome';
    outcomeSpan.textContent = outcomeLabel + placementLabel + rankedLabel + eloLabel;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'profile-history-meta';
    metaSpan.textContent = `${modeLabel}${deckLabel}${vsBotsLabel} · ${profileRelativeTime(entry.timestamp)}`;

    row.appendChild(outcomeSpan);
    row.appendChild(metaSpan);
    container.appendChild(row);
  });
}

el('profileCloseBtn').addEventListener('click', () => el('profileModal').classList.add('hidden'));
el('profileModal').addEventListener('click', (e) => {
  if (e.target.id === 'profileModal') el('profileModal').classList.add('hidden');
});

// ================= Game over / rematch =================

function showGameOver(state) {
  const modal = el('gameOverModal');
  modal.classList.remove('hidden');

  const reasonText = {
    timeout: ' (laiks gājienam beidzās)',
    surrender: ' (padošanās)',
    disconnect: ' (pretinieks pameta spēli)',
  }[state.endReason] || '';

  const isTournament = !!state.tournamentInfo;
  currentGameOverTournamentId = isTournament ? state.tournamentInfo.tournamentId : null;
  const questionEl = document.querySelector('.rematch-question');
  const yesBtn = el('rematchYesBtn');
  const noBtn = el('rematchNoBtn');

  if (state.draw) {
    el('gameOverTitle').textContent = 'Neizšķirts!';
    el('gameOverText').textContent = 'Klājs beidzies un abiem tukšas rokas vienlaicīgi.';
  } else if (state.winnerId === myId) {
    el('gameOverTitle').textContent = 'Tu uzvarēji! 🎉';
    el('gameOverText').textContent = `Pretinieks paliek par duraku${reasonText}.`;
  } else if (isTournament) {
    el('gameOverTitle').textContent = 'Šoreiz nepaveicās!';
    el('gameOverText').textContent = '';
  } else {
    el('gameOverTitle').textContent = 'Tu esi duraks!';
    el('gameOverText').textContent = `Šoreiz neveicās${reasonText} — spēlē vēlreiz!`;
  }

  if (isTournament) {
    questionEl.classList.add('hidden');
    noBtn.textContent = 'Pamest turnīru';
    noBtn.classList.remove('hidden');
    if (state.winnerId === myId) {
      yesBtn.textContent = 'Turpināt turnīru';
      yesBtn.classList.remove('hidden');
    } else {
      // Lost (or drew) a tournament game — nothing to continue, only leaving makes sense.
      yesBtn.classList.add('hidden');
    }
  } else {
    questionEl.classList.remove('hidden');
    yesBtn.textContent = 'Jā';
    yesBtn.classList.remove('hidden');
    noBtn.textContent = 'Nē';
    noBtn.classList.remove('hidden');
  }
}

function resetRematchUI() {
  el('rematchVoteRow').classList.remove('hidden');
  el('rematchYesBtn').disabled = false;
  el('rematchNoBtn').disabled = false;
  el('rematchStatus').classList.add('hidden');
}

el('rematchYesBtn').addEventListener('click', () => {
  if (currentGameOverTournamentId) {
    // "Turpināt turnīru" — tournament games don't use peer rematch voting;
    // just tear the room down and return to the lobby. The tournament
    // itself keeps going on its own (or via the bracket's "Sākt spēli").
    socket.emit('rematchVote', { vote: 'no' });
    return;
  }
  socket.emit('rematchVote', { vote: 'yes' });
  el('rematchYesBtn').disabled = true;
  el('rematchNoBtn').disabled = true;
  const status = el('rematchStatus');
  status.textContent = 'Gaida pretinieka atbildi…';
  status.classList.remove('hidden');
});

el('rematchNoBtn').addEventListener('click', () => {
  if (currentGameOverTournamentId) {
    socket.emit('leaveTournamentMidway', { id: currentGameOverTournamentId });
  }
  socket.emit('rematchVote', { vote: 'no' });
});

socket.on('rematchRequested', ({ fromUsername }) => {
  const status = el('rematchStatus');
  status.textContent = `${fromUsername} jau vēlas spēlēt vēlreiz — nospied "Jā", lai sāktu!`;
  status.classList.remove('hidden');
});

socket.on('returnToLobby', () => {
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  el('gameOverModal').classList.add('hidden');
  el('waiting').classList.add('hidden');
  el('chatMessages').innerHTML = '';
  unreadChat = 0;
  updateChatBadge();
  lastState = null;
  vsAI = false;
  history.replaceState(null, '', window.location.pathname);
  socket.emit('listOpenRooms');

  if (isGuestSession && guestUsername) {
    el('nameInput').value = guestUsername;
    el('continueBtn').classList.add('hidden');
    el('passwordFields').classList.remove('hidden');
    authMode = 'register';
    el('passwordLabel').textContent = 'Izvēlies paroli';
    el('confirmField').classList.remove('hidden');
    el('authBtn').textContent = 'Reģistrēties';
    el('passwordInput').value = '';
    el('confirmInput').value = '';
    el('passwordInput').focus();
    showToast(`Patika spēle? Reģistrējies ar vārdu "${guestUsername}", lai saglabātu savu statistiku!`);
    isGuestSession = false;
  } else {
    showToast('Atgriezies sākuma lapā');
  }
});

// ================= Toast =================

function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

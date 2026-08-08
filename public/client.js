'use strict';

const RANKS_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS_ORDER.map((r, i) => [r, i + 2]));

function cardFaceClass(card) {
  return `card-face card-face-${card.rank}-${card.suit}`;
}
const USER_KEY = 'duraks_username';
const PASS_KEY = 'duraks_password'; // MVP-simple auth — see note in chat reply about the tradeoff
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

const urlParams = new URLSearchParams(window.location.search);
const urlRoomCode = (urlParams.get('room') || '').toUpperCase() || null;

// ================= Auth =================

function tryAutoLogin() {
  const savedUser = localStorage.getItem(USER_KEY);
  const savedPass = localStorage.getItem(PASS_KEY);
  if (savedUser && savedPass) {
    socket.emit('login', { username: savedUser, password: savedPass });
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
    if (password.length < 4) return showLobbyError('Parolei jābūt vismaz 4 rakstzīmes garai');
    if (password !== confirm) return showLobbyError('Paroles nesakrīt');
    socket.emit('register', { username: name, password });
  } else {
    socket.emit('login', { username: name, password });
  }
}

el('switchUserLink').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PASS_KEY);
  myUsername = null;
  el('playStep').classList.add('hidden');
  el('authStep').classList.remove('hidden');
  el('passwordFields').classList.add('hidden');
  el('continueBtn').classList.remove('hidden');
  el('nameInput').value = '';
  el('nameInput').focus();
});

socket.on('registered', (rec) => {
  myUsername = rec.username;
  localStorage.setItem(USER_KEY, myUsername);
  localStorage.setItem(PASS_KEY, el('passwordInput').value || localStorage.getItem(PASS_KEY) || '');
  el('currentUsername').textContent = myUsername;
  el('authStep').classList.add('hidden');
  el('playStep').classList.remove('hidden');
  el('lobbyError').classList.add('hidden');

  if (urlRoomCode) socket.emit('joinRoom', { code: urlRoomCode });
});

tryAutoLogin();

// ================= Open rooms browser =================

socket.on('openRoomsUpdated', (roomsList) => {
  const container = el('openRoomsList');
  container.innerHTML = '';
  if (roomsList.length === 0) {
    container.innerHTML = '<p class="muted small">Nav aktīvu atvērtu spēļu…</p>';
    return;
  }
  roomsList.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'open-room-item';
    const isMine = r.host === myUsername;
    item.innerHTML = `<span><span class="host-name">${escapeHtml(r.host)}</span><span class="room-age">${relativeTime(r.createdAt)}</span></span>`;
    if (!isMine) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Pievienoties';
      btn.addEventListener('click', () => socket.emit('joinRoom', { code: r.code }));
      item.appendChild(btn);
    } else {
      const tag = document.createElement('span');
      tag.className = 'muted small';
      tag.textContent = 'Tava istaba';
      item.appendChild(tag);
    }
    container.appendChild(item);
  });
});

function relativeTime(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `pirms ${secs}s`;
  return `pirms ${Math.floor(secs / 60)}min`;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ================= Lobby / rooms =================

el('createBtn').addEventListener('click', () => {
  vsAI = false;
  socket.emit('createRoom');
});

el('playVsAiBtn').addEventListener('click', () => {
  vsAI = true;
  socket.emit('playVsAI');
});

el('joinBtn').addEventListener('click', () => {
  vsAI = false;
  const code = el('codeInput').value.trim().toUpperCase();
  if (!code) return showLobbyError('Ievadi istabas kodu');
  socket.emit('joinRoom', { code });
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
  showLobbyError(msg);
  showToast(msg);
});

socket.on('gameStarted', ({ names }) => {
  myId = myUsername;
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
  el('myName').textContent = names[myId] || myUsername || 'Tu';
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

function render(state) {
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
  banner.className = 'role-banner ' + (isAttacker ? 'attacker' : 'defender');

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
    back.className = 'card-back small';
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
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('drag-target'));
}

function updateDropTargets(ghostRect, card, kind) {
  clearDropHighlights();
  if (kind === 'attack') {
    if (rectsOverlap(ghostRect, el('tableFelt').getBoundingClientRect())) {
      el('tableFelt').classList.add('drag-target');
    }
  } else if (kind === 'defend') {
    document.querySelectorAll('.slot[data-open="true"]').forEach((slotEl) => {
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
  document.querySelectorAll('.slot[data-open="true"]').forEach((slotEl) => {
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

socket.on('profileData', ({ username: name, stats }) => {
  el('profileTitle').textContent = name;
  el('statPlayed').textContent = stats.played;
  el('statWon').textContent = stats.won;
  el('statLost').textContent = stats.lost;
  el('statWonForfeit').textContent = stats.wonByForfeit;
  el('statLostForfeit').textContent = stats.lostByForfeit;
  el('profileModal').classList.remove('hidden');
});

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

  if (state.draw) {
    el('gameOverTitle').textContent = 'Neizšķirts!';
    el('gameOverText').textContent = 'Klājs beidzies un abiem tukšas rokas vienlaicīgi.';
  } else if (state.winnerId === myId) {
    el('gameOverTitle').textContent = 'Tu uzvarēji! 🎉';
    el('gameOverText').textContent = `Pretinieks paliek par duraku${reasonText}.`;
  } else {
    el('gameOverTitle').textContent = 'Tu esi duraks!';
    el('gameOverText').textContent = `Šoreiz neveicās${reasonText} — spēlē vēlreiz!`;
  }
}

function resetRematchUI() {
  el('rematchVoteRow').classList.remove('hidden');
  el('rematchYesBtn').disabled = false;
  el('rematchNoBtn').disabled = false;
  el('rematchStatus').classList.add('hidden');
}

el('rematchYesBtn').addEventListener('click', () => {
  socket.emit('rematchVote', { vote: 'yes' });
  el('rematchYesBtn').disabled = true;
  el('rematchNoBtn').disabled = true;
  const status = el('rematchStatus');
  status.textContent = 'Gaida pretinieka atbildi…';
  status.classList.remove('hidden');
});

el('rematchNoBtn').addEventListener('click', () => {
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
  showToast('Atgriezies sākuma lapā');
});

// ================= Toast =================

function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

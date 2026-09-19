'use strict';

/**
 * multi-client.js
 * Client-side logic for the 3-4 player "play vs computer" mode
 * (multi-rooms.js on the server). Visually and interactively this now
 * matches the 2-player game exactly on purpose - same wood table, same
 * card sprites, same drag & drop - reusing style.css's classes directly
 * rather than reinventing them. What stays fully separate is the actual
 * game plumbing: own screen (#multiGame), own DOM ids, own render
 * functions (all prefixed multi*), own socket events throughout, and its
 * own copy of the drag & drop functions (renamed, scoped to #multiGame's
 * elements) so nothing here can ever read from or write to the 2-player
 * game's state or vice versa.
 */

let multiMyId = null;
let multiLastState = null;
let multiSelectedCardId = null;

function multiShowScreen() {
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.add('hidden');
  el('multiGame').classList.remove('hidden');
  el('multiGameOverModal').classList.add('hidden');
}

function multiReturnToLobby() {
  el('multiGame').classList.add('hidden');
  el('multiGameOverModal').classList.add('hidden');
  el('multiSafeModal').classList.add('hidden');
  document.getElementById('lobby').classList.remove('hidden');
  multiMyId = null;
  multiLastState = null;
  multiSelectedCardId = null;
  multiWasMyTurn = false;
  multiWasActive = true;
  socket.emit('listMultiRooms');
}

let multiMyUsername = null; // learned via multiGameStarted/multiRoomWaiting — works for guests too, unlike the login-only global myUsername

socket.on('multiGameStarted', (data) => {
  if (data && data.you) multiMyUsername = data.you;
  multiWasMyTurn = false;
  multiWasActive = true;
  el('multiRoomWaiting').classList.add('hidden');
  el('multiSafeModal').classList.add('hidden');
  multiShowScreen();
});

// ================= Multiplayer room lobby (create/list/join/cancel) =================
// Works for both logged-in users and guests — the server assigns a guest
// identity transparently, no login required to reach any of this.

socket.on('connect', function () {
  socket.emit('listMultiRooms');
});

function multiRenderSilhouettes(container, totalPlayers, aiCount, humansJoined) {
  container.innerHTML = '';
  const humanSlotsNeeded = totalPlayers - aiCount;
  for (let i = 0; i < humansJoined; i++) {
    const s = document.createElement('span');
    s.className = 'multi-silhouette';
    s.textContent = '👤';
    container.appendChild(s);
  }
  for (let i = 0; i < humanSlotsNeeded - humansJoined; i++) {
    const s = document.createElement('span');
    s.className = 'multi-silhouette multi-silhouette-empty';
    s.textContent = '👤';
    container.appendChild(s);
  }
  for (let i = 0; i < aiCount; i++) {
    const s = document.createElement('span');
    s.className = 'multi-silhouette';
    s.textContent = '🤖';
    container.appendChild(s);
  }
}

function multiRenderRoomsList(rooms) {
  const container = el('multiRoomsList');
  container.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'Nav atvērtu spēļu…';
    container.appendChild(p);
    return;
  }
  rooms.forEach(function (r) {
    const row = document.createElement('div');
    row.className = 'open-room-row';

    const info = document.createElement('div');
    info.className = 'open-room-info';
    const title = document.createElement('span');
    title.className = 'host-name';
    const lockPrefix = r.isPrivate ? '🔒 ' : '';
    const rankedPrefix = r.ranked ? '🏅 ' : '';
    title.textContent = lockPrefix + rankedPrefix + r.creatorUsername + ' · ' + r.humansJoined + '/' + r.humanSlotsNeeded + ' spēlētāji';
    info.appendChild(title);
    const silhouettes = document.createElement('div');
    silhouettes.className = 'multi-silhouette-row';
    multiRenderSilhouettes(silhouettes, r.totalPlayers, r.aiCount, r.humansJoined);
    info.appendChild(silhouettes);
    row.appendChild(info);

    const effectiveOwnUsername = myUsername || multiMyUsername;
    const isMine = effectiveOwnUsername && r.creatorUsername === effectiveOwnUsername;

    const actionBtn = document.createElement('button');
    if (isMine) {
      actionBtn.className = 'btn btn-danger';
      actionBtn.textContent = 'Atcelt';
      actionBtn.addEventListener('click', function () {
        socket.emit('cancelMultiRoom', { code: r.code });
      });
    } else {
      actionBtn.className = 'btn btn-secondary';
      actionBtn.textContent = 'Pievienoties';
      actionBtn.addEventListener('click', function () {
        if (r.isPrivate) {
          multiPendingJoinCode = r.code;
          el('multiJoinPasswordModalInput').value = '';
          el('multiJoinPasswordModal').classList.remove('hidden');
          el('multiJoinPasswordModalInput').focus();
        } else {
          socket.emit('joinMultiRoom', { code: r.code });
        }
      });
    }
    row.appendChild(actionBtn);

    container.appendChild(row);
  });
}

socket.on('multiRoomsData', multiRenderRoomsList);

let multiPendingJoinCode = null;

el('multiJoinPasswordCancelBtn').addEventListener('click', function () {
  el('multiJoinPasswordModal').classList.add('hidden');
  multiPendingJoinCode = null;
});
el('multiJoinPasswordSubmitBtn').addEventListener('click', function () {
  const password = el('multiJoinPasswordModalInput').value.trim();
  if (!multiPendingJoinCode) return;
  socket.emit('joinMultiRoom', { code: multiPendingJoinCode, password: password });
  el('multiJoinPasswordModal').classList.add('hidden');
  multiPendingJoinCode = null;
});

el('multiRoomsRefreshBtn').addEventListener('click', function () {
  socket.emit('listMultiRooms');
});

// ================= Room-creation modal: button-group option pickers =================
// Replaces the old <select> dropdowns with clickable buttons (the chosen
// option gets an .active highlight). All three groups interact the same
// way they did as selects: a 36-card deck locks the player count to 2, and
// a ranked room locks the AI count to 0 — just expressed as disabled
// buttons instead of a disabled/forced select value.

const multiCreateState = { totalPlayers: 3, aiCount: 0, deckSize: 52 };

function multiSetActiveButton(groupEl, value) {
  Array.from(groupEl.children).forEach(function (btn) {
    btn.classList.toggle('active', Number(btn.dataset.value) === value);
  });
}

function multiBuildAiCountButtons(total) {
  const group = el('multiCreateAiCountGroup');
  group.innerHTML = '';
  for (let i = 0; i <= total - 1; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-option';
    btn.dataset.value = String(i);
    btn.textContent = String(i);
    group.appendChild(btn);
  }
}

// Single source of truth: rebuilds every group's active/disabled state from
// multiCreateState + the ranked checkbox, in the right order so the
// deck-size -> player-count -> AI-count constraint chain stays consistent
// no matter which control was just touched (or when the modal was just
// pre-filled from a preset / a remembered settings snapshot).
function multiRefreshCreateModal() {
  const is36 = multiCreateState.deckSize === 36;
  if (is36) multiCreateState.totalPlayers = 2;

  multiSetActiveButton(el('multiCreateDeckSizeGroup'), multiCreateState.deckSize);

  const totalGroup = el('multiCreateTotalPlayersGroup');
  Array.from(totalGroup.children).forEach(function (btn) {
    btn.disabled = is36 && Number(btn.dataset.value) !== 2;
  });
  multiSetActiveButton(totalGroup, multiCreateState.totalPlayers);

  multiBuildAiCountButtons(multiCreateState.totalPlayers);
  const isRanked = el('multiCreateRanked').checked;
  if (isRanked) multiCreateState.aiCount = 0;
  if (multiCreateState.aiCount > multiCreateState.totalPlayers - 1) {
    multiCreateState.aiCount = multiCreateState.totalPlayers - 1;
  }
  const aiGroup = el('multiCreateAiCountGroup');
  Array.from(aiGroup.children).forEach(function (btn) {
    btn.disabled = isRanked && Number(btn.dataset.value) !== 0;
  });
  multiSetActiveButton(aiGroup, multiCreateState.aiCount);
}

el('multiCreateDeckSizeGroup').addEventListener('click', function (e) {
  const btn = e.target.closest('.btn-option');
  if (!btn || btn.disabled) return;
  multiCreateState.deckSize = Number(btn.dataset.value);
  multiRefreshCreateModal();
});
el('multiCreateTotalPlayersGroup').addEventListener('click', function (e) {
  const btn = e.target.closest('.btn-option');
  if (!btn || btn.disabled) return;
  multiCreateState.totalPlayers = Number(btn.dataset.value);
  multiRefreshCreateModal();
});
el('multiCreateAiCountGroup').addEventListener('click', function (e) {
  const btn = e.target.closest('.btn-option');
  if (!btn || btn.disabled) return;
  multiCreateState.aiCount = Number(btn.dataset.value);
  multiRefreshCreateModal();
});
el('multiCreateRanked').addEventListener('change', multiRefreshCreateModal);

// createBtn now opens this modal — it replaces the old direct 2p-only room
// creation, since totalPlayers:2/aiCount:0 covers that exact case too.
// createRoomGuestBtn (pre-login) opens the exact same modal, so guests can
// create rooms too without needing to register. A quick-preset button
// (see below) also opens this same modal, just pre-filled with that
// preset's values instead of defaults/remembered settings — either way,
// nothing is actually created until "Izveidot" is clicked.
//
// For a registered user with no explicit preset, the modal is pre-filled
// with their last-used settings (window.lastRoomSettings, populated from
// the server on login/registration) rather than the hardcoded defaults —
// purely a convenience so returning hosts don't have to re-pick the same
// options every time. It never auto-submits.
function multiOpenRoomCreateModal(preset) {
  const settings = preset || window.lastRoomSettings || { totalPlayers: 3, aiCount: 0, deckSize: 52, isPrivate: false, ranked: false };
  multiCreateState.deckSize = settings.deckSize === 36 ? 36 : 52;
  multiCreateState.totalPlayers = settings.totalPlayers || 3;
  multiCreateState.aiCount = settings.aiCount || 0;
  el('multiCreatePrivate').checked = !!settings.isPrivate;
  el('multiCreateRanked').checked = !!settings.ranked;
  multiRefreshCreateModal();
  el('multiRoomCreateModal').classList.remove('hidden');
}
el('createBtn').addEventListener('click', function () { multiOpenRoomCreateModal(); });
el('createRoomGuestBtn').addEventListener('click', function () { multiOpenRoomCreateModal(); });

// Quick presets (main lobby page, both for guests and registered users):
// jump straight to the two most popular setups without touching any
// button group by hand. Still just pre-fills the same create modal — the
// user must still press "Izveidot" themselves to actually host the room.
function multiOpenPresetModal(presetName) {
  if (presetName === '2p36') {
    multiOpenRoomCreateModal({ totalPlayers: 2, aiCount: 0, deckSize: 36, isPrivate: false, ranked: false });
  } else if (presetName === '4p52') {
    multiOpenRoomCreateModal({ totalPlayers: 4, aiCount: 0, deckSize: 52, isPrivate: false, ranked: false });
  }
}
['quickPreset2p36', 'quickPreset4p52', 'quickPresetGuest2p36', 'quickPresetGuest4p52'].forEach(function (id) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', function () { multiOpenPresetModal(btn.dataset.preset); });
});

el('multiRoomCreateCancelBtn').addEventListener('click', function () {
  el('multiRoomCreateModal').classList.add('hidden');
});
el('multiRoomCreateSubmitBtn').addEventListener('click', function () {
  const totalPlayers = multiCreateState.totalPlayers;
  const aiCount = multiCreateState.aiCount;
  const isPrivate = el('multiCreatePrivate').checked;
  const deckSize = multiCreateState.deckSize;
  const ranked = el('multiCreateRanked').checked;
  el('multiRoomCreateModal').classList.add('hidden');
  socket.emit('createMultiRoom', { totalPlayers: totalPlayers, aiCount: aiCount, isPrivate: isPrivate, deckSize: deckSize, ranked: ranked });
});

socket.on('multiRoomWaiting', function (data) {
  if (data && data.yourUsername) multiMyUsername = data.yourUsername;
  el('multiRoomWaiting').classList.remove('hidden');
  el('multiWaitingInfo').textContent = data.humansJoined + '/' + data.humanSlotsNeeded + ' spēlētāji pievienojušies' + (data.ranked ? ' · 🏅 Ranked' : '');
  el('multiWaitingCode').textContent = data.code;
  multiRenderSilhouettes(el('multiWaitingSilhouettes'), data.totalPlayers, data.aiCount, data.humansJoined);
  el('multiRoomCancelBtn').classList.toggle('hidden', !data.isCreator);
  el('multiRoomLeaveWaitingBtn').classList.toggle('hidden', !!data.isCreator);

  const passwordRow = el('multiWaitingPasswordRow');
  if (data.isPrivate && data.password) {
    el('multiWaitingPassword').textContent = data.password;
    passwordRow.classList.remove('hidden');
  } else {
    passwordRow.classList.add('hidden');
  }
});

socket.on('multiRoomCancelled', function () {
  el('multiRoomWaiting').classList.add('hidden');
  showToast('Istaba tika atcelta');
});

el('multiRoomCancelBtn').addEventListener('click', function () {
  socket.emit('cancelMultiRoom');
});
el('multiRoomLeaveWaitingBtn').addEventListener('click', function () {
  socket.emit('multiLeaveRoom');
  el('multiRoomWaiting').classList.add('hidden');
});


socket.on('multiState', (state) => {
  multiLastState = state;
  multiMyId = state.you;
  multiRender(state);
  if (state.status === 'finished') {
    setTimeout(() => multiShowGameOver(state), 400);
  }
});

function multiCardChip(card) {
  const span = document.createElement('span');
  span.className = 'card mini ' + cardFaceClass(card);
  span.style.position = 'static';
  span.style.transform = 'none';
  return span;
}

function multiRoleTag(state, playerId) {
  if (playerId === state.attackerId) return ' (uzbrūk)';
  if (playerId === state.defenderId) return ' (aizsargājas)';
  return '';
}

function multiRenderOpponents(state) {
  const container = el('multiOpponentsRow');
  container.innerHTML = '';
  const opponents = state.players.filter(function (p) { return p !== multiMyId; });
  opponents.forEach(function (p) {
    const group = document.createElement('div');
    group.className = 'multi-opponent-group';
    if (state.activePlayers.indexOf(p) === -1) group.classList.add('multi-safe');

    const name = document.createElement('div');
    name.className = 'multi-opponent-group-name';
    name.textContent = p + multiRoleTag(state, p);
    group.appendChild(name);

    const cards = document.createElement('div');
    cards.className = 'multi-opponent-group-cards';
    if (state.pendingActorIds && state.pendingActorIds.indexOf(p) !== -1) {
      cards.classList.add('multi-current-turn');
    }
    const count = state.opponentCounts[p] || 0;
    for (let i = 0; i < count; i++) {
      const back = document.createElement('div');
      back.className = 'card-back-mini';
      cards.appendChild(back);
    }
    group.appendChild(cards);

    container.appendChild(group);
  });
}

function multiRenderTable(state) {
  el('multiDeckCount').textContent = state.deckCount;
  const trumpEl = el('multiTrumpCard');
  trumpEl.innerHTML = '';
  if (state.trumpCard) trumpEl.appendChild(multiCardChip(state.trumpCard));

  const banner = el('multiRoleBanner');
  if (state.pendingTake && state.yourRole === 'defender') {
    banner.textContent = 'Gaidi pēdējo piemešanu…';
    banner.className = 'role-banner-onboard defender';
  } else if (state.yourRole === 'attacker') {
    banner.textContent = 'Tu uzbrūc';
    banner.className = 'role-banner-onboard attacker';
  } else if (state.yourRole === 'defender') {
    banner.textContent = 'Tu aizsargājies';
    banner.className = 'role-banner-onboard defender';
  } else {
    banner.textContent = 'Gaidi savu kārtu';
    banner.className = 'role-banner-onboard';
  }

  const container = el('multiTableSlots');
  container.innerHTML = '';

  if (state.table.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = (state.yourRole === 'attacker' && state.status === 'active')
      ? 'Velc vai pieskaries kārtij no rokas, lai uzbruktu'
      : 'Gaidi uzbrukumu…';
    container.appendChild(hint);
    return;
  }

  state.table.forEach(function (slot, idx) {
    const slotDiv = document.createElement('div');
    slotDiv.className = 'slot';

    const atk = document.createElement('div');
    atk.className = 'card mini ' + cardFaceClass(slot.attack);
    slotDiv.appendChild(atk);

    if (slot.defend) {
      const def = document.createElement('div');
      def.className = 'card mini defend-offset ' + cardFaceClass(slot.defend);
      slotDiv.appendChild(def);
    } else if (!state.pendingTake && state.yourRole === 'defender' && state.status === 'active') {
      slotDiv.dataset.open = 'true';
      slotDiv.dataset.index = String(idx);
      slotDiv.dataset.attack = JSON.stringify(slot.attack);
      slotDiv.style.cursor = 'pointer';
      slotDiv.title = 'Klikšķini vai velc kārti šeit, lai aizsargātos';
      slotDiv.addEventListener('click', function () { multiTrySelectedDefend(idx); });
    }

    container.appendChild(slotDiv);
  });
}

function multiTrySelectedDefend(slotIndex) {
  if (!multiSelectedCardId) {
    showToast('Vispirms izvēlies kārti no rokas (vai velc to tieši uz kārti, kurai jāaizsargājas)');
    return;
  }
  socket.emit('multiDefend', { cardId: multiSelectedCardId, slotIndex: slotIndex });
  multiSelectedCardId = null;
}

function multiRenderHand(state) {
  const container = el('multiHandCards');
  container.innerHTML = '';
  const ranksOnTable = new Set();
  state.table.forEach(function (s) {
    ranksOnTable.add(s.attack.rank);
    if (s.defend) ranksOnTable.add(s.defend.rank);
  });

  const canOpenAttack = state.yourRole === 'attacker' && state.table.length === 0 && state.status === 'active';
  const canThrowIn = !!state.canThrowIn;
  const canAttackNow = canOpenAttack || canThrowIn;
  const canDefend = !state.pendingTake && state.yourRole === 'defender' && state.status === 'active' && state.table.some(function (s) { return !s.defend; });

  state.hand.forEach(function (card) {
    const div = document.createElement('div');
    div.className = 'card ' + cardFaceClass(card);

    let kind = null;
    if (canAttackNow && (state.table.length === 0 || ranksOnTable.has(card.rank))) {
      kind = 'attack';
    } else if (canDefend) {
      kind = 'defend';
    }
    div.classList.add('playable');
    if (!kind) div.classList.add('disabled');

    if (card.id === multiSelectedCardId) {
      div.classList.add('selected');
    }

    if (kind) multiAttachCardInteraction(div, card, kind);

    container.appendChild(div);
  });
}

function multiRenderActions(state) {
  const takeBtn = el('multiTakeBtn');
  const declineBtn = el('multiDeclineBtn');
  const surrenderBtn = el('multiSurrenderBtn');
  takeBtn.classList.add('hidden');
  declineBtn.classList.add('hidden');

  if (state.status !== 'active') {
    surrenderBtn.classList.add('hidden');
    return;
  }
  const isActive = !!(multiMyId && state.activePlayers && state.activePlayers.indexOf(multiMyId) !== -1);
  surrenderBtn.classList.toggle('hidden', !isActive);

  if (state.yourRole === 'defender' && !state.pendingTake && state.table.some(function (s) { return !s.defend; })) takeBtn.classList.remove('hidden');
  if (state.canThrowIn) declineBtn.classList.remove('hidden');
}

let multiActiveDragCancel = null; // set while a card drag/tap gesture is in progress

let multiWasMyTurn = false;
let multiWasActive = true;

function multiIsMyTurnNow(state) {
  return !!(state.pendingActorIds && multiMyId && state.pendingActorIds.indexOf(multiMyId) !== -1);
}

function multiShowTurnNotice() {
  const notice = el('multiTurnNotice');
  notice.classList.remove('hidden');
  notice.classList.remove('multi-turn-notice-fade');
  void notice.offsetWidth; // force reflow so the animation restarts if retriggered quickly
  notice.classList.add('multi-turn-notice-fade');
  clearTimeout(multiShowTurnNotice._t);
  multiShowTurnNotice._t = setTimeout(() => notice.classList.add('hidden'), 1700);
}

el('multiSafeWatchBtn').addEventListener('click', function () {
  el('multiSafeModal').classList.add('hidden');
});
el('multiSafeLeaveBtn').addEventListener('click', function () {
  el('multiSafeModal').classList.add('hidden');
  socket.emit('multiLeaveRoom');
  multiReturnToLobby();
});

function multiRender(state) {
  if (multiActiveDragCancel) multiActiveDragCancel();
  el('multiMyName').textContent = multiMyId || 'Tu';
  multiRenderOpponents(state);
  multiRenderTable(state);
  multiRenderHand(state);
  multiRenderActions(state);

  const isMyTurnNow = multiIsMyTurnNow(state);
  if (isMyTurnNow && !multiWasMyTurn && state.status === 'active') {
    multiShowTurnNotice();
  }
  multiWasMyTurn = isMyTurnNow;

  // Went from active to safe while the match is still going for others —
  // offer to leave now (it won't affect the ongoing game for anyone else)
  // or keep spectating until it actually concludes.
  const isActiveNow = !!(multiMyId && state.activePlayers && state.activePlayers.indexOf(multiMyId) !== -1);
  if (multiWasActive && !isActiveNow && state.status === 'active') {
    el('multiSafeModal').classList.remove('hidden');
  }
  multiWasActive = isActiveNow;
}

function multiShowGameOver(state) {
  const modal = el('multiGameOverModal');
  const title = el('multiGameOverTitle');
  const text = el('multiGameOverText');

  if (state.durakId === multiMyId) {
    title.textContent = state.endReason === 'timeout' ? 'Laiks beidzās' : 'Šoreiz nepaveicās!';
    text.textContent = 'Tu paliki ar kārtīm rokā — tu esi duraks.';
  } else if (state.draw) {
    title.textContent = 'Neizšķirts!';
    text.textContent = 'Visiem beidzās kārtis vienlaicīgi — neviens nav duraks.';
  } else {
    title.textContent = 'Tu tiki drošībā!';
    const durakName = state.durakId ? state.durakId : 'kāds no botiem';
    text.textContent = 'Tu izspēlēji visas savas kārtis. Duraks: ' + durakName + '.';
  }
  modal.classList.remove('hidden');
}

el('multiTakeBtn').addEventListener('click', function () { socket.emit('multiTakeCards'); });
el('multiDeclineBtn').addEventListener('click', function () { socket.emit('multiDeclineThrowIn'); });
el('multiSurrenderBtn').addEventListener('click', function () {
  if (confirm('Vai tiešām vēlies padoties?')) socket.emit('multiSurrender');
});
el('multiGameOverCloseBtn').addEventListener('click', function () {
  socket.emit('multiLeaveRoom');
  multiReturnToLobby();
});

// ================= Ported pointer-based drag & drop =================
// Same mechanics as client.js's version (mirrored on purpose - this is a
// direct port), renamed with a multi prefix and scoped to #multiGame's own
// elements so it can never read from or interfere with the 2-player
// game's drag & drop, even though both are loaded in the same page.

function multiCardBeats(attackCard, defendCard, trumpSuit) {
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  if (defendCard.suit === attackCard.suit) {
    return RANKS.indexOf(defendCard.rank) > RANKS.indexOf(attackCard.rank);
  }
  return defendCard.suit === trumpSuit && attackCard.suit !== trumpSuit;
}

function multiRectsOverlap(r1, r2) {
  return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
}

function multiClearDropHighlights() {
  el('multiTableFelt').classList.remove('drag-target');
  document.querySelectorAll('#multiTableSlots .slot').forEach(function (s) { s.classList.remove('drag-target'); });
}

function multiUpdateDropTargets(ghostRect, card, kind) {
  multiClearDropHighlights();
  if (kind === 'attack') {
    if (multiRectsOverlap(ghostRect, el('multiTableFelt').getBoundingClientRect())) {
      el('multiTableFelt').classList.add('drag-target');
    }
  } else if (kind === 'defend') {
    document.querySelectorAll('#multiTableSlots .slot[data-open="true"]').forEach(function (slotEl) {
      const attackCard = JSON.parse(slotEl.dataset.attack);
      if (multiRectsOverlap(ghostRect, slotEl.getBoundingClientRect()) && multiCardBeats(attackCard, card, multiLastState.trumpSuit)) {
        slotEl.classList.add('drag-target');
      }
    });
  }
}

function multiResolveDropTarget(ghostRect, card, kind) {
  if (kind === 'attack') {
    return multiRectsOverlap(ghostRect, el('multiTableFelt').getBoundingClientRect()) ? { type: 'attack' } : null;
  }
  let found = null;
  document.querySelectorAll('#multiTableSlots .slot[data-open="true"]').forEach(function (slotEl) {
    if (found) return;
    const attackCard = JSON.parse(slotEl.dataset.attack);
    if (multiRectsOverlap(ghostRect, slotEl.getBoundingClientRect()) && multiCardBeats(attackCard, card, multiLastState.trumpSuit)) {
      found = { type: 'defend', slotIndex: Number(slotEl.dataset.index) };
    }
  });
  return found;
}

function multiHandleCardTap(card, kind) {
  if (kind === 'attack') {
    socket.emit('multiAttack', { cardId: card.id });
    multiSelectedCardId = null;
  } else if (kind === 'defend') {
    multiSelectedCardId = multiSelectedCardId === card.id ? null : card.id;
    multiRender(multiLastState);
  }
}

function multiAttachCardInteraction(cardEl, card, kind) {
  cardEl.addEventListener('pointerdown', function (e) {
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
      multiClearDropHighlights();
      if (multiActiveDragCancel === cancel) multiActiveDragCancel = null;
    }
    multiActiveDragCancel = cancel;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 6) {
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
        multiUpdateDropTargets(ghost.getBoundingClientRect(), card, kind);
      }
    }

    function finish() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (cancelled) return; // a re-render already tore this gesture down
      multiActiveDragCancel = null;

      if (!moved) {
        multiHandleCardTap(card, kind);
        return;
      }

      const target = multiResolveDropTarget(ghost.getBoundingClientRect(), card, kind);
      multiClearDropHighlights();

      if (target) {
        if (kind === 'attack') socket.emit('multiAttack', { cardId: card.id });
        else socket.emit('multiDefend', { cardId: card.id, slotIndex: target.slotIndex });
        ghost.remove();
        cardEl.classList.remove('drag-source-hidden');
      } else {
        ghost.style.transition = 'left 0.22s ease, top 0.22s ease';
        ghost.style.left = originRect.left + 'px';
        ghost.style.top = originRect.top + 'px';
        setTimeout(function () {
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

(() => {
  'use strict';

  const SUITS = ['♠', '♥', '♣', '♦']; // black, red, black, red
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUIT_NAME = { '♠': 'pīķi', '♥': 'sirdis', '♦': 'kāro', '♣': 'kreiči' };
  const SUIT_CLASS = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };
  const DECK_NAME = { half: '24 kārtis', full: '52 kārtis' };
  const kartis = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'kārti' : 'kārtis');
  const speletaji = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'spēlētāju' : 'spēlētājiem');

  // Messages that come from the server (English there) are shown in Latvian.
  const SERVER_MSG = [
    [/^That card is not in your hand/, 'Šīs kārts tev nav rokā.'],
    [/^The game is over/, 'Spēle ir beigusies.'],
    [/^There is nothing to challenge/, 'Vēl nav ko apsūdzēt.'],
    [/^You cannot challenge your own card/, 'Savu kārti apsūdzēt nevar.'],
    [/^You are out of this game/, 'Tu jau esi izstājies no šīs spēles.'],
    [/^Announce a (valid )?suit/, 'Paziņo mastu.'],
    [/^The suit is locked to (\S+)/, (m) => `Masts ir nofiksēts: ${m[1]}.`],
    [/^It is not your turn/, 'Tagad nav tava kārta.'],
    [/^You are not in a game/, 'Tu neesi spēlē.'],
    [/^You are already in a game/, 'Tu jau esi pie galda. Vispirms izej no tā.'],
    [/^The server is full/, 'Serveris ir pilns. Mēģini vēlāk.'],
    [/^That game is no longer open/, 'Šis galds vairs nav atvērts.'],
    [/^That game is full/, 'Pie šī galda vairs nav brīvu vietu.'],
    [/^The game has already started/, 'Spēle jau ir sākusies.'],
    [/^This table is ranked/, 'Šis ir ranked galds — pievienoties var tikai reģistrēti spēlētāji. Ielogojies!'],
    [/^The host is reconnecting/, 'Galda autors atjauno savienojumu. Mēģini pēc brīža.'],
    [/^Wrong password/, 'Nepareiza parole.'],
    [/^This game is private/, 'Šis galds ir privāts. Ievadi paroli.'],
    [/^Malformed move/, 'Nederīgs gājiens.'],
    [/^No game in progress/, 'Spēle nenotiek.'],
    [/^The game is not finished/, 'Spēle vēl nav beigusies.'],
    [/^Your opponent has left/, 'Pārējie ir izgājuši no galda.'],
    [/^The computer hit an internal error/, 'Datoram radās kļūda. Sāc jaunu spēli.'],
    [/^Server error/, 'Servera kļūda.'],
  ];
  function lv(msg) {
    for (const [re, out] of SERVER_MSG) {
      const m = re.exec(msg);
      if (m) return typeof out === 'function' ? out(m) : out;
    }
    return msg;
  }
  const SESSION_KEY = 'meli.session';
  const SETTINGS_KEY = 'meli.settings2';

  const $ = (id) => document.getElementById(id);
  // Meļi lives in its own Socket.io namespace of the Uzspēlēsim.lv server and plays under the shared
  // account (the Duraks session token in localStorage) when there is one. The sign-in itself is in
  // /lobby-auth.js, the same flow as the Duraks lobby.
  const acct = (() => {
    try { return { username: localStorage.getItem('duraks_username'), token: localStorage.getItem('duraks_token') }; } catch { return {}; }
  })();
  const hadCreds = !!(acct.username && acct.token);
  const socket = io('/meli', hadCreds ? { auth: acct } : {});
  let account = hadCreds ? acct.username : null; // optimistic until the server confirms
  function renderAccount() {
    $('authStep').classList.toggle('hidden', !!account);
    $('playStep').classList.toggle('hidden', !account);
    $('currentUsername').textContent = account || '';
  }
  socket.on('account', (a) => {
    account = a && a.username ? a.username : null;
    if (!account && hadCreds) {
      // the saved login is stale: forget it quietly, the visitor is a guest
      try { localStorage.removeItem('duraks_username'); localStorage.removeItem('duraks_token'); } catch { /* ignore */ }
    }
    renderAccount();
  });
  renderAccount();

  // the visible-viewport height for the table's size (same helper as Duraks)
  function updateAppViewportHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', h * 0.01 + 'px');
  }
  updateAppViewportHeight();
  (window.visualViewport || window).addEventListener('resize', updateAppViewportHeight);

  // ---- state -------------------------------------------------------------
  let view = null; // latest server state (the only source of truth for the table)
  let wait = null; // latest waiting-room state
  let session = null; // { code, token, seat, solo } of the room we are in
  let screen = 'lobby'; // lobby | game
  let selectedId = null;
  let claim = null; // { forId, rank, suit }
  let activeSuit = null;
  let busy = false;
  let revealTimer = null;
  let overTimer = null;
  let overShown = false;
  let outShown = false;
  let noticeText = '';
  let noticeTimer = null;
  let toastTimer = null;
  let lastRound = null;
  let turnTotal = 60000; // length of a full move, for the timer bars
  let deadline = null; // Date.now() value at which the current move's timer runs out
  let pendingJoin = null; // { code } while the password popup is open
  let invite = null; // { code, pw } from ?table= (or the old ?room=)
  let myTableName = '';
  // Only the suit-only version is switched on for now. The suit + rank version still exists in the engine
  // (server/engine.js) and is re-enabled by listing 'suit-rank' in ANNOUNCE_ENABLED (server/rooms.js).
  let settings = { total: 2, deck: 'half', ai: 0, private: false, ranked: false, announce: 'suit' };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) {
      if (saved.total >= 2 && saved.total <= 6) settings.total = saved.total;
      if (saved.deck === 'half' || saved.deck === 'full') settings.deck = saved.deck;
      if (saved.ai >= 0 && saved.ai < settings.total) settings.ai = saved.ai;
      settings.ranked = !!saved.ranked;
    }
  } catch { /* ignore */ }

  // ---- storage (can throw in private windows) -------------------------------
  const store = {
    get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
    set(area, k, v) { try { window[area].setItem(k, v); } catch { /* ignore */ } },
    del(area, k) { try { window[area].removeItem(k); } catch { /* ignore */ } },
  };

  // ---- tiny DOM helpers ----------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function cardEl(c, { tag = 'div', big = false } = {}) {
    const d = el(tag, 'm-card' + (big ? ' big' : ''));
    if (tag === 'button') d.type = 'button';
    d.dataset.suit = c.suit;
    if (c.rank === null) {
      // suit-only announcement: no particular card, so no Duraks face to show
      d.append(el('span', 'any', 'jebkura'), el('span', 'suit', c.suit));
    } else {
      // Duraks card art (sprite classes come from the shared /style.css)
      d.classList.add('card-face', `card-face-${c.rank}-${SUIT_CLASS[c.suit]}`);
    }
    d.setAttribute('aria-label', c.rank === null ? `kārts: ${SUIT_NAME[c.suit]}` : `${c.rank}, ${SUIT_NAME[c.suit]}`);
    return d;
  }

  const suitOnly = () => !!view && view.announce === 'suit';
  const face = (c) => (c.rank === null ? c.suit : c.rank + c.suit);
  const selectable = () => !!view && view.canPlay && !busy;
  const selectedCard = () => (view && selectedId ? view.hand.find((c) => c.id === selectedId) : null);
  const seatOf = (i) => (view && view.room.seats[i]) || { name: '?' };
  const nameOf = (i) => (view && i === view.you ? 'Tu' : seatOf(i).name);
  const nextOf = (i) => {
    if (!view) return i;
    for (let j = 1; j <= view.players; j++) {
      const q = (i + j) % view.players;
      if (!view.out[q]) return q;
    }
    return i;
  };

  function defaultClaim(card) {
    return { forId: card.id, rank: suitOnly() ? null : card.rank, suit: view.lockedSuit || card.suit };
  }

  function show(name) {
    screen = name;
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('meliStage').classList.toggle('hidden', name !== 'game');
    if (name === 'game') requestAnimationFrame(placeDirs);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  function saveSession() {
    if (session) store.set('sessionStorage', SESSION_KEY, JSON.stringify({ code: session.code, token: session.token }));
    else store.del('sessionStorage', SESSION_KEY);
  }

  function resetTable() {
    clearTimeout(revealTimer);
    clearTimeout(overTimer);
    $('reveal').classList.add('hidden');
    closeModal('over');
    overShown = false;
    outShown = false;
    view = null;
    selectedId = null;
    claim = null;
    activeSuit = null;
    lastRound = null;
    noticeText = '';
    deadline = null;
    busy = false;
  }

  function hideWaiting() {
    wait = null;
    $('waitBox').classList.add('hidden');
    lobbyChatShow(false);
  }

  function toLobby() {
    resetTable();
    hideWaiting();
    chatReset();
    session = null;
    saveSession();
    show('lobby');
    socket.emit('rooms:refresh');
  }

  // ---- lobby -------------------------------------------------------------
  // Signed-in players play under their account name (the server forces it). Guests send no name and
  // the server gives them "Viesis-NNNN".
  function myName() {
    return account || '';
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ total: settings.total, deck: settings.deck, ai: settings.ai, ranked: settings.ranked })); } catch { /* ignore */ }
  }

  function setActive(group, value) {
    Array.from($(group).children).forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)));
  }

  // Same create pop-up as Duraks: players 2–6, deck, how many of them are the computer, private.
  // Ranked (ELO) like Duraks: signed-in players only, and no computer at the table.
  function refreshSetup() {
    const canRank = !!account;
    if (!canRank) settings.ranked = false;
    if (settings.ranked) settings.ai = 0;
    if (settings.ai > settings.total - 1) settings.ai = settings.total - 1;
    setActive('setupTotal', settings.total);
    setActive('setupDeck', settings.deck);
    const aiGroup = $('setupAi');
    aiGroup.replaceChildren();
    for (let i = 0; i < settings.total; i++) {
      const b = el('button', 'btn-option', String(i));
      b.type = 'button';
      b.dataset.value = String(i);
      aiGroup.append(b);
    }
    setActive('setupAi', settings.ai);
    Array.from($('setupAi').children).forEach((b) => { b.disabled = settings.ranked && b.dataset.value !== '0'; });
    $('setupRanked').checked = settings.ranked;
    $('setupRanked').disabled = !canRank;
    $('setupRankedField').title = canRank ? 'Ietekmē ELO reitingu — tikai reģistrētiem, bez datora pretiniekiem' : 'Ranked spēles ir tikai reģistrētiem spēlētājiem';
    $('setupPrivate').checked = settings.private;
    $('setupPrivate').disabled = settings.ai === settings.total - 1; // nobody to keep out of a computer game
  }
  $('setupTotal').addEventListener('click', (e) => {
    const b = e.target.closest('.btn-option');
    if (!b) return;
    settings.total = Number(b.dataset.value);
    refreshSetup();
  });
  $('setupDeck').addEventListener('click', (e) => {
    const b = e.target.closest('.btn-option');
    if (!b) return;
    settings.deck = b.dataset.value;
    refreshSetup();
  });
  $('setupAi').addEventListener('click', (e) => {
    const b = e.target.closest('.btn-option');
    if (!b || b.disabled) return;
    settings.ai = Number(b.dataset.value);
    refreshSetup();
  });
  $('setupPrivate').addEventListener('change', () => { settings.private = $('setupPrivate').checked; });
  $('setupRanked').addEventListener('change', () => { settings.ranked = $('setupRanked').checked; refreshSetup(); });

  function createRoom({ total, ai, deck, isPrivate, ranked }) {
    resetTable();
    chatReset();
    socket.emit('room:create', {
      name: myName(),
      totalPlayers: total,
      aiCount: ai,
      deck,
      announce: settings.announce,
      private: !!isPrivate,
      ranked: !!ranked,
    });
  }

  function openSetup(preset) {
    if (preset) Object.assign(settings, preset, { ranked: settings.ranked });
    settings.private = false;
    refreshSetup();
    openModal('setupModal');
  }

  // Same buttons as the Duraks lobby: computer game, room with options, quick rooms (pre-filled pop-up).
  ['playGuestBtn', 'playAIBtn'].forEach((id) => $(id).addEventListener('click', () => createRoom({ total: 2, ai: 1, deck: settings.deck })));
  ['createRoomGuestBtn', 'createBtn'].forEach((id) => $(id).addEventListener('click', () => openSetup()));
  document.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const [n, deck] = b.dataset.preset.split('-');
      openSetup({ total: Number(n), deck, ai: 0 });
    });
  });
  $('createSubmit').addEventListener('click', () => {
    saveSettings();
    closeModal('setupModal');
    createRoom({ total: settings.total, ai: settings.ai, deck: settings.deck, isPrivate: settings.private && settings.ai < settings.total - 1, ranked: settings.ranked && settings.ai === 0 });
  });
  $('setupCancel').addEventListener('click', () => closeModal('setupModal'));
  $('switchUserLink').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.meliLobby && window.meliLobby.logout) window.meliLobby.logout();
  });

  function silhouettes(box, seats) {
    box.replaceChildren();
    for (const s of seats) {
      const i = el('span', 'multi-silhouette' + (s ? '' : ' multi-silhouette-empty'), s && s.ai ? '🤖' : '👤');
      if (s && s.ready && !s.ai) i.classList.add('is-ready');
      if (s) i.title = s.name;
      box.append(i);
    }
  }

  function renderRooms(list) {
    const box = $('roomList');
    box.replaceChildren();
    const rows = (list || []).filter((r) => !session || r.code !== session.code);
    if (!rows.length) {
      box.append(el('p', 'muted small', 'Nav atvērtu spēļu…'));
      return;
    }
    for (const r of rows) {
      const row = el('div', 'open-room-row');
      const info = el('div', 'open-room-info');
      info.append(el('span', 'host-name', `${r.private ? '🔒 ' : ''}${r.ranked ? '🏅 ' : ''}${r.host} · ${r.filled}/${r.total} spēlētāji`));
      const sil = el('div', 'multi-silhouette-row');
      const seats = [];
      for (let i = 0; i < r.total; i++) seats.push(i < r.people ? { name: '' } : i < r.people + r.aiCount ? { ai: true, name: 'Dators' } : null);
      silhouettes(sil, seats);
      info.append(sil, el('p', 'muted small', DECK_NAME[r.deck] || ''));
      const btn = el('button', 'btn btn-secondary', 'Pievienoties');
      btn.type = 'button';
      btn.addEventListener('click', () => joinRoom(r.code, r.private));
      row.append(info, btn);
      box.append(row);
    }
  }

  function joinRoom(code, isPrivate, password) {
    if (isPrivate && !password) {
      openPassword(code, false);
      return;
    }
    resetTable();
    chatReset();
    socket.emit('room:join', { code, name: myName(), password });
  }

  function openPassword(code, wrong) {
    pendingJoin = { code };
    $('pwText').textContent = wrong ? 'Nepareiza parole. Mēģini vēlreiz.' : 'Jautā paroli galda autoram.';
    $('pwInput').value = '';
    openModal('pwModal');
    $('pwInput').focus();
  }

  $('pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = $('pwInput').value.trim();
    if (!pendingJoin || !pw) return;
    closeModal('pwModal');
    joinRoom(pendingJoin.code, true, pw);
  });
  $('pwCancel').addEventListener('click', () => {
    pendingJoin = null;
    closeModal('pwModal');
  });

  $('refreshBtn').addEventListener('click', () => socket.emit('rooms:refresh'));

  // ---- statistics column (same blocks and numbers layout as Duraks) ---------------
  let stats = null;
  let statsScope = 'today';
  const holder = (h) => (h ? `${h.username.replace(/[<>&]/g, '')} (${h.value})` : '—');
  function renderStats() {
    if (!stats) return;
    $('gamesToday').textContent = stats.games.today;
    $('gamesAllTime').textContent = stats.games.allTime;
    $('gamesVsBotToday').textContent = stats.gamesVsBot.today;
    $('gamesVsBotAllTime').textContent = stats.gamesVsBot.allTime;
    $('streakToday').textContent = holder(stats.longestStreak.today);
    $('streakAllTime').textContent = holder(stats.longestStreak.allTime);
    $('mostPlayedToday').textContent = holder(stats.mostPlayed.today);
    $('mostPlayedAllTime').textContent = holder(stats.mostPlayed.allTime);
    const list = $('topWinRateList');
    list.replaceChildren();
    const rows = stats.topWinRate[statsScope] || [];
    if (!rows.length) list.append(el('li', 'muted small', 'Vēl nav datu…'));
    rows.forEach((r, i) => {
      const li = el('li', 'top-list-row');
      li.append(el('span', 'top-rank', `${i + 1}.`), el('span', 'top-name', r.username), el('span', 'top-pct', `${r.winPct}%`), el('span', 'top-played', `(${r.played})`));
      list.append(li);
    });
  }
  socket.on('stats', (d) => {
    stats = d;
    renderStats();
  });
  document.querySelectorAll('#topScopeTabs .stats-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      statsScope = btn.dataset.scope;
      document.querySelectorAll('#topScopeTabs .stats-tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderStats();
    });
  });

  // ---- table links: /meli/?table=CODE (the old ?room=CODE&pw=… links still work) ----------
  function readInvite() {
    const p = new URLSearchParams(location.search);
    const code = (p.get('table') || p.get('room') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return;
    invite = { code, pw: (p.get('pw') || '').trim().toUpperCase() };
    $('inviteCode').textContent = code;
    $('inviteBar').classList.remove('hidden');
  }
  function clearInvite() {
    invite = null;
    $('inviteBar').classList.add('hidden');
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  }
  $('inviteJoin').addEventListener('click', () => {
    if (!invite) return;
    const { code, pw } = invite;
    clearInvite();
    // We do not know whether it is private; the server answers with room:password if so.
    resetTable();
    chatReset();
    socket.emit('room:join', { code, name: myName(), password: pw || undefined });
  });
  $('inviteDismiss').addEventListener('click', clearInvite);

  const tableLink = (code) => `${location.origin}${location.pathname}?table=${encodeURIComponent(code)}`;

  // ---- waiting for players (inside the lobby card, like Duraks) ------------------------
  function renderWaiting(w) {
    wait = w;
    myTableName = w.seats[w.you] ? w.seats[w.you].name : myTableName;
    show('lobby');
    $('waitBox').classList.remove('hidden');
    lobbyChatShow(true);
    silhouettes($('waitSeats'), w.seats);
    $('waitInfo').textContent = `${w.filled}/${w.total} spēlētāji pievienojušies · ${DECK_NAME[w.deck] || ''}${w.ranked ? ' · 🏅 Ranked' : ''}`;
    const names = $('waitNames');
    names.replaceChildren();
    w.seats.forEach((s, i) => {
      if (!s) return;
      const li = el('li', s.ready && !s.ai ? 'is-ready' : '');
      li.append(el('span', 'nm', (s.ai ? '🤖 ' : '') + s.name + (i === w.you ? ' (tu)' : '')));
      if (!s.ai) li.append(el('span', 'tick', s.ready ? '✓ gatavs' : s.connected ? '' : 'atslēdzies'));
      names.append(li);
    });
    $('waitCode').textContent = w.code;
    $('waitPassRow').classList.toggle('hidden', !w.password);
    $('waitPass').textContent = w.password || '';
    $('shareLink').value = tableLink(w.code);
    $('sharePrivateNote').classList.toggle('hidden', !w.private);
    $('shareBtn').classList.toggle('hidden', !navigator.share);
    $('cancelWaitBtn').classList.toggle('hidden', !w.isHost);
    $('leaveWaitBtn').classList.toggle('hidden', w.isHost);

    // Early start: everybody at the table ticks "ready" and the game starts with whoever is seated.
    const box = $('readyBox');
    box.classList.toggle('hidden', !w.canStartEarly);
    if (w.canStartEarly) {
      const me = w.seats[w.you];
      const btn = $('readyBtn');
      const mine = !!(me && me.ready);
      btn.textContent = mine ? `✓ Gatavs sākt ar ${w.filled} — atsaukt` : `Sākt tagad ar ${w.filled} ${speletaji(w.filled)}`;
      btn.classList.toggle('btn-primary', !mine);
      btn.classList.toggle('btn-secondary', mine);
      btn.setAttribute('aria-pressed', String(mine));
      $('readyInfo').textContent = `Gatavi: ${w.ready}/${w.people}. Spēle sāksies, kad visi pie galda būs gatavi vai kad galds būs pilns.`;
    }
  }

  $('readyBtn').addEventListener('click', () => {
    if (!wait) return;
    const me = wait.seats[wait.you];
    socket.emit('room:ready', { ready: !(me && me.ready) });
  });
  $('copyLinkBtn').addEventListener('click', async () => {
    if (!wait) return;
    const url = tableLink(wait.code);
    try {
      await navigator.clipboard.writeText(url);
      toast('Saite nokopēta');
    } catch {
      $('shareLink').select();
      window.prompt('Nokopē saiti uz galdu:', url);
    }
  });
  $('shareBtn').addEventListener('click', () => {
    if (!wait || !navigator.share) return;
    navigator.share({ title: 'Meļi — Uzspēlēsim.lv', text: 'Nāc uzspēlēt Meļus!', url: tableLink(wait.code) }).catch(() => {});
  });
  $('cancelWaitBtn').addEventListener('click', () => socket.emit('room:leave'));
  $('leaveWaitBtn').addEventListener('click', () => socket.emit('room:leave'));

  // ---- table chat (lobby block while waiting, 💬 panel in the game) ------------------------
  let chatOpen = false;
  let chatUnread = 0;
  const lobbyChatVisible = () => !$('lobbyChatPanel').classList.contains('hidden') && screen === 'lobby';
  function lobbyChatShow(on) {
    $('lobbyChatPanel').classList.toggle('hidden', !on);
  }
  function chatBadge() {
    const btn = $('chatBtn');
    let badge = btn.querySelector('.chat-badge');
    if (chatUnread > 0) {
      if (!badge) {
        badge = el('span', 'chat-badge');
        btn.append(badge);
      }
      badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
    } else if (badge) {
      badge.remove();
    }
  }
  function chatSetOpen(open) {
    chatOpen = open;
    $('chatPanel').classList.toggle('hidden', !open);
    if (open) {
      chatUnread = 0;
      chatBadge();
      $('chatInput').focus();
    }
  }
  function chatReset() {
    $('chatMessages').replaceChildren();
    $('lobbyChatMessages').replaceChildren(el('p', 'muted small lobby-chat-empty', 'Uzraksti kaut ko, kamēr gaidi spēlētājus.'));
    chatUnread = 0;
    chatBadge();
    chatSetOpen(false);
  }
  function chatAdd(msg) {
    const mine = msg.from === myTableName;
    for (const id of ['chatMessages', 'lobbyChatMessages']) {
      const wrap = $(id);
      const empty = wrap.querySelector('.lobby-chat-empty');
      if (empty) empty.remove();
      const row = el('div', 'chat-msg' + (mine ? ' own' : ''));
      row.append(el('span', 'who', msg.from + ':'), document.createTextNode(' ' + msg.text));
      wrap.append(row);
      wrap.scrollTop = wrap.scrollHeight;
    }
    return mine;
  }
  function chatSend(input) {
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
  }
  $('chatBtn').addEventListener('click', () => chatSetOpen(!chatOpen));
  $('chatCloseBtn').addEventListener('click', () => chatSetOpen(false));
  $('chatSendBtn').addEventListener('click', () => chatSend($('chatInput')));
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend($('chatInput')); });
  $('lobbyChatSendBtn').addEventListener('click', () => chatSend($('lobbyChatInput')));
  $('lobbyChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend($('lobbyChatInput')); });
  socket.on('chat', (msg) => {
    const mine = chatAdd(msg);
    if (!chatOpen && !mine && !lobbyChatVisible()) {
      chatUnread += 1;
      chatBadge();
    }
  });
  socket.on('chat:history', (list) => {
    $('chatMessages').replaceChildren();
    $('lobbyChatMessages').replaceChildren();
    if (!list || !list.length) $('lobbyChatMessages').append(el('p', 'muted small lobby-chat-empty', 'Uzraksti kaut ko, kamēr gaidi spēlētājus.'));
    (list || []).forEach(chatAdd);
  });

  // ---- the round table -------------------------------------------------------------
  // Seats by player count, indexed by clockwise distance from me (me = 0, always at the bottom;
  // 1 = my left-hand neighbour, who plays after me). The classes are placed in /multi.css.
  const SEAT_CLASSES = {
    2: [null, 'seat-top'],
    3: [null, 'seat-tl', 'seat-tr'],
    4: [null, 'seat-left', 'seat-top', 'seat-right'],
    // 5–6 players: Meļi's own spots (meli.css), wider apart than the Duraks ones
    5: [null, 'seat-l6', 'seat-tl6', 'seat-tr6', 'seat-r6'],
    6: [null, 'seat-l6', 'seat-tl6', 'seat-top', 'seat-tr6', 'seat-r6'],
  };
  const DIR_ANGLES = { 2: [90, 270], 3: [90, 210, 330], 4: [90, 180, 270, 360], 5: [90, 160, 235, 305, 380], 6: [90, 160, 225, 270, 315, 380] };

  function placeDirs() {
    if (!view) return;
    const layer = $('dirs');
    const table = document.querySelector('#multiGame .multi-round-table');
    const wood = $('wood');
    if (!table || !wood.clientWidth) return;
    const wr = wood.getBoundingClientRect();
    const tr = table.getBoundingClientRect();
    const cx = tr.left - wr.left + tr.width / 2;
    const cy = tr.top - wr.top + tr.height / 2;
    const rx = (tr.width / 2) * 1.14;
    const ry = (tr.height / 2) * 1.24;
    const angles = DIR_ANGLES[view.players] || DIR_ANGLES[4];
    layer.replaceChildren();
    for (let k = 0; k < angles.length; k++) {
      const a0 = angles[k];
      const a1 = k === angles.length - 1 ? angles[0] + 360 : angles[k + 1];
      const th = (((a0 + a1) / 2) * Math.PI) / 180;
      const x = cx + rx * Math.cos(th);
      const y = cy + ry * Math.sin(th);
      const ang = (Math.atan2(ry * Math.cos(th), -rx * Math.sin(th)) * 180) / Math.PI;
      const d = el('span', 'multi-dir');
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      d.style.transform = `translate(-50%,-50%) rotate(${ang}deg)`;
      layer.append(d);
    }
  }
  window.addEventListener('resize', () => {
    placeDirs();
    if (view) renderHand();
  });

  function roleOf(i) {
    const s = seatOf(i);
    if (view.out[i]) return s.left ? 'Izgāja' : 'Izstājies';
    if (!s.ai && !s.connected) return 'Atslēdzies';
    if (view.phase !== 'play') return view.winner === i ? 'Uzvarētājs' : '';
    if (view.turn === i) return s.ai ? 'Domā' : 'Gājiens';
    if (view.pile.top === i) return 'Nolika';
    return '';
  }

  function seatTimer(i) {
    const t = el('div', 'turn-timer-h');
    t.append(el('div', 'turn-timer-fill'));
    if (!(view.phase === 'play' && deadline !== null && view.turn === i)) t.classList.add('idle');
    return t;
  }

  function renderSeats() {
    const box = $('seats');
    box.replaceChildren();
    const n = view.players;
    const classes = SEAT_CLASSES[n] || SEAT_CLASSES[6];
    for (let k = 1; k < n; k++) {
      const i = (view.you + k) % n;
      const s = seatOf(i);
      const seat = el('div', 'multi-seat ' + (classes[k] || 'seat-top'));
      if (view.out[i]) seat.classList.add('multi-safe');
      if (view.phase === 'play' && view.turn === i) seat.classList.add('multi-now');
      seat.append(el('span', 'multi-seat-name', s.name + (s.ai ? ' 🤖' : '')), seatTimer(i));
      const role = roleOf(i);
      seat.append(el('span', 'multi-seat-role' + (role ? '' : ' empty'), role || '-'));
      const cards = el('div', 'multi-seat-cards');
      const count = view.counts[i] || 0;
      for (let c = 0; c < Math.min(count, n > 4 ? 5 : 8); c++) cards.append(el('div', 'card-back-mini'));
      seat.append(cards, el('span', 'multi-seat-count', `${count} ${kartis(count)}`));
      box.append(seat);
    }
    const me = $('mePill');
    me.className = 'multi-seat multi-seat-me' + (view.phase === 'play' && view.turn === view.you ? ' multi-now' : '');
    me.replaceChildren();
    const myRole = roleOf(view.you);
    me.append(
      el('span', 'multi-seat-name', `${view.room.myName} (tu)`),
      el('span', 'multi-seat-role' + (myRole ? '' : ' empty'), myRole || '-')
    );
  }

  function renderTurnBar() {
    const bar = $('turnBar');
    bar.replaceChildren();
    const chip = (cls, small, text) => {
      const c = el('span', 'multi-chip ' + cls);
      c.append(el('small', null, small), document.createTextNode(' ' + text));
      bar.append(c);
    };
    if (view.phase !== 'play') {
      chip('multi-chip-now', 'Beigas', view.winner === view.you ? 'Tu uzvarēji' : `${nameOf(view.winner)} uzvar`);
      return;
    }
    const t = view.turn;
    chip('multi-chip-now', 'Tagad', t === view.you ? 'Tavs gājiens' : nameOf(t));
    if (view.players > 2) {
      bar.append(el('span', 'multi-chip-arrow', '→'));
      const nx = nextOf(t);
      chip('', 'Nākamais', nx === view.you ? 'Tu' : nameOf(nx));
    }
  }

  // The claimed suit of the round: the same dashed card as an empty Duraks deck shows for the trump.
  function renderClaim() {
    const pile = $('claimPile');
    const card = $('claimCard');
    const s = view.lockedSuit;
    pile.classList.toggle('hidden', !s);
    pile.classList.toggle('last', !!s);
    card.replaceChildren();
    if (!s) return;
    const g = el('span', 'trump-ghost ' + (s === '♥' || s === '♦' ? 'red' : 'black'));
    g.append(el('span', 'sym', s), el('span', 'lbl', 'apgalvots'));
    card.append(g);
    card.title = `Šajā aplī apgalvotais masts: ${SUIT_NAME[s]}`;
    card.setAttribute('aria-label', card.title);
  }

  function renderPile() {
    const pile = $('pile');
    pile.replaceChildren();
    const n = view.pile.count;
    if (!n) {
      pile.append(el('div', 'm-pile-empty', 'Galds ir tukšs'));
      return;
    }
    const shown = Math.min(n, 6);
    for (let i = 0; i < shown; i++) {
      const b = el('div', 'back');
      b.style.transform = `translate(${i * 2}px, ${-i * 2}px) rotate(${(i % 2 ? 1 : -1) * (i * 3 + 2)}deg)`;
      pile.append(b);
    }
    pile.append(el('div', 'pile-count', String(n)));
    const last = view.pile.claims[n - 1];
    const cap = el('div', 'm-pile-cap');
    cap.append(document.createTextNode('pēdējo nolika '), el('b', null, last.by === 'you' ? 'tu' : nameOf(last.player)));
    pile.append(cap);
  }

  function setStatusText(t) {
    $('status').textContent = t;
  }

  function renderStatus() {
    if (noticeText) return setStatusText(noticeText);
    if (view.phase === 'over') return setStatusText('Spēle beigusies.');
    if (view.out[view.you]) return setStatusText('Tu esi izstājies. Pārējie spēlē tālāk.');
    const t = view.turn;
    const ts = seatOf(t);
    if (!view.canPlay) {
      if (!ts.ai && !ts.connected) return setStatusText(`${ts.name} zaudēja savienojumu. Gaidām atgriežamies…`);
      const n = view.pile.count;
      const lastMine = n > 0 && view.pile.claims[n - 1].by === 'you';
      if (ts.ai) return setStatusText(`${ts.name} domā…`);
      return setStatusText(lastMine ? `Tu noliki kārti. Gaidām ${ts.name}…` : `Gaidām ${ts.name}…`);
    }
    const n = view.pile.count;
    if (n === 0) {
      return setStatusText(
        suitOnly()
          ? 'Tavs gājiens: noliec jebkuru kārti un paziņo mastu. Drīksti melot.'
          : 'Tavs gājiens: noliec jebkuru kārti un paziņo to. Drīksti melot.'
      );
    }
    const last = view.pile.claims[n - 1];
    const who = nameOf(last.player);
    const hasLegit = view.hand.some((c) => c.suit === view.lockedSuit);
    let txt = view.canChallenge
      ? `${who} apgalvo ${suitOnly() ? last.suit : face(last)}. Liec savu kārti vai spied «Neticu!».`
      : `Liec savu kārti (${view.lockedSuit}).`;
    if (!hasLegit) txt += ` Tev nav masta ${view.lockedSuit}, tāpēc būs jāmelo.`;
    setStatusText(txt);
  }

  function render() {
    if (!view) return;
    renderSeats();
    renderTurnBar();
    renderClaim();
    renderPile();
    renderStatus();
    renderHand();
    renderAct();
    renderHint();
    renderButtons();
    paintTimers();
  }

  // ---- move timers: the vertical bar is mine, the short ones under names are the others' ----
  function paintBar(bar, frac, vertical) {
    const f = bar.querySelector('.turn-timer-fill');
    if (!f) return;
    if (vertical) f.style.height = frac * 100 + '%';
    else f.style.width = frac * 100 + '%';
    f.style.backgroundColor = 'hsl(' + (120 * Math.min(1, frac / 0.7)).toFixed(0) + ', 72%, 46%)';
    bar.classList.toggle('tt-warn', frac <= 0.3 && frac > 0.12);
    bar.classList.toggle('tt-crit', frac <= 0.12);
  }
  function paintTimers() {
    const root = $('turnTimer');
    const live = !!(view && view.phase === 'play' && deadline !== null);
    const mine = live && view.turn === view.you;
    root.classList.toggle('hidden-timer', !mine);
    if (!live) return;
    const left = deadline - Date.now();
    const frac = Math.max(0, Math.min(1, left / turnTotal));
    if (mine) {
      paintBar(root, frac, true);
      root.querySelector('.turn-timer-secs').textContent = String(Math.max(0, Math.ceil(left / 1000)));
    }
    document.querySelectorAll('#seats .turn-timer-h').forEach((b) => paintBar(b, frac, false));
  }
  setInterval(paintTimers, 200);

  function ensureActiveSuit() {
    const has = (s) => view.hand.some((c) => c.suit === s);
    if (activeSuit && has(activeSuit)) return;
    activeSuit = (view.lockedSuit && has(view.lockedSuit) && view.lockedSuit) || SUITS.find(has) || null;
  }

  // ---- my hand: two-tap play ---------------------------------------------
  // The whole hand is one row, grouped by suit (the locked suit first). With a
  // big hand only one suit is spread out and the others sit in small stacks
  // with a count; tapping a stack spreads that suit. Tap a card to lift it
  // (a bubble says what it will announce and whether that's true), tap it
  // again to place it. At the start of a round the bar under the table also
  // offers the four suits to announce something else.
  function cardWidth() {
    const probe = el('div', 'm-card');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    $('fan').append(probe);
    const w = probe.getBoundingClientRect().width || 72.5;
    probe.remove();
    return w;
  }
  // How many cards fit in one row with at least ~22 px of each card showing.
  function fitCount() {
    const fan = $('fan');
    return Math.max(6, Math.floor((fan.clientWidth - 16 - cardWidth()) / 22) + 1);
  }
  const byRank = (a, b) => (view.ranks || RANKS).indexOf(a.rank) - (view.ranks || RANKS).indexOf(b.rank);

  function handGroups() {
    ensureActiveSuit();
    const lock = view.lockedSuit;
    const order = SUITS.slice().sort((x, y) => (y === lock) - (x === lock));
    const compact = view.hand.length > fitCount();
    return order
      .map((s) => ({ suit: s, cards: view.hand.filter((c) => c.suit === s).sort(byRank) }))
      .filter((g) => g.cards.length)
      .map((g) => ({ ...g, open: !compact || g.suit === activeSuit }));
  }

  function claimText(c) {
    return suitOnly() ? c.suit : (c.rank || '?') + c.suit;
  }
  function isTruth(card, c) {
    return suitOnly() ? c.suit === card.suit : c.rank === card.rank && c.suit === card.suit;
  }

  function renderHand() {
    const fan = $('fan');
    fan.replaceChildren();
    if (!view.hand.length) {
      fan.append(el('div', 'm-hint', view.out[view.you] ? '' : 'Tava roka ir tukša'));
      return;
    }
    const ok = selectable();
    const lock = view.lockedSuit;
    const row = el('div', 'fan-row');
    for (const g of handGroups()) {
      if (!g.open) {
        const st = el('button', 'm-stack');
        st.type = 'button';
        st.dataset.suit = g.suit;
        st.setAttribute('aria-label', `${SUIT_NAME[g.suit]}: ${g.cards.length} ${kartis(g.cards.length)}. Izvērst`);
        const top = g.cards[g.cards.length - 1];
        st.append(cardEl(top), cardEl(top), el('b', null, `${g.suit} ${g.cards.length}`));
        st.addEventListener('click', () => {
          activeSuit = g.suit;
          renderHand();
        });
        row.append(st);
        continue;
      }
      g.cards.forEach((c, i) => {
        const d = cardEl(c, { tag: 'button' });
        if (i === 0) d.classList.add('m-group');
        if (ok) d.classList.add('m-playable');
        const selected = c.id === selectedId;
        if (selected) d.classList.add('m-selected');
        if (ok && lock) {
          const honest = c.suit === lock;
          d.append(el('span', 'm-mark ' + (honest ? 't' : 'f'), honest ? '✓' : '✕'));
          d.title = honest ? 'Ar šo kārti saki taisnību' : 'Ar šo kārti melo';
          if (!honest && !selected) d.classList.add('m-off');
        }
        if (selected && claim) {
          const truth = isTruth(c, claim);
          d.append(el('span', 'm-bubble', `Liec kā ${claimText(claim)} · ${truth ? 'taisnība' : 'meli'}`));
        }
        d.addEventListener('click', () => tapCard(c));
        row.append(d);
      });
    }
    fan.append(row);
    fitHand(row);
  }

  // squeeze the overlap so the row fits the table
  function fitHand(row) {
    const cards = [...row.querySelectorAll('.fan-row > .m-card')];
    if (cards.length < 2) return;
    const cardW = cards[0].getBoundingClientRect().width;
    const stacks = [...row.querySelectorAll('.m-stack')].reduce((w, x) => w + x.getBoundingClientRect().width + 10, 0);
    const groups = row.querySelectorAll('.m-card.m-group').length;
    const avail = $('fan').clientWidth - 16 - stacks - (groups - 1) * 10;
    const step = Math.max(16, Math.min(cardW * 0.62, (avail - cardW) / (cards.length - 1)));
    cards.forEach((d, i) => {
      if (i === 0) return;
      d.style.marginLeft = (d.classList.contains('m-group') ? step - cardW + 10 : step - cardW) + 'px';
    });
  }

  function tapCard(c) {
    if (!selectable()) return;
    if (selectedId === c.id && claim) return playSelected();
    selectedId = c.id;
    claim = defaultClaim(c);
    if (c.suit !== activeSuit && view.hand.length > fitCount()) activeSuit = c.suit;
    renderHand();
    renderAct();
    renderHint();
  }

  function playSelected() {
    const card = selectedCard();
    if (!card || !claim || busy || !view.canPlay) return;
    busy = true;
    socket.emit('play', { cardId: card.id, claim: suitOnly() ? { suit: claim.suit } : { rank: claim.rank, suit: claim.suit } });
    renderAct();
    renderHint();
  }

  // The bar under the table: "Neticu!" when it can be pressed, and/or what to announce for the lifted card.
  function renderAct() {
    const bar = $('actBar');
    bar.replaceChildren();
    if (!view) return;
    if (view.canChallenge && !busy) {
      const m = el('button', 'm-meli', 'Neticu!');
      m.type = 'button';
      m.addEventListener('click', () => {
        if (busy || !view || !view.canChallenge) return;
        busy = true;
        socket.emit('challenge');
        renderAct();
      });
      bar.append(m);
    }
    const card = selectedCard();
    if (!card || !claim || !view.canPlay || busy) return;
    const lock = view.lockedSuit;
    if (!lock) {
      const row = el('div', 'm-announce');
      for (const s of SUITS) {
        const o = el('button', 'm-ann' + (s === card.suit ? ' real' : '') + (claim.suit === s ? ' on' : ''), s);
        o.type = 'button';
        o.dataset.suit = s;
        o.setAttribute('aria-label', `Paziņot ${SUIT_NAME[s]}` + (s === card.suit ? ' (taisnība)' : ''));
        o.addEventListener('click', () => {
          claim.suit = s;
          if (suitOnly()) return playSelected();
          renderHand();
          renderAct();
        });
        row.append(o);
      }
      bar.append(row);
    }
    if (!suitOnly()) {
      const used = new Set(view.pile.claims.map((c) => c.rank + c.suit));
      const row = el('div', 'm-announce ranks');
      for (const r of view.ranks || RANKS) {
        const o = el('button', 'm-ann m-rank' + (claim.rank === r ? ' on' : '') + (used.has(r + claim.suit) ? ' used' : '') + (r === card.rank ? ' real' : ''), r);
        o.type = 'button';
        o.title = used.has(r + claim.suit) ? 'Šajā raundā jau paziņota' : '';
        o.addEventListener('click', () => {
          claim.rank = r;
          renderHand();
          renderAct();
        });
        row.append(o);
      }
      bar.append(row);
    }
  }

  function renderHint() {
    const h = $('handHint');
    if (!view || !view.canPlay || busy || view.phase !== 'play') { h.textContent = ''; return; }
    const card = selectedCard();
    if (!card) {
      h.textContent = 'Pieskaries kārtij.' + (view.canChallenge ? ' Netici? Spied «Neticu!».' : '');
      return;
    }
    if (!suitOnly()) {
      h.textContent = view.lockedSuit
        ? 'Izvēlies vērtību, ko paziņot, un pieskaries kārtij vēlreiz.'
        : 'Izvēlies mastu un vērtību, ko paziņot, un pieskaries kārtij vēlreiz.';
      return;
    }
    h.textContent = view.lockedSuit
      ? 'Pieskaries tai pašai kārtij vēlreiz, lai noliktu.'
      : 'Izvēlies mastu, ko paziņot (zaļais ir patiesais), vai pieskaries kārtij vēlreiz.';
  }

  function renderButtons() {
    const canSurrender = !!(view && view.phase === 'play' && !view.out[view.you]);
    $('menuBtn').classList.toggle('hidden', !canSurrender);
    $('surrenderText').textContent = view && view.players > 2
      ? 'Tu izstāsies no spēles, pārējie spēlēs tālāk. Turi nospiestu 1,5 sekundes.'
      : 'Pretinieks tiks pasludināts par uzvarētāju. Turi nospiestu 1,5 sekundes.';
    if (!canSurrender) closeMenu();
  }

  // ---- reveal ------------------------------------------------------------
  function hideReveal() {
    clearTimeout(revealTimer);
    $('reveal').classList.add('hidden');
  }

  function showReveal(r) {
    const me = view ? view.you : 0;
    const box = $('reveal');
    box.replaceChildren();
    const who = (i) => (i === me ? 'Tu' : nameOf(i));
    const whose = (i) => (i === me ? 'tavu' : `${nameOf(i)}`);

    const title = r.final
      ? `${r.accused === me ? 'Tava pēdējā kārts' : `${nameOf(r.accused)} pēdējā kārts`} tika pārbaudīta`
      : r.challenger === me
        ? `Tu neticēji ${nameOf(r.accused)} kārtij`
        : r.accused === me
          ? `${nameOf(r.challenger)} neticēja tavai kārtij`
          : `${nameOf(r.challenger)} neticēja ${whose(r.accused)} kārtij`;
    box.append(el('div', 'sub', title));

    const pair = el('div', 'pair');
    const a = el('div');
    a.append(el('div', 'lab', 'Apgalvots'), cardEl(r.claim, { big: true }));
    const b = el('div', 'actual');
    b.append(el('div', 'lab', 'Patiesībā'), cardEl(r.actual, { big: true }));
    pair.append(a, b);
    box.append(pair);

    const n = `${r.taken} ${kartis(r.taken)}`;
    const picks = r.loser === me ? 'Tu paņem' : `${nameOf(r.loser)} paņem`;
    let verdict;
    let good;
    if (r.final && !r.lie) {
      good = r.accused === me;
      verdict = good ? 'Pēdējā kārts godīga. Tu uzvari!' : `Pēdējā kārts godīga. ${nameOf(r.accused)} uzvar.`;
    } else if (r.lie) {
      good = r.accused !== me;
      verdict = `${r.accused === me ? 'Pieķerts melos!' : `${nameOf(r.accused)} meloja!`} ${picks} ${n}.`;
    } else {
      good = r.loser !== me;
      verdict = `Tā bija taisnība. ${picks} ${n}.`;
    }
    box.append(el('div', `verdict ${good ? 'good' : 'bad'}`, verdict));

    if (!(r.final && !r.lie)) {
      const starter = r.lie ? r.challenger : r.accused;
      box.append(el('div', 'sub', starter === me ? 'Nākamo apli sāc tu.' : `${who(starter)} sāk nākamo apli.`));
    }
    box.onclick = hideReveal; // a tap closes it early; otherwise it goes away by itself
    box.classList.remove('hidden');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideReveal, 3200);
  }

  // ---- notices ---------------------------------------------------------
  function flash(msg) {
    if (screen !== 'game') return toast(msg);
    noticeText = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeText = '';
      if (view) renderStatus();
    }, 3500);
    setStatusText(msg);
  }

  // ---- game over / out of the game -----------------------------------------------
  const OUT_TEXT = { left: 'izgāja no spēles', disconnect: 'atslēdzās', timeout: 'pietrūka laika', surrender: 'padevās' };

  function showOver(v) {
    overShown = true;
    const win = v.winner === v.you;
    const winner = v.room.seats[v.winner] ? v.room.seats[v.winner].name : '?';
    const d = v.room.endDetail;
    const others = v.room.seats.map((s, i) => [s, i]).filter(([, i]) => i !== v.winner && i !== v.you);
    let title;
    let text;
    if (win) {
      title = 'Tu uzvari! 🎉';
      if (d === 'empty-hand') text = 'Tu pirmais atbrīvojies no kārtīm.';
      else if (others.length === 1) text = `${others[0][0].name} ${OUT_TEXT[d] || 'izstājās'}.`;
      else text = 'Visi pārējie izstājās no spēles.';
    } else {
      title = `${winner} uzvar`;
      const myOut = v.room.seats[v.you].outDetail;
      text = myOut === 'timeout' ? 'Tev pietrūka laika.'
        : myOut === 'surrender' ? 'Tu padevies.'
        : d === 'empty-hand' ? `${winner} pirmais atbrīvojās no kārtīm.`
        : 'Pārējie izstājās no spēles.';
    }
    $('overTitle').textContent = title;
    $('overText').textContent = text;

    const rm = v.room.rematch;
    const again = $('againBtn');
    const note = $('rematchNote');
    again.classList.toggle('hidden', !rm.possible);
    again.textContent = v.room.solo ? 'Spēlēt vēlreiz' : 'Atkārtot';
    again.disabled = rm.you;
    $('watchBtn').classList.add('hidden');
    note.textContent = !rm.possible
      ? 'Pārējie ir izgājuši. Atgriezies vestibilā, lai sāktu jaunu spēli.'
      : rm.you && rm.waiting.length
        ? `Gaidām, kad atkārtot piekritīs: ${rm.waiting.join(', ')}…`
        : !rm.you && rm.agreed.length
          ? `Atkārtot vēlas: ${rm.agreed.join(', ')}!`
          : '';
    openModal('over');
    if (!again.disabled && rm.possible) again.focus();
  }

  // I am out but the others play on: offer to watch or to go back to the lobby.
  function showOut(v) {
    outShown = true;
    const d = v.room.seats[v.you].outDetail;
    $('overTitle').textContent = 'Tu izstājies';
    $('overText').textContent = (d === 'timeout' ? 'Tev pietrūka laika. ' : d === 'surrender' ? 'Tu padevies. ' : '') + 'Pārējie spēlē tālāk.';
    $('rematchNote').textContent = '';
    $('againBtn').classList.add('hidden');
    $('watchBtn').classList.remove('hidden');
    openModal('over');
  }

  // ---- socket events ---------------------------------------------------
  socket.on('connect', () => {
    const raw = store.get('sessionStorage', SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      if (s && s.code && s.token) socket.emit('room:resume', s);
    } catch { store.del('sessionStorage', SESSION_KEY); }
  });

  socket.on('disconnect', () => {
    busy = true;
    if (screen === 'game' && view) {
      setStatusText('Savienojums pārtrūcis. Atjaunojam…');
      renderButtons();
    }
  });

  let lastRooms = [];
  socket.on('rooms', (list) => {
    lastRooms = list || [];
    renderRooms(lastRooms);
  });

  socket.on('room:joined', (s) => {
    session = s;
    saveSession();
    if (invite) clearInvite();
    renderRooms(lastRooms);
    // the waiting state or the table follows
  });

  socket.on('room:waiting', renderWaiting);
  socket.on('room:started', () => hideWaiting());

  socket.on('room:left', toLobby);

  socket.on('room:cancelled', () => {
    toLobby();
    toast('Galda autors atcēla istabu.');
  });

  socket.on('room:gone', () => {
    const had = screen !== 'lobby' || !!wait;
    toLobby();
    if (had) toast('Šī spēle vairs nav pieejama.');
  });

  socket.on('room:password', ({ code, wrong }) => {
    openPassword(code, wrong);
  });

  socket.on('state', (v) => {
    const wasMyTurn = !!(view && view.canPlay);
    const firstState = !view;
    busy = false;
    view = v;
    myTableName = v.room.myName;
    deadline = v.room.turnMs !== null && v.room.turnMs !== undefined ? Date.now() + v.room.turnMs : null;
    if (deadline !== null) turnTotal = Math.max(60000, v.room.turnMs);

    if (wait) hideWaiting();
    if (v.pile.count > 0) hideReveal();
    if (!v.canPlay || v.round !== lastRound || !v.hand.some((c) => c.id === selectedId)) {
      selectedId = null;
      claim = null;
    }
    lastRound = v.round;
    if (v.canPlay && !wasMyTurn && v.lockedSuit && v.hand.some((c) => c.suit === v.lockedSuit)) {
      activeSuit = v.lockedSuit;
    }

    show('game');
    render();
    if (firstState) requestAnimationFrame(placeDirs);

    clearTimeout(overTimer);
    if (v.phase === 'over') {
      if (overShown) showOver(v);
      else overTimer = setTimeout(() => showOver(v), v.room.endDetail === 'empty-hand' ? 2400 : 300);
    } else {
      overShown = false;
      if (v.out[v.you]) {
        if (!outShown) showOut(v);
      } else {
        outShown = false;
        closeModal('over');
      }
    }
  });

  socket.on('reveal', showReveal);

  socket.on('notice', (msg) => {
    busy = false;
    if (view && screen === 'game') {
      renderButtons();
      renderHand();
      renderAct();
      renderHint();
    }
    flash(lv(String(msg)));
  });

  // ---- user actions -------------------------------------------------------
  $('againBtn').addEventListener('click', () => {
    socket.emit('rematch');
    $('againBtn').disabled = true;
  });
  $('lobbyBtn').addEventListener('click', () => socket.emit('room:leave'));
  $('watchBtn').addEventListener('click', () => closeModal('over'));

  // "Padoties" lives in the corner menu and needs a 1.5 s press-and-hold,
  // the same as in Duraks, so it can't be hit by accident.
  let holdRaf = null;
  function stopHold() {
    if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = null; }
    const fill = $('surrenderHold').querySelector('.multi-hold-fill');
    fill.style.transition = 'width 0.2s';
    fill.style.width = '0';
  }
  function closeMenu() {
    $('menuSheet').classList.add('hidden');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    stopHold();
  }
  function startHold() {
    if (holdRaf || !view || view.phase !== 'play') return;
    const fill = $('surrenderHold').querySelector('.multi-hold-fill');
    const t0 = performance.now();
    fill.style.transition = 'none';
    holdRaf = requestAnimationFrame(function tick(t) {
      const p = Math.min((t - t0) / 1500, 1);
      fill.style.width = p * 100 + '%';
      if (p >= 1) {
        holdRaf = null;
        closeMenu();
        socket.emit('surrender');
      } else {
        holdRaf = requestAnimationFrame(tick);
      }
    });
  }
  $('menuBtn').addEventListener('click', () => {
    const open = $('menuSheet').classList.contains('hidden');
    $('menuSheet').classList.toggle('hidden', !open);
    $('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) stopHold();
  });
  $('menuCancel').addEventListener('click', closeMenu);
  $('surrenderHold').addEventListener('pointerdown', (e) => { e.preventDefault(); startHold(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('surrenderHold').addEventListener(ev, stopHold));
  $('surrenderHold').addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); }
  });
  $('surrenderHold').addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopHold(); });

  // ---- card design (shared with Duraks: same browser setting) ------------
  const CARD_DECK_KEY = 'duraks_card_deck';
  function applyCardDeck() {
    let v = null;
    try { v = localStorage.getItem(CARD_DECK_KEY); } catch (e) { /* storage blocked */ }
    let deck = v === 'png' || v === 'classic' ? v : 'svg';
    if (deck === 'svg') {
      if (window.DuraksSvgCards) window.DuraksSvgCards.install();
      else deck = 'png';
    }
    if (deck === 'png') delete document.documentElement.dataset.cardDeck;
    else document.documentElement.dataset.cardDeck = deck;
    $('cardDeckSelect').value = deck === 'svg' ? 'svg' : 'png';
  }
  $('cardDeckSelect').addEventListener('change', () => {
    try { localStorage.setItem(CARD_DECK_KEY, $('cardDeckSelect').value); } catch (e) { /* this visit only */ }
    applyCardDeck();
  });

  // ---- init ---------------------------------------------------------------
  applyCardDeck();
  refreshSetup();
  readInvite();
})();

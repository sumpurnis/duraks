(() => {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUIT_NAME = { '♠': 'pīķi', '♥': 'sirdis', '♦': 'kāro', '♣': 'kreiči' };
  const MODE_NAME = { suit: 'Masts', 'suit-rank': 'Masts + vērtība' };
  const kartis = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'kārti' : 'kārtis');

  // Messages that come from the server (English there) are shown in Latvian.
  const SERVER_MSG = [
    [/^That card is not in your hand/, 'Šīs kārts tev nav rokā.'],
    [/^The game is over/, 'Spēle ir beigusies.'],
    [/^There is nothing to challenge/, 'Vēl nav ko apsūdzēt.'],
    [/^Announce a (valid )?suit/, 'Paziņo mastu.'],
    [/^The suit is locked to (\S+)/, (m) => `Masts ir nofiksēts: ${m[1]}.`],
    [/^It is not your turn/, 'Tagad nav tava kārta.'],
    [/^You are not in a game/, 'Tu neesi spēlē.'],
    [/^You are already in a game/, 'Tu jau esi spēlē. Vispirms izej no tās.'],
    [/^The server is full/, 'Serveris ir pilns. Mēģini vēlāk.'],
    [/^That game is no longer open/, 'Šī spēle vairs nav atvērta.'],
    [/^The host is reconnecting/, 'Spēles autors atjauno savienojumu. Mēģini pēc brīža.'],
    [/^Wrong password/, 'Nepareiza parole.'],
    [/^This game is private/, 'Šī spēle ir privāta. Ievadi paroli.'],
    [/^Malformed move/, 'Nederīgs gājiens.'],
    [/^No game in progress/, 'Spēle nenotiek.'],
    [/^The game is not finished/, 'Spēle vēl nav beigusies.'],
    [/^Your opponent has left/, 'Pretinieks ir izgājis no spēles.'],
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
  const SETTINGS_KEY = 'meli.settings';

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

  // ---- state -------------------------------------------------------------
  let view = null; // latest server state (the only source of truth for the table)
  let session = null; // { code, token, seat, vsAI, password } of the room we are in
  let screen = 'lobby'; // lobby | waiting | game
  let selectedId = null;
  let claim = null; // { forId, rank, suit }
  let activeSuit = null;
  let busy = false;
  let revealTimer = null;
  let overTimer = null;
  let overShown = false;
  let noticeText = '';
  let noticeTimer = null;
  let toastTimer = null;
  let lastRound = null;
  let deadline = null; // Date.now() value at which our/their turn timer runs out
  let pendingJoin = null; // { code } while the password popup is open
  let invite = null; // { code, pw } from ?room=
  let settings = { announce: 'suit', size: '10', private: 'off' };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && (saved.announce === 'suit' || saved.announce === 'suit-rank')) settings.announce = saved.announce;
    if (saved && (saved.size === '10' || saved.size === '26')) settings.size = saved.size;
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
    d.append(c.rank === null ? el('span', 'any', 'jebkura') : el('span', null, c.rank), el('span', 'suit', c.suit));
    d.setAttribute('aria-label', c.rank === null ? `kārts: ${SUIT_NAME[c.suit]}` : `${c.rank}, ${SUIT_NAME[c.suit]}`);
    return d;
  }

  const suitOnly = () => !!view && view.announce === 'suit';
  const face = (c) => (c.rank === null ? c.suit : c.rank + c.suit);
  const selectable = () => !!view && view.canPlay && !busy;
  const selectedCard = () => (view && selectedId ? view.hand.find((c) => c.id === selectedId) : null);
  const oppName = () => (view && view.room && view.room.opp ? view.room.opp.name : 'Pretinieks');
  const vsAI = () => !!(view && view.room && view.room.vsAI);

  function defaultClaim(card) {
    return { forId: card.id, rank: suitOnly() ? null : card.rank, suit: view.lockedSuit || card.suit };
  }

  function show(name) {
    screen = name;
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('meliStage').classList.toggle('hidden', name === 'lobby');
    for (const s of ['waiting', 'game']) $(s).classList.toggle('hidden', s !== name);
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
    closeModal('leaveModal');
    overShown = false;
    view = null;
    selectedId = null;
    claim = null;
    activeSuit = null;
    lastRound = null;
    noticeText = '';
    deadline = null;
    busy = false;
  }

  function toLobby() {
    resetTable();
    session = null;
    saveSession();
    show('lobby');
  }

  // ---- lobby -------------------------------------------------------------
  // Signed-in players play under their account name (the server forces it). Guests send no name and
  // the server gives them "Viesis-NNNN".
  function myName() {
    return account || '';
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ announce: settings.announce, size: settings.size })); } catch { /* ignore */ }
  }

  function syncSetup() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === settings[key])));
    });
    $('createSubmit').textContent = settings.private === 'on' ? '🔒 Izveidot privātu istabu' : 'Izveidot istabu';
    $('announceHint').textContent =
      settings.announce === 'suit'
        ? 'Sācējs nosauc mastu; katra nākamā kārts to klusi apgalvo.'
        : 'Katra kārts tiek paziņota kā precīza kārts, piem., K♠.';
  }

  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.key] = b.dataset.value;
      syncSetup();
    });
  });

  function createRoom({ vsAI, size, isPrivate }) {
    resetTable();
    socket.emit('room:create', {
      name: myName(),
      vsAI,
      announce: settings.announce,
      handSize: Number(size || settings.size),
      private: !!isPrivate,
    });
  }

  function openSetup() {
    settings.private = 'off';
    syncSetup();
    openModal('setupModal');
  }

  // Same buttons as the Duraks lobby: computer game, room with options, quick rooms.
  ['playGuestBtn', 'playAIBtn'].forEach((id) => $(id).addEventListener('click', () => createRoom({ vsAI: true })));
  ['createRoomGuestBtn', 'createBtn'].forEach((id) => $(id).addEventListener('click', openSetup));
  document.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => createRoom({ vsAI: false, size: b.dataset.preset }));
  });
  $('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
    closeModal('setupModal');
    createRoom({ vsAI: false, isPrivate: settings.private === 'on' });
  });
  $('setupCancel').addEventListener('click', () => closeModal('setupModal'));
  $('switchUserLink').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.meliLobby && window.meliLobby.logout) window.meliLobby.logout();
  });

  function renderRooms(list) {
    const box = $('roomList');
    box.replaceChildren();
    if (!list.length) {
      box.append(el('p', 'muted small', 'Nav atvērtu spēļu…'));
      return;
    }
    for (const r of list) {
      const row = el('div', 'open-room-row');
      const info = el('div', 'open-room-info');
      info.append(
        el('span', 'host-name', (r.private ? '🔒 ' : '') + r.host),
        el('p', 'muted small', `${MODE_NAME[r.announce]} · ${r.handSize} ${kartis(r.handSize)} katram`)
      );
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
    socket.emit('room:join', { code, name: myName(), password });
  }

  function openPassword(code, wrong) {
    pendingJoin = { code };
    $('pwText').textContent = wrong ? 'Nepareiza parole. Mēģini vēlreiz.' : 'Jautā paroli spēles autoram.';
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

  // invite links
  function readInvite() {
    const p = new URLSearchParams(location.search);
    const code = (p.get('room') || '').trim().toUpperCase();
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
    socket.emit('room:join', { code, name: myName(), password: pw || undefined });
  });
  $('inviteDismiss').addEventListener('click', clearInvite);

  // ---- waiting room ----------------------------------------------------------
  function showWaiting(s) {
    $('waitCode').textContent = s.code;
    $('waitInfo').textContent = `${MODE_NAME[s.announce]} · ${s.handSize} ${kartis(s.handSize)} katram. Nosūti kodu vai uzaicinājuma saiti.`;
    $('waitPassRow').classList.toggle('hidden', !s.password);
    $('waitPass').textContent = s.password || '';
    show('waiting');
  }

  $('copyLinkBtn').addEventListener('click', async () => {
    if (!session) return;
    let url = `${location.origin}${location.pathname}?room=${session.code}`;
    if (session.password) url += `&pw=${session.password}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Saite nokopēta');
    } catch {
      window.prompt('Nokopē uzaicinājuma saiti:', url);
    }
  });
  $('cancelWaitBtn').addEventListener('click', () => socket.emit('room:leave'));

  // ---- table rendering -----------------------------------------------------------
  function render() {
    if (!view) return;
    const opp = view.room.opp;
    $('oppName').textContent = oppName();
    $('oppAvatar').textContent = vsAI() ? '🤖' : '👤';
    const dot = $('oppDot');
    dot.classList.toggle('off', !!opp && !opp.ai && !opp.connected);
    dot.classList.toggle('hidden', vsAI());
    dot.title = opp && !opp.connected ? 'Savienojums pārtrūcis' : 'Savienots';
    $('oppCount').textContent = view.oppCount;
    $('myCount').textContent = view.hand.length;
    $('meName').textContent = view.room.myName;
    $('round').textContent = view.round;

    const lock = $('lock');
    lock.textContent = view.lockedSuit ? `Masts: ${view.lockedSuit}` : 'Masts brīvs';
    lock.classList.toggle('on', !!view.lockedSuit);

    renderPile();
    renderStatus();
    renderSuits();
    renderFan();
    renderClaim();
    renderButtons();
    renderTimer();
  }

  function renderTimer() {
    const t = $('timer');
    if (!view || view.phase !== 'play' || deadline === null) {
      t.classList.add('hidden');
      return;
    }
    const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    t.classList.remove('hidden');
    t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    t.classList.toggle('mine', view.canPlay);
    t.classList.toggle('low', s <= 10);
  }
  setInterval(renderTimer, 250);

  function renderPile() {
    const pile = $('pile');
    const claims = $('claims');
    pile.replaceChildren();
    claims.replaceChildren();
    const n = view.pile.count;

    if (!n) {
      pile.append(el('div', 'empty', 'Galds ir tukšs'));
      return;
    }
    const shown = Math.min(n, 7);
    for (let i = 0; i < shown; i++) {
      const b = el('div', 'back');
      b.style.left = `${i * 3}px`;
      b.style.top = `${-i * 2}px`;
      b.style.transform = `rotate(${(i % 2 ? 1 : -1) * i * 0.9}deg)`;
      pile.append(b);
    }
    const last = view.pile.claims[n - 1];
    const badge = el('div', 'badge');
    badge.append(el('small', null, last.by === 'you' ? 'tu apgalvo' : `${oppName()} apgalvo`), document.createTextNode(face(last)));
    pile.append(badge, el('div', 'pile-count', String(n)));

    if (suitOnly()) return;
    for (const c of view.pile.claims) {
      claims.append(el('span', `chip ${c.by}`, `${c.by === 'you' ? 'Tu' : oppName()}: ${face(c)}`));
    }
  }

  function setStatusText(t) {
    $('status').textContent = t;
  }

  function renderStatus() {
    if (noticeText) return setStatusText(noticeText);
    if (view.phase === 'over') return setStatusText('Spēle beigusies.');
    const opp = view.room.opp;
    if (opp && !opp.ai && !opp.connected) return setStatusText(`${opp.name} zaudēja savienojumu. Gaidām atgriežamies…`);
    if (!view.canPlay) {
      if (vsAI()) return setStatusText(`${oppName()} domā…`);
      return setStatusText(
        view.pile.count > 0 && view.canChallenge === false && view.pile.claims[view.pile.count - 1].by === 'you'
          ? `Tu nolikai kārti. Gaidām ${oppName()}…`
          : `Gaidām ${oppName()}…`
      );
    }

    const n = view.pile.count;
    if (n === 0) {
      return setStatusText(
        suitOnly()
          ? 'Tavs gājiens. Izvēlies jebkuru kārti un nosauc mastu. Masts nofiksējas šim raundam, un drīksti melot.'
          : 'Tavs gājiens. Izvēlies jebkuru kārti un paziņo to. Paziņotais masts nofiksējas šim raundam.'
      );
    }
    const last = view.pile.claims[n - 1];
    const hasLegit = view.hand.some((c) => c.suit === view.lockedSuit);
    let t = suitOnly()
      ? `${oppName()} nolika kārti kā ${last.suit}. Noliec savu kā ${last.suit}, lai nodotu gājienu, vai spied “Meli!”.`
      : `${oppName()} paziņoja ${face(last)}. Noliec kārti, paziņotu mastā ${view.lockedSuit}, vai spied “Meli!”.`;
    if (!hasLegit) t += ` Tev nav mastas ${view.lockedSuit}, tāpēc būs jāmelo.`;
    setStatusText(t);
  }

  function ensureActiveSuit() {
    const has = (s) => view.hand.some((c) => c.suit === s);
    if (activeSuit && has(activeSuit)) return;
    activeSuit = (view.lockedSuit && has(view.lockedSuit) && view.lockedSuit) || SUITS.find(has) || null;
  }

  function renderSuits() {
    ensureActiveSuit();
    const box = $('suits');
    box.replaceChildren();
    for (const s of SUITS) {
      const cards = view.hand.filter((c) => c.suit === s);
      const b = el('button', 'suit-btn' + (s === activeSuit ? ' m-active' : '') + (s === view.lockedSuit ? ' locked' : ''), s);
      b.type = 'button';
      b.dataset.suit = s;
      b.disabled = cards.length === 0;
      b.setAttribute('aria-label', `${SUIT_NAME[s]}: ${cards.length} ${kartis(cards.length)}`);
      b.append(el('span', 'n', String(cards.length)));
      b.addEventListener('click', () => openSuit(s));
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') openSuit(s);
      });
      box.append(b);
    }
  }

  function openSuit(s) {
    if (activeSuit === s || !view.hand.some((c) => c.suit === s)) return;
    activeSuit = s;
    renderSuits();
    renderFan();
  }

  function renderFan() {
    const fan = $('fan');
    fan.replaceChildren();
    const cards = view.hand.filter((c) => c.suit === activeSuit);
    if (!cards.length) {
      fan.append(el('div', 'm-hint', view.hand.length ? 'Izvēlies mastu zemāk' : 'Tava roka ir tukša'));
      return;
    }
    const row = el('div', 'fan-row');
    for (const c of cards) {
      const ok = selectable();
      const d = cardEl(c, { tag: 'button' });
      if (ok) d.classList.add('m-playable');
      if (c.id === selectedId) d.classList.add('m-selected');
      if (ok && view.lockedSuit && c.suit === view.lockedSuit) d.append(el('span', 'tick', '✓'));
      d.addEventListener('click', () => pickCard(c));
      row.append(d);
    }
    fan.append(row);

    const n = cards.length;
    if (n > 1) {
      const cardW = row.firstChild.getBoundingClientRect().width;
      const avail = fan.clientWidth - 24;
      const step = Math.max(26, Math.min(cardW * 0.78, (avail - cardW) / (n - 1)));
      row.querySelectorAll('.m-card:not(:first-child)').forEach((d) => {
        d.style.marginLeft = `${step - cardW}px`;
      });
    }
  }

  function pickCard(c) {
    if (!selectable()) return;
    selectedId = selectedId === c.id ? null : c.id;
    claim = selectedId ? defaultClaim(c) : null;
    renderFan();
    renderClaim();
    renderButtons();
  }

  function renderClaim() {
    const panel = $('claimPanel');
    const card = selectedCard();
    if (!card || !view.canPlay) {
      panel.classList.add('hidden');
      return;
    }
    if (!claim || claim.forId !== card.id) claim = defaultClaim(card);
    panel.classList.remove('hidden');
    panel.replaceChildren();

    const truth = suitOnly() ? claim.suit === card.suit : claim.rank === card.rank && claim.suit === card.suit;
    const head = el('div', 'line');
    const asText = suitOnly()
      ? view.lockedSuit
        ? `ar seju uz leju, apgalvo ${view.lockedSuit}`
        : 'ar seju uz leju. Kādu mastu paziņo?'
      : 'ar seju uz leju. Paziņo kā:';
    head.append(
      document.createTextNode('Liec'),
      cardEl(card),
      document.createTextNode(asText),
      el('span', `verdict-pill ${truth ? 'truth' : 'bluff'}`, truth ? 'TAISNĪBA' : 'MELI')
    );

    if (suitOnly() && view.lockedSuit) {
      panel.append(head);
      return;
    }

    const suitRow = el('div', 'row');
    for (const s of SUITS) {
      const o = el('button', 'opt' + (claim.suit === s ? ' on' : '') + (s === '♥' || s === '♦' ? ' s-red' : ''), s);
      o.type = 'button';
      o.disabled = !!view.lockedSuit && s !== view.lockedSuit;
      o.addEventListener('click', () => {
        claim.suit = s;
        renderClaim();
        renderButtons();
      });
      suitRow.append(o);
    }

    if (suitOnly()) {
      panel.append(head, suitRow);
      return;
    }

    const used = new Set(view.pile.claims.map((c) => c.rank + c.suit));
    const rankRow = el('div', 'row');
    for (const r of RANKS) {
      const o = el('button', 'opt' + (claim.rank === r ? ' on' : '') + (used.has(r + claim.suit) ? ' used' : ''), r);
      o.type = 'button';
      o.title = used.has(r + claim.suit) ? 'Šajā raundā jau paziņota' : '';
      o.addEventListener('click', () => {
        claim.rank = r;
        renderClaim();
        renderButtons();
      });
      rankRow.append(o);
    }
    panel.append(head, suitRow, rankRow);
  }

  function renderButtons() {
    const card = selectedCard();
    $('placeBtn').disabled = !(view && view.canPlay && !busy && card);
    $('placeBtn').textContent = card && claim ? `Likt kā ${suitOnly() ? claim.suit : claim.rank + claim.suit}` : 'Likt kārti';
    $('bluffBtn').disabled = !(view && view.canChallenge && !busy);
  }

  // ---- reveal ------------------------------------------------------------
  function hideReveal() {
    clearTimeout(revealTimer);
    $('reveal').classList.add('hidden');
  }

  function showReveal(r) {
    const me = view ? view.you : 0;
    const opp = oppName();
    const box = $('reveal');
    box.replaceChildren();

    const accusedMe = r.accused === me;
    const title = r.final
      ? `${accusedMe ? 'Tava pēdējā kārts' : `${opp} pēdējā kārts`} tika pārbaudīta`
      : r.challenger === me
        ? `Tu apsūdzēji melos ${opp} kārti`
        : `${opp} apsūdzēja melos tavu kārti`;
    box.append(el('div', 'sub', title));

    const pair = el('div', 'pair');
    const a = el('div');
    a.append(el('div', 'lab', 'Paziņots'), cardEl(r.claim, { big: true }));
    const b = el('div', 'actual');
    b.append(el('div', 'lab', 'Patiesībā'), cardEl(r.actual, { big: true }));
    pair.append(a, b);
    box.append(pair);

    const youLose = r.loser === me;
    const n = `${r.taken} ${kartis(r.taken)}`;
    const picks = youLose ? 'Tu paņem' : `${opp} paņem`;
    let verdict;
    let good;
    if (r.final && !r.lie) {
      good = accusedMe;
      verdict = accusedMe ? 'Pēdējā kārts godīga. Tu uzvari!' : `Pēdējā kārts godīga. ${opp} uzvar.`;
    } else if (r.lie) {
      good = !accusedMe;
      verdict = `${accusedMe ? 'Pieķerts melos!' : `${opp} melo!`} ${picks} ${n}.`;
    } else {
      good = !youLose;
      verdict = `Tā bija taisnība. ${picks} ${n}.`;
    }
    box.append(el('div', `verdict ${good ? 'good' : 'bad'}`, verdict));

    if (!(r.final && !r.lie)) {
      const nextYou = (r.lie ? r.challenger : r.accused) === me;
      box.append(el('div', 'sub', nextYou ? 'Nākamo raundu sāc tu.' : `${opp} sāk nākamo raundu.`));
    }
    const ok = el('button', null, 'Labi');
    ok.type = 'button';
    ok.addEventListener('click', hideReveal);
    box.append(ok);
    box.classList.remove('hidden');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideReveal, 8000);
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

  // ---- game over modal ---------------------------------------------------------
  function showOver(v) {
    overShown = true;
    const win = v.winner === v.you;
    const opp = v.room.opp ? v.room.opp.name : 'Pretinieks';
    const d = v.room.endDetail;
    let title;
    let text;
    if (win) {
      title = 'Tu uzvari! 🎉';
      text =
        d === 'left' ? `${opp} izgāja no spēles.`
        : d === 'disconnect' ? `${opp} atslēdzās.`
        : d === 'timeout' ? `${opp} pietrūka laika.`
        : 'Tu pirmais atbrīvojies no kārtīm.';
    } else {
      title = `${opp} uzvar`;
      text = d === 'timeout' ? 'Tev pietrūka laika.' : `${opp} pirmais atbrīvojās no kārtīm.`;
    }
    $('overTitle').textContent = title;
    $('overText').textContent = text;

    const oppGone = !!(v.room.opp && !v.room.opp.ai && v.room.opp.left);
    const again = $('againBtn');
    const note = $('rematchNote');
    again.classList.toggle('hidden', oppGone);
    again.textContent = v.room.vsAI ? 'Spēlēt vēlreiz' : 'Atkārtot';
    again.disabled = v.room.rematch.you;
    note.textContent = oppGone
      ? `${opp} ir izgājis. Atgriezies vestibilā, lai sāktu jaunu spēli.`
      : v.room.rematch.you
        ? `Gaidām, kad ${opp} piekritīs atkārtot…`
        : v.room.rematch.opp
          ? `${opp} vēlas atkārtot!`
          : '';
    openModal('over');
    if (!again.disabled && !oppGone) again.focus();
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

  socket.on('rooms', renderRooms);

  socket.on('room:joined', (s) => {
    session = s;
    saveSession();
    if (invite) clearInvite();
    if (s.status === 'waiting') showWaiting(s);
    // otherwise the 'state' event follows and shows the table
  });

  socket.on('room:left', toLobby);

  socket.on('room:gone', () => {
    const had = screen !== 'lobby';
    toLobby();
    if (had) toast('Šī spēle vairs nav pieejama.');
  });

  socket.on('room:password', ({ code, wrong }) => {
    openPassword(code, wrong);
  });

  socket.on('state', (v) => {
    const wasMyTurn = !!(view && view.canPlay);
    busy = false;
    view = v;
    deadline = v.room.turnMs !== null && v.room.turnMs !== undefined ? Date.now() + v.room.turnMs : null;

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

    clearTimeout(overTimer);
    if (v.phase === 'over') {
      if (overShown) showOver(v);
      else overTimer = setTimeout(() => showOver(v), v.room.endDetail === 'empty-hand' ? 2400 : 300);
    } else {
      overShown = false;
      closeModal('over');
    }
  });

  socket.on('reveal', showReveal);

  socket.on('notice', (msg) => {
    busy = false;
    if (view && screen === 'game') {
      renderButtons();
      renderFan();
    }
    flash(lv(String(msg)));
  });

  // ---- user actions -------------------------------------------------------
  $('againBtn').addEventListener('click', () => {
    socket.emit('rematch');
    $('againBtn').disabled = true;
  });
  $('lobbyBtn').addEventListener('click', () => socket.emit('room:leave'));

  $('leaveBtn').addEventListener('click', () => {
    if (!view || view.phase === 'over') return socket.emit('room:leave');
    $('leaveText').textContent = vsAI() ? 'Spēle tiks zaudēta.' : `Iziešana ir padošanās. ${oppName()} uzvar.`;
    openModal('leaveModal');
  });
  $('leaveNo').addEventListener('click', () => closeModal('leaveModal'));
  $('leaveYes').addEventListener('click', () => {
    closeModal('leaveModal');
    socket.emit('room:leave');
  });

  $('placeBtn').addEventListener('click', () => {
    const card = selectedCard();
    if (!card || !claim || busy || !view.canPlay) return;
    busy = true;
    socket.emit('play', { cardId: card.id, claim: suitOnly() ? { suit: claim.suit } : { rank: claim.rank, suit: claim.suit } });
    renderButtons();
  });

  $('bluffBtn').addEventListener('click', () => {
    if (busy || !view || !view.canChallenge) return;
    busy = true;
    socket.emit('challenge');
    renderButtons();
  });

  // ---- init ---------------------------------------------------------------
  syncSetup();
  readInvite();
})();

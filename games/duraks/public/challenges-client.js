// Izaicinājumi (challenges): the lobby button and its window. Daily now; weekly and monthly later.
// The game itself is an ordinary 2-player table (multi-client.js); the server fixes the deal and plays
// the computer that knows every card. Uses `socket`, `el` and `showToast` from client.js.
(function () {
  'use strict';

  let status = null;
  let tab = 'day';
  let level = null;
  let open = false;
  let countdown = null;

  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  const kartis = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'gājiens' : 'gājieni');
  function timeLeft(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  function dateLv(iso) {
    const months = ['janvāris', 'februāris', 'marts', 'aprīlis', 'maijs', 'jūnijs', 'jūlijs', 'augusts', 'septembris', 'oktobris', 'novembris', 'decembris'];
    const [, mo, d] = String(iso || '').split('-').map(Number);
    return mo ? `${d}. ${months[mo - 1]}` : '';
  }
  const fresh = (s) => !!(s && s.ready && s.signedIn && s.levels.every((l) => !l.attemptsUsed));
  let receivedAt = Date.now();
  const msLeft = () => (status ? status.endsInMs - (Date.now() - receivedAt) : 0);

  // ---- the lobby buttons ----
  function renderButtons() {
    document.querySelectorAll('.ch-open-btn').forEach((b) => {
      const sub = b.querySelector('.ch-sub');
      const badge = b.querySelector('.ch-badge');
      if (!status) return;
      sub.textContent = status.ready ? `Dienas izaicinājums · beidzas pēc ${timeLeft(msLeft())}` : 'Dienas izaicinājums tiek gatavots…';
      const show = fresh(status) || (!status.signedIn && status.ready);
      badge.classList.toggle('hidden', !show);
      b.setAttribute('aria-label', 'Izaicinājumi' + (show ? ' — pieejams jauns' : ''));
    });
  }

  // ---- the window ----
  function levelButton(l) {
    const b = h('button', 'ch-level' + (l.id === level ? ' active' : ''));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(l.id === level));
    const dot = h('span', 'ch-radio');
    dot.setAttribute('aria-hidden', 'true');
    const text = h('span', 'ch-level-text');
    const name = h('span', 'ch-level-name', l.name);
    name.append(h('span', 'ch-level-rate', ` · uzvar ~${l.targetPct}% spēlētāju`));
    text.append(name, h('span', 'ch-level-reward', `Balva: +${l.reward} punkti${l.badge ? ' un nozīmīte' : ''}`));
    let st;
    if (l.won) st = h('span', 'ch-level-status won', `Uzvarēts ✓ (${l.moves} ${kartis(l.moves)})`);
    else if (!status.signedIn) st = h('span', 'ch-level-status', '');
    else if (l.attemptsUsed >= status.attemptsMax) st = h('span', 'ch-level-status out', 'Mēģinājumi izmantoti');
    else if (l.attemptsUsed) st = h('span', 'ch-level-status', `${l.attemptsUsed} no ${status.attemptsMax} izmantoti`);
    else st = h('span', 'ch-level-status muted', 'Nav mēģināts');
    b.append(dot, text, st);
    b.addEventListener('click', () => { level = l.id; render(); });
    return b;
  }

  function dailyPanel() {
    const box = h('div', 'ch-panel');
    const info = h('div', 'ch-info');
    const head = h('div', 'ch-info-head');
    head.append(h('strong', null, 'Dienas izaicinājums'), h('span', 'ch-date', dateLv(status.date)));
    info.append(
      head,
      h('p', null, 'Visiem viena un tā pati izdale, 1 pret 1, 36 kārtis. Dators zina visas kārtis — arī tavas un kavas secību.'),
      h('p', 'ch-ends', status.ready ? `Beidzas pēc ${timeLeft(msLeft())}` : 'Šodienas izdale tiek gatavota — mirkli…')
    );
    box.append(info);
    if (!status.ready) return box;

    box.append(h('p', 'ch-label', 'Izvēlies grūtību'));
    const group = h('div', 'ch-levels');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Grūtība');
    status.levels.forEach((l) => group.append(levelButton(l)));
    box.append(group);

    const cur = status.levels.find((l) => l.id === level) || status.levels[0];
    const top = (status.top && status.top[cur.id]) || [];
    box.append(h('p', 'ch-label', `Šodien uzvarēja · ${cur.name}`));
    const list = h('div', 'ch-top');
    if (!top.length) list.append(h('p', 'muted small', 'Vēl neviens — esi pirmais!'));
    top.forEach((w, i) => {
      const row = h('div', 'ch-top-row' + (w.username === (typeof myUsername === 'string' ? myUsername : '') ? ' me' : ''));
      row.append(h('span', 'ch-top-rank', `${i + 1}.`), h('span', 'ch-top-name', w.username), h('span', 'ch-top-meta', `${w.moves} ${kartis(w.moves)}`));
      list.append(row);
    });
    box.append(list, h('p', 'ch-hint', 'Vieta sarakstā pēc tā, cik ātri uzvarēji (mazāk gājienu).'));

    const play = h('button', 'btn btn-primary ch-play');
    play.type = 'button';
    if (!status.signedIn) {
      play.textContent = 'Ielogojies, lai piedalītos';
      play.addEventListener('click', () => { close(); const u = el('nameInput'); if (u) u.focus(); });
    } else if (cur.won) {
      play.textContent = `${cur.name}: uzvarēts ✓`;
      play.disabled = true;
    } else if (!cur.canPlay) {
      play.textContent = `${cur.name}: mēģinājumi izmantoti`;
      play.disabled = true;
    } else {
      play.textContent = `Spēlēt: ${cur.name} · mēģinājums ${cur.attemptsUsed + 1} no ${status.attemptsMax}`;
      play.addEventListener('click', () => { play.disabled = true; socket.emit('startChallenge', { level: cur.id }); });
    }
    box.append(play);
    if (status.signedIn) box.append(h('p', 'ch-points', `Tavi izaicinājumu punkti: ${status.points}`));
    return box;
  }

  function laterPanel(kind) {
    const box = h('div', 'ch-later');
    const text = kind === 'week'
      ? ['Nedēļas izaicinājums', 'Piecas izdales pēc kārtas — uzvari pēc iespējas vairāk no tām. Tabula atjaunosies katru pirmdienu.']
      : ['Mēneša izaicinājums', 'Garāks pārbaudījums ar lielāku balvu un mēneša čempiona nozīmīti.'];
    box.append(h('strong', null, text[0]), h('p', null, text[1]), h('span', 'ch-soon', 'Drīzumā'));
    return box;
  }

  function render() {
    const body = el('challengeBody');
    body.replaceChildren();
    const title = h('h2', 'ch-title', 'Izaicinājumi');
    title.id = 'challengeTitle';
    body.append(title);
    const tabs = h('div', 'ch-tabs');
    tabs.setAttribute('role', 'tablist');
    [['day', 'Dienas'], ['week', 'Nedēļas'], ['month', 'Mēneša']].forEach(([id, label]) => {
      const b = h('button', 'ch-tab' + (tab === id ? ' active' : ''), label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === id));
      if (id === 'day' && fresh(status) && tab !== 'day') b.append(h('span', 'ch-dot'));
      b.addEventListener('click', () => { tab = id; render(); });
      tabs.append(b);
    });
    body.append(tabs);
    if (!status) body.append(h('p', 'muted small', 'Ielādē…'));
    else body.append(tab === 'day' ? dailyPanel() : laterPanel(tab));
  }

  function chooseDefaultLevel() {
    if (!status || !status.levels) return;
    if (level && status.levels.some((l) => l.id === level)) return;
    const next = status.levels.find((l) => l.canPlay) || status.levels[0];
    level = next.id;
  }

  function openWindow() {
    open = true;
    tab = 'day';
    socket.emit('getChallenges');
    render();
    el('challengeModal').classList.remove('hidden');
    clearInterval(countdown);
    countdown = setInterval(() => { if (open) { const e = document.querySelector('.ch-ends'); if (e && status && status.ready) e.textContent = `Beidzas pēc ${timeLeft(msLeft())}`; } renderButtons(); }, 30000);
  }
  function close() {
    open = false;
    el('challengeModal').classList.add('hidden');
  }

  document.querySelectorAll('.ch-open-btn').forEach((b) => b.addEventListener('click', openWindow));
  el('challengeCloseBtn').addEventListener('click', close);
  el('challengeModal').addEventListener('click', (e) => { if (e.target.id === 'challengeModal') close(); });
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });

  socket.on('challengesData', (s) => {
    status = s;
    receivedAt = Date.now();
    chooseDefaultLevel();
    renderButtons();
    if (open) render();
  });
  let challengeStarting = false;
  // an ordinary table afterwards: no challenge note in its game-over window
  socket.on('multiGameStarted', () => {
    if (!challengeStarting) el('challengeOverNote').classList.add('hidden');
    challengeStarting = false;
  });
  socket.on('challengeStarted', (d) => {
    challengeStarting = true;
    status = d.status;
    receivedAt = Date.now();
    renderButtons();
    close();
    el('challengeOverNote').classList.add('hidden');
  });
  socket.on('challengeResult', (r) => {
    status = r.status;
    receivedAt = Date.now();
    renderButtons();
    const lv = (status.levels || []).find((l) => l.id === r.level) || { name: '', attemptsUsed: 0 };
    const note = el('challengeOverNote');
    if (r.won && r.reward) note.textContent = `Izaicinājums «${lv.name}» uzvarēts ar ${r.moves} gājieniem! +${r.reward} punkti${r.badge ? ' un nozīmīte' : ''} · ${r.place}. vieta šodienas sarakstā.`;
    else if (r.won) note.textContent = `Izaicinājums «${lv.name}» uzvarēts.`;
    else {
      const left = Math.max(0, status.attemptsMax - lv.attemptsUsed);
      note.textContent = left ? `Izaicinājums «${lv.name}» šoreiz neizdevās. Atlikuši ${left} mēģinājumi šodien.` : `Izaicinājums «${lv.name}» neizdevās, un šodienas mēģinājumi ir izmantoti. Rīt būs jauna izdale!`;
    }
    note.classList.remove('hidden');
  });
  socket.on('errorMsg', () => {
    // a refused start (e.g. attempts used): let the button be pressed again
    const p = document.querySelector('.ch-play');
    if (p && open && status) render();
  });

  // ask on load and after logging in / out
  socket.on('connect', () => socket.emit('getChallenges'));
  socket.on('registered', () => socket.emit('getChallenges'));
  socket.emit('getChallenges');
})();

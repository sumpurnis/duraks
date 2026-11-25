// The admin's game log (/admin-games.html): every Duraks and Meļi game, newest first; a click shows one
// game in full. Uses the login saved by the games (same browser); the server lets only the admin in.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let user = '', token = '';
  try { user = localStorage.getItem('duraks_username') || ''; token = localStorage.getItem('duraks_token') || ''; } catch (e) { /* none */ }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GAME = { duraks: '<span class="s">♠</span> Duraks', meli: '<span class="s">♥</span> Meļi' };
  const MODE = { casual: '', ranked: 'reitinga', tournament: 'turnīrs', challenge: 'izaicinājums' };
  const STATUS = { finished: 'Pabeigta', ended: 'Beidzās priekšlaikus', interrupted: 'Pārtraukta', live: 'Notiek' };
  const REASON = {
    normal: '', 'empty-hand': '', surrender: 'padevās', disconnect: 'atvienojās', timeout: 'beidzās laiks', left: 'pameta',
    'only-bots-left': 'palika tikai datori', closed: 'istaba aizvērta',
  };
  const KIND = { bot: 'dators', guest: 'viesis' };
  const SUIT = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

  // Duraks' engine writes its moves in English: shown in Latvian here.
  function pretty(t) {
    const c = (r, s) => r + (SUIT[s] || s);
    return String(t)
      .replace(/^(.+) attacks with (\S+) of (\w+)$/, (m, p, r, s) => `${p} uzbrūk ar ${c(r, s)}`)
      .replace(/^(.+) defends with (\S+) of (\w+)$/, (m, p, r, s) => `${p} sit ar ${c(r, s)}`)
      .replace(/^(.+) padod tālāk ar (\S+) no (\w+)$/, (m, p, r, s) => `${p} padod tālāk ar ${c(r, s)}`)
      .replace(/^(.+) takes — waiting for any final throw-ins$/, '$1 ņem (vēl var piemest)')
      .replace(/^(.+) takes the cards$/, '$1 paņem kārtis')
      .replace(/^(.+) ends the attack — round won by defense$/, '$1 beidz uzbrukumu — bita')
      .replace(/^(.+) is the durak!$/, '$1 paliek durakos')
      .replace(/^Deck and both hands empty — draw, no durak!$/, 'Neizšķirts — nav duraka');
  }
  const two = (n) => String(n).padStart(2, '0');
  const when = (t) => { const d = new Date(t); return `${two(d.getDate())}.${two(d.getMonth() + 1)}. ${two(d.getHours())}:${two(d.getMinutes())}`; };
  const dur = (ms) => { if (!(ms >= 0)) return '—'; const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60; return m ? `${m} min ${two(s)} s` : `${s} s`; };
  const clock = (ms) => `${two(Math.floor(ms / 60000))}:${two(Math.floor(ms / 1000) % 60)}`;

  function api(path) {
    return fetch(path, { cache: 'no-store', headers: { 'X-Uzs-User': encodeURIComponent(user), 'X-Uzs-Token': token } })
      .then((r) => (r.status === 403 ? Promise.reject(new Error('Šis logs ir tikai administratoram. Ielogojies ar admin kontu Durakā vai Meļos šajā pašā pārlūkā un atver logu vēlreiz.')) : r.ok ? r.json() : Promise.reject(new Error('Neizdevās ielādēt (' + r.status + ')'))));
  }
  function showError(msg) { const e = $('agError'); e.textContent = msg || ''; e.hidden = !msg; }

  function players(s) {
    return s.players.map((p) => `<span class="p">${esc(p.name)}${KIND[p.kind] ? `<span class="tag">${KIND[p.kind]}</span>` : ''}</span>`).join('');
  }
  function statusHtml(s) {
    const why = s.status === 'ended' && REASON[s.reason] !== '' ? esc(REASON[s.reason] || s.reason || '') : '';
    return `<span class="st ${esc(s.status)}">${STATUS[s.status] || esc(s.status)}</span>${why ? ` <span class="ag-muted">${why}</span>` : ''}`;
  }
  function resultText(s) {
    const r = s.result;
    if (!r) return s.status === 'live' ? 'spēle notiek' : '—';
    if (s.game === 'duraks') {
      if (r.draw) return 'neizšķirts';
      if (r.durak) return `durakos: ${r.durak}`;
      if (r.winner) return `uzvarēja: ${r.winner}`;
      return '—';
    }
    return r.winner ? `uzvarēja: ${r.winner}` : '—';
  }
  function row(s) {
    const mode = MODE[s.mode] ? `<div class="ag-muted">${MODE[s.mode]}</div>` : '';
    const ms = s.endedAt ? s.endedAt - s.at : s.status === 'live' ? Date.now() - s.at : NaN;
    return `<tr tabindex="0" data-id="${esc(s.id)}"><td class="t">${when(s.at)}</td><td><span class="g">${GAME[s.game] || esc(s.game)}</span>${mode}</td>` +
      `<td>${players(s)}</td><td>${statusHtml(s)}</td><td class="t">${dur(ms)}</td><td class="t">${s.moveCount || 0}</td><td>${esc(resultText(s))}</td></tr>`;
  }

  let lastId = '';
  function load(more) {
    const q = new URLSearchParams();
    if ($('fGame').value) q.set('game', $('fGame').value);
    if ($('fStatus').value) q.set('status', $('fStatus').value);
    if ($('fPlayer').value.trim()) q.set('player', $('fPlayer').value.trim());
    if (more && lastId) q.set('before', lastId);
    q.set('limit', '50');
    return api('/api/admin/games?' + q.toString()).then((d) => {
      showError('');
      const rows = $('agRows');
      if (!more) rows.innerHTML = '';
      rows.insertAdjacentHTML('beforeend', d.games.map(row).join('') || (more ? '' : '<tr><td colspan="7" class="ag-muted">Nav spēļu ar šiem filtriem.</td></tr>'));
      lastId = d.games.length ? d.games[d.games.length - 1].id : lastId;
      $('agMore').hidden = !d.more;
      const c = d.counts;
      $('agSummary').textContent = `Kopā ${d.total} spēles (pēdējie ${d.keepMonths} mēneši) · notiek ${c.live} · pabeigtas ${c.finished} · beidzās priekšlaikus ${c.ended} · pārtrauktas ${c.interrupted}`;
    }).catch((e) => showError(e.message));
  }

  function detail(id) {
    document.querySelectorAll('#agRows tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === id));
    api('/api/admin/games/' + encodeURIComponent(id)).then((g) => {
      const box = $('agDetail');
      const o = g.opts || {};
      const optBits = [o.code && `galds ${esc(o.code)}`, o.deck && `${esc(o.deck)} kārtis`, o.seats && `${esc(o.seats)} vietas`, o.transfer && 'ar padošanu', o.private && 'privāts', o.announce === 'suit' && 'tikai masts', o.challenge && `izaicinājums: ${esc(o.challenge)}`].filter(Boolean).join(' · ');
      const setup = g.setup || {};
      const hands = setup.hands ? Object.entries(setup.hands).map(([n, h]) => `<dt>${esc(n)}</dt><dd class="hand">${esc(h.join(' '))}</dd>`).join('') : '';
      const ms = g.endedAt ? g.endedAt - g.at : NaN;
      const moves = (g.moves || []).map(([t, txt]) => `<li><time>${clock(t)}</time><span>${esc(pretty(txt))}</span></li>`).join('');
      box.innerHTML = `<button type="button" class="close" id="agClose" aria-label="Aizvērt">×</button>` +
        `<h2>${GAME[g.game] || esc(g.game)}${MODE[g.mode] ? ' · ' + MODE[g.mode] : ''}</h2>` +
        `<p class="ag-muted">${when(g.at)} · ${statusHtml(g)}</p>` +
        `<dl><dt>Spēlētāji</dt><dd>${players(g)}</dd><dt>Iestatījumi</dt><dd>${optBits || '—'}</dd><dt>Ilgums</dt><dd>${dur(ms)}</dd><dt>Rezultāts</dt><dd>${esc(resultText(g))}</dd></dl>` +
        (setup.trump || hands ? `<h3>Izdale</h3><dl>${setup.trump ? `<dt>Trumpis</dt><dd class="hand">${esc(setup.trump)}</dd>` : ''}${hands}</dl>` : '') +
        `<h3>Gājieni (${(g.moves || []).length})</h3>` +
        (moves ? `<ol class="moves">${moves}</ol>` : `<p class="ag-muted">${g.status === 'interrupted' ? 'Gājieni nav saglabāti: serveris pārstartējās spēles laikā.' : 'Vēl nav gājienu.'}</p>`);
      box.hidden = false;
      $('agClose').addEventListener('click', () => { box.hidden = true; document.querySelectorAll('#agRows tr.sel').forEach((tr) => tr.classList.remove('sel')); });
    }).catch((e) => showError(e.message));
  }

  $('agRows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) detail(tr.dataset.id); });
  $('agRows').addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; const tr = e.target.closest('tr[data-id]'); if (tr) { e.preventDefault(); detail(tr.dataset.id); } });
  $('agFilters').addEventListener('submit', (e) => { e.preventDefault(); load(false); });
  $('agMore').addEventListener('click', () => load(true));
  if (!user || !token) showError('Šis logs ir tikai administratoram. Ielogojies ar admin kontu Durakā vai Meļos šajā pašā pārlūkā un atver logu vēlreiz.');
  else load(false);
})();

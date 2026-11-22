// The player profile window with one tab per game (shared by the Duraks lobby and the front page).
//
//   UzsProfileWindow.render(bodyEl, data, { defaultTab })
//
// bodyEl  the scrolling body of the profile pop-up (the page keeps its own frame and "Aizvērt" button)
// data    { username, games: { duraks: { stats, eloByPool, history }, meli: { … } } } — users.getProfileGames().
//         An older server without `games` (only { stats, history, eloByPool }) still works: Duraks only.
// defaultTab  'all' (Kopā) or a game key; the last tab picked is remembered while the page is open.
//
// Every game tab shows exactly what the Duraks profile always did: both ELO ratings, games, wins,
// losses incl. forfeits, streaks, today, the ELO chart and the latest games. A new game only needs an
// entry in GAMES below (and the server's users.GAMES); a game the page doesn't know still gets a tab.
(function () {
  'use strict';

  const GAMES = {
    duraks: { name: 'Duraks', suit: '♠', color: '#2f7391', suitColor: '#8fc3dc', multi: '3-4 spēlētāji' },
    meli: { name: 'Meļi', suit: '♥', color: '#a8323e', suitColor: '#f0868f', multi: '3-6 spēlētāji' },
  };
  const metaOf = (key) => GAMES[key] || { name: key.charAt(0).toUpperCase() + key.slice(1), suit: '♦', color: '#6b5a2e', suitColor: '#e2c374', multi: 'vairāki spēlētāji' };

  const OUTCOME = { won: 'Uzvara', lost: 'Zaudējums', placed: 'Ievietojās', draw: 'Neizšķirts' };
  const POOL_COLORS = { oneVOne: '#e8b84b', multi: '#5ac8e0' };
  const ELO_MIDPOINT = 1000;

  let currentTab = null; // remembered while the page is open
  const poolVisible = { oneVOne: true, multi: true };

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function relTime(ts) {
    const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (secs < 60) return `pirms ${secs}s`;
    if (secs < 3600) return `pirms ${Math.floor(secs / 60)}min`;
    if (secs < 86400) return `pirms ${Math.floor(secs / 3600)}h`;
    return `pirms ${Math.floor(secs / 86400)}d`;
  }
  const pct = (won, played) => (played ? Math.round((won / played) * 100) + '%' : '—');
  const eloText = (v) => (typeof v === 'number' ? v : '—');

  function normalize(data) {
    if (data && data.games && typeof data.games === 'object') return data.games;
    return { duraks: { stats: data.stats, eloByPool: data.eloByPool, history: data.history || [] } };
  }

  // ---------------------------------------------------------------- one game
  function statRow(label, value, opts = {}) {
    const row = h('div', 'profile-stat-row' + (opts.muted ? ' muted-row' : ''));
    const l = h('span');
    if (opts.pool) l.append(h('span', 'elo-swatch elo-swatch-' + opts.pool));
    l.append(document.createTextNode(label));
    row.append(l, h('strong', null, value));
    return row;
  }

  function historyRow(entry, gameKey) {
    const row = h('div', 'profile-history-row profile-history-' + (entry.outcome || 'lost'));
    if (Array.isArray(entry.opponents) && entry.opponents.length) row.title = 'Pretinieki: ' + entry.opponents.join(', ');
    const place = entry.placement ? ` (${entry.placement}. vieta)` : '';
    const ranked = entry.ranked ? ' 🏅' : '';
    const elo = typeof entry.eloChange === 'number' ? ` · ELO ${entry.eloChange > 0 ? '+' : ''}${entry.eloChange}` : '';
    const mode = entry.mode === '2p' ? '2 spēlētāji' : `${entry.totalPlayers} spēlētāji`;
    const deck = entry.deckSize && entry.deckSize !== 52 ? ` · ${entry.deckSize} kārtis` : '';
    const bots = entry.vsBots ? ' · pret datoru' : '';
    const left = entry.endReason === 'left' || entry.endReason === 'disconnect' ? ' · izgāja' : entry.endReason === 'timeout' ? ' · laiks beidzās' : entry.endReason === 'surrender' ? ' · padevās' : '';
    const text = h('div', 'pw-history-text');
    text.append(
      h('span', 'profile-history-outcome', (OUTCOME[entry.outcome] || entry.outcome) + place + ranked + elo),
      h('span', 'profile-history-meta', `${mode}${deck}${bots}${left} · ${relTime(entry.timestamp)}`)
    );
    if (gameKey) {
      const m = metaOf(gameKey);
      const badge = h('span', 'pw-badge', m.suit);
      badge.style.background = m.color;
      badge.title = m.name;
      badge.setAttribute('aria-label', m.name);
      row.classList.add('pw-history-tagged');
      row.append(badge);
    }
    row.append(text);
    return row;
  }

  function historyList(entries, tagged) {
    const list = h('div', 'profile-history-list');
    if (!entries.length) list.append(h('p', 'muted small', 'Nav vēl izspēlētu spēļu…'));
    entries.forEach((e) => list.append(historyRow(e, tagged ? e._game : null)));
    return list;
  }

  function eloEntries(history, pool) {
    return history
      .filter((e) => typeof e.eloAfter === 'number' && (e.eloPool || (e.totalPlayers === 2 ? 'oneVOne' : 'multi')) === pool)
      .slice()
      .reverse(); // oldest -> newest
  }

  // The ELO chart (same drawing as the Duraks profile always had), one shared value axis for both ratings.
  function drawChart(box, history, labels) {
    box.replaceChildren();
    const pools = Object.keys(POOL_COLORS).filter((p) => poolVisible[p]);
    if (!pools.length) return box.append(h('p', 'muted small', 'Atzīmē vismaz vienu skatu augstāk, lai redzētu grafiku'));
    const series = pools.map((pool) => ({ pool, color: POOL_COLORS[pool], label: labels[pool], entries: eloEntries(history, pool) })).filter((s) => s.entries.length >= 2);
    if (!series.length) return box.append(h('p', 'muted small', 'Nepietiek ranked spēļu grafikam izvēlētajā skatā (vajag vismaz 2)'));

    const W = 300, H = 90, pt = 10, pb = 10, ps = 6;
    const all = series.flatMap((s) => s.entries.map((e) => e.eloAfter));
    const lo = Math.min(Math.min.apply(null, all), ELO_MIDPOINT);
    const hi = Math.max(Math.max.apply(null, all), ELO_MIDPOINT);
    const range = Math.max(1, hi - lo);
    const x = (i, n) => (n === 1 ? W / 2 : ps + (i / (n - 1)) * (W - 2 * ps));
    const y = (v) => H - pb - ((v - lo) / range) * (H - pt - pb);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'profile-elo-chart-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    const add = (tag, attrs, parent = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      parent.append(e);
      return e;
    };
    const ym = y(ELO_MIDPOINT).toFixed(1);
    add('line', { x1: ps, y1: ym, x2: W - ps, y2: ym, stroke: 'rgba(250,246,236,0.32)', 'stroke-width': 1, 'stroke-dasharray': '3,3', 'vector-effect': 'non-scaling-stroke' });
    add('text', { x: W - ps, y: Number(ym) - 3, 'text-anchor': 'end', 'font-size': 7, fill: 'rgba(250,246,236,0.55)' }).textContent = String(ELO_MIDPOINT);
    const legends = [];
    series.forEach((s) => {
      const vals = s.entries.map((e) => e.eloAfter);
      let minI = 0, maxI = 0;
      vals.forEach((v, i) => { if (v < vals[minI]) minI = i; if (v > vals[maxI]) maxI = i; });
      const distinct = vals[minI] !== vals[maxI];
      add('polyline', { points: s.entries.map((e, i) => x(i, vals.length).toFixed(1) + ',' + y(e.eloAfter).toFixed(1)).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
      s.entries.forEach((e, i) => {
        const cx = x(i, vals.length).toFixed(1), cy = y(e.eloAfter).toFixed(1);
        const hit = add('circle', { cx, cy, r: 7, fill: 'transparent', stroke: 'none' });
        const ch = typeof e.eloChange === 'number' ? ` (${e.eloChange > 0 ? '+' : ''}${e.eloChange})` : '';
        add('title', {}, hit).textContent = `${s.label} ELO: ${e.eloAfter}${ch}${distinct && i === maxI ? ' · augstākais' : distinct && i === minI ? ' · zemākais' : ''}`;
        add('circle', { cx, cy, r: i === vals.length - 1 ? 3 : 1.6, fill: s.color, 'pointer-events': 'none' });
        if (distinct && (i === maxI || i === minI)) {
          add('text', { x: cx, y: i === maxI ? Number(cy) - 4 : Number(cy) + 10, 'text-anchor': 'middle', 'font-size': 7, fill: s.color, 'pointer-events': 'none' }).textContent = i === maxI ? '▲' : '▼';
        }
      });
      const lg = h('div', 'profile-elo-series-legend');
      const title = h('p', 'profile-elo-series-legend-title');
      title.style.color = s.color;
      title.append(h('span', 'elo-swatch elo-swatch-' + s.pool), document.createTextNode(s.label));
      const labelsBox = h('div', 'profile-elo-chart-labels');
      [['low', '▼ Zemākais', vals[minI]], ['high', '▲ Augstākais', vals[maxI]], ['current', 'Tagad', vals[vals.length - 1]]].forEach(([k, l, v]) => {
        const st = h('div', 'profile-elo-stat profile-elo-stat-' + k);
        st.append(h('span', 'profile-elo-stat-label', l), h('span', 'profile-elo-stat-value', v));
        labelsBox.append(st);
      });
      lg.append(title, labelsBox);
      legends.push(lg);
    });
    box.append(svg, ...legends);
  }

  function gamePanel(key, g) {
    const m = metaOf(key);
    const s = g.stats || {};
    const today = s.today || {};
    const elo = g.eloByPool || {};
    const labels = { oneVOne: '1v1', multi: m.multi };
    const panel = h('div', 'pw-panel');

    const stats = h('div', 'profile-stats');
    stats.append(
      statRow('ELO (1v1)', eloText(elo.oneVOne), { pool: 'oneVOne' }),
      statRow(`ELO (${m.multi})`, eloText(elo.multi), { pool: 'multi' }),
      statRow('Spēles spēlētas', s.played || 0),
      statRow('Spēles uzvarētas', s.won || 0),
      statRow('Spēles zaudētas', s.lost || 0),
      statRow('t.sk. uzvaras piespiedu kārtā', s.wonByForfeit || 0, { muted: true }),
      statRow('t.sk. zaudējumi piespiedu kārtā', s.lostByForfeit || 0, { muted: true }),
      statRow('Pašreizējā uzvaru sērija', s.currentStreak || 0),
      statRow('Garākā uzvaru sērija (visu laiku)', s.longestStreak || 0),
      h('p', 'profile-stats-divider', 'Šodien'),
      statRow('Spēles šodien', today.played || 0),
      statRow('Uzvaras šodien', today.won || 0),
      statRow('Zaudējumi šodien', today.lost || 0),
      statRow('Garākā sērija šodien', today.longestStreak || 0)
    );

    const chartWrap = h('div', 'profile-elo-chart');
    const head = h('div', 'profile-elo-chart-header');
    head.append(h('p', 'profile-stats-divider profile-elo-chart-divider', 'ELO svārstības'));
    const toggles = h('div', 'elo-toggle-row');
    const chart = h('div', 'pw-elo-chart');
    const history = g.history || [];
    Object.keys(POOL_COLORS).forEach((pool) => {
      const lab = h('label', 'elo-toggle');
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = poolVisible[pool];
      cb.addEventListener('change', () => { poolVisible[pool] = cb.checked; drawChart(chart, history, labels); });
      lab.append(cb, h('span', 'elo-swatch elo-swatch-' + pool), document.createTextNode(labels[pool]));
      toggles.append(lab);
    });
    head.append(toggles);
    chartWrap.append(head, chart);
    drawChart(chart, history, labels);

    const hist = h('div', 'profile-history');
    hist.append(h('p', 'profile-stats-divider', 'Pēdējās spēles'), historyList(history.slice(0, 15), false));
    panel.append(stats, chartWrap, hist);
    return panel;
  }

  // ---------------------------------------------------------------- Kopā (all games)
  function allPanel(games, pick) {
    const keys = Object.keys(games);
    const sum = (f) => keys.reduce((a, k) => a + (f(games[k].stats || {}) || 0), 0);
    const played = sum((s) => s.played), won = sum((s) => s.won), today = sum((s) => (s.today || {}).played);
    const panel = h('div', 'pw-panel');

    const tiles = h('div', 'pw-totals');
    [[played, 'spēles kopā'], [pct(won, played), 'uzvaras'], [today, 'šodien']].forEach(([v, l]) => {
      const t = h('div', 'pw-tile');
      t.append(h('strong', null, v), h('span', null, l));
      tiles.append(t);
    });
    panel.append(tiles);

    keys.forEach((k) => {
      const m = metaOf(k);
      const s = games[k].stats || {};
      const elo = games[k].eloByPool || {};
      const card = h('button', 'pw-game-card');
      card.type = 'button';
      card.style.borderLeftColor = m.color;
      card.setAttribute('aria-label', `${m.name}: atvērt statistiku`);
      const top = h('span', 'pw-game-top');
      const suit = h('span', 'pw-game-suit', m.suit);
      suit.style.color = m.suitColor;
      top.append(suit, h('span', 'pw-game-name', m.name), h('span', 'pw-game-meta', `${s.played || 0} spēles · ${pct(s.won || 0, s.played || 0)} uzvaras`));
      const elos = h('span', 'pw-game-elo');
      [['oneVOne', '1v1'], ['multi', m.multi]].forEach(([pool, label]) => {
        const e = h('span');
        e.append(h('span', 'elo-swatch elo-swatch-' + pool), document.createTextNode(label + ' '), h('strong', null, eloText(elo[pool])));
        elos.append(e);
      });
      card.append(top, elos);
      card.addEventListener('click', () => pick(k));
      panel.append(card);
    });

    const merged = keys
      .flatMap((k) => (games[k].history || []).map((e) => ({ ...e, _game: k })))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 15);
    const hist = h('div', 'profile-history');
    hist.append(h('p', 'profile-stats-divider', 'Pēdējās spēles'), historyList(merged, true));
    panel.append(hist);
    return panel;
  }

  // ---------------------------------------------------------------- the window
  function render(body, data, opts = {}) {
    const games = normalize(data || {});
    const keys = Object.keys(games);
    const tabsList = ['all'].concat(keys);
    if (!currentTab || !tabsList.includes(currentTab)) currentTab = tabsList.includes(opts.defaultTab) ? opts.defaultTab : 'all';

    body.replaceChildren();
    body.append(h('h2', 'pw-title', (data && data.username) || 'Profils'));
    const bar = h('div', 'pw-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Statistika');
    const holder = h('div', 'pw-holder');
    const buttons = {};
    function show(tab) {
      currentTab = tab;
      for (const [k, b] of Object.entries(buttons)) {
        b.classList.toggle('active', k === tab);
        b.setAttribute('aria-selected', String(k === tab));
      }
      holder.replaceChildren(tab === 'all' ? allPanel(games, show) : gamePanel(tab, games[tab]));
      body.scrollTop = 0;
    }
    tabsList.forEach((k) => {
      const b = h('button', 'pw-tab', k === 'all' ? 'Kopā' : `${metaOf(k).suit} ${metaOf(k).name}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => show(k));
      buttons[k] = b;
      bar.append(b);
    });
    bar.style.gridTemplateColumns = `repeat(${tabsList.length}, minmax(0, 1fr))`;
    body.append(bar, holder);
    show(currentTab);
  }

  window.UzsProfileWindow = { render };
})();

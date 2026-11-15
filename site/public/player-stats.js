// Uzspēlēsim.lv front page: the Duraks profile window, opened from a village on the map (logged-in players).
//
// Markup (landing.html #profileModal), styles (duraks-profile.css) and the drawing code below are copied
// 1:1 from the Duraks page (games/duraks/public: index.html, style.css, client.js — the 'profileData'
// handler, the ELO chart and the latest-games list), so it looks and reads exactly the same.
// Only the data source differs: POST /api/player/full with the saved login, instead of the Duraks socket.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- copied from games/duraks/public/client.js
function showProfileData({ username: name, stats, history, eloByPool }) {
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
}

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


  // ---------------------------------------------------------------- front-page glue
  let req = 0;
  let lastFocus = null;
  function close() {
    if (el('profileModal').classList.contains('hidden')) return;
    el('profileModal').classList.add('hidden');
    req++;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  el('profileCloseBtn').addEventListener('click', close);
  el('profileModal').addEventListener('click', (e) => {
    if (e.target.id === 'profileModal') close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // The saved login (the same keys every game page uses). Read directly as well, so an older cached
  // landing.js without UzsSite.creds() can't make a logged-in player look logged out.
  function savedLogin() {
    if (window.UzsSite && window.UzsSite.creds) { const c = window.UzsSite.creds(); if (c) return c; }
    try {
      const me = localStorage.getItem('duraks_username'), token = localStorage.getItem('duraks_token');
      return me && token ? { me, token } : null;
    } catch (e) { return null; }
  }

  // Returns false when there is no saved login (the map then shows the short card instead).
  function open(name) {
    const creds = savedLogin();
    if (!creds) return false;
    lastFocus = document.activeElement;
    const my = ++req;
    fetch('/api/player/full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, me: creds.me, token: creds.token }),
      cache: 'no-store',
    })
      .then((r) => (r.status === 401 ? { login: true } : r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        if (my !== req) return;
        const toast = (msg) => { const t = el('toast'); if (!t) return; t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3500); };
        if (!d) return toast('Profils šobrīd nav pieejams — vai serveris ir restartēts pēc atjaunināšanas?');
        if (d.login) { toast('Sesija vairs nav derīga, lūdzu piesakies no jauna'); if (window.UzsSite) window.UzsSite.openModal('login'); return; }
        showProfileData({ username: d.username, stats: d.stats, history: d.history, eloByPool: d.elo });
        el('profileCloseBtn').focus();
      });
    return true;
  }

  window.UzsProfile = { open, close };
})();

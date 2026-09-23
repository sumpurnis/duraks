'use strict';

/**
 * tournament-client.js
 * All tournament UI lives here, deliberately separate from client.js (the
 * card game itself). Reuses the shared `socket` and `el` globals that
 * client.js already sets up. Generic errors are already toasted by
 * client.js's existing `errorMsg` listener — this file doesn't duplicate
 * that, it only handles tournament-specific rendering and view state.
 */

let tCurrentView = 'list';
let tLastList = [];
let tOpenDetailId = null;
// Each tournament item carries the requesting user's isAdmin flag (it's
// per-request, not per-tournament), but an empty list carries no items at
// all — cache the last known value so admin-only controls don't flicker
// hidden just because the tournament list happens to be empty right now
// (e.g. right after the admin cleanup tool clears everything out).
let tIsAdminCache = false;

function tShowView(view) {
  tCurrentView = view;
  el('tournamentListView').classList.toggle('hidden', view !== 'list');
  el('tournamentCreateView').classList.toggle('hidden', view !== 'create');
  el('tournamentDetailView').classList.toggle('hidden', view !== 'detail');
  el('tournamentResultsView').classList.toggle('hidden', view !== 'results');
}

function tOpenModal() {
  el('tournamentModal').classList.remove('hidden');
  tShowView('list');
  socket.emit('listTournaments');
}

function tCloseModal() {
  el('tournamentModal').classList.add('hidden');
  tOpenDetailId = null;
}

// ---------- formatting helpers ----------

function tFormatDateTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function tStatusLabel(t) {
  if (t.status === 'cancelled') return 'Atcelts' + (t.cancelReason === 'not_enough_participants' ? ' (par maz dalībnieku)' : '');
  if (t.status === 'completed') return 'Pabeigts';
  if (t.status === 'active') return 'Notiek';
  if (!t.isRegistrationOpen) return 'Reģistrācija slēgta';
  return 'Atvērta reģistrācija';
}

// ---------- list view ----------

function tRenderList(list) {
  tLastList = list;
  const container = el('tournamentList');
  container.innerHTML = '';

  if (list.length > 0) tIsAdminCache = !!list[0].isAdmin;
  el('tournamentDeleteAllBtn').classList.toggle('hidden', !tIsAdminCache);
  el('tCleanupToggleBtn').classList.toggle('hidden', !tIsAdminCache);

  if (list.length === 0) {
    container.innerHTML = '<p class="muted small">Vēl nav neviena turnīra. Izveido pirmo!</p>';
    return;
  }

  list.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tournament-row';

    const info = document.createElement('div');
    info.className = 'tournament-row-info';
    const title = document.createElement('div');
    title.className = 'tournament-row-title';
    title.textContent = t.name + (t.isPrivate ? ' 🔒' : '');
    const meta = document.createElement('div');
    meta.className = 'tournament-row-meta';
    meta.textContent =
      `${t.participantCount}/${t.maxParticipants} dalībnieki · ${t.seriesFormat.toUpperCase()} · ` +
      `${tStatusLabel(t)} · sākums ${tFormatDateTime(t.startTime)}`;
    info.appendChild(title);
    info.appendChild(meta);

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary btn-small';
    openBtn.textContent = 'Atvērt';
    openBtn.addEventListener('click', () => tOpenDetail(t.id));

    row.appendChild(info);
    row.appendChild(openBtn);

    if (t.isAdmin && t.status === 'completed') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-ghost-danger btn-small';
      deleteBtn.textContent = '🗑';
      deleteBtn.title = 'Dzēst turnīru (admin)';
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Dzēst turnīru "${t.name}"? Šo darbību nevar atsaukt.`)) {
          socket.emit('deleteTournament', { id: t.id });
        }
      });
      row.appendChild(deleteBtn);
    }

    container.appendChild(row);
  });
}

// ---------- public lobby-page tournaments section ----------
// A read-only summary shown on the main page itself — outside the modal —
// so it's visible to every visitor, including guests and people who
// haven't registered. Split into three tabs (open/ongoing/finished) rather
// than three always-visible lists, to match the existing TOP10 stats-block
// tab pattern and keep the sidebar from getting too tall.

let tPublicScope = 'registration';
let tLastPublicData = { registration: [], active: [], completed: [] };

const tPublicEmptyMessage = {
  registration: 'Nav atvērtu turnīru, kuros var pieteikties…',
  active: 'Šobrīd nav notiekošu turnīru…',
  completed: 'Vēl nav aizvadītu turnīru…',
};

function tPublicMetaLine(t) {
  const deckLabel = t.gameName || (t.gameId === 'duraks-36' ? '36 kārtis' : '52 kārtis');
  const base = `${t.participantCount}/${t.maxParticipants} dalībnieki · ${t.seriesFormat.toUpperCase()} · ${deckLabel}`;
  if (t.status === 'registration') return `${base} · sākums ${tFormatDateTime(t.startTime)}`;
  if (t.status === 'active') return `${base} · sākās ${tFormatDateTime(t.startTime)}`;
  return `${base} · sākums bija ${tFormatDateTime(t.startTime)}`;
}

function tRenderPublicTournaments() {
  const container = el('publicTournamentsList');
  const list = tLastPublicData[tPublicScope] || [];
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `<p class="muted small">${tPublicEmptyMessage[tPublicScope]}</p>`;
    return;
  }

  list.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tournament-row';

    const info = document.createElement('div');
    info.className = 'tournament-row-info';
    const title = document.createElement('div');
    title.className = 'tournament-row-title';
    title.textContent = t.name;
    const meta = document.createElement('div');
    meta.className = 'tournament-row-meta';
    meta.textContent = tPublicMetaLine(t);
    info.appendChild(title);
    info.appendChild(meta);

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary btn-small';
    openBtn.textContent = 'Skatīt';
    openBtn.addEventListener('click', () => {
      // myUsername is client.js's shared login-state global — guests (and
      // anyone not logged in) get nudged toward registering instead of
      // silently failing the gated getTournamentDetail request.
      if (typeof myUsername !== 'undefined' && myUsername) {
        tOpenModal();
        tOpenDetail(t.id);
      } else {
        showToast('Ielogojies vai reģistrējies, lai skatītu turnīra detaļas');
      }
    });

    row.appendChild(info);
    row.appendChild(openBtn);
    container.appendChild(row);
  });
}

socket.on('publicTournamentsData', (data) => {
  tLastPublicData = data;
  tRenderPublicTournaments();
});

document.querySelectorAll('#publicTournamentsTabs .stats-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    tPublicScope = btn.dataset.status;
    document.querySelectorAll('#publicTournamentsTabs .stats-tab').forEach((b) => b.classList.toggle('active', b === btn));
    tRenderPublicTournaments();
  });
});

el('tournamentOpenBtn').addEventListener('click', tOpenModal);
el('tournamentCloseBtn').addEventListener('click', tCloseModal);

document.querySelectorAll('.tournament-back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    tShowView('list');
    socket.emit('listTournaments');
  });
});

// A native <input type="datetime-local"> takes/returns "YYYY-MM-DDTHH:mm"
// in the browser's local time zone (no timezone suffix) — exactly what we
// need here, so no custom picker UI or state is required any more.
function tSetDateTimeInput(id, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  el(id).value = local;
}

function tReadDateTimeInput(id) {
  const raw = el(id).value;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Format and deck-size are button-group pickers (same visual pattern as the
// multiplayer room-creation modal) instead of <select> dropdowns — this
// object is their single source of truth, mirroring multiCreateState.
// startPreset holds either a number of minutes-from-now (as a string, e.g.
// '1440' for 24 hours) or 'custom', in which case the actual moment comes
// from the datetime-local field instead.
const tCreateState = { seriesFormat: 'bo3', gameId: 'duraks-52', startPreset: '1440' };

function tSetActiveOption(groupEl, value) {
  Array.from(groupEl.children).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

// The tournament's actual start moment: either "now + N minutes" from the
// preset buttons, or whatever's in the custom datetime-local field.
function tComputeStartDate() {
  if (tCreateState.startPreset === 'custom') return tReadDateTimeInput('tCreateStart');
  return new Date(Date.now() + Number(tCreateState.startPreset) * 60 * 1000);
}

// Registration close defaults to the start moment itself (no separate field
// shown) unless the organizer explicitly opts into a separate cutoff via
// the checkbox, which reveals its own datetime-local field.
function tComputeRegEndDate(startDate) {
  if (el('tCreateRegEndToggle').checked) return tReadDateTimeInput('tCreateRegEnd');
  return startDate;
}

function tUpdateTimesSummary() {
  const startDate = tComputeStartDate();
  const regEndDate = startDate ? tComputeRegEndDate(startDate) : null;
  const summary = el('tCreateTimesSummary');
  if (!startDate || !regEndDate) {
    summary.textContent = 'Ievadi turnīra sākuma laiku.';
    return;
  }
  const sameAsStart = regEndDate.getTime() === startDate.getTime();
  summary.textContent = sameAsStart
    ? `Sākums (un reģistrācijas termiņš): ${tFormatDateTime(startDate.toISOString())}`
    : `Reģistrācija slēdzas: ${tFormatDateTime(regEndDate.toISOString())} · Sākums: ${tFormatDateTime(startDate.toISOString())}`;
}

function tOpenCreateForm() {
  el('tCreateName').value = '';
  el('tCreateMax').value = 8;
  el('tCreateMaxValue').textContent = '8';
  tCreateState.seriesFormat = 'bo3';
  tCreateState.gameId = 'duraks-52';
  tCreateState.startPreset = '1440';
  tSetActiveOption(el('tCreateFormatGroup'), tCreateState.seriesFormat);
  tSetActiveOption(el('tCreateGameGroup'), tCreateState.gameId);
  tSetActiveOption(el('tCreateStartPresetGroup'), tCreateState.startPreset);
  el('tCreateStartCustomField').classList.add('hidden');
  tSetDateTimeInput('tCreateStart', new Date(Date.now() + 24 * 60 * 60 * 1000));
  el('tCreateRegEndToggle').checked = false;
  el('tCreateRegEndField').classList.add('hidden');
  tSetDateTimeInput('tCreateRegEnd', new Date(Date.now() + 24 * 60 * 60 * 1000));
  el('tCreatePrivate').checked = false;
  tUpdateTimesSummary();
  tShowView('create');
}

el('tCreateMax').addEventListener('input', () => {
  el('tCreateMaxValue').textContent = el('tCreateMax').value;
});
el('tCreateFormatGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-option');
  if (!btn) return;
  tCreateState.seriesFormat = btn.dataset.value;
  tSetActiveOption(el('tCreateFormatGroup'), tCreateState.seriesFormat);
});
el('tCreateGameGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-option');
  if (!btn) return;
  tCreateState.gameId = btn.dataset.value;
  tSetActiveOption(el('tCreateGameGroup'), tCreateState.gameId);
});
el('tCreateStartPresetGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-option');
  if (!btn) return;
  tCreateState.startPreset = btn.dataset.value;
  tSetActiveOption(el('tCreateStartPresetGroup'), tCreateState.startPreset);
  const isCustom = tCreateState.startPreset === 'custom';
  el('tCreateStartCustomField').classList.toggle('hidden', !isCustom);
  if (isCustom && !el('tCreateStart').value) {
    tSetDateTimeInput('tCreateStart', new Date(Date.now() + 24 * 60 * 60 * 1000));
  }
  tUpdateTimesSummary();
});
el('tCreateStart').addEventListener('input', tUpdateTimesSummary);
el('tCreateRegEndToggle').addEventListener('change', () => {
  const show = el('tCreateRegEndToggle').checked;
  el('tCreateRegEndField').classList.toggle('hidden', !show);
  if (show) {
    const startDate = tComputeStartDate() || new Date(Date.now() + 24 * 60 * 60 * 1000);
    tSetDateTimeInput('tCreateRegEnd', startDate);
  }
  tUpdateTimesSummary();
});
el('tCreateRegEnd').addEventListener('input', tUpdateTimesSummary);

el('tournamentCreateOpenBtn').addEventListener('click', tOpenCreateForm);

el('tCreateSubmitBtn').addEventListener('click', () => {
  const name = el('tCreateName').value.trim();
  const maxParticipants = parseInt(el('tCreateMax').value, 10);
  const seriesFormat = tCreateState.seriesFormat;
  const gameId = tCreateState.gameId;
  const startDate = tComputeStartDate();
  const regEndDate = startDate ? tComputeRegEndDate(startDate) : null;
  const registrationEndTime = regEndDate ? regEndDate.toISOString() : null;
  const startTime = startDate ? startDate.toISOString() : null;
  const isPrivate = el('tCreatePrivate').checked;

  if (!name) return showToast('Ievadi turnīra nosaukumu');
  if (!registrationEndTime || !startTime) return showToast('Ievadi turnīra sākuma laiku');

  socket.emit('createTournament', { name, maxParticipants, seriesFormat, gameId, registrationEndTime, startTime, isPrivate });
});

el('tournamentJoinCodeBtn').addEventListener('click', () => {
  const code = el('tournamentCodeInput').value.trim().toUpperCase();
  if (!code) return showToast('Ievadi ielūguma kodu');
  socket.emit('joinTournamentByCode', { code });
});

el('tournamentResultsOpenBtn').addEventListener('click', () => {
  tShowView('results');
  socket.emit('getTournamentResults');
});

el('tournamentDeleteAllBtn').addEventListener('click', () => {
  if (confirm('Dzēst VISUS pabeigtos turnīrus? Šo darbību nevar atsaukt.')) {
    socket.emit('deleteAllCompletedTournaments');
  }
});

// ---------- detail view (roster + bracket) ----------

function tOpenDetail(id) {
  tOpenDetailId = id;
  tShowView('detail');
  socket.emit('getTournamentDetail', { id });
}

function tRenderDetail(t) {
  const header = el('tDetailHeader');
  header.innerHTML = '';

  const title = document.createElement('h3');
  title.textContent = t.name + (t.isPrivate ? ' 🔒' : '');
  header.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'muted small';
  meta.textContent =
    `${t.participantCount}/${t.maxParticipants} dalībnieki (min. ${t.minParticipants}) · ${t.seriesFormat.toUpperCase()} · ${tStatusLabel(t)}`;
  header.appendChild(meta);

  if (t.isAdmin && t.status === 'completed') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-ghost-danger btn-small';
    deleteBtn.textContent = '🗑 Dzēst turnīru (admin)';
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Dzēst turnīru "${t.name}"? Šo darbību nevar atsaukt.`)) {
        socket.emit('deleteTournament', { id: t.id });
      }
    });
    header.appendChild(deleteBtn);
  }

  const times = document.createElement('p');
  times.className = 'muted small';
  times.textContent = `Reģistrācija līdz ${tFormatDateTime(t.registrationEndTime)} · sākums ${tFormatDateTime(t.startTime)}`;
  header.appendChild(times);

  if (t.isPrivate && t.inviteCode) {
    const codeRow = document.createElement('p');
    codeRow.className = 'tournament-invite-code';
    codeRow.textContent = `Ielūguma kods: ${t.inviteCode}`;
    header.appendChild(codeRow);
  }

  const body = el('tDetailBody');
  body.innerHTML = '';

  if (t.status === 'registration') {
    const actionRow = document.createElement('div');
    actionRow.className = 'tournament-form-actions';

    if (t.hasJoined) {
      const leaveBtn = document.createElement('button');
      leaveBtn.className = 'btn btn-ghost-danger btn-small';
      leaveBtn.textContent = 'Pamest turnīru';
      leaveBtn.addEventListener('click', () => socket.emit('leaveTournament', { id: t.id }));
      actionRow.appendChild(leaveBtn);
    } else if (t.isRegistrationOpen) {
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn btn-primary btn-small';
      joinBtn.textContent = 'Pievienoties';
      joinBtn.addEventListener('click', () => socket.emit('joinTournament', { id: t.id }));
      actionRow.appendChild(joinBtn);
    }

    if (t.isCreator) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-secondary btn-small';
      closeBtn.textContent = 'Slēgt reģistrāciju un ģenerēt izspēli';
      closeBtn.addEventListener('click', () => socket.emit('closeTournamentRegistration', { id: t.id }));
      actionRow.appendChild(closeBtn);

      if (t.participantCount < t.maxParticipants) {
        const botsBtn = document.createElement('button');
        botsBtn.className = 'btn btn-secondary btn-small';
        botsBtn.textContent = '🤖 Aizpildīt ar botiem (testēšanai)';
        botsBtn.addEventListener('click', () => socket.emit('fillTournamentWithBots', { id: t.id }));
        actionRow.appendChild(botsBtn);
      }
    }

    body.appendChild(actionRow);

    const roster = document.createElement('div');
    roster.className = 'tournament-roster';
    t.participants.forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'tournament-roster-chip';
      chip.textContent = p.playerId;
      roster.appendChild(chip);
    });
    body.appendChild(roster);
  } else if (t.bracket) {
    body.appendChild(tRenderBracket(t.bracket));
  } else {
    body.innerHTML = '<p class="muted small">Šim turnīram vēl nav izspēles.</p>';
  }
}

function tDescribeSource(source) {
  if (!source) return 'TBD';
  if (source.type === 'seed') return source.participant.playerId;
  if (source.type === 'winner_of') return `Uzvarētājs (${source.matchId})`;
  if (source.type === 'loser_of') return `Zaudētājs (${source.matchId})`;
  return 'TBD';
}

/** Derives champion/runner-up/third place from a finished bracket, for the
 *  gold/silver/bronze placements summary. Returns null until the final
 *  (and, if applicable, third-place) match is actually completed. */
function tComputePlacements(bracket) {
  if (!bracket || !bracket.finalMatch || bracket.finalMatch.status !== 'completed') return null;
  const champion = bracket.finalMatch.winner;
  const runnerUp = bracket.finalMatch.loser;
  let third = null;
  if (bracket.thirdPlaceMatch) {
    if (bracket.thirdPlaceMatch.status === 'completed') third = bracket.thirdPlaceMatch.winner;
  } else {
    // No real third-place match was needed — one semifinal was a bye, so
    // its lone loser was marked to auto-become 3rd (see bracket-generator.js).
    const semifinalRound = bracket.rounds[bracket.rounds.length - 2];
    if (semifinalRound) {
      const autoMatch = semifinalRound.matches.find(
        (m) => m.loserNextSeriesId === 'auto-third-place' && m.status === 'completed'
      );
      if (autoMatch) third = autoMatch.loser;
    }
  }
  return { champion, runnerUp, third };
}

function tRenderPlayerName(playerId, displayName, match, placements) {
  const span = document.createElement('span');
  span.textContent = displayName;
  span.className = 'tournament-player-name';
  if (match.status === 'completed' && playerId) {
    if (playerId === match.winner) span.classList.add('winner');
    else if (playerId === match.loser) span.classList.add('loser');
  }
  if (match.forfeitedBy && playerId === match.forfeitedBy) {
    span.classList.add('forfeited');
  }
  if (placements && playerId) {
    if (playerId === placements.champion) span.classList.add('place-gold');
    else if (playerId === placements.runnerUp) span.classList.add('place-silver');
    else if (playerId === placements.third) span.classList.add('place-bronze');
  }
  return span;
}

function tRenderMatchRow(playerId, displayName, score, match, placements) {
  const row = document.createElement('div');
  row.className = 'tournament-match-row';
  if (match.status === 'completed' && playerId) {
    if (playerId === match.winner) row.classList.add('winner-row');
    else if (playerId === match.loser) row.classList.add('loser-row');
  }

  row.appendChild(tRenderPlayerName(playerId, displayName, match, placements));

  if (score !== null) {
    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'tournament-match-score';
    scoreSpan.textContent = score;
    row.appendChild(scoreSpan);
  }

  return row;
}

function tIsBotParticipant(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('Bots-');
}

function tRenderMatchBox(match, placements) {
  const box = document.createElement('div');
  box.className = 'tournament-match-box' + (match.isThirdPlaceMatch ? ' third-place' : '');

  const completed = match.status === 'completed';
  box.appendChild(tRenderMatchRow(
    match.player1, match.player1 || tDescribeSource(match.player1Source),
    completed ? match.player1Wins : null, match, placements
  ));
  box.appendChild(tRenderMatchRow(
    match.player2, match.player2 || tDescribeSource(match.player2Source),
    completed ? match.player2Wins : null, match, placements
  ));

  if (!completed) {
    if (match.status === 'in_progress') {
      const label = document.createElement('div');
      label.className = 'tournament-match-format';
      label.textContent = 'Notiek…';
      box.appendChild(label);
    } else if (
      match.player1 && match.player2 &&
      (match.player1 === myUsername || match.player2 === myUsername) &&
      !tIsBotParticipant(match.player1) && !tIsBotParticipant(match.player2)
    ) {
      const startBtn = document.createElement('button');
      startBtn.className = 'btn btn-primary btn-small tournament-match-start-btn';
      startBtn.textContent = '▶ Sākt spēli';
      startBtn.addEventListener('click', () => {
        socket.emit('startTournamentMatch', { id: tOpenDetailId, matchId: match.id });
      });
      box.appendChild(startBtn);
    } else {
      const formatLabel = document.createElement('div');
      formatLabel.className = 'tournament-match-format';
      formatLabel.textContent = `Bo${match.requiredWins === 3 ? 5 : 3}`;
      box.appendChild(formatLabel);
    }
  }

  return box;
}

function tRenderPlacementsSummary(placements) {
  const wrap = document.createElement('div');
  wrap.className = 'tournament-placements-summary';
  const rows = [
    ['🥇', placements.champion, 'place-gold'],
    ['🥈', placements.runnerUp, 'place-silver'],
    ['🥉', placements.third, 'place-bronze'],
  ];
  rows.forEach(([medal, name, cls]) => {
    if (!name) return;
    const row = document.createElement('div');
    row.className = 'tournament-placements-summary-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tournament-player-name ' + cls;
    nameSpan.textContent = name;
    row.textContent = medal + ' ';
    row.appendChild(nameSpan);
    wrap.appendChild(row);
  });
  return wrap;
}

function tRenderBracket(bracket) {
  const wrap = document.createElement('div');
  const placements = tComputePlacements(bracket);

  if (placements) {
    wrap.appendChild(tRenderPlacementsSummary(placements));
  }

  const rows = document.createElement('div');
  rows.className = 'tournament-bracket';

  bracket.rounds.forEach((round) => {
    const col = document.createElement('div');
    col.className = 'tournament-bracket-round';
    const heading = document.createElement('h4');
    heading.textContent = round.roundNumber === bracket.rounds.length ? 'Fināls' : `${round.roundNumber}. kārta`;
    col.appendChild(heading);
    round.matches.forEach((m) => col.appendChild(tRenderMatchBox(m, placements)));
    if (round.byeParticipant) {
      const bye = document.createElement('div');
      bye.className = 'tournament-match-box bye';
      bye.textContent = `${round.byeParticipant} — brīvs gājiens`;
      col.appendChild(bye);
    }
    rows.appendChild(col);
  });

  if (bracket.thirdPlaceMatch) {
    const col = document.createElement('div');
    col.className = 'tournament-bracket-round';
    const heading = document.createElement('h4');
    heading.textContent = '3. vietas spēle';
    col.appendChild(heading);
    col.appendChild(tRenderMatchBox(bracket.thirdPlaceMatch, placements));
    rows.appendChild(col);
  }

  wrap.appendChild(rows);
  return wrap;
}

// ---------- results view ----------

function tRenderResults(results) {
  const body = el('tResultsBody');
  body.innerHTML = '';

  const renderBucket = (label, bucket) => {
    const section = document.createElement('div');
    section.className = 'tournament-results-bucket';
    const h = document.createElement('h4');
    h.textContent = label;
    section.appendChild(h);

    const summary = document.createElement('p');
    summary.className = 'muted small';
    summary.textContent = `Spēlēti turnīri: ${bucket.tournamentsPlayed} · Uzvarēti: ${bucket.wins}`;
    section.appendChild(summary);

    if (bucket.placements.length === 0) {
      const none = document.createElement('p');
      none.className = 'muted small';
      none.textContent = 'Vēl nav rezultātu.';
      section.appendChild(none);
    } else {
      const list = document.createElement('ul');
      list.className = 'tournament-placements-list';
      bucket.placements.slice().reverse().forEach((p) => {
        const li = document.createElement('li');
        li.textContent = `${p.tournamentName} — ${p.placement}. vieta`;
        list.appendChild(li);
      });
      section.appendChild(list);
    }
    body.appendChild(section);
  };

  renderBucket('Publiskie turnīri', results.public);
  renderBucket('Privātie turnīri', results.private);
}

// ---------- socket wiring ----------

// Server pushes this right before auto-starting a tournament-series game
// against a bot (either the first game of a match, or the next game in an
// ongoing Bo3/Bo5 series). Mirrors what client.js's own playVsAI button
// click does — sets the vsAI flag so opponent-profile clicks are
// suppressed — closes the tournament modal, and joins the prepared room
// (this is what actually wires up the connection's game state correctly).
// In-game round/score/stage HUD, shown next to the opponent's hand for any
// game that's part of a tournament series. client.js's own 'state' handler
// runs first (it sets myId), so myId is already current by the time this
// listener (registered after client.js loads) runs for the same event.
socket.on('state', (state) => {
  const info = el('tournamentGameInfo');
  if (!info) return;
  if (!state.tournamentInfo) {
    info.classList.add('hidden');
    return;
  }
  const ti = state.tournamentInfo;
  const myWins = ti.player1 === myId ? ti.player1Wins : ti.player2Wins;
  const oppWins = ti.player1 === myId ? ti.player2Wins : ti.player1Wins;
  el('tGameInfoRound').textContent = ti.roundLabel;
  el('tGameInfoScore').textContent = `${myWins} : ${oppWins}`;
  info.title = ti.tournamentName;
  info.classList.remove('hidden');
});

socket.on('tournamentGameStarting', ({ code, vsBot }) => {
  vsAI = !!vsBot;
  tCloseModal();
  socket.emit('joinRoom', { code });
});

socket.on('tournamentsData', (list) => {
  if (tCurrentView === 'list') tRenderList(list);
});

socket.on('tournamentCreated', () => {
  showToast('Turnīrs izveidots');
  tShowView('list');
});

socket.on('tournamentDetail', (t) => {
  tOpenDetailId = t.id;
  tShowView('detail');
  tRenderDetail(t);
});

socket.on('tournamentResultsData', (results) => {
  if (tCurrentView === 'results') tRenderResults(results);
});

// Any tournament change (someone else joining, registration closing, etc.)
// refreshes whichever tournament view is currently open.
socket.on('tournamentUpdated', ({ id, deleted, bulkDeleted }) => {
  // The lobby-page public tournaments section is always mounted (even for
  // guests, who never open the modal at all), so it refreshes on every
  // change regardless of what's happening inside the modal below.
  socket.emit('listPublicTournaments');

  if (bulkDeleted) {
    if (tCurrentView === 'detail') {
      tOpenDetailId = null;
      tShowView('list');
    }
    if (!el('tournamentModal').classList.contains('hidden')) socket.emit('listTournaments');
    return;
  }
  if (deleted && tCurrentView === 'detail' && tOpenDetailId === id) {
    tOpenDetailId = null;
    tShowView('list');
    socket.emit('listTournaments');
    return;
  }
  if (tCurrentView === 'list' && !el('tournamentModal').classList.contains('hidden')) {
    socket.emit('listTournaments');
  }
  if (tCurrentView === 'detail' && tOpenDetailId === id) {
    socket.emit('getTournamentDetail', { id });
  }
});

socket.on('adminBulkDeleteResult', ({ count }) => {
  showToast(count > 0 ? `Dzēsti ${count} pabeigti turnīri` : 'Nav neviena pabeigta turnīra dzēšanai');
});

// ---------- admin cleanup tool (kritērijos balstīta turnīru dzēšana) ----------

const tCleanupReasonLabel = {
  few_participants: 'par maz dalībnieku',
  stuck_past_start: 'iestrēdzis reģistrācijā',
  stale: 'vecs/neaktīvs',
  empty_private: 'privāts, bez dalībniekiem',
};

function tReadCleanupCriteria() {
  return {
    minParticipants: { enabled: el('tCleanupMinEnabled').checked, value: el('tCleanupMinValue').value },
    stuckPastStart: { enabled: el('tCleanupStuckEnabled').checked },
    olderThanDays: { enabled: el('tCleanupOldEnabled').checked, value: el('tCleanupOldValue').value },
    emptyPrivate: { enabled: el('tCleanupEmptyPrivateEnabled').checked },
  };
}

el('tCleanupToggleBtn').addEventListener('click', () => {
  const panel = el('tCleanupPanel');
  const nowHidden = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', nowHidden);
  if (nowHidden) {
    el('tCleanupPreviewList').innerHTML = '';
    el('tCleanupDeleteBtn').classList.add('hidden');
  }
});

el('tCleanupPreviewBtn').addEventListener('click', () => {
  socket.emit('adminPreviewCleanup', tReadCleanupCriteria());
});

socket.on('adminCleanupPreview', ({ items }) => {
  const list = el('tCleanupPreviewList');
  list.innerHTML = '';
  el('tCleanupDeleteBtn').classList.toggle('hidden', items.length === 0);
  el('tCleanupDeleteBtn').textContent = `Dzēst atlasītos (${items.length})`;

  if (items.length === 0) {
    list.innerHTML = '<p class="muted small">Neviens turnīrs neatbilst atzīmētajiem kritērijiem.</p>';
    return;
  }

  items.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'cleanup-preview-row';
    const title = document.createElement('div');
    title.className = 'cleanup-preview-row-title';
    title.textContent = t.name + (t.isPrivate ? ' 🔒' : '');
    const meta = document.createElement('div');
    meta.className = 'cleanup-preview-row-meta';
    const reasons = t.reasons.map((r) => tCleanupReasonLabel[r] || r).join(', ');
    meta.textContent =
      `${t.participantCount}/${t.maxParticipants} dalībnieki · ${tStatusLabel(t)} · ` +
      `sākums ${tFormatDateTime(t.startTime)} · iemesls: ${reasons}`;
    row.appendChild(title);
    row.appendChild(meta);
    list.appendChild(row);
  });
});

el('tCleanupDeleteBtn').addEventListener('click', () => {
  const count = el('tCleanupPreviewList').children.length;
  if (!confirm(`Dzēst ${count} turnīru(s)? Šo darbību nevar atsaukt.`)) return;
  socket.emit('adminRunCleanup', tReadCleanupCriteria());
});

socket.on('adminCleanupResult', ({ count }) => {
  showToast(count > 0 ? `Dzēsti ${count} turnīri` : 'Neviens turnīrs neatbilda kritērijiem');
  el('tCleanupPreviewList').innerHTML = '';
  el('tCleanupDeleteBtn').classList.add('hidden');
});

socket.on('tournamentPlayerWithdrew', ({ username: withdrawnUsername, tournamentName }) => {
  showToast(`${withdrawnUsername} pameta turnīru "${tournamentName}"`);
});

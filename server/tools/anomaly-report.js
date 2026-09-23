'use strict';

/**
 * server/tools/anomaly-report.js
 *
 * A read-only diagnostic tool for spotting patterns consistent with
 * deliberate ELO manipulation between colluding accounts — repeatedly
 * arranged matches, one side always "throwing" the game, and shared
 * network origins. Run it any time (even while the server is running,
 * since it only reads users.json) with:
 *
 *   node server/tools/anomaly-report.js
 *
 * IMPORTANT — read this before treating any flag as proof:
 * every signal here is circumstantial. Real friends who happen to be
 * roommates share an IP. A weaker player who plays a lot against one
 * strong friend will naturally lose most of those games. A single quick
 * surrender means someone got called away, nothing more. None of this
 * is a verdict — it's a shortlist of pairs worth a second look, ideally
 * combined (a pair flagged on 2+ independent signals is far more
 * suspicious than one flagged on a single signal).
 *
 * What it checks:
 *   1. Pairing concentration  — two accounts playing each other far more
 *      than matchmaking-by-chance would predict.
 *   2. Expected-vs-actual win rate — using the same ELO expected-score
 *      formula the rating system itself uses, whether one side wins (or
 *      loses) against a specific opponent far more consistently than
 *      their rating gap predicts.
 *   3. Quick-surrender streaks — the same player surrendering within
 *      seconds of the game starting, several times in a row, against the
 *      same opponent.
 *   4. Illogical-move streaks — repeatedly taking cards despite having an
 *      obvious card to defend with (a rough heuristic, not a solver —
 *      see isAvoidableTake in server.js / multi-rooms.js).
 *   5. Shared IP addresses — different accounts that have connected from
 *      the same IP.
 *
 * Signals 1-4 only look at *ranked* games — that's the only mode where
 * boosting ELO is actually the incentive.
 */

const fs = require('fs');
const path = require('path');

// Same DURAKS_DATA_DIR override as users.js, so this admin tool reads
// whichever location the running server is actually writing to.
const FILE = path.join(process.env.DURAKS_DATA_DIR || path.join(__dirname, '..', 'data'), 'users.json');

// ---------- Tunables ----------
const MIN_GAMES_FOR_PAIR_FLAG = 4; // don't flag pairs with too few games to say anything meaningful
const HIGH_CONCENTRATION_RATIO = 0.5; // e.g. 0.5 = half of someone's ranked games are against this one opponent
const QUICK_SURRENDER_MS = 20 * 1000; // "within the first seconds" of the game
const STREAK_THRESHOLD = 3; // "several times in a row"
const EXPECTED_DEVIATION_MIN_GAMES = 5;
const EXPECTED_DEVIATION_THRESHOLD = 0.35; // actual win rate vs expected, absolute difference
const TIMESTAMP_JOIN_WINDOW_MS = 5000; // for matching "the same game" across both players' own history logs

function bold(s) { return '\x1b[1m' + s + '\x1b[0m'; }
function dim(s) { return '\x1b[2m' + s + '\x1b[0m'; }
function red(s) { return '\x1b[31m' + s + '\x1b[0m'; }
function yellow(s) { return '\x1b[33m' + s + '\x1b[0m'; }
function green(s) { return '\x1b[32m' + s + '\x1b[0m'; }

function loadUsers() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('Neizdevās nolasīt ' + FILE + ': ' + err.message);
    process.exit(1);
  }
  return raw.users || raw || {};
}

function pairKey(a, b) {
  return [a, b].sort().join(' | ');
}

// Chronological (oldest-first) list of *ranked* 1-on-1-collapsible games
// between `username` and `opponent`, built only from `username`'s own
// history (so a game is never counted twice — the opponent's mirrored
// entry for the same game is skipped entirely). Each item carries
// username's own outcome/elo/duration/avoidableTakes for that game.
function gamesBetween(users, username, opponent) {
  const record = users[username];
  const history = Array.isArray(record.history) ? record.history : [];
  return history
    .filter((e) => e.ranked && Array.isArray(e.opponents) && e.opponents.includes(opponent))
    .map((e) => ({ ...e }))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function totalRankedGames(users, username) {
  const history = Array.isArray(users[username].history) ? users[username].history : [];
  return history.filter((e) => e.ranked).length;
}

// Finds the opponent's own history entry for the same game (matched by
// nearest timestamp) — used only to read the opponent's eloBefore for the
// expected-vs-actual check, since a player's own entry only stores their
// own rating.
function findMirrorEntry(users, opponent, username, timestamp) {
  const history = Array.isArray(users[opponent].history) ? users[opponent].history : [];
  let best = null;
  let bestDelta = Infinity;
  for (const e of history) {
    if (!Array.isArray(e.opponents) || !e.opponents.includes(username)) continue;
    const delta = Math.abs((e.timestamp || 0) - (timestamp || 0));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = e;
    }
  }
  return bestDelta <= TIMESTAMP_JOIN_WINDOW_MS ? best : null;
}

function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function formatGame(g) {
  const when = g.timestamp ? new Date(g.timestamp).toISOString().slice(0, 16).replace('T', ' ') : '?';
  return when + ' · ' + (g.outcome || '?') + (g.endReason && g.endReason !== 'normal' ? ' (' + g.endReason + ')' : '');
}

function main() {
  const users = loadUsers();
  const usernames = Object.keys(users);

  if (usernames.length === 0) {
    console.log('Nav neviena reģistrēta lietotāja — nav ko analizēt.');
    return;
  }

  // Build the pair list once: every (a, b) with a < b that have at least
  // one ranked game together.
  const pairs = [];
  for (let i = 0; i < usernames.length; i++) {
    for (let j = i + 1; j < usernames.length; j++) {
      const a = usernames[i];
      const b = usernames[j];
      const games = gamesBetween(users, a, b);
      if (games.length > 0) pairs.push({ a, b, games });
    }
  }

  console.log(bold('=== Duraks — anomāliju pārskats ==='));
  console.log(dim('Ģenerēts: ' + new Date().toISOString()));
  console.log(dim('Reģistrēti lietotāji: ' + usernames.length + ' · Spēlētāju pāri ar kopīgām ranked spēlēm: ' + pairs.length));
  console.log('');

  // ---------- 1 & 2: pairing concentration + expected-vs-actual ----------
  const concentrationFlags = [];
  const deviationFlags = [];

  for (const { a, b, games } of pairs) {
    const aTotal = totalRankedGames(users, a);
    const bTotal = totalRankedGames(users, b);
    const ratioA = aTotal > 0 ? games.length / aTotal : 0;
    const ratioB = bTotal > 0 ? games.length / bTotal : 0;

    if (games.length >= MIN_GAMES_FOR_PAIR_FLAG && (ratioA >= HIGH_CONCENTRATION_RATIO || ratioB >= HIGH_CONCENTRATION_RATIO)) {
      concentrationFlags.push({ a, b, games: games.length, ratioA, ratioB, aTotal, bTotal });
    }

    if (games.length >= EXPECTED_DEVIATION_MIN_GAMES) {
      let expectedSum = 0;
      let actualSum = 0;
      let counted = 0;
      for (const g of games) {
        if (typeof g.eloBefore !== 'number') continue;
        const mirror = findMirrorEntry(users, b, a, g.timestamp);
        if (!mirror || typeof mirror.eloBefore !== 'number') continue;
        const expected = expectedScore(g.eloBefore, mirror.eloBefore);
        const actual = g.outcome === 'won' ? 1 : g.outcome === 'draw' ? 0.5 : 0;
        expectedSum += expected;
        actualSum += actual;
        counted += 1;
      }
      if (counted >= EXPECTED_DEVIATION_MIN_GAMES) {
        const deviation = actualSum / counted - expectedSum / counted;
        if (Math.abs(deviation) >= EXPECTED_DEVIATION_THRESHOLD) {
          deviationFlags.push({ a, b, counted, expectedRate: expectedSum / counted, actualRate: actualSum / counted, deviation });
        }
      }
    }
  }

  console.log(bold('1) Neparasti bieža pārošanās'));
  console.log(dim('   Divi konti spēlē savā starpā daudz biežāk, nekā gadītos nejauši.'));
  if (concentrationFlags.length === 0) {
    console.log('   ' + green('Nekas neizceļas.'));
  } else {
    concentrationFlags
      .sort((x, y) => Math.max(y.ratioA, y.ratioB) - Math.max(x.ratioA, x.ratioB))
      .forEach((f) => {
        console.log(
          '   ' + yellow(f.a + ' <-> ' + f.b) + ': ' + f.games + ' kopīgas ranked spēles — ' +
          f.a + ' (' + Math.round(f.ratioA * 100) + '% no ' + f.aTotal + ' viņa ranked spēlēm), ' +
          f.b + ' (' + Math.round(f.ratioB * 100) + '% no ' + f.bTotal + ' viņa ranked spēlēm)'
        );
      });
  }
  console.log('');

  console.log(bold('2) Rezultāts neatbilst ELO starpībai (sagaidāmais vs. faktiskais)'));
  console.log(dim('   Salīdzina faktisko uzvaru daļu pret to, ko paredz abu spēlētāju ELO tajā brīdī.'));
  if (deviationFlags.length === 0) {
    console.log('   ' + green('Nekas neizceļas.'));
  } else {
    deviationFlags
      .sort((x, y) => Math.abs(y.deviation) - Math.abs(x.deviation))
      .forEach((f) => {
        const who = f.deviation > 0 ? f.a : f.b;
        console.log(
          '   ' + yellow(f.a + ' <-> ' + f.b) + ': ' + f.counted + ' spēles — ' + who +
          ' uzvar ' + (f.deviation > 0 ? Math.round(f.actualRate * 100) : Math.round((1 - f.actualRate) * 100)) +
          '% no reizēm, sagaidāms ~' + (f.deviation > 0 ? Math.round(f.expectedRate * 100) : Math.round((1 - f.expectedRate) * 100)) + '%'
        );
      });
  }
  console.log('');

  // ---------- 3 & 4: quick-surrender / illogical-move streaks ----------
  // Restricted to true 1-on-1 games (mode:'2p' or totalPlayers:2) — with
  // 3-4 player games it's not always unambiguous who specifically threw
  // the game, so those are left out of streak detection to avoid false
  // positives, even though the underlying data is collected for them too.
  const surrenderFlags = [];
  const avoidableTakeFlags = [];

  for (const { a, b, games } of pairs) {
    const oneVOne = games.filter((g) => g.mode === '2p' || g.totalPlayers === 2);

    let streakLoser = null;
    let streakLen = 0;
    let streakGames = [];
    function flushSurrenderStreak() {
      if (streakLen >= STREAK_THRESHOLD) {
        surrenderFlags.push({ loser: streakLoser, opponent: streakLoser === a ? b : a, len: streakLen, games: streakGames.slice() });
      }
      streakLoser = null;
      streakLen = 0;
      streakGames = [];
    }
    for (const g of oneVOne) {
      const isQuickSurrenderLoss = g.outcome === 'lost' && g.endReason === 'surrender' && typeof g.durationMs === 'number' && g.durationMs < QUICK_SURRENDER_MS;
      const loserThisGame = isQuickSurrenderLoss ? a : (g.outcome === 'won' && g.endReason === 'surrender' && typeof g.durationMs === 'number' && g.durationMs < QUICK_SURRENDER_MS ? b : null);
      if (loserThisGame && loserThisGame === streakLoser) {
        streakLen += 1;
        streakGames.push(g);
      } else if (loserThisGame) {
        flushSurrenderStreak();
        streakLoser = loserThisGame;
        streakLen = 1;
        streakGames = [g];
      } else {
        flushSurrenderStreak();
      }
    }
    flushSurrenderStreak();

    // A player's own avoidableTakes count only ever shows up in *their own*
    // history entries, never in their opponent's — so unlike the surrender
    // check above, this has to be run once per direction: once over `a`'s
    // own entries (games, i.e. gamesBetween(a,b)) to catch `a` losing with
    // avoidable takes, and once over `b`'s own entries
    // (gamesBetween(b,a)) to catch `b` doing the same.
    function scanAvoidableStreak(perspectiveGames, loserName, opponentName) {
      let len = 0;
      let streakGames = [];
      function flush() {
        if (len >= STREAK_THRESHOLD) {
          avoidableTakeFlags.push({ loser: loserName, opponent: opponentName, len, games: streakGames.slice() });
        }
        len = 0;
        streakGames = [];
      }
      for (const g of perspectiveGames) {
        if (g.avoidableTakes > 0 && g.outcome === 'lost') {
          len += 1;
          streakGames.push(g);
        } else {
          flush();
        }
      }
      flush();
    }
    scanAvoidableStreak(oneVOne, a, b);
    const gamesBA = gamesBetween(users, b, a).filter((g) => g.mode === '2p' || g.totalPlayers === 2);
    scanAvoidableStreak(gamesBA, b, a);
  }

  console.log(bold('3) Ātras padošanās virknē pret vienu pretinieku'));
  console.log(dim('   Tas pats spēlētājs padodas < ' + Math.round(QUICK_SURRENDER_MS / 1000) + 's laikā, vairākas reizes pēc kārtas, pret to pašu pretinieku. (Tikai 1v1 spēles.)'));
  if (surrenderFlags.length === 0) {
    console.log('   ' + green('Nekas neizceļas.'));
  } else {
    surrenderFlags
      .sort((x, y) => y.len - x.len)
      .forEach((f) => {
        console.log('   ' + red(f.loser) + ' padevās ātri ' + f.len + 'x pēc kārtas pret ' + f.opponent + ':');
        // Note: g.outcome/g.timestamp here are recorded from `a`'s side of
        // the pair (see gamesBetween), so they aren't necessarily the
        // loser's own outcome label — the duration and "padevās" framing
        // above already say everything that matters, so only the date is
        // shown here to avoid a confusing "won"/"lost" mismatch.
        f.games.forEach((g) => console.log('     - ' + (g.timestamp ? new Date(g.timestamp).toISOString().slice(0, 16).replace('T', ' ') : '?') + ' (' + Math.round(g.durationMs / 1000) + 's)'));
      });
  }
  console.log('');

  console.log(bold('4) Neloģiski gājieni virknē (ņem kārtis, lai gan ir acīmredzama aizsardzība)'));
  console.log(dim('   Aptuvens heiristisks rādītājs, ne precīzs risinātājs — skat. isAvoidableTake komentāru kodā.'));
  if (avoidableTakeFlags.length === 0) {
    console.log('   ' + green('Nekas neizceļas.'));
  } else {
    avoidableTakeFlags
      .sort((x, y) => y.len - x.len)
      .forEach((f) => {
        console.log('   ' + red(f.loser) + ' — neizmantoja acīmredzamu aizsardzību ' + f.len + ' spēlēs pēc kārtas pret ' + f.opponent + ':');
        f.games.forEach((g) => console.log('     - ' + formatGame(g) + ' (' + g.avoidableTakes + 'x šajā spēlē)'));
      });
  }
  console.log('');

  // ---------- 5: shared IPs ----------
  const ipFlags = [];
  for (let i = 0; i < usernames.length; i++) {
    for (let j = i + 1; j < usernames.length; j++) {
      const a = usernames[i];
      const b = usernames[j];
      const aIps = Array.isArray(users[a].knownIps) ? users[a].knownIps : [];
      const bIps = Array.isArray(users[b].knownIps) ? users[b].knownIps : [];
      const shared = aIps.filter((x) => bIps.some((y) => y.ip === x.ip));
      if (shared.length > 0) {
        ipFlags.push({ a, b, ips: shared.map((s) => s.ip) });
      }
    }
  }

  console.log(bold('5) Kopīgas IP adreses'));
  console.log(dim('   Konti, kas ir pieslēgušies no vienas un tās pašas IP adreses. Der atcerēties: viena mājsaimniecība, NAT vai VPN šo pašu var izraisīt nevainīgi.'));
  if (ipFlags.length === 0) {
    console.log('   ' + green('Nekas neizceļas.'));
  } else {
    ipFlags.forEach((f) => {
      console.log('   ' + yellow(f.a + ' <-> ' + f.b) + ': kopīga(s) IP — ' + f.ips.join(', '));
    });
  }
  console.log('');

  const totalFlags = concentrationFlags.length + deviationFlags.length + surrenderFlags.length + avoidableTakeFlags.length + ipFlags.length;
  console.log(bold('=== Kopā: ' + totalFlags + ' atzīmes ==='));
  if (totalFlags > 0) {
    console.log(dim('Atgādinājums: neviena atzīme pati par sevi nav pierādījums. Pāri, kas parādās vairākās sadaļās, ir prioritāri pārbaudāmi.'));
  }
}

main();

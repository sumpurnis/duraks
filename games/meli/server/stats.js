'use strict';
// Meļi statistics for the lobby's "Statistika" column. Same shape as Duraks' leaderboards
// (games, gamesVsBot, topWinRate, longestStreak, mostPlayed) so the two lobbies look alike.
// Only games between two signed-in accounts count towards the rankings; games against the computer
// and guest games only count in the totals.
const fs = require('node:fs');
const path = require('node:path');

const TOP_SIZE = 10;
const MIN_GAMES_ALL_TIME = 3;
const today = () => new Date().toISOString().slice(0, 10);

class MeliStats {
  /** @param {string|null} file JSON file to persist to (null = memory only, used by tests) */
  constructor(file = null) {
    this.file = file;
    this.data = { global: { allTime: 0, vsBotAllTime: 0, daily: null, vsBotDaily: null }, players: {} };
    this.timer = null;
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && raw.global && raw.players) this.data = raw;
      } catch { /* first run, or unreadable: start empty */ }
    }
  }

  daily(obj, key) {
    if (!obj[key] || obj[key].date !== today()) obj[key] = { date: today(), played: 0 };
    return obj[key];
  }

  player(name) {
    const p = this.data.players[name] || (this.data.players[name] = { played: 0, won: 0, currentStreak: 0, longestStreak: 0, daily: null });
    if (!p.daily || p.daily.date !== today()) p.daily = { date: today(), played: 0, won: 0, currentStreak: 0, longestStreak: 0 };
    return p;
  }

  /** winner/loser: { name, account } seat info; vsAI: whether the loser or winner was the computer. */
  record({ winner, loser, vsAI }) {
    const g = this.data.global;
    g.allTime += 1;
    this.daily(g, 'daily').played += 1;
    if (vsAI) {
      g.vsBotAllTime += 1;
      this.daily(g, 'vsBotDaily').played += 1;
    } else {
      for (const [seat, won] of [[winner, true], [loser, false]]) {
        if (!seat || !seat.account) continue;
        const p = this.player(seat.name);
        for (const s of [p, p.daily]) {
          s.played += 1;
          if (won) {
            s.won += 1;
            s.currentStreak += 1;
            s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
          } else {
            s.currentStreak = 0;
          }
        }
      }
    }
    this.persistSoon();
  }

  persistSoon() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('Meļi stats could not be saved:', err.message);
      }
    }, 500);
    if (this.timer.unref) this.timer.unref();
  }

  snapshot() {
    const g = this.data.global;
    const cur = (obj) => (obj && obj.date === today() ? obj.played : 0);
    const entries = Object.entries(this.data.players).map(([name, p]) => [name, p, p.daily && p.daily.date === today() ? p.daily : { played: 0, won: 0, longestStreak: 0 }]);
    const top = (pick, min) =>
      entries
        .map(([name, p, d]) => {
          const s = pick(p, d);
          return { username: name, played: s.played, winPct: s.played ? (s.won / s.played) * 100 : 0 };
        })
        .filter((e) => e.played >= min)
        .sort((a, b) => b.winPct - a.winPct || b.played - a.played)
        .slice(0, TOP_SIZE)
        .map((e) => ({ username: e.username, winPct: Math.round(e.winPct), played: e.played }));
    const single = (value) => {
      let best = null;
      for (const [name, p, d] of entries) {
        const v = value(p, d);
        if (v > 0 && (!best || v > best.value)) best = { username: name, value: v };
      }
      return best;
    };
    return {
      games: { today: cur(g.daily), allTime: g.allTime },
      gamesVsBot: { today: cur(g.vsBotDaily), allTime: g.vsBotAllTime },
      topWinRate: { today: top((p, d) => d, 1), allTime: top((p) => p, MIN_GAMES_ALL_TIME) },
      longestStreak: { today: single((p, d) => d.longestStreak), allTime: single((p) => p.longestStreak) },
      mostPlayed: { today: single((p, d) => d.played), allTime: single((p) => p.played) },
    };
  }
}

module.exports = { MeliStats };

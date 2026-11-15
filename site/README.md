# site/ — the front page
`public/landing.html|css|js` — header (guest / "Ielogoties kā …" / logged in), game buttons (plain links),
sign-in pop-up (reuses the platform's login events).

`public/world-map.js` — the living map in the hero: every registered player's village on a hex grid,
roads worn by the games played between players, walkers for games in progress, smoke for players online.
Drawn on two canvases without images or canvas copying (so privacy blockers can't blank it).
Data comes from `GET /api/world` (`platform/world.js`); tapping a village loads `GET /api/player`.
`public/player-stats.js` + `public/duraks-profile.css` + `#profileModal` in landing.html — the Duraks profile
window, copied 1:1 from games/duraks/public (markup, styles scoped under `.dk`, the profileData/ELO chart/history
code). Logged-in players get it straight away when they tap a village; data from `POST /api/player/full`.
If the Duraks profile window changes, copy the matching parts here again.

The previous front page is kept on the git branch `VECAIS`.

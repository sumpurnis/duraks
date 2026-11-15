# site/ — the front page
`public/landing.html|css|js` — header (guest / "Ielogoties kā …" / logged in), game buttons (plain links),
sign-in pop-up (reuses the platform's login events).

`public/world-map.js` — the living map in the hero: every registered player's village on a hex grid,
roads worn by the games played between players, walkers for games in progress, smoke for players online.
Drawn on two canvases without images or canvas copying (so privacy blockers can't blank it).
Data comes from `GET /api/world` (`platform/world.js`).

The previous front page is kept on the git branch `VECAIS`.

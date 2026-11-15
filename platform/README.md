# platform/ — shared by every game
Accounts, sign-in (password, Google, Facebook), session tokens, password reset mail, rate limiting, the feedback board and the data folder location. Games never edit these files; a game that needs something from here asks for it in `server.js`. Must not require anything from `games/` or `site/`.

`world.js` — the front page's map: village places (hex spiral, never move), games per player (village level 1–10)
and per pair of players (road wear), who is online, live games. Games report to it: Duraks directly,
Meļi through callbacks wired in `server.js`. Data file: `world.json` in the data folder.

# platform/ — shared by every game
Accounts, sign-in (password, Google, Facebook), session tokens, password reset mail, rate limiting, the feedback board and the data folder location. Games never edit these files; a game that needs something from here asks for it in `server.js`. Must not require anything from `games/` or `site/`.

`world.js` — the front page's map: village places (hex spiral, never move), games per player (village level 1–10)
and per pair of players (road wear), who is online, live games. Games report to it: Duraks directly,
Meļi through callbacks wired in `server.js`. Data file: `world.json` in the data folder.

`persist.js` — safe JSON files for users, feedback, tournaments and the map: batched atomic writes (temp file +
rename, at most once a second), an hourly `.bak`, flush on shutdown, and a refusal to start when a file exists
but can't be parsed (it falls back to the `.bak` first). `client-ip.js` — the player's real address behind
Railway's proxy (last `X-Forwarded-For` entry; trusted on Railway or with `TRUST_PROXY=1`).

Environment: `PUBLIC_URL` must be set in production — password-reset links are built only from it.

`profanity.js` — rude-word filter for player names (Latvian, English, Russian slang). New names are refused at
registration (also OAuth sign-up and Meļi guest names); on every start, existing offensive account names are
renamed to "Spēlētājs1234" everywhere (old name still logs in, one-time note to the player). Preview on real data:
`node tools/check-usernames.js data/users.json`. Settings: `BLOCKED_NAME_WORDS` (extra words), `ALLOWED_NAMES`
(exceptions), `RENAME_OFFENSIVE_USERNAMES=0` (only log, don't rename).

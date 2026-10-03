# Uzspēlēsim.lv — one site, separate parts

One Node process serves everything. Start as before: `npm install`, then `npm start` (`node server.js`).

| URL | What | Where the code is |
|---|---|---|
| `/` | Front page: game buttons, sign-up / log-in pop-up (with Google) | `site/` |
| `/duraks` | Duraks | `games/duraks/` |
| `/meli/` | Meļi (own Socket.io namespace `/meli`) | `games/meli/` |

## Folders — who owns what
```
server.js            the site shell: wires the parts together, nothing else
site/public/         front page (landing.html / .css / .js)
platform/            shared by every game — accounts, login, Google/Facebook, mail, rate limit,
                     feedback board, data folder config
  auth.js            register / log in / log out / reset / OAuth routes + feedback events
  users.js oauth.js mailer.js rate-limit.js feedback.js config.js
  public/            shared pages & scripts: board.html, guest-nudge.js, lobby-auth.js, site-nav.css,
                     board-preview-client.js, privacy.html, data-deletion.html
  tools/             anomaly-report.js
games/duraks/
  server/index.js    all Duraks socket events, rooms, AI, tournaments, leaderboards (+ /duraks route)
  server/…           ai, multi-rooms, games/, tournament/
  public/            index.html, client.js, multi-client.js, tournament-client.js, style.css, multi.css, tournament.css, images/
games/meli/          Meļi: server/, client/, tests (own README)
tools/check-boundaries.js   `npm run check` — fails if a part reaches into another one
```
Rules (checked by `npm run check`): `platform/` knows nothing about games; `games/duraks` and `games/meli` never use each other; Meļi gets its accounts handed in by `server.js`.

**One known front-end link:** the Meļi lobby is deliberately built from Duraks' own lobby files so the two look identical — `/style.css`, `/multi.css`, `/client.js`-independent markup and `/board.css` (Duraks) plus `/board-preview-client.js` and `/lobby-auth.js` (platform). Changing the Duraks lobby CSS therefore changes Meļi's lobby. Meļi's own screens are in `games/meli/client/meli.css`.

## Working on one game in a separate chat
- Duraks chat: give it the whole project, ask it to change only `games/duraks/`.
- Meļi chat: whole project, only `games/meli/`.
- Accounts / login / feedback: `platform/`. Front page: `site/`. `server.js` only when a new game is added.
- Run `npm run check` after changes.

## Accounts and data (nothing changed for existing players)
- Accounts, sessions and Google/Facebook sign-in: `platform/`. Same Socket.io events, same localStorage keys (`duraks_username`, `duraks_token`), so one login covers `/`, `/duraks` and `/meli/`.
- Data files live in `DURAKS_DATA_DIR` if set (your Railway volume), otherwise in `server/data` if that folder already exists, otherwise in `data/`. Files: `users.json`, `feedback.json` (platform), `tournaments.json`, `tournament-results.json` (Duraks), `meli-stats.json` (Meļi).
- Meļi connects with the saved token; if it checks out, the player's name is the account name. Guests get "Viesis-NNNN".
- `reset-data.js` and `npm run anomaly-report` work as before.

## Google / Facebook login
- Nothing to change in the Google console: redirect URI is still `PUBLIC_URL/auth/google/callback`. Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` (the real https address).
- `/auth/:provider?return=…&next=…` accepts only `/`, `/duraks`, `/meli/`. Default return is `/duraks` (the old behaviour). From the front page Google returns to `/`; from the Meļi page to `/meli/`.
- Old links keep working: `/?room=…` and `/?reset=…` are forwarded to `/duraks`.

## Front page
- Each game button is an ordinary link (`/duraks`, `/meli/`). Both lobbies have a "← Uzspēlēsim.lv" button (`platform/public/site-nav.css`).
- The front page keeps no socket open (connects only to verify, log in or log out).
- `platform/public/guest-nudge.js` shows a dismissible sign-up card to logged-out players in a lobby, once per session.

## Meļi lobby
Same three columns as Duraks: sign-up / log-in card, Statistika, Atsauksmes. Meļi statistics (`games/meli/server/stats.js`): games today / all time, vs computer, TOP10 win %, longest streak, most games — only games between two signed-in accounts count for rankings. Differences: no tournaments, no e-mail settings link yet; quick rooms are 10 / 26 cards each.

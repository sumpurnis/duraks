# Meļi

Two-player bluffing card game: play against a friend (open or private rooms, invite links) or against a simple computer opponent. Node.js + Socket.io, no build step, one runtime dependency.

```bash
npm install
npm start            # http://localhost:3000
npm test             # engine rules, AI-vs-AI games, and real-socket rooms (PvP, AI, timers, reconnect)
```

## Rules as implemented

Based on the published Meļi rules (cards are placed face-down and *announced*; the next player may call the
bluff; first to empty their hand wins) plus these house rules:

1. Full 52-card deck split between two players (26 each; a 10-card quick game is available in the lobby).
2. A round starts with the starter placing **any** card face-down and announcing it. The announcement may be a lie.
3. That first announcement **locks the suit** for the round. Every later card must be announced in the locked suit.

   Two versions, chosen in the lobby (`announce` in `server/engine.js`):
   - **Suit only** (default): the starter just names a suit; every later card silently claims that suit. A card is honest if it really is of that suit.
   - **Suit and rank**: each card is announced as an exact card (e.g. K♠), in the locked suit. A card is honest only if it is exactly that card.
4. You may play **any card** in your hand. If you hold none of the locked suit, you have to bluff.
5. **Placing your next card is your pass.** The only extra button is **Call bluff**, enabled on your turn when the opponent just placed a card.
6. Calling bluff reveals only the last card. If it was not what was announced, the liar takes the whole pile. Otherwise the caller does.
7. Whoever was right starts the next round (caught liar: the caller starts; honest card: its owner starts).
8. First to run out of cards wins. Your last card is checked automatically: if it was a lie you pick up the pile and play on.

All rule switches live in `server/engine.js` (`DEFAULTS`), the AI personality in `server/ai.js` (`tuning`).

## Playing with a friend

Lobby switches: **Opponent** (Computer / Player), **Announce** (Suit / Suit + rank), **Cards each** (10 / 26) and, for player games, **Private**.

- A player game appears in the *Open games* list until someone joins. Share the 5-letter code or press *Copy invite link* (`/?room=CODE`).
- Private games show a 🔒 and get a generated 6-letter password. The invite link contains it, so a friend can join with one click; anyone else is asked for it.
- Per-move timer: 60 s. Running out of time, leaving, or staying disconnected for 30 s forfeits.
- Reload or lose connection: your seat is kept (secret token in `sessionStorage`) and you resume where you were.
- Rematch needs both players to accept (against the computer it restarts at once).
- There are no accounts: names are guest names typed in the lobby.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `MELI_AI_DELAY` | 1100 | ms the computer "thinks" |
| `MELI_REVEAL_PAUSE` | 2600 | ms the computer waits after a reveal before moving |
| `MELI_TURN_MS` | 60000 | move limit in player games |
| `MELI_GRACE_MS` | 30000 | time a dropped player has to reconnect |

## Layout

```
server/engine.js   pure rules (no I/O), player indexes 0/1
server/ai.js       computer opponent
server/rooms.js    rooms: lobby list, passwords, timers, reconnect, rematch, AI seat
server/index.js    static files + Socket.io wiring (createApp); server is authoritative, clients only get their own view
client/            index.html, meli.css, app.js (renders whatever state the server sends). The lobby reuses the Uzspēlēsim.lv/Duraks stylesheets and login script, so it needs the whole site server (npm start in the parent folder)
test/              node:test suites
```

Socket protocol, client to server: `room:create {name, vsAI, announce, handSize, private}`, `room:join {code, name, password?}`,
`room:leave`, `room:resume {code, token}`, `rooms:refresh`, `play {cardId, claim}`, `challenge`, `rematch`.
Server to client: `room:joined`, `state`, `reveal`, `rooms`, `room:password`, `room:left`, `room:gone`, `notice`.

## Known limitations

- Games live in server memory: a server restart ends them. No accounts, so no stats or friend lists.
- The UI is Latvian only (strings live in `client/index.html` and `client/app.js`; server messages are mapped in `SERVER_MSG`).
- Full 26-card games against the AI are long (hundreds of moves) because piles are small; use the quick game for testing.
- The AI is simple. Suit and rank: it bluffs by announcing cards it still holds. Suit only: it names the suit it holds most of, dumps off-suit cards when bluffing, and calls bluff more when an honest card looks unlikely from its own hand.

# platform/ — shared by every game
Accounts, sign-in (password, Google, Facebook), session tokens, password reset mail, rate limiting, the feedback board and the data folder location. Games never edit these files; a game that needs something from here asks for it in `server.js`. Must not require anything from `games/` or `site/`.

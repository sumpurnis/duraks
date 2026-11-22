# Discord Activity files

Served at `/discord/…` only when `DISCORD_ACTIVITY=1` (see `platform/discord.js`).

- `index.html` + `shell.js` + `discord.css` — the Activity's start page. It stays loaded the whole time
  (it holds the Discord SDK connection) and shows the game in a frame inside itself.
- `client.js` — added to the Duraks / Meļi page only when it is opened inside Discord: one table per
  voice channel, links that open outside Discord, the real site's address in share links.
- `sdk.min.js` — Discord's Embedded App SDK, bundled for the browser (we have no build step, and the
  pages may only load scripts from this site).

## Setting up (Discord Developer Portal + Railway)

1. Developer Portal → New Application (a test one first, e.g. "Uzspēlēsim (tests)").
2. Activities → Settings: enable Activities. Activities → URL Mappings: prefix `/` → target `uzspelesim.lv`
   (or the test deployment's address), without `https://`.
3. Activities → Settings: turn on **Proxy Authentication** (Discord then signs every request).
4. Railway variables: `DISCORD_ACTIVITY=1`, `DISCORD_CLIENT_ID=<Application ID>`,
   `DISCORD_PUBLIC_KEY=<Public Key>` (General Information page; both are public values, not secrets).
5. Start the Activity in a voice channel and open `/api/discord/check` — easiest from the browser
   console inside the Activity: `fetch('/api/discord/check').then(r => r.json()).then(console.log)`.
   When it shows `signatureValid: true`, also set `DISCORD_REQUIRE_SIGNATURE=1`.

Switching it off: remove `DISCORD_ACTIVITY` (or set it to 0) and redeploy/restart — the site is then
exactly as without this feature.

Without the public key every Activity player arrives from Discord's addresses and they share one
rate-limit bucket (e.g. "too many new tables"), so step 3–4 matters as soon as more than a few people play.

## Rebuilding sdk.min.js (e.g. a newer SDK version)

```
mkdir /tmp/sdk && cd /tmp/sdk && npm init -y && npm install @discord/embedded-app-sdk esbuild
echo "export { DiscordSDK, Events } from '@discord/embedded-app-sdk';" > entry.js
npx esbuild entry.js --bundle --minify --format=iife --global-name=DiscordEmbeddedSDK --target=es2019 --outfile=sdk.min.js
```

Put the MIT licence line back at the top of the file, and update the version here.
Current: 2.5.0.

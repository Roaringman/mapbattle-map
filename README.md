# MapBattle — map client

The browser side of MapBattle: the **map player** commands monsters on a top-down map of Jystrup while the host plays
the first-person game in Unity on their own PC.

The page is static files (`index.html`, `map.js`, `utm.js`) published with GitHub Pages. Its only link to the game is
a WebSocket: after the code is accepted, the game sends the map itself and the live state. No game files are needed
here.

`relay/` is the small server in the middle: a Cloudflare Worker that both the page and the game connect out to, so
the FPS player's PC needs no tunnel and anyone can start a game. It allows **one game at a time** (one FPS player, up
to four map players) to stay inside Cloudflare's free tier. See "Relay" in `PROTOCOL.md`.

## Playing as a map player

Either player can create the game; the game itself runs on the FPS player's PC.

- **Create:** open https://roaringman.github.io/mapbattle-map/, choose **Create a game** and send the invite (link +
  code) to the FPS player. They choose **Join game** in the game and enter the code; the page joins by itself once
  the game is up. *Create* is greyed out while another game is running.
- **Join:** open the invite link (`https://roaringman.github.io/mapbattle-map/?join`), enter your name and the code.

The code changes every game.

## Hosting (the FPS player)

Each game:

1. Press **Play** in Unity. The lobby opens: **Create game**, or **Join game** with the code from a map player's
   invite. The lobby says if a map player is already waiting, or if another game is running (one at a time).
2. Press **Esc** in the game to open the invite panel, then **Copy invite (link + code)** and send it to friends.

The game connects out to the relay, so no router ports are opened and map players never see your IP address.
Stopping Play ends the game on the relay and frees it for the next one.

Without the relay (`MapRelayLink.useRelay` off in Unity) the game hosts the old way, through a Cloudflare quick
tunnel (`winget install --id Cloudflare.cloudflared` once); invite links then look like
`…/mapbattle-map/?server=wss://something.trycloudflare.com`.

## Security model

- A new random password (about 59 bits) every game. Clients get no data at all before sending it.
- 15 seconds to log in, a cap on waiting connections, a one-minute lockout after 10 wrong guesses, and at most four map
  players.
- The game accepts browsers only from `localhost` and the sites in `MapSocketServer.allowedOrigins`
  (by default `https://roaringman.github.io`). Add your own Pages address there if you fork this.
- Everything the map player sees is decided by the game; this page cannot ask for hidden information.
- The relay applies the same rules in front of the game (code, 15 s to send it, lockout, four map players, allowed
  origins), runs one game at a time, and passes messages through without reading them once a player is in.

## The relay

Deploy once (needs a free Cloudflare account):

```
cd relay
npx wrangler login
npx wrangler deploy
```

It runs at `wss://mapbattle-relay.mapbattle.workers.dev` (`RELAY_URL` in `map.js`); a fork deploys its own and puts
that address there. On Windows PowerShell with scripts disabled, use `npx.cmd` instead of `npx`.

What happened in the last games, with timings: https://mapbattle-relay.mapbattle.workers.dev/log

Testing without Cloudflare or Unity: `node relay/dev-server.mjs` (a local relay on port 8787, no packages needed),
`node relay/test.mjs` (end-to-end checks against it) and `node relay/mock-host.mjs [relay] [code]` (a fake game).
The page on `localhost` uses the local relay by default.

## Developing

```
node serve.mjs
```

Then open http://localhost:8080/?server=ws://localhost:8090 while the game is playing in Unity (the direct way), or
http://localhost:8080/ with `node relay/dev-server.mjs` running (the relay way).

`utm.js` must stay in step with `UtmProjection.cs` in the game: both convert between lat/lon and the
ETRS89 / UTM 32N metres the game uses.

Map data © OpenStreetMap contributors, ODbL. Maps by MapLibre GL JS.

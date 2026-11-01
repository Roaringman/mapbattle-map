# MapBattle — map client

The browser side of MapBattle: the **map player** commands monsters on a top-down map of Jystrup while the host plays
the first-person game in Unity on their own PC.

This repository holds only static files (`index.html`, `map.js`, `utm.js`) and is published with GitHub Pages.
Its only link to the game is a WebSocket: after the password is accepted, the game sends the map itself and the live
state. No game files are needed here.

## Playing as a map player

1. Open the invite link from the host. It looks like
   `https://roaringman.github.io/mapbattle-map/?server=wss://something.trycloudflare.com`
2. Enter your name and the password the host gives you, then **Join**.

The password and the server address change every time the host starts the game.

## Hosting (the FPS player)

One-time setup on the host PC:

```
winget install --id Cloudflare.cloudflared
```

Each game:

1. Press **Play** in Unity. The game generates a password and starts a Cloudflare quick tunnel to the map server.
2. Press **Esc** in the game to open the invite panel, then **Copy invite (link + password)** and send it to friends.

The tunnel gives the map server a public `wss://` address without opening router ports or revealing your IP address.
The game only listens on `localhost:8090`; nothing else on your PC is exposed.

## Security model

- A new random password (about 59 bits) every game. Clients get no data at all before sending it.
- 15 seconds to log in, a cap on waiting connections, a one-minute lockout after 10 wrong guesses, and at most four map
  players.
- The game accepts browsers only from `localhost` and the sites in `MapSocketServer.allowedOrigins`
  (by default `https://roaringman.github.io`). Add your own Pages address there if you fork this.
- Everything the map player sees is decided by the game; this page cannot ask for hidden information.

## Developing

```
node serve.mjs
```

Then open http://localhost:8080/?server=ws://localhost:8090 while the game is playing in Unity.

`utm.js` must stay in step with `UtmProjection.cs` in the game: both convert between lat/lon and the
ETRS89 / UTM 32N metres the game uses.

Map data © OpenStreetMap contributors, ODbL. Maps by MapLibre GL JS.

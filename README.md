# MapBattle — map client

The browser side of MapBattle: the **map player** commands monsters on a top-down map of Jystrup while the host plays
the first-person game in Unity on their own PC.

This repository holds only static files (`index.html`, `map.js`, `utm.js`) and is published with GitHub Pages.
Its only link to the game is a WebSocket: after the password is accepted, the game sends the map itself and the live
state. No game files are needed here.

## Playing as a map player

Either player can create the game; the game itself always runs on the FPS player's PC.

**Joining** an invite (a link and a code):

1. Open the link. From the FPS player it looks like
   `https://roaringman.github.io/mapbattle-map/?server=wss://something.trycloudflare.com`; from another map player,
   `https://roaringman.github.io/mapbattle-map/?join`.
2. Enter your name and the code, then **Join**.

**Creating** a game: open https://roaringman.github.io/mapbattle-map/, choose **Create a game** and send the invite
(link + code) to the FPS player. They choose **Join game** in the game's lobby and enter the code; the page joins by
itself once the game is up, usually within half a minute. (The page learns the game's address through ntfy.sh; see
"Lobby" in `PROTOCOL.md`.)

The code and the server address change every game.

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
- A game created from the map announces its tunnel address on a public ntfy.sh topic named after a hash of the
  code. Anyone who finds that topic learns the address, not the code, and still needs the code to get in.

## Developing

```
node serve.mjs
```

Then open http://localhost:8080/?server=ws://localhost:8090 while the game is playing in Unity.

`utm.js` must stay in step with `UtmProjection.cs` in the game: both convert between lat/lon and the
ETRS89 / UTM 32N metres the game uses.

Map data © OpenStreetMap contributors, ODbL. Maps by MapLibre GL JS.

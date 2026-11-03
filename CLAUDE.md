# MapBattle map client

The browser side of MapBattle, an asymmetric two-player game set in Jystrup, Denmark. The **map player** spawns
monsters, fights over control zones, and sees the FPS player only when a monster does. The FPS side is a private Unity
project on the host's PC (`../MapBattle`); this repository is public and served by **GitHub Pages** at
https://roaringman.github.io/mapbattle-map/ (from `main`, root).

**The WebSocket is the only link to the game. `PROTOCOL.md` is the contract — read it before touching messages.**
Never read or reference files from the Unity project; if the client needs data, the game must send it.

## Files

| File | What |
|---|---|
| `index.html` | Page, styles, join screen, side panel. No build step. |
| `map.js` | Everything else: join flow, connection, MapLibre layers, drawing each message. ES module. |
| `utm.js` | lat/lon ↔ ETRS89 / UTM 32N. Same formulas as `UtmProjection.cs` in the game: change both together. |
| `PROTOCOL.md` | Message format, shared with the game. |
| `serve.mjs` | Local dev server only (Pages serves the same files). |
| `relay/room.js` | The relay's one game room: lobby, limits (1 host + 4 map players, one game at a time), routing. Platform-free. |
| `relay/worker.js`, `relay/wrangler.toml` | The relay on Cloudflare Workers: one Durable Object holds the room. `npx wrangler deploy` in `relay/`. |
| `relay/dev-server.mjs` | The same room on Node for local testing (port 8787), with a built-in WebSocket server: no packages. |
| `relay/test.mjs`, `relay/mock-host.mjs` | End-to-end relay checks, and a fake game on the host link (reference for the Unity side). |

The relay passes game messages through unread: game rules stay in the game, as for the page. Keep `room.js` free of
platform APIs so the Worker and the Node dev server share it.

Libraries: MapLibre GL JS 4.7.1 and Turf 7.1.0 (route/play-area crossings for the plane minigame) from unpkg, pinned. No npm, no bundler; keep it that way unless there's a real need.

## Running

- Local, through the relay: `node relay/dev-server.mjs`, `node serve.mjs` → http://localhost:8080/ (the page on
  localhost defaults to `ws://localhost:8787`); `node relay/mock-host.mjs ws://localhost:8787 <code>` plays the game.
  `node relay/test.mjs [relay]` checks a relay. http://localhost:8080/?relay=live uses the deployed relay instead.
- Local, direct to today's game: http://localhost:8080/?server=ws://localhost:8090 (the `map-client` launch config).
  Needs the host's game in Play mode; the password is in the game's invite panel (Esc) and Unity console.
- Production: push to `main`; Pages redeploys in about a minute. The relay deploys separately (`npx wrangler deploy`
  in `relay/`); its address is `RELAY_URL` in `map.js`.

## How the client works

1. Join screen, three views: the **lobby** (bare URL: *Create a game*, greyed out while the relay's one game is
   running per `/status`, or *Join with a code*), the **join form** (`?join` invites; `?server=` for a game that
   hosts itself) and **waiting** (after `create`, or a join before the host is there: the relay's `created` /
   `lobby`). One connection throughout: the relay hands it to the game when the host comes. Mid-game `lobby`
   `hostAway` clears the live layers and waits; `ended` goes back to the join form. Name remembered in localStorage;
   the code is never stored. See "Relay" in `PROTOCOL.md`.
2. Send `join`; on `joinResult` ok, wait for `welcome`, which carries the whole map (`area`). The map is created on
   the first `welcome`; later joins only refresh its data.
3. Ignore `state` and events until `welcome` is handled, then redraw from each `state` (10 Hz).
4. Spawning: tap one of the game's `welcome.spawnZones`, pick a type in its popup, send `spawn` with `type` and
   `zone`; the game picks the spot. There is no click-to-place spawning: moving monsters is the main interaction,
   and a map click only ever means "place this order", "select this monster" or "open this spawn zone".
5. Orders (`order` message): the page only asks. Pins, rings and lines come from `state.groupOrder` and
   `monsters[].order`; a dragged pin is the one thing drawn from local input, and only until the game catches up.
   Which types obey comes from `welcome.monsterTypes[].orders`, never from a list in the page. Press, hold still
   ~0.3 s, then drag draws a selection box (a drag that starts straight away still pans); the selection gets one
   order with `target` as a list of ids, and monsters sharing a move-to point share one pin.
6. Supply-plane shoot-down: on `planeEnter` a console opens on the right (bottom sheet on phones). Turf finds where
   the plane's route leaves the play-area square; a popup there shows that point as WGS84 with 3 decimals, and the
   map player clicks those 10 digits on the console's keypad (pointer only, no typing). A correct entry sends
   `planeHit`; the game answers with `rocketLaunched`/`planeShotDown` or `planeHitResult`, and `planeLeave` ends it.
7. If the connection drops after joining, reconnect with the same password. "Wrong password." on a reconnect means the
   host restarted: back to the join screen with that explanation.

## Rules of thumb

- **The game decides, the page draws.** Never compute game rules here (costs, visibility, spawn validity). Ask with
  `spawn` and show the reply. If something needs a rule, the game should send the result.
- **Hidden information stays hidden** because the game never sends it; don't try to infer the FPS player's position
  from other data.
- Data from the game ends up in HTML in a few places: escape it (`escapeHtml`) or use `textContent`.
- Positions are local metres (`x` east, `z` north); yaw is a compass bearing. Convert with `view.toLngLat(x, z)`.
- Keep the OpenStreetMap attribution visible.
- Map players are friends of the host joining over the internet; the page must work at phone width.

## Changing the protocol

Coordinate with the game: the game side changes first, then `PROTOCOL.md`, then this client. Breaking changes bump
`PROTOCOL_VERSION` here and `MapSocketServer.ProtocolVersion` in the game together.

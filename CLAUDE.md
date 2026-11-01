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

Libraries: MapLibre GL JS 4.7.1 from unpkg, pinned. No npm, no bundler; keep it that way unless there's a real need.

## Running

- Local: `node serve.mjs` → http://localhost:8080/?server=ws://localhost:8090 (the `map-client` launch config).
  Needs the host's game in Play mode; the password is in the game's invite panel (Esc) and Unity console.
- Production: push to `main`; Pages redeploys in about a minute.

## How the client works

1. Join screen: server address (from `?server=`), name (remembered in localStorage), password (never stored).
2. Send `join`; on `joinResult` ok, wait for `welcome`, which carries the whole map (`area`). The map is created on
   the first `welcome`; later joins only refresh its data.
3. Ignore `state` and events until `welcome` is handled, then redraw from each `state` (10 Hz).
4. Orders (`order` message): the page only asks. Pins, rings and lines come from `state.groupOrder` and
   `monsters[].order`; a dragged pin is the one thing drawn from local input, and only until the game catches up.
   Which types obey comes from `welcome.monsterTypes[].orders`, never from a list in the page.
5. If the connection drops after joining, reconnect with the same password. "Wrong password." on a reconnect means the
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

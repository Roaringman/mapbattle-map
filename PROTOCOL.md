# MapBattle map protocol

The contract between the game (Unity, `MapSocketServer`, private repository) and this map client. It is the **only**
link between the two: the client reads no game files. Anything one side sends must be described here.

**Protocol version: 2** — `MapSocketServer.ProtocolVersion` in the game, `PROTOCOL_VERSION` in `map.js`.

Version 2: monsters are spawned **into a spawn zone** (`spawn` sends `zone`, the game picks the spot) instead of at
a clicked point, and the single `welcome.spawnZone` became the list `welcome.spawnZones` (two zones). See
[Spawning](#spawning).

## Rules for changing it

- Change the game first, then this file, then the client.
- **Adding** a message type or an optional field is not breaking: no version bump. Both sides ignore unknown message
  types and unknown fields, so add freely.
- **Renaming, removing or changing the meaning** of a field is breaking: bump the version on both sides in the same
  change. On a mismatch the client keeps playing but tells the player to refresh or ask the host to update.

## Transport

- WebSocket, text frames, one JSON object per message, `t` is the message type.
- Host side: the game listens on `ws://localhost:8090`; friends reach it through a Cloudflare quick tunnel as
  `wss://<random>.trycloudflare.com`. The invite link passes it as `?server=wss://…`.
- The game accepts browser origins `localhost` and those in `MapSocketServer.allowedOrigins`
  (`https://roaringman.github.io`). Other origins are refused during the handshake.

## Conventions

- **Positions are local metres from the play-area origin**: `x` = east, `z` = north. The `area` data uses `x`/`y`
  with `y` = north. The client converts to lon/lat with `utm.js` and `originEasting`/`originNorthing`
  (ETRS89 / UTM 32N, EPSG:25832).
- **Yaw and bearings are compass degrees**: 0 = north, 90 = east.
- Numbers have at most 2 decimals. Booleans are JSON `true`/`false`. Absent optional fields mean "nothing to show".
- The game decides everything. The client only asks (`spawn`) and draws what it is sent; it must never assume a
  request succeeded until the reply arrives.

## 1. Joining

The game sends **nothing** until the client's first message is an accepted `join`.

### Client → game: `join` (must be the first message, within 15 s)

```json
{ "t": "join", "password": "ABCD-EFGH-JKLM", "name": "Anna" }
```

| Field | Notes |
|---|---|
| `password` | The host's session password. Case, spaces and dashes are ignored. New every time the host presses Play. |
| `name` | Optional display name for the host. The game keeps letters, digits, spaces, `-` and `_`, max 20 characters. |

### Game → client: `joinResult`

```json
{ "t": "joinResult", "ok": false, "reason": "Wrong password." }
```

On `ok: false` the game closes the connection about a second later. Reasons the client may see:

| `reason` | Meaning |
|---|---|
| `Wrong password.` | Wrong password. If the client had joined before, the host has restarted the game. |
| `Too many wrong passwords. Try again in a minute.` | Lockout after 10 wrong guesses within a minute (for everyone). |
| `The game is full (4 map players).` | Player limit reached. |
| `Send the password first.` | The first message wasn't a `join`. |

Connections that send nothing for 15 s are dropped without a reply.

## 2. After joining: game → client

Order: `joinResult` (ok), then `welcome`, then `state` 10 times a second plus events as they happen. The client
must ignore `state` and events until it has finished handling `welcome`.

### `welcome` (after joining, and again after every `newGame`)

```json
{
  "t": "welcome", "protocolVersion": 1, "map": "PlayArea01",
  "originEasting": 680680.32, "originNorthing": 6156136.38, "sendRate": 10,
  "area": { ... },
  "callRange": 100,
  "monsterTypes": [ { "type": "crawler", "cost": 1, "limit": 8, "orders": true },
                    { "type": "overlord", "cost": 3, "limit": 1, "orders": true } ],
  "zones": [ { "id": 1, "name": "Zone A", "x": 45.39, "z": -0.71, "size": 50 } ],
  "spawnZones": [ { "id": 1, "name": "North-west", "x": -250, "z": 250, "size": 100 },
                  { "id": 2, "name": "South-east", "x": 250, "z": -250, "size": 100 } ],
  "victory": { "target": 100, "secondsHoldingAll": 180, "slowdownPerMissingZone": 2 }
}
```

| Field | Notes |
|---|---|
| `protocolVersion` | See the top of this file. |
| `map` | Name of the play-area data file. |
| `originEasting`, `originNorthing` | UTM 32N of the area origin (also inside `area`). |
| `sendRate` | `state` messages per second. |
| `area` | The whole play area (about 285 KB), described below. |
| `callRange` | Metres a monster's yell carries; used to draw the monster network. Optional. |
| `monsterTypes` | Spawnable types, their energy cost, and `limit`: how many of that type the map player may have alive at once. Optional; no `limit` means no per-type limit. `orders`: monsters of this type obey `order` messages (see [Orders](#orders)); absent or `false` means they don't. Crawlers and overlords take orders; later types may not. |
| `zones` | Control zones: centre (`x`, `z`) and side length `size`, squares aligned to the grid. |
| `spawnZones` | The places monsters are spawned into (two today): `id`, a short `name` for the popup, centre (`x`, `z`) and side length `size`, squares aligned to the grid. The game decides where they are. See [Spawning](#spawning). |
| `game` | Optional. Number of this game in the session, starting at 1; goes up with every [New game](#new-game). |
| `victory` | Optional. The win rule, for explaining it: first side to `target` victory points wins; holding every zone takes `secondsHoldingAll`, and each zone short of all multiplies that by `slowdownPerMissingZone`. See [Victory](#victory). |

#### `area`

```json
{
  "version": 1, "source": "OpenStreetMap via Overpass API. © OpenStreetMap contributors, ODbL 1.0",
  "crs": "EPSG:25832", "originLat": 55.5178, "originLon": 11.8619,
  "originEasting": 680680.32, "originNorthing": 6156136.38, "sizeMeters": 600, "createdUtc": "…",
  "buildings": [
    {
      "id": "way/123", "type": "house", "name": "", "height": 6, "heightSource": "default",
      "levels": -1, "roofShape": "",
      "outer": { "points": [ { "x": 1.5, "y": -3.2 }, … ] },
      "holes": [ { "points": [ … ] } ]
    }
  ]
}
```

- The play area is a square of `sizeMeters`, centred on the origin.
- `outer` is counter-clockwise, `holes` clockwise, rings not closed (first point not repeated).
- `heightSource` is `osm:height`, `osm:levels` or `default` (a guess by building type). `levels` is -1 when unknown.
- `source` is the data attribution; the client must show it.

### `state` (10 times a second)

```json
{
  "t": "state", "time": 123.45,
  "player": { "x": 1.2, "z": 3.4, "y": 0.05, "yaw": 90 },
  "lastSeen": { "x": 1.2, "z": 3.4, "yaw": 90, "ago": 12.5 },
  "deaths": 1, "energy": 2.4, "energyRate": 0.5, "maxEnergy": 5,
  "groupOrder": { "kind": "moveTo", "x": -120.5, "z": 80.25 },
  "victory": { "player": 12.5, "monsters": 40.25, "playerRate": 0.14, "monstersRate": 0.28, "target": 100 },
  "monsters": [ … ],
  "zones": [ { "id": 1, "progress": 0.4, "held": false, "playerProgress": 0, "playerHeld": false,
               "status": "capturing", "monsters": 2 } ]
}
```

| Field | Notes |
|---|---|
| `time` | Game time in seconds. |
| `player` | The FPS player **only while a monster sees them** (position as the monster saw it), otherwise `null`. |
| `lastSeen` | Where the player was last seen, present only while hidden and after at least one sighting. `ago` in seconds. |
| `deaths` | Times the monsters have killed the FPS player this session. |
| `energy`, `energyRate`, `maxEnergy` | Spawn energy, current gain per second (base + held zones), maximum. |
| `groupOrder` | Optional. The order given to all monsters (`target: "all"`): `{ "kind": "moveTo", "x", "z" }` with the point the game accepted (after snapping), or `{ "kind": "stay" }`. Absent or `null` when there is none. See [Orders](#orders). |
| `victory` | Optional. Victory points so far: `player` (FPS player) and `monsters` (the map side), each 0 → `target`; `playerRate`/`monstersRate` are points per second right now (0 while holding no zone, and for both once the game is over), so the client can animate between messages or show "wins in m:ss". `winner` (`player`, `monsters` or `draw`) appears once the game is over. See [Victory](#victory). |
| `monsters` | All of the map player's monsters, see below. |
| `zones[].progress` | 0 = neutral, 1 = fully monster-held. |
| `zones[].held` | Held by the monsters (stays true until drained back to 0). |
| `zones[].playerProgress` | Optional. 0 = neutral, 1 = fully held by the FPS player. At most one of `progress` and `playerProgress` is above 0. |
| `zones[].playerHeld` | Optional. Held by the FPS player (stays true until monsters drain it back to 0). |
| `zones[].status` | `idle`, `capturing` (monsters inside), `reclaiming` (FPS player alone inside), `contested` (both inside). |
| `zones[].monsters` | Zone-capturing monsters inside. |

A zone is one tug of war: think of it as a single value from −1 (player-held) to +1 (monster-held), sent as
`progress` = max(0, value) and `playerProgress` = max(0, −value). Whoever is alone inside first drains the other
side's hold, then builds their own. The player alone takes 10 s per half (monster-held → neutral → player-held).
Each zone the player holds earns them supply points for ammo drops (see `supplyPlane`); the points themselves are
never sent.

`reclaiming` and `contested` reveal that the FPS player is in that zone. `playerHeld` reveals that they have been
there. That is deliberate.

#### `monsters[]`

```json
{ "id": 3, "type": "crawler", "x": 10, "z": -40, "yaw": 180, "range": 30, "fov": 120, "sees": false,
  "heard": { "bearing": 12.5, "fade": 0.8 }, "directing": [4, 7],
  "order": { "kind": "moveTo", "x": -120.5, "z": 80.25, "from": "group" } }
```

| Field | Notes |
|---|---|
| `id` | Unique for the session. |
| `type` | `crawler` or `overlord` (see `welcome.monsterTypes`). |
| `range`, `fov` | Sight distance (m) and view cone width (degrees, 360 = all round). |
| `sees` | This monster can see the FPS player right now. |
| `heard` | Optional. A recent gunshot: `bearing` from the monster towards it, `fade` 1 → 0 over a few seconds. Never the shooter's position. |
| `directing` | Optional, overlords only. Ids of crawlers it is currently sending towards the player. |
| `order` | Optional. The order this monster is following: `kind` `moveTo` or `stay`; `x`, `z` the point it is going to or holding (for a group `stay`, the spot this monster holds); `from` `individual` (given to this monster) or `group` (it is following `groupOrder`). Absent when the monster acts on its own. See [Orders](#orders). |

### Events

| Message | Fields | Meaning |
|---|---|---|
| `spawnResult` | `ok`, `type`, `zone`, `x`, `z`, `reason` | Reply to `spawn`. On success (`x`, `z`) is where the game put the monster; `reason` is a human-readable refusal, empty on success. |
| `killed` | `id`, `type`, `x`, `z` | One of the map player's monsters died there. |
| `playerKilled` | `by`, `byType`, `x`, `z`, `respawnIn`, `deaths` | The FPS player died. `by`/`byType` is the monster that dealt the last hit and (`x`, `z`) where it saw them fall; all four are absent if no monster gets the credit. The player is out of the game (nothing can see them) for `respawnIn` seconds, then respawns at the start point. `deaths` is the new total. |
| `yell` | `id`, `from`, `wave`, `x`, `z`, `range` | Monster `id` yelled at (`x`, `z`), heard within `range` m. `from` is the monster it was answering, or -1 if it started the alarm. Yells in one alarm share a `wave`. |
| `supplyPlane` | `x1`, `z1`, `x2`, `z2`, `show`, `incoming` | A supply plane is flying (`incoming: true`, sent as it appears) or flew (older games, sent after it left) straight from (`x1`, `z1`) to (`x2`, `z2`). See below. |
| `gameOver` | `winner`, `player`, `monsters` | A side reached the victory target. `winner` is `player` (the FPS player), `monsters` (the map side) or `draw`; `player`/`monsters` are the final scores. Sent once; see [Victory](#victory). |
| `newGame` | `game` | The host started a new game in the same session. Clear the old match; a fresh `welcome` follows. See [New game](#new-game). |
| `orderResult` | `ok`, `target`, `kind`, `reason` | Sent **only when an `order` is refused** (`ok: false`); accepted orders show up in the next `state`. `target` and `kind` echo the order. See [Orders](#orders). |
| `pong` | | Reply to `ping`. |

#### `supplyPlane`

```json
{ "t": "supplyPlane", "x1": 290.43, "z1": 360, "x2": -291.87, "z2": -360, "show": 45, "incoming": true }
```

The FPS player spent supply points on an ammo drop. A plane flies a straight line across the whole map, from beyond
one edge to beyond the other (the endpoints are outside the play area; clip or let MapLibre draw past the edge),
and drops a crate on a parachute **somewhere below that line**.

**When it is sent (game side):** the moment the plane is spawned, before it reaches the play area, with
`incoming: true`. The route is fixed when the plane spawns, so nothing else needs to wait. `show` counts from when
the message is sent, so it should cover the flight plus the time the trace should stay up afterwards (e.g. flight
time + 30 s). Older games sent the message only after the plane had left and without `incoming`; the client handles
both.

- **Draw it as a trace of the route** as soon as it arrives: a line (e.g. dashed) that fades out over `show`
  seconds, then remove it. Several can be on screen at once.
- **The plane's position along the line is not sent**, nor when the crate drops: either would narrow down the drop
  point.
- **The crate's position is never sent**, not in this message and not later. The client must not suggest an exact
  spot; the line is all the map player knows. The drop is always within about 45 m of where the FPS player called
  it, which is the hint: send monsters to sweep along the line.
- The FPS player picks the crate up by walking to it; nothing is sent when that happens.

#### Victory

```json
{ "t": "gameOver", "winner": "monsters", "player": 31.4, "monsters": 100 }
```

Both sides race to `target` (100) victory points. A side earns points only for the control zones it **holds**
(`zones[].held` for the monsters, `zones[].playerHeld` for the FPS player); capturing in progress earns nothing.
The rate depends on how many zones that side holds, out of N zones in total:

    rate = target / (secondsHoldingAll × slowdownPerMissingZone^(N − held))

With the current 3 zones: all 3 held wins in **3 min**, 2 in **6 min**, 1 in **12 min**, none earns nothing.
Points are kept when a zone is lost, so a lead built early still counts. The rates in `state.victory` already follow
this formula; the client should show them rather than compute its own.

When a side reaches the target the game is over: the world freezes, `gameOver` is sent once, and every later `state`
carries `victory.winner`, so a page that joins or reloads afterwards still knows. A tie in the same frame is a
`draw`. After the game is over, `spawn` and `order` are refused with `The game is over`.

#### New game

```json
{ "t": "newGame", "game": 2 }
```

The host can start a new game **in the same session** at any time (from the win screen, or mid-game from the host
panel). The password and tunnel address stay the same and connected pages stay connected; nobody needs a new
invite. The game sends `newGame`, then a complete new `welcome`, then `state` as usual. On `newGame` the client
must drop everything from the previous game: monsters, kill and death markers, yells, plane traces, last-seen
marker, orders, the end screen and any pending spawn or order. It then handles the `welcome` exactly as after
joining (it may skip re-drawing the map if `area` hasn't changed).

What the new game starts with: no monsters, energy back at its start value, every zone neutral, both victory
scores 0, `deaths` 0, no group order, and the FPS player alive at the start point. Monster `id`s keep counting up
across games, so an id is never reused within a session. `welcome.game` (and `newGame.game`) is the game number in
this session, starting at 1; a page that reloads can compare it to tell a new game from the one it was showing.

Pressing Play again in the editor is still a whole new session: new password, new tunnel address, everyone rejoins.

## 3. After joining: client → game

| Message | Fields | Meaning |
|---|---|---|
| `spawn` | `type`, `zone` | Ask for a monster of `type` in spawn zone `zone` (an id from `welcome.spawnZones`). The game picks the spot, checks every rule and replies with `spawnResult`. See [Spawning](#spawning). |
| `order` | `target`, `kind`, `x`, `z` | Give monsters an order. See [Orders](#orders). The game replies only on refusal (`orderResult`). |
| `ping` | | Connection check; the game replies `pong`. |

Messages over 64 KB close the connection.

### Orders

The map player can tell monsters where to go and when to hold still. Only monsters whose type has `orders: true` in
`welcome.monsterTypes` obey (crawlers and overlords today). Orders cost no energy.

```json
{ "t": "order", "target": "all", "kind": "moveTo", "x": -120.5, "z": 80.25 }
{ "t": "order", "target": "all", "kind": "stay" }
{ "t": "order", "target": "all", "kind": "release" }
{ "t": "order", "target": 3, "kind": "moveTo", "x": 12, "z": -40 }
{ "t": "order", "target": 3, "kind": "stay" }
{ "t": "order", "target": 3, "kind": "release" }
```

| Field | Notes |
|---|---|
| `target` | `"all"` for a **group order** (every obeying monster without an individual order), or a monster `id` for an **individual order**. |
| `kind` | `moveTo` (needs `x`, `z`), `stay`, or `release` (cancel). |
| `x`, `z` | Local metres, `moveTo` only. |

**Rules the game enforces** (the client only asks and draws `state`):

1. **Who obeys.** Monsters of types with `orders: true`. A group order skips the others; an individual order to one of
   them is refused (`That monster doesn't take orders`).
2. **Priority, per monster:** its individual order, then an overlord directing it (`directing`), then the group order,
   then its own behaviour. A group order never replaces an individual one, so the map player can keep a sentry while
   moving the rest.
3. **`moveTo`.** Crawlers walk (navmesh), overlords fly to the point, then stay near it until the order changes. Group
   members gather around the point, spread a few metres apart rather than stacking. The game may move the point to
   the nearest reachable spot; `groupOrder` / `monsters[].order` carry the point actually used. A new `moveTo` with
   the same target simply replaces the point: the client sends one every ~200 ms while the map player **drags** the
   point, and one on release.
4. **`stay`.** The monster holds the spot where it is when the order arrives (each group member its own spot), still
   turning and looking around as usual.
5. **`release`.** Individual: the monster goes back to the group order if there is one, otherwise its own behaviour.
   Group (`target: "all"`): clears the group order **and every individual order**: everyone acts on their own.
6. **Senses and fighting don't change.** A monster under orders still sees, hears, yells and reports `sees`. If it
   sees the player it attacks as it would anyway; once it loses them it returns to its order. Zone capture works for
   monsters standing in a zone, ordered or not.
7. **New monsters** of an obeying type join the current group order when they spawn.
8. **Several map players** share the monsters: any map player's order applies, the last one wins, and every page
   shows the result through `state`.
9. **Limits.** Accept at least 10 orders a second per connection; refuse beyond that with `Too many orders`.
   Orders end when the monster dies.

Order refusal reasons: `No such monster`, `That monster doesn't take orders`, `Outside the play area`,
`No reachable ground near that point`, `Too many orders`, `Unknown order '…'`, `The game is over`. The client shows
them as-is.

### Spawning

```json
{ "t": "spawn", "type": "crawler", "zone": 2 }
{ "t": "spawnResult", "ok": true, "type": "crawler", "zone": 2, "x": 233.5, "z": -261.25, "reason": "" }
```

The map player doesn't place monsters: they pick a spawn zone, then a monster type, and the game puts the monster
at a **random spot inside that zone**. This keeps the map player's attention on moving monsters (orders) rather than
on placing them.

**Rules the game enforces:**

1. `zone` must be an id from `welcome.spawnZones`; the type must be spawnable; the usual energy and per-type limits
   apply.
2. The game picks a random point inside the zone square that is walkable ground, not inside a building, not within
   the minimum distance of the FPS player and not visible to them. It tries several random points; if none
   qualifies it refuses with `No free spot in that spawn zone`. Overlords (flying) only need a point inside the zone.
3. Each `spawn` is one monster; several in a row each get their own random spot.
4. The new monster joins the current group order, if any (see [Orders](#orders)).

Spawn refusal reasons: `Unknown monster type '…'`, `No such spawn zone`, `No free spot in that spawn zone`,
`Crawler limit reached (8)`, `Overlord limit reached (1)`, `Monster limit reached (12)`, `Not enough energy`,
`The map is still loading`, `The game is over`. The client shows them as-is; it should not depend on the exact
wording.

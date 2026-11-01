# MapBattle map protocol

The contract between the game (Unity, `MapSocketServer`, private repository) and this map client. It is the **only**
link between the two: the client reads no game files. Anything one side sends must be described here.

**Protocol version: 1** — `MapSocketServer.ProtocolVersion` in the game, `PROTOCOL_VERSION` in `map.js`.

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

### `welcome` (once per connection)

```json
{
  "t": "welcome", "protocolVersion": 1, "map": "PlayArea01",
  "originEasting": 680680.32, "originNorthing": 6156136.38, "sendRate": 10,
  "area": { ... },
  "callRange": 100,
  "monsterTypes": [ { "type": "crawler", "cost": 1, "limit": 8 }, { "type": "overlord", "cost": 3, "limit": 1 } ],
  "zones": [ { "id": 1, "name": "Zone A", "x": 45.39, "z": -0.71, "size": 50 } ],
  "spawnZone": { "x": -250, "z": 250, "size": 100 }
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
| `monsterTypes` | Spawnable types, their energy cost, and `limit`: how many of that type the map player may have alive at once. Optional; no `limit` means no per-type limit. |
| `zones` | Control zones: centre (`x`, `z`) and side length `size`, squares aligned to the grid. |
| `spawnZone` | The only place monsters may be spawned: centre (`x`, `z`) and side length `size`, a square aligned to the grid in the north-west corner of the play area. Optional; absent means anywhere in the play area. |

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
  "monsters": [ … ],
  "zones": [ { "id": 1, "progress": 0.4, "held": false, "status": "capturing", "monsters": 2 } ]
}
```

| Field | Notes |
|---|---|
| `time` | Game time in seconds. |
| `player` | The FPS player **only while a monster sees them** (position as the monster saw it), otherwise `null`. |
| `lastSeen` | Where the player was last seen, present only while hidden and after at least one sighting. `ago` in seconds. |
| `deaths` | Times the monsters have killed the FPS player this session. |
| `energy`, `energyRate`, `maxEnergy` | Spawn energy, current gain per second (base + held zones), maximum. |
| `monsters` | All of the map player's monsters, see below. |
| `zones[].progress` | 0 = neutral, 1 = fully monster-held. |
| `zones[].held` | Held by the monsters (stays true until drained back to 0). |
| `zones[].status` | `idle`, `capturing` (monsters inside), `reclaiming` (FPS player alone inside), `contested` (both inside). |
| `zones[].monsters` | Zone-capturing monsters inside. |

`reclaiming` and `contested` reveal that the FPS player is in that zone. That is deliberate.

#### `monsters[]`

```json
{ "id": 3, "type": "crawler", "x": 10, "z": -40, "yaw": 180, "range": 30, "fov": 120, "sees": false,
  "heard": { "bearing": 12.5, "fade": 0.8 }, "directing": [4, 7] }
```

| Field | Notes |
|---|---|
| `id` | Unique for the session. |
| `type` | `crawler` or `overlord` (see `welcome.monsterTypes`). |
| `range`, `fov` | Sight distance (m) and view cone width (degrees, 360 = all round). |
| `sees` | This monster can see the FPS player right now. |
| `heard` | Optional. A recent gunshot: `bearing` from the monster towards it, `fade` 1 → 0 over a few seconds. Never the shooter's position. |
| `directing` | Optional, overlords only. Ids of crawlers it is currently sending towards the player. |

### Events

| Message | Fields | Meaning |
|---|---|---|
| `spawnResult` | `ok`, `type`, `x`, `z`, `reason` | Reply to `spawn`. `reason` is a human-readable refusal, empty on success. |
| `killed` | `id`, `type`, `x`, `z` | One of the map player's monsters died there. |
| `playerKilled` | `by`, `byType`, `x`, `z`, `respawnIn`, `deaths` | The FPS player died. `by`/`byType` is the monster that dealt the last hit and (`x`, `z`) where it saw them fall; all four are absent if no monster gets the credit. The player is out of the game (nothing can see them) for `respawnIn` seconds, then respawns at the start point. `deaths` is the new total. |
| `yell` | `id`, `from`, `wave`, `x`, `z`, `range` | Monster `id` yelled at (`x`, `z`), heard within `range` m. `from` is the monster it was answering, or -1 if it started the alarm. Yells in one alarm share a `wave`. |
| `pong` | | Reply to `ping`. |

## 3. After joining: client → game

| Message | Fields | Meaning |
|---|---|---|
| `spawn` | `type`, `x`, `z` | Ask to place a monster. The game checks every rule and replies with `spawnResult`. |
| `ping` | | Connection check; the game replies `pong`. |

Messages over 64 KB close the connection.

## Spawn refusal reasons (current)

`Unknown monster type '…'`, `The map is still loading`, `Outside the play area`, `Outside the spawn zone`,
`Crawler limit reached (8)`, `Overlord limit reached (1)`, `Monster limit reached (12)`,
`Not enough energy`, `Inside a building`, `Not walkable ground`, `Too close to the player`,
`The player can see that spot`. The client shows them as-is; it should not depend on the exact wording.

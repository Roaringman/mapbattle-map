import { fromUtm32, toUtm32 } from './utm.js';

// The game's WebSocket address comes from the invite link (?server=wss://...) or the join form.
const DEFAULT_SERVER = new URLSearchParams(location.search).get('server') ?? 'ws://localhost:8090';
// The message format this page understands; see PROTOCOL.md. Must match the game's MapSocketServer.ProtocolVersion.
const PROTOCOL_VERSION = 1;
const HEADING_LENGTH_M = 14;
const HEARD_ARROW_LENGTH_M = 35;
const HEARD_ARROW_HEAD_M = 8;
const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';

// Colour buildings by rough category so the map player can read the village at a glance.
const CATEGORY = {
  house: ['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'bungalow', 'apartments', 'farm'],
  outbuilding: ['shed', 'garage', 'garages', 'carport', 'hut', 'greenhouse', 'roof'],
  farm: ['barn', 'farm_auxiliary', 'agricultural', 'stable'],
};
const COLOURS = { house: '#c9a27a', outbuilding: '#7d8a96', farm: '#a3875b', other: '#b8b0a4' };

const EMPTY = { type: 'FeatureCollection', features: [] };
const OVERLORD_COLOR = '#4fd1c5';
const ZONE_NEUTRAL = '#d9d6cf';
const ZONE_MONSTER = '#a77bff';
const ZONE_PLAYER = '#ff5a4f';
const SPAWN_ZONE_COLOR = '#6cc070';
const SUPPLY_PLANE_COLOR = '#7fb8ff';
const LIVE_SOURCES = ['player', 'last-seen', 'monsters', 'cones', 'heard', 'kills', 'zones', 'spawn-zone', 'network',
  'yells', 'commands', 'supply-planes'];

function categoryOf(type) {
  for (const [name, types] of Object.entries(CATEGORY)) if (types.includes(type)) return name;
  return 'other';
}

/** Game / map-data local metres (x = east, y or z = north) -> [lon, lat]. */
function makeLocalToLngLat(area) {
  return (x, y) => fromUtm32(area.originEasting + x, area.originNorthing + y);
}

/** [lon, lat] -> game local metres {x, z}. */
function makeLngLatToLocal(area) {
  return (lng, lat) => {
    const [e, n] = toUtm32(lat, lng);
    return { x: e - area.originEasting, z: n - area.originNorthing };
  };
}

function ringToLngLat(points, toLngLat) {
  const ring = points.map((p) => toLngLat(p.x, p.y));
  ring.push(ring[0]); // GeoJSON rings are explicitly closed
  return ring;
}

function buildingsGeoJson(area, toLngLat) {
  return {
    type: 'FeatureCollection',
    features: area.buildings.map((b, i) => ({
      type: 'Feature',
      id: i,
      properties: {
        id: b.id,
        type: b.type,
        name: b.name,
        height: b.height,
        heightSource: b.heightSource,
        category: categoryOf(b.type),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [b.outer, ...b.holes].map((r) => ringToLngLat(r.points, toLngLat)),
      },
    })),
  };
}

function areaGeoJson(area, toLngLat) {
  const h = area.sizeMeters / 2;
  const square = [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ringToLngLat(square, toLngLat)] },
  };
}

function boundsOf(feature) {
  const corners = feature.geometry.coordinates[0];
  const lngs = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

// ---------------------------------------------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------------------------------------------

/** Accepts what people paste: wss://..., https://..., or a bare host. */
function normaliseServerUrl(text) {
  let url = text.trim();
  if (!url) return '';
  if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
  else if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
  else if (!/^wss?:\/\//.test(url)) url = (url.startsWith('localhost') ? 'ws://' : 'wss://') + url;
  return url.replace(/\/+$/, '');
}

function loadName() {
  try { return localStorage.getItem('mapbattle.name') ?? ''; } catch { return ''; }
}

function saveName(name) {
  try { localStorage.setItem('mapbattle.name', name); } catch { /* storage unavailable: not important */ }
}

function main() {
  const form = document.getElementById('join-form');
  const serverInput = document.getElementById('join-server');
  const nameInput = document.getElementById('join-name');
  const passwordInput = document.getElementById('join-password');
  const error = document.getElementById('join-error');
  const button = document.getElementById('join-button');

  serverInput.value = DEFAULT_SERVER;
  nameInput.value = loadName();
  (nameInput.value ? passwordInput : nameInput).focus();

  let game = null;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const server = normaliseServerUrl(serverInput.value);
    if (!server) { error.textContent = 'Enter the server address from the invite.'; return; }
    if (!passwordInput.value.trim()) { error.textContent = 'Enter the password from the host.'; return; }
    saveName(nameInput.value.trim());
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Joining…';

    game?.close();
    game = connectToGame({
      server,
      password: passwordInput.value,
      name: nameInput.value.trim(),
      onJoinFailed(reason) {
        button.disabled = false;
        button.textContent = 'Join';
        error.textContent = reason;
        showJoinScreen(true);
        passwordInput.select();
      },
      onJoined() {
        button.disabled = false;
        button.textContent = 'Join';
        showJoinScreen(false);
      },
    });
  });
}

function showJoinScreen(visible) {
  document.getElementById('join').hidden = !visible;
}

// ---------------------------------------------------------------------------------------------------------------
// The map, created from the area the game sends after a successful join
// ---------------------------------------------------------------------------------------------------------------

let view = null; // { map, area, toLngLat, toLocal, bounds, ready }
let spawnType = null; // the monster type placed by the next map click, or null when not spawning
let sendToGame = () => {};

/** Creates the map the first time; on later joins only refreshes the buildings. Resolves when layers exist. */
function showArea(area) {
  const toLngLat = makeLocalToLngLat(area);
  const boundary = areaGeoJson(area, toLngLat);

  if (view) {
    Object.assign(view, { area, toLngLat, toLocal: makeLngLatToLocal(area), bounds: boundsOf(boundary) });
    view.map.getSource('area').setData(boundary);
    view.map.getSource('buildings').setData(buildingsGeoJson(area, toLngLat));
    updateSummary(area);
    return view.ready;
  }

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: OSM_CREDIT,
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#151a20' } },
        {
          id: 'osm', type: 'raster', source: 'osm',
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.7 },
        },
      ],
    },
    center: [area.originLon, area.originLat],
    zoom: 16,
    minZoom: 13,
    maxZoom: 20,
    attributionControl: { compact: false },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  view = { map, area, toLngLat, toLocal: makeLngLatToLocal(area), bounds: boundsOf(boundary) };
  view.ready = new Promise((resolve) => map.on('load', () => {
    map.addSource('area', { type: 'geojson', data: boundary });
    map.addSource('buildings', {
      type: 'geojson',
      data: buildingsGeoJson(area, toLngLat),
      attribution: `Buildings ${OSM_CREDIT} (ODbL)`,
    });

    map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#26313a', 'fill-opacity': 0.6 } });
    map.addLayer({
      id: 'area-outline', type: 'line', source: 'area',
      paint: { 'line-color': '#e0b84f', 'line-width': 2, 'line-dasharray': [3, 2] },
    });

    const colourByCategory = ['match', ['get', 'category'],
      'house', COLOURS.house, 'outbuilding', COLOURS.outbuilding, 'farm', COLOURS.farm, COLOURS.other];

    map.addLayer({
      id: 'buildings-fill', type: 'fill', source: 'buildings',
      paint: {
        'fill-color': colourByCategory,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.85],
      },
    });
    map.addLayer({
      id: 'buildings-outline', type: 'line', source: 'buildings',
      paint: { 'line-color': '#0d1014', 'line-width': 1 },
    });
    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings',
      layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': colourByCategory, 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.9 },
    });

    addZoneLayers(map);
    addNetworkLayers(map);
    addSupplyPlaneLayers(map);
    addMonsterLayers(map);
    addPlayerLayers(map);
    wireHover(map);
    wireControls(map);
    wireSpawning(map);
    frameArea(map, view.bounds);
    resolve();
  }));
  updateSummary(area);
  return view.ready;
}

function updateSummary(area) {
  document.getElementById('summary').textContent =
    `${area.buildings.length} buildings · ${area.sizeMeters} × ${area.sizeMeters} m`;
}

function clearLiveLayers() {
  recentKills.length = 0;
  activeYells.length = 0;
  supplyPlanes.length = 0;
  playerRespawnAt = 0;
  if (!view?.map.getSource('player')) return;
  for (const source of LIVE_SOURCES) view.map.getSource(source).setData(EMPTY);
  document.getElementById('zones').innerHTML = '';
  updateMonsterCounts([]);
}

function wireSpawning(map) {
  const spawnButtons = document.querySelectorAll('.spawn-btn');
  const setSpawnType = (type) => {
    const button = [...spawnButtons].find((b) => b.dataset.type === type);
    spawnType = button && !button.disabled ? type : null;
    for (const b of spawnButtons) b.classList.toggle('active', b.dataset.type === spawnType);
    map.getContainer().classList.toggle('spawning', spawnType !== null); // CSS crosshair that hover can't override
    map.setPaintProperty('spawn-zone-fill', 'fill-opacity', spawnType ? 0.3 : 0.1); // show where clicks can land
  };
  for (const b of spawnButtons) {
    b.addEventListener('click', () => setSpawnType(spawnType === b.dataset.type ? null : b.dataset.type));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSpawnType(null); });

  document.getElementById('recenter').addEventListener('click', () => frameArea(map, view.bounds));

  const coordsBox = document.getElementById('coords');
  map.on('click', (e) => {
    const { lng, lat } = e.lngLat;
    const local = view.toLocal(lng, lat);
    const half = view.area.sizeMeters / 2;
    const inside = Math.abs(local.x) <= half && Math.abs(local.z) <= half;
    coordsBox.innerHTML =
      `<b>Game</b> x ${local.x.toFixed(1)}, z ${local.z.toFixed(1)}${inside ? '' : ' <span class="warn">(outside play area)</span>'}<br>` +
      `<b>GPS</b> ${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    // The game decides whether the spawn is allowed; the page only asks.
    if (spawnType) sendToGame({ t: 'spawn', type: spawnType, x: local.x, z: local.z });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------------------------

function addZoneLayers(map) {
  map.addSource('zones', { type: 'geojson', data: EMPTY });
  // Inserted below the buildings so footprints stay readable inside a zone.
  map.addLayer({
    id: 'zone-fill', type: 'fill', source: 'zones',
    paint: {
      'fill-color': ['case', ['get', 'held'], ZONE_MONSTER, ['get', 'playerHeld'], ZONE_PLAYER,
        ['>', ['get', 'playerProgress'], 0],
        ['interpolate', ['linear'], ['get', 'playerProgress'], 0, ZONE_NEUTRAL, 1, ZONE_PLAYER],
        ['interpolate', ['linear'], ['get', 'progress'], 0, ZONE_NEUTRAL, 1, ZONE_MONSTER]],
      'fill-opacity': ['case', ['any', ['get', 'held'], ['get', 'playerHeld']], 0.35,
        ['+', 0.1, ['*', 0.2, ['max', ['get', 'progress'], ['get', 'playerProgress']]]]],
    },
  }, 'buildings-fill');
  map.addLayer({
    id: 'zone-outline', type: 'line', source: 'zones',
    paint: {
      'line-color': ['match', ['get', 'status'],
        'contested', '#ffb347', 'reclaiming', '#ff5a4f', 'capturing', ZONE_MONSTER,
        ['case', ['get', 'held'], ZONE_MONSTER, ['get', 'playerHeld'], ZONE_PLAYER, ZONE_NEUTRAL]],
      'line-width': 2.5,
    },
  }, 'buildings-fill');

  // Where monsters may be spawned (welcome.spawnZone). Fill strengthens while a spawn button is active.
  map.addSource('spawn-zone', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'spawn-zone-fill', type: 'fill', source: 'spawn-zone',
    paint: { 'fill-color': SPAWN_ZONE_COLOR, 'fill-opacity': 0.1 },
  }, 'buildings-fill');
  map.addLayer({
    id: 'spawn-zone-outline', type: 'line', source: 'spawn-zone',
    paint: { 'line-color': SPAWN_ZONE_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
  }, 'buildings-fill');
}

/** A grid-aligned square given by its centre and side length, as a closed lon/lat ring. */
function squareRing({ x, z, size }, toLngLat) {
  const h = size / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([dx, dz]) => toLngLat(x + dx, z + dz));
}

/** Zone squares (from the welcome message) with their live state (from each state message). */
function zoneFeatures(defs, states, toLngLat) {
  const byId = new Map((states ?? []).map((s) => [s.id, s]));
  return {
    type: 'FeatureCollection',
    features: defs.map((z) => {
      const s = zoneState(byId, z.id);
      return {
        type: 'Feature',
        properties: {
          id: z.id, name: z.name, progress: s.progress, held: s.held, status: s.status, monsters: s.monsters,
          playerProgress: s.playerProgress, playerHeld: s.playerHeld,
        },
        geometry: { type: 'Polygon', coordinates: [squareRing(z, toLngLat)] },
      };
    }),
  };
}

function spawnZoneFeatures(zone, toLngLat) {
  if (!zone) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [squareRing(zone, toLngLat)] } }],
  };
}

const ZONE_STATUS_TEXT = {
  capturing: 'capturing',
  reclaiming: 'player is capturing it',
  contested: 'contested',
};

/** A zone's live state with the optional player-side fields filled in. */
function zoneState(byId, id) {
  const s = byId.get(id) ?? { progress: 0, held: false, status: 'idle' };
  return { ...s, playerProgress: s.playerProgress ?? 0, playerHeld: s.playerHeld === true, monsters: s.monsters ?? 0 };
}

/** Idle zones are described by who holds them. */
function zoneIdleText(s, monsterHeldText) {
  return s.held ? monsterHeldText : s.playerHeld ? 'held by the player' : 'neutral';
}

/** Popup text for a control zone: what state it is in now, and what zones are for. */
function zonePopupHtml(p) {
  const status = ZONE_STATUS_TEXT[p.status] ?? zoneIdleText(p, 'held by your monsters');
  const share = p.playerProgress > 0
    ? `${Math.round(p.playerProgress * 100)}% the player's`
    : `${Math.round(p.progress * 100)}% yours`;
  const inside = p.monsters ? ` · ${p.monsters} monster${p.monsters === 1 ? '' : 's'} inside` : '';
  return `<b>${escapeHtml(p.name)}</b> <span class="dim">control zone</span><br>` +
    `${status[0].toUpperCase()}${status.slice(1)} · ${share}${inside}<br>` +
    '<span class="dim">Keep monsters inside to capture it; held zones raise your energy gain. ' +
    'The player captures it by standing in it alone, and each zone they hold earns them supply drops.</span>';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function updateZonePanel(defs, states) {
  const list = document.getElementById('zones');
  const byId = new Map((states ?? []).map((s) => [s.id, s]));
  list.innerHTML = defs.map((z) => {
    const s = zoneState(byId, z.id);
    const label = ZONE_STATUS_TEXT[s.status] ?? zoneIdleText(s, 'held');
    // One bar for the tug of war: purple for the monsters' share, red for the player's.
    const bar = s.playerProgress > 0
      ? `<span class="player" style="width:${Math.round(s.playerProgress * 100)}%"></span>`
      : `<span style="width:${Math.round(s.progress * 100)}%"></span>`;
    return `<div class="zone" data-status="${escapeHtml(s.status)}" data-held="${s.held}" data-player-held="${s.playerHeld}">` +
      `<span class="zone-name">${escapeHtml(z.name)}</span>` +
      `<span class="zone-bar">${bar}</span>` +
      `<span class="zone-label">${label}</span></div>`;
  }).join('');
}

function addMonsterLayers(map) {
  map.addSource('cones', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'cone-fill', type: 'fill', source: 'cones',
    paint: {
      'fill-color': ['case', ['get', 'sees'], '#ffb347', ['==', ['get', 'type'], 'overlord'], OVERLORD_COLOR, '#a77bff'],
      'fill-opacity': ['case', ['get', 'sees'], 0.22, 0.08],
    },
  });
  map.addLayer({
    id: 'cone-edge', type: 'line', source: 'cones',
    paint: { 'line-color': ['case', ['get', 'sees'], '#ffb347', '#a77bff'], 'line-opacity': 0.35, 'line-width': 1 },
  });

  map.addSource('heard', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'heard-arrow', type: 'line', source: 'heard',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffd166', 'line-width': 3, 'line-opacity': ['get', 'fade'] },
  });

  // Where monsters died (red ring) and where the player fell (solid red with a white ring).
  const isPlayer = ['==', ['get', 'kind'], 'player'];
  map.addSource('kills', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'kill-marker', type: 'circle', source: 'kills',
    paint: {
      'circle-radius': ['case', isPlayer, 10, 7], 'circle-color': '#ff5a4f',
      'circle-opacity': ['*', ['get', 'fade'], ['case', isPlayer, 0.7, 0.15]],
      'circle-stroke-color': ['case', isPlayer, '#ffffff', '#ff5a4f'], 'circle-stroke-width': ['case', isPlayer, 2.5, 2],
      'circle-stroke-opacity': ['get', 'fade'],
    },
  });

  // Overlord orders: a line to each crawler it is sending towards the player.
  map.addSource('commands', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'command-link', type: 'line', source: 'commands',
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': OVERLORD_COLOR, 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [1, 1.5] },
  });

  const isOverlord = ['==', ['get', 'type'], 'overlord'];
  map.addSource('monsters', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'monster-alert', type: 'circle', source: 'monsters', filter: ['==', ['get', 'sees'], true],
    paint: { 'circle-radius': ['case', isOverlord, 18, 13], 'circle-color': '#ffb347', 'circle-opacity': 0.35 },
  });
  map.addLayer({
    id: 'monster-dot', type: 'circle', source: 'monsters',
    paint: {
      'circle-radius': ['case', isOverlord, 8, 5],
      'circle-color': ['case', isOverlord, OVERLORD_COLOR, '#a77bff'],
      'circle-stroke-color': ['case', isOverlord, '#e8fffd', '#1a1030'],
      'circle-stroke-width': ['case', isOverlord, 2.5, 1.5],
    },
  });
}

/** Lines from each overlord to the crawlers it is currently directing. */
function commandFeatures(monsters, toLngLat) {
  const byId = new Map(monsters.map((m) => [m.id, m]));
  const features = [];
  for (const overlord of monsters) {
    for (const id of overlord.directing ?? []) {
      const m = byId.get(id);
      if (!m) continue;
      features.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [toLngLat(overlord.x, overlord.z), toLngLat(m.x, m.z)] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function monsterFeatures(monsters, toLngLat) {
  return {
    type: 'FeatureCollection',
    features: monsters.map((m) => ({
      type: 'Feature',
      properties: { id: m.id, type: m.type, sees: m.sees },
      geometry: { type: 'Point', coordinates: toLngLat(m.x, m.z) },
    })),
  };
}

/** An arrow from each monster that heard a gunshot, pointing the way the sound came from. */
function heardFeatures(monsters, toLngLat) {
  const offset = (x, z, bearingDeg, metres) => {
    const b = (bearingDeg * Math.PI) / 180;
    return [x + Math.sin(b) * metres, z + Math.cos(b) * metres];
  };
  return {
    type: 'FeatureCollection',
    features: monsters.filter((m) => m.heard).map((m) => {
      const { bearing, fade } = m.heard;
      const start = offset(m.x, m.z, bearing, 4); // begin just outside the monster dot
      const tip = offset(m.x, m.z, bearing, HEARD_ARROW_LENGTH_M);
      const left = offset(tip[0], tip[1], bearing + 150, HEARD_ARROW_HEAD_M);
      const right = offset(tip[0], tip[1], bearing - 150, HEARD_ARROW_HEAD_M);
      const ll = ([x, z]) => toLngLat(x, z);
      return {
        type: 'Feature',
        properties: { fade },
        geometry: { type: 'MultiLineString', coordinates: [[ll(start), ll(tip)], [ll(left), ll(tip), ll(right)]] },
      };
    }),
  };
}

/** Each monster's view cone as a polygon. Range and angle only: walls that block the view aren't cut out. */
function coneFeatures(monsters, toLngLat) {
  const STEPS = 12;
  return {
    type: 'FeatureCollection',
    features: monsters.map((m) => {
      const ring = [toLngLat(m.x, m.z)];
      for (let i = 0; i <= STEPS; i++) {
        const bearing = ((m.yaw - m.fov / 2 + (m.fov * i) / STEPS) * Math.PI) / 180;
        ring.push(toLngLat(m.x + Math.sin(bearing) * m.range, m.z + Math.cos(bearing) * m.range));
      }
      ring.push(ring[0]);
      return { type: 'Feature', properties: { sees: m.sees, type: m.type }, geometry: { type: 'Polygon', coordinates: [ring] } };
    }),
  };
}

/** performance.now() seconds when the player is back after a playerKilled event; 0 when not dead. */
let playerRespawnAt = 0;

function updateSighting(msg) {
  const line = document.getElementById('sighting');
  if (msg.deaths !== undefined) {
    document.getElementById('deaths').textContent = `Player killed ${msg.deaths} time${msg.deaths === 1 ? '' : 's'}`;
  }
  const respawnIn = playerRespawnAt - performance.now() / 1000;
  if (respawnIn > 0) {
    line.textContent = `Player down · respawns in ${Math.ceil(respawnIn)} s`;
    line.dataset.state = 'dead';
    return;
  }
  const counts = {};
  for (const m of msg.monsters ?? []) if (m.sees) counts[m.type] = (counts[m.type] ?? 0) + 1;
  const watchers = Object.entries(counts).map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`).join(' and ');
  if (msg.player) {
    line.textContent = watchers ? `Player spotted by ${watchers}` : 'Player visible (debug reveal)';
    line.dataset.state = 'spotted';
  } else if (msg.lastSeen) {
    line.textContent = `Player hidden · last seen ${Math.round(msg.lastSeen.ago)} s ago`;
    line.dataset.state = 'lost';
  } else {
    line.textContent = 'Player hidden · not seen yet';
    line.dataset.state = 'hidden';
  }
}

const YELL_SECONDS = 3;
const YELL_RING_GROW_SECONDS = 0.8;
const activeYells = [];

function addNetworkLayers(map) {
  map.addSource('network', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'network-edge', type: 'line', source: 'network',
    paint: { 'line-color': '#a77bff', 'line-width': 1, 'line-opacity': 0.25, 'line-dasharray': [2, 3] },
  });
  map.addSource('yells', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'yell-ring', type: 'line', source: 'yells', filter: ['==', ['get', 'kind'], 'ring'],
    paint: { 'line-color': '#ff7ad9', 'line-width': 2, 'line-opacity': ['get', 'fade'] },
  });
  map.addLayer({
    id: 'yell-link', type: 'line', source: 'yells', filter: ['==', ['get', 'kind'], 'link'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#ff7ad9', 'line-width': 3, 'line-opacity': ['get', 'fade'] },
  });
}

/** Lines between monsters close enough to hear each other's calls. Overlords don't take part. */
function networkFeatures(allMonsters, callRange, toLngLat) {
  const monsters = allMonsters.filter((m) => m.type !== 'overlord');
  const features = [];
  for (let i = 0; i < monsters.length; i++) {
    for (let j = i + 1; j < monsters.length; j++) {
      const a = monsters[i], b = monsters[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > callRange) continue;
      features.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [toLngLat(a.x, a.z), toLngLat(b.x, b.z)] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Animates yell rings (growing to the call range) and answer links until they fade out. */
function animateYells(map, toLngLat) {
  const now = performance.now() / 1000;
  while (activeYells.length && now - activeYells[0].at > YELL_SECONDS) activeYells.shift();

  const features = [];
  for (const y of activeYells) {
    const age = now - y.at;
    const fade = 1 - age / YELL_SECONDS;
    const radius = y.range * Math.min(1, age / YELL_RING_GROW_SECONDS);
    const ring = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ring.push(toLngLat(y.x + Math.sin(a) * radius, y.z + Math.cos(a) * radius));
    }
    features.push({ type: 'Feature', properties: { kind: 'ring', fade }, geometry: { type: 'LineString', coordinates: ring } });
    if (y.fromX !== undefined) {
      features.push({
        type: 'Feature', properties: { kind: 'link', fade },
        geometry: { type: 'LineString', coordinates: [toLngLat(y.fromX, y.fromZ), toLngLat(y.x, y.z)] },
      });
    }
  }
  map.getSource('yells').setData({ type: 'FeatureCollection', features });
  if (activeYells.length) requestAnimationFrame(() => animateYells(map, toLngLat));
}

const KILL_MARKER_SECONDS = 10;
const PLAYER_DEATH_MARKER_SECONDS = 20;
const recentKills = []; // { kind: 'monster' | 'player', x, z, at, seconds }

/** Shows where monsters died and where the player fell; each marker fades out over its own seconds. */
function drawKills(map, toLngLat) {
  const now = performance.now() / 1000;
  for (let i = recentKills.length - 1; i >= 0; i--) {
    if (now - recentKills[i].at > recentKills[i].seconds) recentKills.splice(i, 1);
  }
  map.getSource('kills').setData({
    type: 'FeatureCollection',
    features: recentKills.map((k) => ({
      type: 'Feature',
      properties: { kind: k.kind, fade: 1 - (now - k.at) / k.seconds },
      geometry: { type: 'Point', coordinates: toLngLat(k.x, k.z) },
    })),
  });
}

const supplyPlanes = []; // { x1, z1, x2, z2, at, seconds }

function addSupplyPlaneLayers(map) {
  map.addSource('supply-planes', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'supply-plane-route', type: 'line', source: 'supply-planes',
    paint: {
      'line-color': SUPPLY_PLANE_COLOR, 'line-width': 3, 'line-dasharray': [3, 2],
      'line-opacity': ['*', 0.9, ['get', 'fade']],
    },
  });
}

/**
 * The routes of recent supply planes, each fading out over the seconds the game gave. Only the line: the game
 * never says where along it the crate fell, so nothing here may hint at a spot. Endpoints lie past the play area.
 */
function drawSupplyPlanes(map, toLngLat) {
  const now = performance.now() / 1000;
  for (let i = supplyPlanes.length - 1; i >= 0; i--) {
    if (now - supplyPlanes[i].at > supplyPlanes[i].seconds) supplyPlanes.splice(i, 1);
  }
  map.getSource('supply-planes').setData({
    type: 'FeatureCollection',
    features: supplyPlanes.map((p) => ({
      type: 'Feature',
      properties: { fade: 1 - (now - p.at) / p.seconds },
      geometry: { type: 'LineString', coordinates: [toLngLat(p.x1, p.z1), toLngLat(p.x2, p.z2)] },
    })),
  });
}

/** Energy cost and alive-at-once limit per monster type, from the game's welcome message. */
const monsterCosts = {};
const monsterLimits = {};

/** "3/8" on each spawn button: monsters of that type in the latest state, out of the game's limit. */
function updateMonsterCounts(monsters) {
  const counts = {};
  for (const m of monsters) counts[m.type] = (counts[m.type] ?? 0) + 1;
  for (const b of document.querySelectorAll('.spawn-btn')) {
    const limit = monsterLimits[b.dataset.type];
    const n = counts[b.dataset.type] ?? 0;
    b.querySelector('[data-count]').textContent = limit === undefined ? '' : ` · ${n}/${limit}`;
    b.classList.toggle('full', limit !== undefined && n >= limit);
  }
}

let toastTimer = 0;
function showToast(text, ok) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.dataset.ok = ok;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
}

function updateEnergy(msg) {
  if (msg.energy === undefined) return;
  const fill = document.getElementById('energy-fill');
  fill.style.width = `${(100 * msg.energy) / msg.maxEnergy}%`;
  const rate = msg.energyRate !== undefined ? ` · +${msg.energyRate.toFixed(2)}/s` : '';
  document.getElementById('energy-text').textContent = `${msg.energy.toFixed(1)} / ${msg.maxEnergy}${rate}`;
  for (const b of document.querySelectorAll('.spawn-btn')) {
    b.classList.toggle('short', msg.energy < (monsterCosts[b.dataset.type] ?? Infinity));
  }
}

function addPlayerLayers(map) {
  map.addSource('last-seen', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'last-seen-heading', type: 'line', source: 'last-seen', filter: ['==', ['get', 'kind'], 'heading'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#c9c3b8', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [1, 2] },
  });
  map.addLayer({
    id: 'last-seen-dot', type: 'circle', source: 'last-seen', filter: ['==', ['get', 'kind'], 'position'],
    paint: {
      'circle-radius': 7, 'circle-color': '#c9c3b8', 'circle-opacity': 0.15,
      'circle-stroke-color': '#c9c3b8', 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.7,
    },
  });

  map.addSource('player', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'player-heading', type: 'line', source: 'player', filter: ['==', ['get', 'kind'], 'heading'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#ff5a4f', 'line-width': 3, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'player-halo', type: 'circle', source: 'player', filter: ['==', ['get', 'kind'], 'position'],
    paint: { 'circle-radius': 14, 'circle-color': '#ff5a4f', 'circle-opacity': 0.25 },
  });
  map.addLayer({
    id: 'player-dot', type: 'circle', source: 'player', filter: ['==', ['get', 'kind'], 'position'],
    paint: { 'circle-radius': 6, 'circle-color': '#ff5a4f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}

/** Player position + heading as GeoJSON. Game yaw is already a compass bearing (0 = north, 90 = east). */
function playerFeatures(player, toLngLat) {
  const rad = (player.yaw * Math.PI) / 180;
  const tip = toLngLat(player.x + Math.sin(rad) * HEADING_LENGTH_M, player.z + Math.cos(rad) * HEADING_LENGTH_M);
  const here = toLngLat(player.x, player.z);
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { kind: 'heading' }, geometry: { type: 'LineString', coordinates: [here, tip] } },
      { type: 'Feature', properties: { kind: 'position' }, geometry: { type: 'Point', coordinates: here } },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Connection to the game
// ---------------------------------------------------------------------------------------------------------------

/**
 * Opens the WebSocket to the game, sends the password, and draws everything the game sends. After a successful join
 * it reconnects on its own when the connection drops, using the same password. Returns { close() }.
 */
function connectToGame({ server, password, name, onJoined, onJoinFailed }) {
  const status = document.getElementById('connection');
  const setStatus = (text, state) => {
    status.textContent = text;
    status.dataset.state = state;
    for (const b of document.querySelectorAll('.spawn-btn')) b.disabled = state !== 'connected' && state !== 'warning';
  };

  // Back to the join screen, leaving the status line in a sensible state behind it.
  const fail = (reason) => {
    setStatus("Not connected", "offline");
    onJoinFailed(reason);
  };

  let retryMs = 1000;
  let socket = null;
  let closedByUs = false;
  let everJoined = false;
  let joined = false;
  let ready = false; // the map is drawn and can take live updates
  let zoneDefs = [];
  let callRange = 100;
  const lastMonsterPositions = new Map(); // id -> { x, z }, to draw who answered whom

  const handleWelcome = async (msg) => {
    if (!msg.area) {
      fail('The game did not send a map. Is it the latest version?');
      return;
    }
    await showArea(msg.area);
    zoneDefs = msg.zones ?? [];
    callRange = msg.callRange ?? callRange;
    for (const key of Object.keys(monsterLimits)) delete monsterLimits[key]; // a restarted game may drop limits
    for (const { type, cost, limit } of msg.monsterTypes ?? []) {
      monsterCosts[type] = cost;
      if (limit !== undefined) monsterLimits[type] = limit;
      const label = document.querySelector(`.spawn-btn[data-type="${CSS.escape(type)}"] [data-cost]`);
      if (label) label.textContent = cost;
    }
    updateMonsterCounts([]);
    view.map.getSource('zones').setData(zoneFeatures(zoneDefs, [], view.toLngLat));
    view.map.getSource('spawn-zone').setData(spawnZoneFeatures(msg.spawnZone, view.toLngLat));
    updateZonePanel(zoneDefs, []);
    ready = true;
    setStatus(`Connected to game${name ? ` as ${name}` : ''}`, 'connected');
    warnOnVersionMismatch(msg.protocolVersion);
    onJoined();
  };

  // Keep playing on a mismatch, but say why things may look wrong and what to do about it.
  const warnOnVersionMismatch = (gameVersion) => {
    if (gameVersion === undefined || gameVersion === PROTOCOL_VERSION) return;
    showToast(gameVersion > PROTOCOL_VERSION
      ? 'The game is newer than this page. Refresh the page (Ctrl+F5).'
      : 'The host is running an older game than this page. Ask them to update.', false);
    setStatus(`Connected, but the game uses protocol v${gameVersion} and this page v${PROTOCOL_VERSION}`, 'warning');
  };

  const handleState = (msg) => {
    const { map, toLngLat } = view;
    const monsters = msg.monsters ?? [];
    map.getSource('player').setData(msg.player ? playerFeatures(msg.player, toLngLat) : EMPTY);
    map.getSource('last-seen').setData(msg.lastSeen ? playerFeatures(msg.lastSeen, toLngLat) : EMPTY);
    map.getSource('monsters').setData(monsterFeatures(monsters, toLngLat));
    map.getSource('cones').setData(coneFeatures(monsters, toLngLat));
    map.getSource('heard').setData(heardFeatures(monsters, toLngLat));
    map.getSource('network').setData(networkFeatures(monsters, callRange, toLngLat));
    map.getSource('commands').setData(commandFeatures(monsters, toLngLat));
    lastMonsterPositions.clear();
    for (const m of monsters) lastMonsterPositions.set(m.id, { x: m.x, z: m.z });
    const zones = zoneFeatures(zoneDefs, msg.zones, toLngLat);
    map.getSource('zones').setData(zones);
    refreshZonePopup(zones);
    updateZonePanel(zoneDefs, msg.zones);
    updateEnergy(msg);
    updateMonsterCounts(monsters);
    updateSighting(msg);
    drawKills(map, toLngLat);
    drawSupplyPlanes(map, toLngLat);
  };

  const open = () => {
    joined = false;
    ready = false;
    setStatus(`Connecting to ${server}…`, 'connecting');
    try {
      socket = new WebSocket(server);
    } catch {
      fail('That server address is not valid.');
      return;
    }

    // The game sends nothing until it has the password.
    socket.onopen = () => socket.send(JSON.stringify({ t: 'join', password, name }));

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === 'joinResult') {
        if (msg.ok) {
          joined = everJoined = true;
          retryMs = 1000;
          setStatus('Loading map…', 'connecting');
        } else {
          closedByUs = true;
          socket.close();
          fail(everJoined && msg.reason === 'Wrong password.'
            ? 'The host restarted the game, so the password changed. Ask for the new one.'
            : msg.reason);
        }
        return;
      }
      if (!joined) return;
      if (msg.t === 'welcome') handleWelcome(msg);
      if (!ready) return; // live updates before the map is drawn are simply dropped

      if (msg.t === 'state') {
        handleState(msg);
      } else if (msg.t === 'yell') {
        const from = lastMonsterPositions.get(msg.from);
        const wasIdle = activeYells.length === 0;
        activeYells.push({ x: msg.x, z: msg.z, range: msg.range, at: performance.now() / 1000, fromX: from?.x, fromZ: from?.z });
        if (wasIdle) animateYells(view.map, view.toLngLat);
      } else if (msg.t === 'killed') {
        recentKills.push({ kind: 'monster', x: msg.x, z: msg.z, at: performance.now() / 1000, seconds: KILL_MARKER_SECONDS });
        drawKills(view.map, view.toLngLat);
        showToast(`Your ${msg.type} #${msg.id} was killed`, false);
      } else if (msg.t === 'supplyPlane') {
        const { x1, z1, x2, z2, show } = msg;
        supplyPlanes.push({ x1, z1, x2, z2, at: performance.now() / 1000, seconds: show > 0 ? show : 30 });
        drawSupplyPlanes(view.map, view.toLngLat);
        showToast('Supply plane passed over — a crate is somewhere under the line', false);
      } else if (msg.t === 'playerKilled') {
        const now = performance.now() / 1000;
        playerRespawnAt = now + (msg.respawnIn ?? 0);
        // No credit means no position either: nothing to mark on the map.
        if (msg.x !== undefined) {
          recentKills.push({ kind: 'player', x: msg.x, z: msg.z, at: now, seconds: PLAYER_DEATH_MARKER_SECONDS });
          drawKills(view.map, view.toLngLat);
        }
        const respawn = msg.respawnIn ? ` Back in ${Math.round(msg.respawnIn)} s.` : '';
        showToast(`${msg.byType ? `Your ${msg.byType} #${msg.by} killed the player!` : 'The player died!'}${respawn}`, true);
      } else if (msg.t === 'spawnResult') {
        const type = msg.type ? msg.type[0].toUpperCase() + msg.type.slice(1) : 'Monster';
        showToast(msg.ok ? `${type} spawned` : `Can't spawn: ${msg.reason}`, msg.ok);
      }
    };

    socket.onclose = () => {
      clearLiveLayers();
      if (closedByUs) return;
      if (!everJoined) {
        // Never got in: wrong address, game not running, or the page's site isn't allowed by the game.
        fail(`Could not reach the game at ${server}. Check the address, and that the host is playing.`);
        return;
      }
      setStatus(`Lost connection to the game. Retrying in ${Math.round(retryMs / 1000)} s…`, 'offline');
      setTimeout(() => { if (!closedByUs) open(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
  };

  sendToGame = (message) => {
    if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  open();

  return {
    close() {
      closedByUs = true;
      socket?.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Map controls
// ---------------------------------------------------------------------------------------------------------------

/** Fits the play area into view, keeping it clear of the info panel on wide screens. */
function frameArea(map, bounds) {
  const panel = document.querySelector('.panel').getBoundingClientRect();
  const wide = map.getContainer().clientWidth > panel.right + 300;
  map.resize();
  map.fitBounds(bounds, {
    padding: wide ? { top: 30, bottom: 30, left: panel.right + 20, right: 60 } : { top: panel.bottom + 10, bottom: 30, left: 20, right: 50 },
    animate: false,
  });
}

function wireHover(map) {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  let hovered = null;

  map.on('mousemove', 'buildings-fill', (e) => {
    const f = e.features[0];
    if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: false });
    hovered = f.id;
    map.setFeatureState({ source: 'buildings', id: hovered }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';

    // Building data comes from the game, so escape it before putting it in HTML.
    const p = f.properties;
    const height = p.heightSource === 'default' ? `~${p.height} m (guessed)` : `${p.height} m`;
    popup.setLngLat(e.lngLat)
      .setHTML(`${p.name ? `<b>${escapeHtml(p.name)}</b><br>` : ''}${escapeHtml(p.type)} · ${height}<br>` +
        `<span class="dim">${escapeHtml(p.id)}</span>`)
      .addTo(map);
  });

  map.on('mouseleave', 'buildings-fill', () => {
    if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: false });
    hovered = null;
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  wireZoneHover(map);
}

/** Keeps an open zone popup current as state messages arrive; set by wireZoneHover. */
let refreshZonePopup = () => {};

/** Zone info on hover, or on tap for phones. Buildings inside a zone keep their own popup. */
function wireZoneHover(map) {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, maxWidth: '260px' });
  let zoneId = null;
  const show = (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['buildings-fill'] }).length) return hide();
    const p = e.features[0].properties;
    zoneId = p.id;
    popup.setLngLat(e.lngLat).setHTML(zonePopupHtml(p)).addTo(map);
  };
  const hide = () => {
    zoneId = null;
    popup.remove();
  };
  map.on('mousemove', 'zone-fill', show);
  map.on('mouseleave', 'zone-fill', hide);
  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] });
    if (hit.length && !spawnType) show({ ...e, features: hit });
    else if (!hit.length) hide();
  });
  refreshZonePopup = (zones) => {
    const f = zoneId === null ? null : zones.features.find((z) => z.properties.id === zoneId);
    if (f) popup.setHTML(zonePopupHtml(f.properties));
  };
}

function wireControls(map) {
  document.getElementById('toggle-osm').addEventListener('change', (e) => {
    map.setLayoutProperty('osm', 'visibility', e.target.checked ? 'visible' : 'none');
  });
  document.getElementById('toggle-3d').addEventListener('change', (e) => {
    const on = e.target.checked;
    map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
    map.setLayoutProperty('buildings-fill', 'visibility', on ? 'none' : 'visible');
    map.easeTo({ pitch: on ? 55 : 0, bearing: on ? -20 : 0, duration: 800 });
  });
}

main();

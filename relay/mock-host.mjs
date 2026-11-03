// A stand-in for the Unity game on the relay's host side, for testing the map page without Unity:
//   node relay/mock-host.mjs [relay] [code]
// relay defaults to ws://localhost:8787; code to a new one (an FPS-created game). Pass a map-created code to start
// that game instead. It accepts map players with the code, sends an empty map and a 10 Hz state, and flies a supply
// plane every minute. Also a small reference for the host side of "Relay" in ../PROTOCOL.md.
import { newCode, normaliseCode } from './room.js';

const relay = (process.argv[2] ?? 'ws://localhost:8787').replace(/\/$/, '');
const code = process.argv[3] ?? newCode();
const area = {
  version: 1, source: 'test', crs: 'EPSG:25832', originLat: 55.5178, originLon: 11.8619,
  originEasting: 680680.32, originNorthing: 6156136.38, sizeMeters: 600, buildings: [],
};

const socket = new WebSocket(`${relay}/host`);
const joined = new Set(); // map players that gave the right code
const toRelay = (msg) => socket.send(`relay\n${JSON.stringify(msg)}`);
const to = (ids, msg) => { if (ids.length) socket.send(`to:${ids.join(',')}\n${JSON.stringify(msg)}`); };

socket.onopen = () => toRelay({ t: 'host', code, protocolVersion: 2 });
socket.onclose = (e) => { console.log(`relay closed the link (${e.code} ${e.reason})`); process.exit(0); };
socket.onmessage = ({ data }) => {
  const split = data.indexOf('\n');
  const header = data.slice(0, split);
  const msg = JSON.parse(data.slice(split + 1));
  if (header === 'relay') {
    if (msg.t === 'hosting') console.log(msg.ok ? `hosting ${msg.code}` : `refused: ${msg.reason}`);
    else if (msg.t === 'peerLeft') joined.delete(msg.peer);
    else if (msg.t === 'ended') console.log(`ended: ${msg.reason}`);
    return;
  }
  const peer = Number(header.slice(5)); // from:N
  console.log(`map player ${peer}: ${JSON.stringify(msg).slice(0, 120)}`);
  if (msg.t === 'join') {
    if (normaliseCode(msg.password) !== normaliseCode(code)) {
      to([peer], { t: 'joinResult', ok: false, reason: 'Wrong password.' });
      toRelay({ t: 'kick', peer });
      return;
    }
    to([peer], { t: 'joinResult', ok: true, reason: '' });
    to([peer], {
      t: 'welcome', protocolVersion: 2, map: 'Mock', originEasting: area.originEasting,
      originNorthing: area.originNorthing, sendRate: 10, area,
      monsterTypes: [{ type: 'crawler', cost: 1, limit: 8, orders: true }], zones: [], spawnZones: [],
    });
    joined.add(peer);
  } else if (msg.t === 'ping') {
    to([peer], { t: 'pong' });
  }
};

// One state for everyone: a single relay message however many map players there are.
let time = 0;
setInterval(() => {
  time += 0.1;
  if (joined.size) socket.send(`to:*\n${JSON.stringify({ t: 'state', time: Math.round(time * 100) / 100, player: null,
    deaths: 0, energy: 1, energyRate: 0.5, maxEnergy: 5, monsters: [], zones: [] })}`);
}, 100);

let planeId = 1;
setInterval(() => {
  if (!joined.size) return;
  const id = planeId++;
  to([...joined], { t: 'supplyPlane', id, x1: 290, z1: 360, x2: -292, z2: -360, show: 60, incoming: true });
  setTimeout(() => to([...joined], { t: 'planeEnter', id }), 3000);
  setTimeout(() => to([...joined], { t: 'planeLeave', id, shotDown: false }), 30000);
}, 60000);

console.log(`mock host for ${relay}, code ${code}`);

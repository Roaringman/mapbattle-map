// End-to-end test of the relay: start `node relay/dev-server.mjs`, then `node relay/test.mjs [relay]`.
// Uses Node's built-in WebSocket; no packages. Leaves the room idle when it passes.
const relay = (process.argv[2] ?? 'ws://localhost:8787').replace(/\/$/, '');
const ORIGIN = 'http://localhost:8080';
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

/** A WebSocket with a message queue: `await next()` gives the next message, parsed like the other side sends it. */
function client(path, { origin = ORIGIN } = {}) {
  const ws = new WebSocket(`${relay}${path}`, { headers: origin ? { Origin: origin } : {} });
  const queue = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', ({ data }) => {
    const item = path === '/host'
      ? { route: data.slice(0, data.indexOf('\n')), msg: JSON.parse(data.slice(data.indexOf('\n') + 1)) }
      : JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(item); else queue.push(item);
  });
  const opened = new Promise((resolve) => ws.addEventListener('open', resolve));
  return {
    ws, closed, opened,
    send: (data) => ws.send(typeof data === 'string' ? data : JSON.stringify(data)),
    next: (ms = 2000) => queue.length ? Promise.resolve(queue.shift())
      : new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        waiters.push((item) => { clearTimeout(timer); resolve(item); });
      }),
    quiet: async (ms = 300) => { await new Promise((r) => setTimeout(r, ms)); return queue.length === 0; },
  };
}

const status = async () => (await fetch(relay.replace(/^ws/, 'http') + '/status')).json();
const open = async (path, opts) => { const c = client(path, opts); await c.opened; return c; };

check((await status()).state === 'idle', 'starts idle');

const a = await open('/play');
a.send({ t: 'create', name: 'Anna<script>' });
const created = await a.next();
check(created?.t === 'created' && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(created.code), `map creates a game (${created?.code})`);
const code = created.code;
check((await a.next())?.state === 'waitingForHost', 'creator waits for the host');
check((await status()).state === 'waitingForHost', 'status: waiting for host');

const x = await open('/play');
x.send({ t: 'create' });
check((await x.next())?.reason?.startsWith('A game is already running'), 'a second game is refused');

const wrong = await open('/play');
wrong.send({ t: 'join', password: 'AAAA-BBBB-CCCC', name: 'Eve' });
check((await wrong.next())?.reason === 'Wrong password.', 'wrong code refused');

const b = await open('/play');
b.send({ t: 'join', password: code.toLowerCase().replace(/-/g, ' '), name: 'Bo' });
check((await b.next())?.state === 'waitingForHost', 'joiner with the code (any case/spacing) waits too');

const badOrigin = await open('/play', { origin: 'https://evil.example' }).catch(() => null);
check(badOrigin === null || (await badOrigin.closed) === 1008, 'map player from another site is refused');

const intruder = await open('/host');
intruder.send(`relay\n${JSON.stringify({ t: 'host', code: 'ZZZZ-ZZZZ-ZZZZ' })}`);
check((await intruder.next())?.msg.reason === 'Another game is running.', 'host with another code is refused');

let host = await open('/host');
host.send(`relay\n${JSON.stringify({ t: 'host', code, protocolVersion: 2 })}`);
const hosting = await host.next();
check(hosting?.route === 'relay' && hosting.msg.ok === true && hosting.msg.code === code, 'host attaches with the code');
const joinA = await host.next();
const joinB = await host.next();
check(joinA?.route === 'from:1' && joinA.msg.t === 'join' && joinA.msg.password === code && joinA.msg.name === 'Annascript',
  'host gets the creator\'s join, with the code and a cleaned name');
check(joinB?.route === 'from:2' && joinB.msg.name === 'Bo', 'host gets the joiner\'s own join');
check((await status()).state === 'playing', 'status: playing');

host.send(`to:*\n${JSON.stringify({ t: 'state', time: 1 })}`);
check((await a.next())?.t === 'state' && (await b.next())?.t === 'state', 'to:* reaches every map player');
host.send(`to:2\n${JSON.stringify({ t: 'welcome' })}`);
check((await b.next())?.t === 'welcome' && await a.quiet(), 'to:2 reaches only map player 2');

a.send({ t: 'spawn', type: 'crawler', zone: 1 });
const spawn = await host.next();
check(spawn?.route === 'from:1' && spawn.msg.t === 'spawn', 'map messages reach the host as from:N');

const c = await open('/play');
c.send({ t: 'join', password: code, name: 'Cy' });
check((await host.next())?.route === 'from:3', 'a late joiner goes straight to the host');
const d = await open('/play');
d.send({ t: 'join', password: code, name: 'Di' });
await host.next();
const e = await open('/play');
e.send({ t: 'join', password: code, name: 'Ed' });
check((await e.next())?.reason === 'The game is full (4 map players).', 'a fifth map player is refused');

host.send(`relay\n${JSON.stringify({ t: 'kick', peer: 4 })}`);
check((await d.closed) === 4003, 'host can kick a map player');
const left = await host.next();
check(left?.msg.t === 'peerLeft' && left.msg.peer === 4, 'host hears that the player left');

host.ws.close();
check((await a.next())?.state === 'hostAway' && (await b.next())?.state === 'hostAway', 'map players hear the host is away');
check((await status()).state === 'hostAway', 'status: host away');

host = await open('/host');
host.send(`relay\n${JSON.stringify({ t: 'host', code, protocolVersion: 2 })}`);
check((await host.next())?.msg.ok === true, 'host comes back with the same code');
const rejoins = [await host.next(), await host.next(), await host.next()].map((m) => m?.route).sort();
check(rejoins.join() === 'from:1,from:2,from:3', 'everyone still there is joined again');

host.send(`relay\n${JSON.stringify({ t: 'end', reason: 'Test over.' })}`);
const ended = await a.next();
check(ended?.t === 'ended' && ended.reason === 'Test over.', 'ending the game tells the map players');
check((await status()).state === 'idle', 'back to idle');

const creator = await open('/play');
creator.send({ t: 'create', name: 'Fay' });
await creator.next();
await creator.next();
creator.send({ t: 'cancel' });
check((await creator.next())?.t === 'ended' && (await status()).state === 'idle', 'the creator can cancel before a host comes');

const log = await (await fetch(relay.replace(/^ws/, 'http') + '/log')).text();
check(log.includes('handed to the host') && !log.includes(code) && !log.includes('Bo'),
  '/log has the lobby events, without codes or names');

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);

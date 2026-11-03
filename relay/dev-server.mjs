// The relay on your own machine, for testing without Cloudflare: `node relay/dev-server.mjs [port]` (default 8787,
// like `wrangler dev`). Same Room as the Worker, with a minimal WebSocket server so it needs no npm packages.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Room } from './room.js';

const PORT = Number(process.argv[2] ?? 8787);
const room = new Room({
  allowedOrigins: ['http://localhost:8080', 'http://127.0.0.1:8080', 'https://roaringman.github.io'],
  log: (text) => console.log(`[room] ${text}`),
});

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (new URL(req.url, 'http://x').pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(room.status()));
  } else {
    res.writeHead(404).end('Not found');
  }
});

server.on('upgrade', (req, socket) => {
  const role = { '/play': 'map', '/host': 'host' }[new URL(req.url, 'http://x').pathname];
  const key = req.headers['sec-websocket-key'];
  if (!role || !key) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let open = true;
  const conn = room.open(role, {
    send(text) { if (open) socket.write(frame(0x1, Buffer.from(text))); },
    close(code, reason) {
      if (!open) return;
      open = false;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason ?? ''));
      body.writeUInt16BE(code ?? 1000, 0);
      body.write(reason ?? '', 2);
      socket.end(frame(0x8, body));
    },
  }, req.headers.origin ?? '');

  let buffer = Buffer.alloc(0);
  let parts = []; // fragments of a message in progress
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const f = readFrame(buffer);
      if (!f) break;
      buffer = buffer.subarray(f.size);
      if (f.op === 0x8) { open = false; socket.end(); room.closed(conn); return; }
      if (f.op === 0x9) { socket.write(frame(0xA, f.data)); continue; }
      if (f.op === 0xA) continue;
      if (f.op === 0x1 || f.op === 0x0) parts.push(f.data);
      else if (f.op === 0x2) { room.message(conn, null); continue; }
      if (f.fin && parts.length) {
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        room.message(conn, text);
      }
    }
  });
  socket.on('close', () => { open = false; room.closed(conn); });
  socket.on('error', () => {});
});

function frame(op, data) {
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, data]);
}

function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const op = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let pos = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); pos = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); pos = 10; }
  const mask = masked ? buf.subarray(pos, pos + 4) : null;
  if (masked) pos += 4;
  if (buf.length < pos + len) return null;
  const data = Buffer.from(buf.subarray(pos, pos + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return { fin, op, data, size: pos + len };
}

server.listen(PORT, () => console.log(`MapBattle relay (dev) on ws://localhost:${PORT}  (/play, /host, /status)`));

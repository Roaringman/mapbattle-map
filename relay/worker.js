// The MapBattle relay on Cloudflare Workers. Every request goes to one Durable Object, so there is exactly one game
// room: one game at a time, which keeps it well inside the free tier. Deploy with `npx wrangler deploy` in this folder.
//
//   GET /status        lobby info for the page: { state, maps, maxMaps }
//   WebSocket /play    map players (browsers from ALLOWED_ORIGINS)
//   WebSocket /host    the authority: the Unity game today
import { Room } from './room.js';

const ALLOWED_ORIGINS = ['https://roaringman.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export class RelayRoom {
  constructor(ctx, env) {
    this.room = new Room({ allowedOrigins: ALLOWED_ORIGINS, log: (text) => console.log(text) });
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/status') return Response.json(this.room.status(), { headers: CORS });

    const role = { '/play': 'map', '/host': 'host' }[pathname];
    if (!role) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket expected', { status: 426 });

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = this.room.open(role, {
      send: (text) => { try { server.send(text); } catch { /* closing */ } },
      close: (code, reason) => { try { server.close(code, reason); } catch { /* closed */ } },
    }, request.headers.get('Origin') ?? '');
    server.addEventListener('message', (event) => this.room.message(conn, event.data));
    server.addEventListener('close', () => {
      this.room.closed(conn);
      // Answer the close, or the other side waits for it until it times out (this compatibility date doesn't).
      try { server.close(1000, 'Bye'); } catch { /* already closed */ }
    });
    server.addEventListener('error', () => this.room.closed(conn));
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    const room = env.ROOM.get(env.ROOM.idFromName('the-one-game'));
    return room.fetch(request);
  },
};

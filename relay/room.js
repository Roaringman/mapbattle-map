// The one game room of the MapBattle relay. Platform-free: worker.js (Cloudflare Durable Object) and dev-server.mjs
// (Node, for local testing) both feed it sockets and messages. See "Relay" in ../PROTOCOL.md for the wire format.
//
// Roles: one `host` (the authority: the Unity game today, maybe a cloud simulation later) and up to MAX_MAPS map
// players. The relay runs the lobby (codes, limits, waiting for the host) and then only routes messages; it never
// reads game messages beyond the map players' first `create`/`join`.

export const MAX_MAPS = 4;
const FIRST_MESSAGE_MS = 15_000; // a socket that says nothing is dropped, as the game does
const WAITING_FOR_HOST_MS = 15 * 60_000; // a game created on the map that no host ever starts
const HOST_GRACE_MS = 2 * 60_000; // a host that dropped out may come back this long
const EMPTY_MS = 2 * 60_000; // a game nobody is connected to
const MAX_MAP_MESSAGE = 64 * 1024;
const LOCKOUT_GUESSES = 10; // wrong codes within LOCKOUT_MS lock joining for LOCKOUT_MS (for everyone)
const LOCKOUT_MS = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 letters and digits, none that look alike

/** Case, spaces and dashes don't count, as in the game's password check. */
export function normaliseCode(code) {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/** XXXX-XXXX-XXXX: 60 random bits, the same shape as the passwords the game makes. */
export function newCode() {
  const chars = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => CODE_ALPHABET[b % 32]); // 256 % 32 = 0
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** The game's rule for display names: letters, digits, spaces, - and _, at most 20 characters. */
function cleanName(name) {
  return String(name ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 20);
}

function json(message) {
  return JSON.stringify(message);
}

export class Room {
  constructor({ allowedOrigins = [], now = () => Date.now(), log = () => {} } = {}) {
    this.allowedOrigins = allowedOrigins;
    this.now = now;
    this.log = log;
    this.session = null; // { code, state: 'waitingForHost' | 'playing' | 'hostAway', timers }
    this.host = null; // the connection hosting the session
    this.peers = new Map(); // map-player id -> connection, in the session
    this.nextPeer = 1;
    this.wrongGuesses = [];
    this.lockedUntil = 0;
  }

  /** For the lobby page: is a game running, and how full is it. */
  status() {
    return { state: this.session?.state ?? 'idle', maps: this.peers.size, maxMaps: MAX_MAPS };
  }

  /** A new socket. `socket` is { send(text), close(code, reason) }; role 'host' or 'map'. Returns the connection. */
  open(role, socket, origin) {
    const conn = { role, socket, id: 0, name: '', joinText: null, forwarded: false, inSession: false, closed: false };
    if (role === 'map' && !this.allowedOrigins.includes(origin)) {
      socket.close(1008, 'Origin not allowed');
      conn.closed = true;
      return conn;
    }
    conn.firstTimer = setTimeout(() => this.drop(conn, 1008, 'Nothing sent'), FIRST_MESSAGE_MS);
    return conn;
  }

  message(conn, text) {
    if (conn.closed) return;
    if (typeof text !== 'string') return this.drop(conn, 1003, 'Text frames only');
    if (conn.role === 'map') this.mapMessage(conn, text);
    else this.hostMessage(conn, text);
  }

  closed(conn) {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.firstTimer);
    if (conn.role === 'map' && conn.inSession) {
      this.peers.delete(conn.id);
      if (conn.forwarded && this.host) this.host.socket.send(`relay\n${json({ t: 'peerLeft', peer: conn.id })}`);
    } else if (conn === this.host) {
      this.host = null;
      this.hostLeft();
    }
    this.checkEmpty();
  }

  // --- Map players ---------------------------------------------------------------------------------------------

  mapMessage(conn, text) {
    if (text.length > MAX_MAP_MESSAGE) return this.drop(conn, 1009, 'Message too big');
    if (conn.inSession) {
      if (conn.forwarded && this.host) return this.host.socket.send(`from:${conn.id}\n${text}`);
      // Not handed to a host (yet, or the host is away): the relay answers the little there is to answer.
      const msg = text.length < 100 ? safeParse(text) : null;
      if (msg?.t === 'ping') conn.socket.send(json({ t: 'pong' }));
      else if (msg?.t === 'cancel' && conn.creator && this.session.state === 'waitingForHost') {
        this.end('The game was cancelled.');
      }
      return; // game messages have nowhere to go until the host is here
    }
    clearTimeout(conn.firstTimer);
    const msg = safeParse(text);
    if (msg?.t === 'create') this.create(conn, msg);
    else if (msg?.t === 'join') this.join(conn, msg, text);
    else this.refuse(conn, 'Send the password first.');
  }

  create(conn, msg) {
    if (this.session) return this.refuse(conn, 'A game is already running. Join it with its code.');
    const code = newCode();
    this.session = { code, state: 'waitingForHost', timers: {} };
    this.session.timers.waiting = setTimeout(() => this.end('Nobody started the game in time.'), WAITING_FOR_HOST_MS);
    conn.name = cleanName(msg.name);
    conn.creator = true;
    // The creator never typed the code; this is the join the host gets on its behalf.
    conn.joinText = json({ t: 'join', password: code, name: conn.name });
    this.admit(conn);
    conn.socket.send(json({ t: 'created', code }));
    conn.socket.send(json({ t: 'lobby', state: 'waitingForHost' }));
    this.log(`created ${code} by map player ${conn.id}`);
  }

  join(conn, msg, text) {
    if (this.now() < this.lockedUntil) return this.refuse(conn, 'Too many wrong passwords. Try again in a minute.');
    if (!this.session) return this.refuse(conn, 'No game is running. Create one from the lobby.');
    if (normaliseCode(msg.password) !== normaliseCode(this.session.code)) {
      this.wrongGuess();
      return this.refuse(conn, 'Wrong password.');
    }
    if (this.peers.size >= MAX_MAPS) return this.refuse(conn, `The game is full (${MAX_MAPS} map players).`);
    conn.name = cleanName(msg.name);
    conn.joinText = text;
    this.admit(conn);
    if (this.session.state === 'playing') this.forward(conn);
    else conn.socket.send(json({ t: 'lobby', state: this.session.state }));
  }

  admit(conn) {
    conn.id = this.nextPeer++;
    conn.inSession = true;
    this.peers.set(conn.id, conn);
    clearTimeout(this.session.timers.empty);
  }

  /** Hands a map player over to the host: from now on the host answers it, starting with its join. */
  forward(conn) {
    conn.forwarded = true;
    this.host.socket.send(`from:${conn.id}\n${conn.joinText}`);
  }

  refuse(conn, reason) {
    conn.socket.send(json({ t: 'joinResult', ok: false, reason }));
    setTimeout(() => this.drop(conn, 1000, 'Refused'), 1000); // as the game: reply, then close a second later
  }

  wrongGuess() {
    const now = this.now();
    this.wrongGuesses = this.wrongGuesses.filter((t) => now - t < LOCKOUT_MS);
    this.wrongGuesses.push(now);
    if (this.wrongGuesses.length >= LOCKOUT_GUESSES) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.wrongGuesses = [];
    }
  }

  // --- The host --------------------------------------------------------------------------------------------------

  hostMessage(conn, text) {
    const split = text.indexOf('\n');
    const header = split < 0 ? text : text.slice(0, split);
    const payload = split < 0 ? '' : text.slice(split + 1);

    if (conn !== this.host) {
      // Not hosting yet: the only thing it may say is `host`.
      const msg = header === 'relay' ? safeParse(payload) : null;
      if (msg?.t !== 'host') return this.drop(conn, 1008, 'Send host first');
      clearTimeout(conn.firstTimer);
      return this.attachHost(conn, msg);
    }

    if (header === 'relay') return this.control(conn, safeParse(payload));
    if (!header.startsWith('to:')) return; // unknown routes are ignored, like unknown messages
    const to = header.slice(3);
    const targets = to === '*' ? [...this.peers.values()]
      : to.split(',').map((id) => this.peers.get(Number(id))).filter(Boolean);
    for (const peer of targets) if (peer.forwarded) peer.socket.send(payload);
  }

  attachHost(conn, msg) {
    const code = String(msg.code ?? '');
    const reply = (fields) => conn.socket.send(`relay\n${json({ t: 'hosting', ...fields })}`);
    if (normaliseCode(code).length < 8) {
      reply({ ok: false, reason: 'The code is too short.' });
      return this.drop(conn, 1008, 'Bad code');
    }
    if (!this.session) {
      this.session = { code, state: 'playing', timers: {} };
      this.log(`created ${code} by the host`);
    } else if (normaliseCode(code) !== normaliseCode(this.session.code)) {
      reply({ ok: false, reason: 'Another game is running.' });
      return this.drop(conn, 1008, 'Another game');
    }
    if (this.host) this.drop(this.host, 4002, 'Replaced by a new host connection');
    this.host = conn;
    conn.inSession = true;
    clearTimeout(this.session.timers.waiting);
    clearTimeout(this.session.timers.grace);
    clearTimeout(this.session.timers.empty);
    this.session.state = 'playing';
    reply({ ok: true, code: this.session.code, maxMaps: MAX_MAPS });
    for (const peer of this.peers.values()) this.forward(peer);
    this.log(`host attached to ${this.session.code}, ${this.peers.size} map player(s) waiting`);
  }

  control(conn, msg) {
    if (msg?.t === 'kick') {
      const peer = this.peers.get(Number(msg.peer));
      if (peer) this.drop(peer, 4003, String(msg.reason ?? 'Removed by the host').slice(0, 100));
    } else if (msg?.t === 'end') {
      this.end(String(msg.reason ?? 'The host ended the game.').slice(0, 200));
    } else if (msg?.t === 'ping') {
      conn.socket.send(`relay\n${json({ t: 'pong' })}`);
    }
  }

  hostLeft() {
    if (!this.session) return;
    this.session.state = 'hostAway';
    for (const peer of this.peers.values()) {
      peer.forwarded = false; // they get joined again, with the same join, when the host is back
      peer.socket.send(json({ t: 'lobby', state: 'hostAway' }));
    }
    this.session.timers.grace = setTimeout(() => this.end('The host left the game.'), HOST_GRACE_MS);
    this.log('host left; waiting for it to come back');
  }

  // --- The session as a whole ----------------------------------------------------------------------------------

  checkEmpty() {
    if (!this.session || this.host || this.peers.size) return;
    clearTimeout(this.session.timers.empty);
    this.session.timers.empty = setTimeout(() => this.end('Everyone left.'), EMPTY_MS);
  }

  end(reason) {
    if (!this.session) return;
    this.log(`ended ${this.session.code}: ${reason}`);
    for (const timer of Object.values(this.session.timers)) clearTimeout(timer);
    this.session = null;
    for (const peer of this.peers.values()) {
      peer.socket.send(json({ t: 'ended', reason }));
      this.drop(peer, 1000, 'Game over');
    }
    this.peers.clear();
    if (this.host) {
      this.host.socket.send(`relay\n${json({ t: 'ended', reason })}`);
      this.drop(this.host, 1000, 'Game over');
      this.host = null;
    }
  }

  drop(conn, code, reason) {
    if (conn.closed) return;
    try { conn.socket.close(code, reason); } catch { /* already gone */ }
    this.closed(conn);
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

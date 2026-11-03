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
const STATS_MS = 30_000; // one timing line per this while a game is played (logs are per line, not per message)
const LOG_LINES = 300; // kept for GET /log: over two hours of stats lines

// What one stats window measured. The relay never parses game messages; it only looks at how they start.
/** State frames per second, from the first one in the window (players may join partway). */
function stateRate(s) {
  return s.states > 1 ? ((s.states - 1) / ((s.lastState - s.firstState) / 1000)).toFixed(1) : String(s.states);
}

function newStats(now) {
  return { from: now, states: 0, firstState: 0, lastState: 0, maxStateGap: 0, hostFrames: 0, hostBytes: 0, maxFrame: 0,
    mapMessages: 0, replies: 0, replyTotal: 0, replyMax: 0 };
}

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
    this.stats = null; // timing for the current stats window, while a game is played (newStats)
    this.lines = []; // recent log lines for GET /log (note)
    this.host = null; // the connection hosting the session
    this.peers = new Map(); // map-player id -> connection, in the session
    this.nextPeer = 1;
    this.wrongGuesses = [];
    this.lockedUntil = 0;
  }

  /**
   * Logs a line and keeps it for GET /log. Cloudflare doesn't show a Durable Object's console output while its
   * WebSockets are open (the whole game), so the recent lines are kept here too. /log is public: lines never carry
   * a code or a player name.
   */
  note(text) {
    this.lines.push(`${new Date(this.now()).toISOString()} ${text}`);
    if (this.lines.length > LOG_LINES) this.lines.shift();
    this.log(text);
  }

  /** The recent log lines, oldest first, for GET /log. */
  recentLog() {
    return this.lines.join('\n') + '\n';
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
      if (this.session) this.note(`map player ${conn.id} left`);
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
      if (conn.forwarded && this.host) {
        if (this.stats) {
          this.stats.mapMessages++;
          // A spawn always gets its own answer (spawnResult): its round trip through the game is the reply time.
          if (!conn.waitingSince && text.startsWith('{"t":"spawn"')) conn.waitingSince = this.now();
        }
        return this.host.socket.send(`from:${conn.id}\n${text}`);
      }
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
    this.note(`game created by map player ${conn.id}`);
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
    conn.forwardedAt = this.now();
    conn.welcomed = false;
    conn.waitingSince = 0;
    this.note(`map player ${conn.id} handed to the host`);
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
    if (this.stats) this.measure(payload, targets);
  }

  /** Timing from a host frame, by how its payload starts (cheap, and never more than that). */
  measure(payload, targets) {
    const s = this.stats;
    const now = this.now();
    s.hostFrames++;
    s.hostBytes += payload.length;
    s.maxFrame = Math.max(s.maxFrame, payload.length);
    if (payload.startsWith('{"t":"state"')) {
      // The game sends state 10 times a second: a long gap is the game (or its link) stalling.
      if (s.lastState) s.maxStateGap = Math.max(s.maxStateGap, now - s.lastState);
      else s.firstState = now;
      s.lastState = now;
      s.states++;
    } else if (payload.startsWith('{"t":"spawnResult"')) {
      for (const peer of targets) {
        if (!peer.waitingSince) continue;
        const ms = now - peer.waitingSince;
        peer.waitingSince = 0;
        s.replies++;
        s.replyTotal += ms;
        s.replyMax = Math.max(s.replyMax, ms);
      }
    } else if (payload.startsWith('{"t":"welcome"')) {
      for (const peer of targets) {
        if (peer.welcomed) continue;
        peer.welcomed = true;
        this.note(`welcome to map player ${peer.id}: ${now - peer.forwardedAt} ms after hand-over, ` +
          `${Math.round(payload.length / 1024)} KB`);
      }
    }
  }

  logStats() {
    const s = this.stats;
    if (!s || this.session?.state !== 'playing') return;
    const now = this.now();
    const seconds = (now - s.from) / 1000;
    if (s.hostFrames || s.mapMessages) {
      this.note(`stats ${Math.round(seconds)} s, ${this.peers.size} map player(s): ` +
        `state ${stateRate(s)}/s, longest gap ${s.maxStateGap} ms; ` +
        `host sent ${s.hostFrames} frames, ${Math.round(s.hostBytes / 1024)} KB, largest ${Math.round(s.maxFrame / 1024)} KB; ` +
        `map players sent ${s.mapMessages}; ` +
        (s.replies ? `spawn round trip avg ${Math.round(s.replyTotal / s.replies)} ms, max ${s.replyMax} ms` : 'no spawns'));
    }
    this.stats = newStats(now);
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
      this.note('game created by the host');
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
    this.stats = newStats(this.now());
    if (!this.session.timers.stats) this.session.timers.stats = setInterval(() => this.logStats(), STATS_MS);
    reply({ ok: true, code: this.session.code, maxMaps: MAX_MAPS });
    for (const peer of this.peers.values()) this.forward(peer);
    this.note(`host attached, ${this.peers.size} map player(s) waiting`);
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
    this.note('host left; waiting for it to come back');
  }

  // --- The session as a whole ----------------------------------------------------------------------------------

  checkEmpty() {
    if (!this.session || this.host || this.peers.size) return;
    clearTimeout(this.session.timers.empty);
    this.session.timers.empty = setTimeout(() => this.end('Everyone left.'), EMPTY_MS);
  }

  end(reason) {
    if (!this.session) return;
    this.logStats(); // the last, partial window
    this.stats = null;
    this.note(`ended: ${reason}`);
    for (const timer of Object.values(this.session.timers)) { clearTimeout(timer); clearInterval(timer); }
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

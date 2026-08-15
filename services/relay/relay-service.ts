// The relay: it carries game datagrams between agents, and knows nothing else.
//
// Everything else in this repository may restart; a game in progress must not notice. So
// the relay asks the core exactly one question — "who is this agent, and which room is he
// in" — when a connection opens, keeps the answer for the life of that connection, and
// depends on nothing afterwards (docs/ARCHITECTURE.md).
//
// Consequences, deliberate: the core being down refuses NEW connections and leaves running
// games alone; a banned player is stopped at his next connection with no revocation list
// anywhere; and an identity confirmed a minute ago is re-admitted from the cache below, so
// a wifi blip during a core restart does not end a match.
//
// IT NEVER LEARNS A DESTINATION FROM ITS CLIENT. An agent says "to the others in my room",
// never "to this address" — so this cannot be pointed at a third party, and that property
// has to survive every future change to it.
//
// Exports:
//   startRelay(options)   the http/ws server, listening, with close()

import { createServer, type Server } from 'node:http';
import { CoreClient } from '../../shared/core-client.ts';
import type { PeerEndpoint } from '../../shared/core-protocol.ts';
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

export interface RelayOptions {
  /** The address to bind — `H5E_BIND`, not the one the game is advertised. */
  bind: string;
  port: number;
  coreUrl: string;
  /** How long a connection may say nothing before it is dropped. Tests make it short. */
  identifyMs?: number;
  log?: (line: string) => void;
}

export interface RunningRelay {
  server: Server;
  port(): number;
  /** How many agents are connected, per room — what the log and the tests ask for. */
  rooms(): Record<string, string[]>;
  close(): Promise<void>;
}

interface Agent {
  peer: WebSocketPeer;
  nick: string;
  room: string;
  /** Where this player's game is, if the room description said so. */
  endpoint: PeerEndpoint | null;
  /**
   * What this agent has actually pushed through, which is the one number a test of the
   * network wants and the one thing the log never said. Forwarding is otherwise silent, so
   * "three joined a room" and "three joined a room and then played for eight minutes" read
   * exactly alike — and the first of those is a tunnel that carried nothing.
   */
  carried: { datagrams: number; bytes: number };
}

// ---------------------------------------------------------------------------
// The frame, which is the same seven bytes in both directions:
//
//   [0x01][address: 4 bytes][port: 2 bytes big-endian][the datagram]
//
// Going OUT of an agent the address is who the game dialled; coming BACK it is
// who the datagram is from, so the agent can answer its game's `recvfrom` with
// a peer the game already believes in. The relay is what turns one into the
// other, because it is the only side that knows which player is at which
// address — and it learns that from the core, which learns it from the host's
// own description of the room.
//
// Seven bytes and no names on purpose: the agent is C inside the game, and the
// less it has to parse the less there is to get wrong in there.
// ---------------------------------------------------------------------------

const FRAME_DATAGRAM = 0x01;
/**
 * And the one an agent sends first: `[0x02][address: 4][port: 2]`, where its game plays.
 *
 * Same seven bytes as a datagram frame with nothing after them, because the agent is C
 * inside the game and one shape is easier to get right than two. It is not a credential —
 * see `agent.identify` in the protocol — it is the question "who is at this address", and
 * only the lobby can answer it.
 */
const FRAME_IDENTIFY = 0x02;
const FRAME_HEADER = 7;

function frameFor(endpoint: PeerEndpoint | null, payload: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_HEADER + payload.length);
  out[0] = FRAME_DATAGRAM;
  const octets = (endpoint?.address ?? '0.0.0.0').split('.').map(Number);
  for (let i = 0; i < 4; i++) out[1 + i] = octets[i] ?? 0;
  out.writeUInt16BE(endpoint?.port ?? 0, 5);
  payload.copy(out, FRAME_HEADER);
  return out;
}

/** Where an agent says its game plays, out of its first frame. Null if this is not one. */
function readIdentify(bytes: Buffer): PeerEndpoint | null {
  if (bytes.length !== FRAME_HEADER || bytes[0] !== FRAME_IDENTIFY) return null;
  const port = bytes.readUInt16BE(5);
  if (!port) return null;
  return { nick: '', address: `${bytes[1]}.${bytes[2]}.${bytes[3]}.${bytes[4]}`, port };
}

/** The address a framed datagram names, and the rest of it. Null if unframed. */
function readFrame(bytes: Buffer): { address: string; port: number; payload: Buffer } | null {
  if (bytes.length < FRAME_HEADER || bytes[0] !== FRAME_DATAGRAM) return null;
  return {
    address: `${bytes[1]}.${bytes[2]}.${bytes[3]}.${bytes[4]}`,
    port: bytes.readUInt16BE(5),
    payload: bytes.subarray(FRAME_HEADER),
  };
}

/** How long an identity stays good enough to re-admit on without asking again. */
const GRACE_MS = 60_000;

/**
 * And how long a connection may go without saying where it plays.
 *
 * The handshake decides nothing here — there is no token on the URL any more — so this is
 * the only thing standing between the relay and a client that connects and then says
 * nothing at all, forever. An agent speaks as soon as its game has a socket, which is
 * before it has a peer to send to, so ten seconds is not a race anybody can lose.
 */
const IDENTIFY_MS = 10_000;

/**
 * How often a room that is carrying traffic says so.
 *
 * A line per datagram would be the game's own tick rate written to disk; a line per room
 * per ten seconds is enough to watch a match cross the tunnel and see the moment it stops.
 */
const TALLY_MS = 10_000;

/** Bytes, as something a person reads at a glance in a log. */
function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? ((): void => {});
  const agents = new Set<Agent>();
  /** Every open connection, admitted or not — what `close()` has to let go of. */
  const peers = new Set<WebSocketPeer>();
  const recent = new Map<string, { nick: string; room: string; roster: PeerEndpoint[]; at: number }>();
  /** What each room has carried since it last said so — see TALLY_MS. */
  const tally = new Map<string, { since: number; datagrams: number; bytes: number }>();

  const inRoom = (room: string): Agent[] => [...agents].filter((one) => one.room === room);

  /**
   * Drop the identities nobody can still be re-admitted on.
   *
   * `recent` exists so a wifi blip during a core restart does not end a match, which means
   * it must outlive a disconnection — but only by GRACE_MS, after which an entry is a dead
   * endpoint kept for the life of the process. Swept when a connection ends rather than on
   * a timer: that is the only moment new ones stop arriving, and it needs nothing to clean
   * up afterwards.
   */
  const sweep = (): void => {
    const now = Date.now();
    for (const [key, identity] of recent) if (now - identity.at >= GRACE_MS) recent.delete(key);
  };

  const core = new CoreClient({ url: options.coreUrl, service: 'relay', log });
  core.start();

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const body = JSON.stringify({ ok: true, agents: agents.size, core: core.connected });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('the relay speaks WebSocket at /agent\n');
  });

  serveWebSocket(server, (peer) => {
    peers.add(peer);
    let agent: Agent | null = null;
    /** Set the moment the agent has said where it plays; the core is asked once, not twice. */
    let asked = false;
    /** Datagrams that arrive while the core is still being asked. A handful, then stop. */
    const early: Buffer[] = [];

    const admit = (mine: PeerEndpoint, identity: { nick: string; room: string; roster?: PeerEndpoint[] }): void => {
      agent = { peer, nick: identity.nick, room: identity.room, endpoint: mine, carried: { datagrams: 0, bytes: 0 } };
      agents.add(agent);
      recent.set(`${mine.address}:${mine.port}`, {
        nick: identity.nick,
        room: identity.room,
        roster: identity.roster ?? [],
        at: Date.now(),
      });
      log(
        `relay ${identity.nick} joined room ${identity.room} ` +
          `(${inRoom(identity.room).length} there, at ${mine.address}:${mine.port})`,
      );
      for (const held of early.splice(0)) forward(agent, held);
    };

    const refuse = (why: string): void => {
      log(`relay refused a connection: ${why}`);
      peer.close();
    };

    // Nothing about the handshake says who this is, so silence cannot be waited on
    // indefinitely.
    const mute = setTimeout(() => {
      if (!agent && !asked) refuse('it never said where it plays');
    }, options.identifyMs ?? IDENTIFY_MS);
    mute.unref?.();

    /**
     * An agent has said where its game is. Now the lobby decides whether that is anybody.
     *
     * The core is ASKED FIRST, every time. The grace window is for a core that cannot
     * answer — it is not a shortcut past one that can: a "no" is final, and an agent whose
     * game has ended must be refused even though he was admitted a minute ago. Answering
     * that out of the cache is what this did at first, and what let a finished room keep
     * taking connections.
     */
    const identify = (mine: PeerEndpoint): void => {
      core
        .identifyAgent(mine.address, mine.port)
        .then((identity) =>
          identity ? admit(mine, identity) : refuse(`nobody the lobby knows is playing at ${mine.address}:${mine.port}`),
        )
        .catch((error: Error) => {
          const cached = recent.get(`${mine.address}:${mine.port}`);
          if (cached && Date.now() - cached.at < GRACE_MS) {
            log(`relay the core did not answer (${error.message}) — admitting ${cached.nick} on a minute-old identity`);
            admit(mine, cached);
            return;
          }
          refuse(`the core did not answer — ${error.message}`);
        });
    };

    peer.onMessage((bytes) => {
      if (agent) {
        forward(agent, bytes);
        return;
      }
      // Nothing is known about this connection until it says where it plays. That is the
      // whole of what an agent presents — no secret, no name — and the lobby turns it into
      // a player or does not.
      const hello = readIdentify(bytes);
      if (hello && !asked) {
        asked = true;
        identify(hello);
        return;
      }
      // Still waiting on the core. A datagram is worth holding for the moment that takes;
      // a flood before an identity is not, and is where an unidentified client would
      // otherwise buy itself memory.
      if (early.length < 32) early.push(bytes);
    });

    peer.onClose(() => {
      clearTimeout(mute);
      peers.delete(peer);
      sweep();
      if (!agent) return;
      agents.delete(agent);
      const left = inRoom(agent.room).length;
      log(
        `relay ${agent.nick} left room ${agent.room} — carried ` +
          `${agent.carried.datagrams} datagram(s), ${size(agent.carried.bytes)} (${left} still there)`,
      );
      // AND THE ROOM ITSELF, when the last of them goes. A room is nothing but the agents
      // that name it, so it ends by becoming empty rather than by being closed — and its
      // running total goes with it, or the next game to be handed the same room id (they
      // are reused) would inherit the last one's numbers.
      if (left === 0) {
        const carried = tally.get(agent.room);
        tally.delete(agent.room);
        log(`relay room ${agent.room} is empty${carried ? `, ${carried.datagrams} datagram(s) since its last tally` : ''}`);
      }
    });
  });

  /**
   * On to whoever it is for, stamped with who it is from.
   *
   * The sender names an ADDRESS, never an agent and never a connection, so this
   * is still not a proxy anybody can bounce traffic through: the address is
   * looked up among the players of the sender's own room, and a match outside
   * it is not possible because the search never leaves the room.
   *
   * Two fallbacks, both of which keep two players working while the endpoints
   * are not known: an unframed datagram (an older agent) goes to the others as
   * it arrived, and a framed one whose address matches nobody goes to the
   * others re-stamped, which with one other agent is exactly right and with two
   * is the best a nameless datagram allows.
   */
  function forward(from: Agent, bytes: Buffer): void {
    const others = inRoom(from.room).filter((one) => one !== from);
    count(from, bytes.length, others.length);
    const frame = readFrame(bytes);
    if (!frame) {
      for (const other of others) other.peer.send(bytes);
      return;
    }
    const stamped = frameFor(from.endpoint, frame.payload);
    const wanted = others.filter(
      (one) => one.endpoint && one.endpoint.address === frame.address && one.endpoint.port === frame.port,
    );
    for (const other of wanted.length ? wanted : others) other.peer.send(stamped);
    if (!wanted.length && others.length > 1) {
      // Worth saying once it can actually go wrong: with three in a room and no
      // endpoint to match, everybody gets everybody's traffic.
      log(`relay ${from.nick} named ${frame.address}:${frame.port}, which is nobody here — sent to all ${others.length}`);
    }
  }

  /**
   * The traffic, said out loud — the first datagram, and then a line per room per TALLY_MS.
   *
   * The first one gets its own line because it is the answer to the only question a test of
   * the network is asking: whether anything at all crossed. Everything after it is a rate,
   * and a rate is worth one line every ten seconds and not one per packet.
   */
  function count(from: Agent, bytes: number, to: number): void {
    from.carried.datagrams += 1;
    from.carried.bytes += bytes;
    const now = Date.now();
    if (from.carried.datagrams === 1) {
      log(`relay first datagram from ${from.nick} in room ${from.room} — ${bytes} B to ${to} peer(s)`);
    }
    const room = tally.get(from.room) ?? { since: now, datagrams: 0, bytes: 0 };
    room.datagrams += 1;
    room.bytes += bytes;
    tally.set(from.room, room);
    if (now - room.since < TALLY_MS) return;
    const seconds = (now - room.since) / 1000;
    log(
      `relay room ${from.room} carried ${room.datagrams} datagram(s), ${size(room.bytes)} ` +
        `in ${seconds.toFixed(0)}s (${Math.round(room.datagrams / seconds)}/s, ${inRoom(from.room).length} there)`,
    );
    tally.set(from.room, { since: now, datagrams: 0, bytes: 0 });
  }

  return new Promise((resolve) => {
    server.listen(options.port, options.bind, () => {
      resolve({
        server,
        port: () => (server.address() as { port: number }).port,
        rooms: () => {
          const out: Record<string, string[]> = {};
          for (const agent of agents) (out[agent.room] ??= []).push(agent.nick);
          return out;
        },
        close: () =>
          new Promise<void>((done) => {
            core.stop();
            // EVERY connection, not only the admitted ones. `server.close()` waits for the
            // sockets that are still open, and one that never identified is still a socket
            // — closing only the agents left it holding the door, and a suite that ought to
            // have gone red hung instead. Found by sabotaging the silence timeout.
            for (const one of peers) one.close();
            server.close(() => done());
          }),
      });
    });
  });
}

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

export function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? ((): void => {});
  const agents = new Set<Agent>();
  const recent = new Map<string, { nick: string; room: string; roster: PeerEndpoint[]; at: number }>();

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
    let agent: Agent | null = null;
    /** Set the moment the agent has said where it plays; the core is asked once, not twice. */
    let asked = false;
    /** Datagrams that arrive while the core is still being asked. A handful, then stop. */
    const early: Buffer[] = [];

    const admit = (mine: PeerEndpoint, identity: { nick: string; room: string; roster?: PeerEndpoint[] }): void => {
      agent = { peer, nick: identity.nick, room: identity.room, endpoint: mine };
      agents.add(agent);
      recent.set(`${mine.address}:${mine.port}`, {
        nick: identity.nick,
        room: identity.room,
        roster: identity.roster ?? [],
        at: Date.now(),
      });
      log(
        `relay ${identity.nick} joined room ${identity.room} ` +
          `(${[...agents].filter((a) => a.room === identity.room).length} there, ` +
          `at ${mine.address}:${mine.port})`,
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
      if (!agent) return;
      agents.delete(agent);
      log(`relay ${agent.nick} left room ${agent.room}`);
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
    const inRoom = [...agents].filter((one) => one !== from && one.room === from.room);
    const frame = readFrame(bytes);
    if (!frame) {
      for (const other of inRoom) other.peer.send(bytes);
      return;
    }
    const stamped = frameFor(from.endpoint, frame.payload);
    const wanted = inRoom.filter(
      (one) => one.endpoint && one.endpoint.address === frame.address && one.endpoint.port === frame.port,
    );
    for (const other of wanted.length ? wanted : inRoom) other.peer.send(stamped);
    if (!wanted.length && inRoom.length > 1) {
      // Worth saying once it can actually go wrong: with three in a room and no
      // endpoint to match, everybody gets everybody's traffic.
      log(`relay ${from.nick} named ${frame.address}:${frame.port}, which is nobody here — sent to all ${inRoom.length}`);
    }
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
            for (const agent of agents) agent.peer.close();
            server.close(() => done());
          }),
      });
    });
  });
}

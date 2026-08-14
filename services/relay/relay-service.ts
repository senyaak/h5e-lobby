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
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

export interface RelayOptions {
  host: string;
  port: number;
  coreUrl: string;
  coreToken: string;
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
}

/** How long an identity stays good enough to re-admit on without asking again. */
const GRACE_MS = 60_000;

export function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? ((): void => {});
  const agents = new Set<Agent>();
  const recent = new Map<string, { nick: string; room: string; at: number }>();

  const core = new CoreClient({ url: options.coreUrl, token: options.coreToken, service: 'relay', log });
  core.start();

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const body = JSON.stringify({ ok: true, agents: agents.size, core: core.connected });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('the relay speaks WebSocket at /agent?token=…\n');
  });

  serveWebSocket(server, (peer) => {
    const token = new URL(peer.url, 'http://relay').searchParams.get('token') ?? '';
    let agent: Agent | null = null;
    /** Datagrams that arrive while the core is still being asked. A handful, then stop. */
    const early: Buffer[] = [];

    const admit = (identity: { nick: string; room: string }): void => {
      agent = { peer, nick: identity.nick, room: identity.room };
      agents.add(agent);
      recent.set(token, { ...identity, at: Date.now() });
      log(`relay ${identity.nick} joined room ${identity.room} (${[...agents].filter((a) => a.room === identity.room).length} there)`);
      for (const held of early.splice(0)) forward(agent, held);
    };

    const refuse = (why: string): void => {
      log(`relay refused a connection: ${why}`);
      peer.close();
    };

    const cached = recent.get(token);
    if (cached && Date.now() - cached.at < GRACE_MS) {
      admit(cached);
    } else if (!token) {
      refuse('no token');
    } else {
      core
        .identifyAgent(token)
        .then((identity) => (identity ? admit(identity) : refuse('the core does not know that agent')))
        .catch((error: Error) => refuse(`the core did not answer — ${error.message}`));
    }

    peer.onMessage((bytes) => {
      if (agent) {
        forward(agent, bytes);
        return;
      }
      // Still waiting on the core. A datagram is worth holding for the moment that takes;
      // a flood before an identity is not, and is where an unidentified client would
      // otherwise buy itself memory.
      if (early.length < 32) early.push(bytes);
    });

    peer.onClose(() => {
      if (!agent) return;
      agents.delete(agent);
      log(`relay ${agent.nick} left room ${agent.room}`);
    });
  });

  /** To the others in the room. Never anywhere the sender named. */
  function forward(from: Agent, bytes: Buffer): void {
    for (const other of agents) if (other !== from && other.room === from.room) other.peer.send(bytes);
  }

  return new Promise((resolve) => {
    server.listen(options.port, options.host, () => {
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

// The core, on a socket.
//
// `CoreService` answers; this puts it behind a WebSocket and a health check. It is its own
// file so that the tests can raise a whole core on an ephemeral port with a database that
// lives in memory, and be testing the same thing `services/core/main.ts` runs.
//
// Exports:
//   startCore(options)   listening, with close()

import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CoreService } from './core-service.ts';
import type { ChannelInfo } from '../../shared/core-protocol.ts';
import { serveWebSocket } from '../../shared/websocket.ts';

export interface CoreServerOptions {
  /**
   * The address to bind, and it may only be a loopback one — see `LOOPBACK` below. There
   * is deliberately no environment variable behind this: a core reachable from off the
   * host is a core with nothing in front of it.
   */
  bind: string;
  port: number;
  db: DatabaseSync;
  channels: ChannelInfo[];
  log?: (line: string) => void;
}

export interface RunningCore {
  core: CoreService;
  server: Server;
  port(): number;
  /** `ws://…/core`, which is what the other services are configured with. */
  url(): string;
  /**
   * Stop listening, and cut every connection that is open.
   *
   * A plain `server.close()` waits for its sockets, and a WebSocket does not end on its
   * own — so without this, closing the core leaves the services still talking to it. That
   * is exactly the state a test of "the core is away" must not be in.
   */
  close(): Promise<void>;
}

/**
 * The addresses the core is allowed to bind. Everything that talks to it — the gateway,
 * the web, the relay — is on the same host by design (docs/ARCHITECTURE.md), so the list
 * is the loopback interface and nothing else. `0.0.0.0` is not on it, which is the point:
 * it is the value a well-meaning "make it reachable" edit reaches for first.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function startCore(options: CoreServerOptions): Promise<RunningCore> {
  if (!LOOPBACK.has(options.bind)) {
    throw new Error(
      `core: refusing to listen on ${options.bind} — the core is loopback only, and that bind is its whole defence. ` +
        `If it truly has to move, it needs a way in of its own, not a share of H5E_BIND.`,
    );
  }

  const core = new CoreService({
    db: options.db,
    channels: options.channels,
    ...(options.log ? { log: options.log } : {}),
  });

  const server = createServer((request, response) => {
    // One plain answer, so "is the core up" is a question anything can ask — a shell, a
    // systemd ExecStartPre, the web page's own banner.
    if (request.url === '/health') {
      const body = JSON.stringify({ ok: true, connections: core.connections, messages: core.chat.size });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('the core speaks WebSocket at /core\n');
  });

  const peers = new Set<{ close(): void }>();
  serveWebSocket(server, (peer) => {
    const connection = core.connect((text) => peer.sendText(text));
    peers.add(peer);
    peer.onMessage((bytes) => connection.receive(bytes));
    peer.onClose(() => {
      peers.delete(peer);
      connection.close();
    });
  });

  return new Promise((resolve, reject) => {
    // A socket that cannot be had — the port taken, the address not this machine's — is a
    // message, not a stack trace: without this, `listen` raises an 'error' event nobody is
    // listening for and Node ends the process on the spot.
    server.on('error', (error: Error) => reject(new Error(`core: cannot listen on ${options.bind}:${options.port} — ${error.message}`)));
    server.listen(options.port, options.bind, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        core,
        server,
        port: () => port,
        url: () => `ws://${options.bind}:${port}/core`,
        close: () =>
          new Promise<void>((done) => {
            for (const peer of [...peers]) peer.close();
            server.close(() => done());
          }),
      });
    });
  });
}

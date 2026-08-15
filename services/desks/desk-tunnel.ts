// The desk tunnel — the game's own sockets, carried over one WebSocket.
//
// WHY THIS EXISTS. A tunnel of the cloudflared family carries HTTP and WebSocket and
// nothing else. The game speaks HTTP to us exactly once, for its server list, and raw TCP
// and UDP for everything after that — so no configuration of a tunnel can put the desks
// behind one (SLICE_over_the_internet.md §1). The peer half solved the same problem years
// of design earlier in this project: the mod inside the game holds the socket and carries
// its bytes out over an outbound WebSocket. This is that trick applied to the other half.
//
// WHAT IT IS NOT. It is not a change to the gateway, and it must never become one. The
// gateway accepts ordinary sockets and works out which desk a connection is from the bytes
// it sends first (`services/gateway/desk.ts`) — so a tunnelled connection is given to it as
// an ordinary socket, opened here on the loopback. The gateway cannot tell the difference
// and is not told. That is also what keeps the two halves separable: the desks know nothing
// about the tunnel, and the tunnel knows nothing about the desks beyond the port they are
// on.
//
// THE PROTOCOL, one byte of type and then the rest:
//
//   0x01 [id:u16] payload   bytes on a TCP stream, either direction
//   0x02 [id:u16]           open a stream                        (client -> server)
//   0x03 [id:u16]           the stream ended, either direction
//   0x04 payload            one datagram, either direction
//
// Stream ids are the client's to choose and are unique within one connection; nothing here
// hands them out, so a client can open a stream and write to it in the same breath without
// waiting for an answer. The ids of two different clients never meet: each connection has
// its own table.
//
// Exports:
//   startDeskTunnel(options) -> RunningDeskTunnel

import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

export interface DeskTunnelOptions {
  bind: string;
  port: number;
  /** Where the desks actually are. The loopback, because they are on this host with us. */
  deskHost: string;
  deskPort: number;
  log?: (line: string) => void;
}

export interface RunningDeskTunnel {
  port(): number;
  /** How many clients are carrying their desks through here — for `/health` and the tests. */
  clients(): number;
  close(): Promise<void>;
}

const FRAME_DATA = 0x01;
const FRAME_OPEN = 0x02;
const FRAME_CLOSE = 0x03;
const FRAME_DATAGRAM = 0x04;

/** Type and stream id. A datagram carries the type alone, so its header is one byte. */
const STREAM_HEADER = 3;
const DATAGRAM_HEADER = 1;

function streamFrame(type: number, id: number, payload?: Buffer): Buffer {
  const out = Buffer.alloc(STREAM_HEADER + (payload?.length ?? 0));
  out[0] = type;
  out.writeUInt16BE(id, 1);
  payload?.copy(out, STREAM_HEADER);
  return out;
}

function datagramFrame(payload: Buffer): Buffer {
  const out = Buffer.alloc(DATAGRAM_HEADER + payload.length);
  out[0] = FRAME_DATAGRAM;
  payload.copy(out, DATAGRAM_HEADER);
  return out;
}

export function startDeskTunnel(options: DeskTunnelOptions): Promise<RunningDeskTunnel> {
  const log = options.log ?? ((): void => {});
  const peers = new Set<WebSocketPeer>();
  let clients = 0;

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const body = JSON.stringify({ ok: true, clients });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('the desk tunnel speaks WebSocket at /desks\n');
  });

  serveWebSocket(server, (peer) => {
    peers.add(peer);
    clients++;
    const who = `${peer.remoteAddress}#${clients}`;
    log(`desks ${who} connected (${clients} carrying)`);

    /** The loopback connection standing in for each of this client's desk connections. */
    const streams = new Map<number, Socket>();

    /**
     * This client's datagrams, and only this client's.
     *
     * One socket per connection rather than one for the service: the desks answer the
     * address a datagram came from, and the NAT mirror keeps a conversation per address
     * (`services/gateway/nat-service.ts`). Sharing one socket would merge every player's
     * mirror into one and there would be no way to tell whose answer came back.
     */
    let udp: UdpSocket | null = null;

    const datagrams = (): UdpSocket => {
      if (udp) return udp;
      const socket = createSocket('udp4');
      socket.on('message', (data: Buffer) => peer.send(datagramFrame(data)));
      socket.on('error', (error: Error) => log(`desks ${who} udp error: ${error.message}`));
      udp = socket;
      return socket;
    };

    const open = (id: number): Socket => {
      const existing = streams.get(id);
      if (existing) return existing;
      // Writes made before the connection is up are queued by Node, which is what lets a
      // client open a stream and send its first message without a round trip.
      const socket = createConnection({ host: options.deskHost, port: options.deskPort });
      socket.setNoDelay(true);
      socket.on('data', (data: Buffer) => peer.send(streamFrame(FRAME_DATA, id, data)));
      socket.on('error', (error: Error) => log(`desks ${who} stream ${id} error: ${error.message}`));
      socket.on('close', () => {
        if (!streams.delete(id)) return;
        peer.send(streamFrame(FRAME_CLOSE, id));
        log(`desks ${who} stream ${id} closed by the desk`);
      });
      streams.set(id, socket);
      return socket;
    };

    peer.onMessage((bytes) => {
      if (!bytes.length) return;
      const type = bytes[0];

      if (type === FRAME_DATAGRAM) {
        datagrams().send(bytes.subarray(DATAGRAM_HEADER), options.deskPort, options.deskHost);
        return;
      }

      if (bytes.length < STREAM_HEADER) {
        log(`desks ${who} sent ${bytes.length} bytes of a stream frame, which is not one — ignored`);
        return;
      }
      const id = bytes.readUInt16BE(1);

      if (type === FRAME_OPEN) {
        open(id);
        log(`desks ${who} opened stream ${id}`);
        return;
      }
      if (type === FRAME_DATA) {
        // An implicit open: a client that writes to a stream it never announced still gets
        // one. The alternative is dropping the first message of a connection because two
        // frames crossed, and a dropped first message is exactly what the desk classifier
        // has no way to recover from.
        open(id).write(bytes.subarray(STREAM_HEADER));
        return;
      }
      if (type === FRAME_CLOSE) {
        streams.get(id)?.end();
        return;
      }
      log(`desks ${who} sent frame type ${String(type)}, which is not one of ours — ignored`);
    });

    peer.onClose(() => {
      peers.delete(peer);
      clients--;
      for (const [, socket] of streams) socket.destroy();
      streams.clear();
      udp?.close();
      udp = null;
      log(`desks ${who} gone (${clients} carrying)`);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port, options.bind, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port: () => port,
        clients: () => clients,
        close: () =>
          new Promise((done) => {
            // Every connection, not only the ones with streams open: a client that has said
            // nothing still holds a socket, and a close that waits for it never returns.
            for (const peer of peers) peer.close();
            peers.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

// The u-lobby tunnel — the game's own sockets, carried over one WebSocket.
//
// WHY THIS EXISTS. A tunnel of the cloudflared family carries HTTP and WebSocket and
// nothing else. The game speaks HTTP to us exactly once, for its server list, and raw TCP
// and UDP for everything after that — so no configuration of a tunnel can put the u-lobby services
// behind one (SLICE_over_the_internet.md §1). The peer half solved the same problem years
// of design earlier in this project: the mod inside the game holds the socket and carries
// its bytes out over an outbound WebSocket. This is that trick applied to the other half.
//
// WHAT IT IS NOT. It is not a change to the gateway, and it must never become one. The
// gateway accepts ordinary sockets and works out which u-lobby service a connection is from the bytes
// it sends first (`services/gateway/u-lobby.ts`) — so a tunnelled connection is given to it as
// an ordinary socket, opened here on the loopback. The gateway cannot tell the difference
// and is not told. That is also what keeps the two halves separable: the u-lobby services know nothing
// about the tunnel, and the tunnel knows nothing about the u-lobby services beyond the port they are
// on.
//
// THE PROTOCOL, one byte of type and then the rest:
//
//   0x01 [id:u16] payload   bytes on a TCP stream, either direction
//   0x02 [id:u16]           open a stream                        (client -> server)
//   0x03 [id:u16]           the stream ended, either direction
//   0x04 [id:u16] payload   one datagram, on a channel, either direction
//
// Ids are the client's to choose and are unique within one connection; nothing here hands
// them out, so a client can open a stream and write to it in the same breath without
// waiting for an answer. The ids of two different clients never meet: each connection has
// its own table. Streams and channels are numbered apart — one table each.
//
// WHY A DATAGRAM CARRIES A CHANNEL AND NOT JUST ITSELF. Two of the game's u-lobby services are UDP —
// the NAT mirror and the CD-key window — and the client may well ask them from two sockets
// of its own. An answer has to come back to the socket that asked, and once it has crossed
// a WebSocket the only thing that can say which one that was is a number the client put
// there. So each of the client's source addresses is a channel, and each channel gets a
// datagram socket of its own here.
//
// Exports:
//   startULobbyTunnel(options) -> RunningULobbyTunnel

import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

export interface ULobbyTunnelOptions {
  bind: string;
  port: number;
  /** Where the u-lobby actually is. The loopback, because they are on this host with us. */
  gatewayHost: string;
  gatewayPort: number;
  log?: (line: string) => void;
}

export interface RunningULobbyTunnel {
  port(): number;
  /** How many clients are carrying their u-lobby through here — for `/health` and the tests. */
  clients(): number;
  close(): Promise<void>;
}

const FRAME_DATA = 0x01;
const FRAME_OPEN = 0x02;
const FRAME_CLOSE = 0x03;
const FRAME_DATAGRAM = 0x04;

/** Type and id, the same three bytes in front of every frame there is. */
const HEADER = 3;

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const out = Buffer.alloc(HEADER + (payload?.length ?? 0));
  out[0] = type;
  out.writeUInt16BE(id, 1);
  payload?.copy(out, HEADER);
  return out;
}

export function startULobbyTunnel(options: ULobbyTunnelOptions): Promise<RunningULobbyTunnel> {
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
    response.end('the u-lobby tunnel speaks WebSocket at /u-lobby\n');
  });

  serveWebSocket(server, (peer) => {
    peers.add(peer);
    clients++;
    const who = `${peer.remoteAddress}#${clients}`;
    log(`u-lobby ${who} connected (${clients} carrying)`);

    /** The loopback connection standing in for each of this client's u-lobby connections. */
    const streams = new Map<number, Socket>();

    /**
     * A datagram socket per channel, and every one of them this client's alone.
     *
     * Never one for the service and never even one for the connection: the u-lobby services answer
     * the address a datagram came from, and the NAT mirror keeps a conversation per
     * address (`services/gateway/nat-service.ts`). One socket for everybody would merge
     * every player's mirror into one; one socket per connection would merge the two u-lobby services
     * a single player asks from two sockets of his own.
     */
    const channels = new Map<number, UdpSocket>();

    const datagrams = (id: number): UdpSocket => {
      const existing = channels.get(id);
      if (existing) return existing;
      const socket = createSocket('udp4');
      socket.on('message', (data: Buffer) => peer.send(frame(FRAME_DATAGRAM, id, data)));
      socket.on('error', (error: Error) => log(`u-lobby ${who} channel ${id} error: ${error.message}`));
      channels.set(id, socket);
      return socket;
    };

    const open = (id: number): Socket => {
      const existing = streams.get(id);
      if (existing) return existing;
      // Writes made before the connection is up are queued by Node, which is what lets a
      // client open a stream and send its first message without a round trip.
      const socket = createConnection({ host: options.gatewayHost, port: options.gatewayPort });
      socket.setNoDelay(true);
      socket.on('data', (data: Buffer) => peer.send(frame(FRAME_DATA, id, data)));
      socket.on('error', (error: Error) => log(`u-lobby ${who} stream ${id} error: ${error.message}`));
      socket.on('close', () => {
        if (!streams.delete(id)) return;
        peer.send(frame(FRAME_CLOSE, id));
        log(`u-lobby ${who} stream ${id} closed by the u-lobby service`);
      });
      streams.set(id, socket);
      return socket;
    };

    peer.onMessage((bytes) => {
      if (bytes.length < HEADER) {
        log(`u-lobby ${who} sent ${bytes.length} bytes, which is not a frame — ignored`);
        return;
      }
      const type = bytes[0];
      const id = bytes.readUInt16BE(1);

      if (type === FRAME_DATAGRAM) {
        datagrams(id).send(bytes.subarray(HEADER), options.gatewayPort, options.gatewayHost);
        return;
      }
      if (type === FRAME_OPEN) {
        open(id);
        log(`u-lobby ${who} opened stream ${id}`);
        return;
      }
      if (type === FRAME_DATA) {
        // An implicit open: a client that writes to a stream it never announced still gets
        // one. The alternative is dropping the first message of a connection because two
        // frames crossed, and a dropped first message is exactly what the u-lobby classifier
        // has no way to recover from.
        open(id).write(bytes.subarray(HEADER));
        return;
      }
      if (type === FRAME_CLOSE) {
        streams.get(id)?.end();
        return;
      }
      log(`u-lobby ${who} sent frame type ${String(type)}, which is not one of ours — ignored`);
    });

    peer.onClose(() => {
      peers.delete(peer);
      clients--;
      for (const [, socket] of streams) socket.destroy();
      streams.clear();
      for (const [, socket] of channels) socket.close();
      channels.clear();
      log(`u-lobby ${who} gone (${clients} carrying)`);
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

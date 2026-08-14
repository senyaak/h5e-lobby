// A WebSocket server, in the one shape this project needs: binary messages, no
// extensions, no fragmentation on the way out.
//
// Why ours rather than a package: the game's own packets are what travel here, and a
// datagram must arrive as the datagram it was — WebSocket is message-oriented, so one
// message is one datagram and nothing else has to be framed. That is a hundred lines of
// RFC 6455, next to the Blowfish and SRP already in this folder, against a dependency in
// a repository that has none.
//
// TLS is deliberately absent. The relay is reached from outside through a tunnel
// (cloudflared) that terminates HTTPS and speaks plain HTTP to the local port, so
// `wss://` on the internet is this same `ws://` here. Nothing in our code has to know.
//
// Exports:
//   WebSocketPeer          one connected client: send(bytes), close(), events
//   serveWebSocket(server) attach to a node:http server; returns the peer stream

import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** RFC 6455's magic, appended to the client key before the hash. */
const ACCEPT_SALT = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** The handshake answer for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + ACCEPT_SALT)
    .digest('base64');
}

/**
 * One frame at the front of `buf`, or null while it is still incomplete.
 *
 * Only what a client sends is handled: client frames are always masked, and this refuses
 * an unmasked one rather than reading it, because an unmasked client frame is either a
 * broken implementation or not a WebSocket at all.
 */
function readFrame(buf: Buffer): { opcode: number; payload: Buffer; size: number; fin: boolean } | null {
  if (buf.length < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let at = 2;

  if (length === 126) {
    if (buf.length < at + 2) return null;
    length = buf.readUInt16BE(at);
    at += 2;
  } else if (length === 127) {
    if (buf.length < at + 8) return null;
    const big = buf.readBigUInt64BE(at);
    // A frame we could not hold in a Buffer anyway, and nothing here sends one.
    if (big > 0x7fffffffn) throw new Error(`websocket: a ${String(big)}-byte frame is not something this carries`);
    length = Number(big);
    at += 8;
  }

  if (!masked) throw new Error('websocket: a client frame must be masked');
  if (buf.length < at + 4 + length) return null;
  const mask = buf.subarray(at, at + 4);
  at += 4;

  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) payload[i] = buf[at + i]! ^ mask[i & 3]!;
  return { opcode, payload, size: at + length, fin };
}

/** A frame to send: server frames are never masked. */
function writeFrame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 0x10000
        ? (() => {
            const b = Buffer.alloc(4);
            b[0] = 0x80 | opcode;
            b[1] = 126;
            b.writeUInt16BE(payload.length, 2);
            return b;
          })()
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(payload.length), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
}

export interface WebSocketPeer {
  /** What the client asked for — the relay reads the room and the player out of it. */
  readonly url: string;
  readonly remoteAddress: string;
  send(bytes: Uint8Array): void;
  close(): void;
  onMessage(handler: (bytes: Buffer) => void): void;
  onClose(handler: () => void): void;
}

function attach(socket: Duplex, url: string): WebSocketPeer {
  const messageHandlers: ((bytes: Buffer) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let buffered = Buffer.alloc(0);
  // A message split across frames is reassembled; the game's datagrams are far too small
  // for a client to fragment one, but a client we did not write is free to.
  let partial: { opcode: number; chunks: Buffer[] } | null = null;
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  socket.on('data', (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    try {
      for (;;) {
        const frame = readFrame(buffered);
        if (!frame) break;
        buffered = buffered.subarray(frame.size);

        if (frame.opcode === OPCODE.close) {
          socket.end(writeFrame(OPCODE.close, Buffer.alloc(0)));
          finish();
          return;
        }
        if (frame.opcode === OPCODE.ping) {
          socket.write(writeFrame(OPCODE.pong, frame.payload));
          continue;
        }
        if (frame.opcode === OPCODE.pong) continue;

        if (frame.opcode === OPCODE.continuation) {
          if (!partial) throw new Error('websocket: a continuation with nothing to continue');
          partial.chunks.push(frame.payload);
        } else {
          partial = { opcode: frame.opcode, chunks: [frame.payload] };
        }
        if (!frame.fin) continue;

        const whole = partial.chunks.length === 1 ? partial.chunks[0]! : Buffer.concat(partial.chunks);
        partial = null;
        for (const handler of messageHandlers) handler(whole);
      }
    } catch (error) {
      // A frame we cannot read means the stream is no longer a WebSocket; there is
      // nothing to recover to, so the connection goes rather than the process.
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
      finish();
    }
  });

  socket.on('close', finish);
  socket.on('error', finish);

  return {
    url,
    remoteAddress: socket.remoteAddress ?? '',
    send(bytes) {
      if (closed) return;
      socket.write(writeFrame(OPCODE.binary, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
    },
    close() {
      if (closed) return;
      socket.end(writeFrame(OPCODE.close, Buffer.alloc(0)));
      finish();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

/**
 * Answer WebSocket upgrades on an http server, and hand each accepted client over.
 *
 * A request that is not a WebSocket upgrade is refused with 400 rather than left hanging,
 * so a browser pointed at the relay by mistake says so instead of spinning.
 */
export function serveWebSocket(server: Server, onPeer: (peer: WebSocketPeer) => void): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const key = request.headers['sec-websocket-key'];
    const upgrade = String(request.headers['upgrade'] ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    onPeer(attach(socket, request.url ?? '/'));
  });
}

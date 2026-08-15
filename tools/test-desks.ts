// The desk tunnel, driven without a game.
//
// What it proves is the thing the tunnel exists for: bytes that would have gone straight
// at the gateway's TCP and UDP sockets arrive there anyway, having crossed a WebSocket,
// and come back to the client that sent them AND NOT TO ANOTHER ONE.
//
// The desks themselves are a stub here — a TCP server and a UDP socket that echo what they
// are given with a mark of their own. That is deliberate: what is being tested is the
// carrying, and a real gateway would drag the core, the database and the whole protocol
// into a test whose subject is a socket.
//
// Usage: `node tools/test-desks.ts`

import { createServer as createTcpServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { startDeskTunnel } from '../services/desks/desk-tunnel.ts';

const WATCHDOG_MS = 60 * 1000;
setTimeout(() => {
  console.log(`
!! this suite has been running for ${WATCHDOG_MS / 1000}s and is not moving — something is holding a handle open
`);
  process.exit(2);
}, WATCHDOG_MS);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function until(ready: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((done) => setTimeout(done, 10));
  }
  return ready();
}

const FRAME_DATA = 0x01;
const FRAME_OPEN = 0x02;
const FRAME_CLOSE = 0x03;
const FRAME_DATAGRAM = 0x04;

function streamFrame(type: number, id: number, payload?: Buffer): Buffer {
  const out = Buffer.alloc(3 + (payload?.length ?? 0));
  out[0] = type;
  out.writeUInt16BE(id, 1);
  payload?.copy(out, 3);
  return out;
}

function datagramFrame(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([FRAME_DATAGRAM]), payload]);
}

// ---------------------------------------------------------------------------------
// The desks, stubbed: a TCP server that answers `desk:<what it heard>` and a UDP socket
// that answers `mirror:<what it heard>@<the port it heard it from>`. The port is in the
// answer because that is what tells one client's mirror from another's, which is the whole
// reason a datagram socket is opened per connection rather than per service.
// ---------------------------------------------------------------------------------

const deskConnections: Socket[] = [];
const tcpDesk = createTcpServer((socket) => {
  // Each connection answers under its own number. Counting connections is not enough to
  // say two streams got two of them — a tunnel that put the second stream on the wrong id
  // still opens two — so the answer has to say WHICH connection served it.
  const mine = deskConnections.push(socket);
  socket.on('data', (data: Buffer) => socket.write(Buffer.from(`desk${String(mine)}:${data.toString()}`)));
  socket.on('error', () => {});
});
await new Promise<void>((done) => tcpDesk.listen(0, '127.0.0.1', () => done()));
const deskPort = (tcpDesk.address() as { port: number }).port;

const udpDesk = createSocket('udp4');
udpDesk.on('message', (data, from) => {
  const answer = Buffer.from(`mirror:${data.toString()}@${String(from.port)}`);
  udpDesk.send(answer, from.port, from.address);
});
await new Promise<void>((done) => udpDesk.bind(deskPort, '127.0.0.1', () => done()));

const tunnel = await startDeskTunnel({
  bind: '127.0.0.1',
  port: 0,
  deskHost: '127.0.0.1',
  deskPort,
  log: () => {},
});

// ---------------------------------------------------------------------------------
// A client is Node's own WebSocket, which is what the browsers in test-services.ts are.
// ---------------------------------------------------------------------------------

interface Client {
  socket: WebSocket;
  /** Every frame that came back, as bytes. */
  heard: Buffer[];
  /** The text of every stream frame, by stream id. */
  onStream(id: number): string;
  datagrams(): string[];
  closed(id: number): boolean;
}

async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(tunnel.port())}/desks`);
  socket.binaryType = 'arraybuffer';
  const heard: Buffer[] = [];
  socket.addEventListener('message', (event) => heard.push(Buffer.from(event.data as ArrayBuffer)));
  await new Promise<void>((done) => socket.addEventListener('open', () => done(), { once: true }));
  return {
    socket,
    heard,
    onStream: (id) =>
      heard
        .filter((frame) => frame[0] === FRAME_DATA && frame.readUInt16BE(1) === id)
        .map((frame) => frame.subarray(3).toString())
        .join(''),
    datagrams: () => heard.filter((frame) => frame[0] === FRAME_DATAGRAM).map((frame) => frame.subarray(1).toString()),
    closed: (id) => heard.some((frame) => frame[0] === FRAME_CLOSE && frame.readUInt16BE(1) === id),
  };
}

console.log('\nthe desk tunnel');

const one = await connect();

// A stream opened and written to in the same breath — the case a client actually produces,
// and the one that fails if the open is not allowed to queue its writes.
one.socket.send(streamFrame(FRAME_OPEN, 7));
one.socket.send(streamFrame(FRAME_DATA, 7, Buffer.from('hello')));
await until(() => one.onStream(7).length > 0);
check('a stream carries bytes to the desk and back', one.onStream(7) === 'desk1:hello', one.onStream(7));

// THE SECOND stream, not the first: with one of anything every id in the table is the same
// id, and a tunnel that ignored the id entirely would pass a one-stream test.
one.socket.send(streamFrame(FRAME_DATA, 9, Buffer.from('second')));
await until(() => one.onStream(9).length > 0);
check('a second stream is its own connection', one.onStream(9) === 'desk2:second', one.onStream(9));
check('and the first one did not hear it', one.onStream(7) === 'desk1:hello', one.onStream(7));

// An implicit open is what that last write was. It has to reach a desk of its own, or two
// streams would share one connection and their bytes would interleave. Which desk served
// which stream is what says so — the count alone stays right while the ids are wrong.
await until(() => deskConnections.length >= 2);
const servedSeven = one.onStream(7).split(':')[0] ?? '';
const servedNine = one.onStream(9).split(':')[0] ?? '';
check(
  'the two streams were served by two different desks',
  servedSeven !== '' && servedNine !== '' && servedSeven !== servedNine,
  `${servedSeven} and ${servedNine}`,
);

one.socket.send(datagramFrame(Buffer.from('ask')));
await until(() => one.datagrams().length > 0);
const firstMirror = one.datagrams()[0] ?? '';
check('a datagram crosses and comes back', firstMirror.startsWith('mirror:ask@'), firstMirror);

// ---------------------------------------------------------------------------------
// A second client. This is the check the per-connection UDP socket exists for: two
// players' mirrors must not be one conversation.
// ---------------------------------------------------------------------------------

const two = await connect();
two.socket.send(datagramFrame(Buffer.from('theirs')));
await until(() => two.datagrams().length > 0);

check('the second client hears its own datagram', (two.datagrams()[0] ?? '').startsWith('mirror:theirs@'), two.datagrams()[0] ?? '');
check('and the first client did not hear it', one.datagrams().length === 1, `${String(one.datagrams().length)} datagrams`);

const portOfOne = firstMirror.split('@')[1] ?? '';
const portOfTwo = (two.datagrams()[0] ?? '').split('@')[1] ?? '';
// BOTH have to be there. A client that heard nothing at all leaves an empty string, which
// differs from any port there is — so "they differ" on its own passes the very failure
// this is here to catch.
check(
  'the desks see two different sources, so two mirrors stay apart',
  portOfOne !== '' && portOfTwo !== '' && portOfOne !== portOfTwo,
  `${portOfOne || '(nothing)'} and ${portOfTwo || '(nothing)'}`,
);

// ---------------------------------------------------------------------------------
// Closing, both ways round.
// ---------------------------------------------------------------------------------

one.socket.send(streamFrame(FRAME_CLOSE, 7));
await until(() => one.closed(7));
check('a stream closed by the client is closed at the desk', one.closed(7));

const before = tunnel.clients();
two.socket.close();
await until(() => tunnel.clients() === before - 1);
check('a client that leaves is let go of', tunnel.clients() === before - 1, `${String(tunnel.clients())} carrying`);

one.socket.close();
await until(() => tunnel.clients() === 0);
await tunnel.close();
await new Promise<void>((done) => tcpDesk.close(() => done()));
udpDesk.close();

console.log(failures === 0 ? '\nall good\n' : `\n${String(failures)} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

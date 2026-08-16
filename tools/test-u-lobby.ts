// The u-lobby's door, driven without a game.
//
// What it proves is the thing the door exists for: bytes that would have gone straight
// at the u-lobby's TCP and UDP sockets arrive there anyway, having crossed a WebSocket,
// and come back to the client that sent them AND NOT TO ANOTHER ONE.
//
// The u-lobby services themselves are a stub here — a TCP server and a UDP socket that echo what they
// are given with a mark of their own. That is deliberate: what is being tested is the
// carrying, and the real u-lobby would drag the core, the database and the whole protocol
// into a test whose subject is a socket.
//
// Usage: `node tools/test-u-lobby.ts`

import { createServer as createTcpServer, createConnection, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryULobby } from '../services/u-lobby/tunnel.ts';

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

function datagramFrame(id: number, payload: Buffer): Buffer {
  return streamFrame(FRAME_DATAGRAM, id, payload);
}

// ---------------------------------------------------------------------------------
// The u-lobby services, stubbed: a TCP server that answers `service<n>:<what it heard>` and a UDP socket
// that answers `mirror:<what it heard>@<the port it heard it from>`. The port is in the
// answer because that is what tells one client's mirror from another's, which is the whole
// reason a datagram socket is opened per connection rather than per service.
// ---------------------------------------------------------------------------------

const serviceConnections: Socket[] = [];
const tcpService = createTcpServer((socket) => {
  // Each connection answers under its own number. Counting connections is not enough to
  // say two streams got two of them — a tunnel that put the second stream on the wrong id
  // still opens two — so the answer has to say WHICH connection served it.
  const mine = serviceConnections.push(socket);
  socket.on('data', (data: Buffer) => socket.write(Buffer.from(`service${String(mine)}:${data.toString()}`)));
  socket.on('error', () => {});
});
await new Promise<void>((done) => tcpService.listen(0, '127.0.0.1', () => done()));
const stubPort = (tcpService.address() as { port: number }).port;

const udpService = createSocket('udp4');
udpService.on('message', (data, from) => {
  const answer = Buffer.from(`mirror:${data.toString()}@${String(from.port)}`);
  udpService.send(answer, from.port, from.address);
});
await new Promise<void>((done) => udpService.bind(stubPort, '127.0.0.1', () => done()));

// The door hangs on an HTTP server the way it hangs on the u-lobby's own: here the
// server is this test's, so the carry can point at the stub.
const doorServer = createHttpServer();
const carry = carryULobby({
  server: doorServer,
  target: { host: '127.0.0.1', port: stubPort },
  log: () => {},
});
await new Promise<void>((done) => doorServer.listen(0, '127.0.0.1', () => done()));
const doorPort = (doorServer.address() as { port: number }).port;

// ---------------------------------------------------------------------------------
// A client is Node's own WebSocket, which is what the browsers in test-services.ts are.
// ---------------------------------------------------------------------------------

interface Client {
  socket: WebSocket;
  /** Every frame that came back, as bytes. */
  heard: Buffer[];
  /** The text of every stream frame, by stream id. */
  onStream(id: number): string;
  datagrams(id?: number): string[];
  closed(id: number): boolean;
}

async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(doorPort)}/u-lobby`);
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
    datagrams: (id?: number) =>
      heard
        .filter((frame) => frame[0] === FRAME_DATAGRAM && (id === undefined || frame.readUInt16BE(1) === id))
        .map((frame) => frame.subarray(3).toString()),
    closed: (id) => heard.some((frame) => frame[0] === FRAME_CLOSE && frame.readUInt16BE(1) === id),
  };
}

console.log('\nthe u-lobby door, against a stub');

const one = await connect();

// A stream opened and written to in the same breath — the case a client actually produces,
// and the one that fails if the open is not allowed to queue its writes.
one.socket.send(streamFrame(FRAME_OPEN, 7));
one.socket.send(streamFrame(FRAME_DATA, 7, Buffer.from('hello')));
await until(() => one.onStream(7).length > 0);
check('a stream carries bytes to the u-lobby service and back', one.onStream(7) === 'service1:hello', one.onStream(7));

// THE SECOND stream, not the first: with one of anything every id in the table is the same
// id, and a tunnel that ignored the id entirely would pass a one-stream test.
one.socket.send(streamFrame(FRAME_DATA, 9, Buffer.from('second')));
await until(() => one.onStream(9).length > 0);
check('a second stream is its own connection', one.onStream(9) === 'service2:second', one.onStream(9));
check('and the first one did not hear it', one.onStream(7) === 'service1:hello', one.onStream(7));

// An implicit open is what that last write was. It has to reach a connection of its own, or two
// streams would share one and their bytes would interleave. Which stub connection served
// which stream is what says so — the count alone stays right while the ids are wrong.
await until(() => serviceConnections.length >= 2);
const servedSeven = one.onStream(7).split(':')[0] ?? '';
const servedNine = one.onStream(9).split(':')[0] ?? '';
check(
  'the two streams were served by two different u-lobby services',
  servedSeven !== '' && servedNine !== '' && servedSeven !== servedNine,
  `${servedSeven} and ${servedNine}`,
);

one.socket.send(datagramFrame(1, Buffer.from('ask')));
await until(() => one.datagrams(1).length > 0);
const firstMirror = one.datagrams(1)[0] ?? '';
check('a datagram crosses and comes back', firstMirror.startsWith('mirror:ask@'), firstMirror);

// A SECOND channel from the same client. This is why a datagram carries a channel at all:
// the game asks two UDP u-lobby services, may well ask them from two sockets of its own, and each
// answer has to come back to the socket that asked.
one.socket.send(datagramFrame(2, Buffer.from('other')));
await until(() => one.datagrams(2).length > 0);
const secondMirror = one.datagrams(2)[0] ?? '';
check('a second channel is its own conversation', secondMirror.startsWith('mirror:other@'), secondMirror);
check('and the first channel did not hear it', one.datagrams(1).length === 1, `${String(one.datagrams(1).length)} on channel 1`);

const sourceOfOne = firstMirror.split('@')[1] ?? '';
const sourceOfTwo = secondMirror.split('@')[1] ?? '';
check(
  'two channels are two sockets at the u-lobby service',
  sourceOfOne !== '' && sourceOfTwo !== '' && sourceOfOne !== sourceOfTwo,
  `${sourceOfOne || '(nothing)'} and ${sourceOfTwo || '(nothing)'}`,
);

// ---------------------------------------------------------------------------------
// A second client. This is the check the per-connection UDP socket exists for: two
// players' mirrors must not be one conversation.
// ---------------------------------------------------------------------------------

const two = await connect();
// Channel 1 again, deliberately: ids are the client's own and two clients using the same
// number must still be two conversations.
two.socket.send(datagramFrame(1, Buffer.from('theirs')));
await until(() => two.datagrams().length > 0);

check('the second client hears its own datagram', (two.datagrams()[0] ?? '').startsWith('mirror:theirs@'), two.datagrams()[0] ?? '');
check('and the first client did not hear it', one.datagrams().length === 2, `${String(one.datagrams().length)} datagrams`);

const portOfOne = firstMirror.split('@')[1] ?? '';
const portOfTwo = (two.datagrams()[0] ?? '').split('@')[1] ?? '';
// BOTH have to be there. A client that heard nothing at all leaves an empty string, which
// differs from any port there is — so "they differ" on its own passes the very failure
// this is here to catch.
check(
  'the u-lobby services see two different sources, so two mirrors stay apart',
  portOfOne !== '' && portOfTwo !== '' && portOfOne !== portOfTwo,
  `${portOfOne || '(nothing)'} and ${portOfTwo || '(nothing)'}`,
);

// ---------------------------------------------------------------------------------
// The door knows whose connection is whose. `?port=` on the upgrade names the
// client's OWN listener, and the carry remembers it against the source port of
// every loopback connection it opens — which is what lets a session hand a
// tunnelled game back to itself (`session()` in router-service.ts).
// ---------------------------------------------------------------------------------

const namedBefore = serviceConnections.length;
const named = new WebSocket(`ws://127.0.0.1:${String(doorPort)}/u-lobby?port=4242`);
named.binaryType = 'arraybuffer';
await new Promise<void>((done) => named.addEventListener('open', () => done(), { once: true }));
named.send(streamFrame(FRAME_OPEN, 1));
await until(() => serviceConnections.length > namedBefore);
const carried = serviceConnections[serviceConnections.length - 1]!;
await until(() => carry.carriedPortOf(carried.remotePort ?? 0) !== null);
check(
  'a door that names a port is remembered, per connection',
  carry.carriedPortOf(carried.remotePort ?? 0) === 4242,
  String(carry.carriedPortOf(carried.remotePort ?? 0)),
);
check(
  'and a client that named nothing stays nobody\'s',
  carry.carriedPortOf(serviceConnections[0]!.remotePort ?? 0) === null,
  String(carry.carriedPortOf(serviceConnections[0]!.remotePort ?? 0)),
);

const carriedPort = carried.remotePort ?? 0;
named.close();
await until(() => carry.carriedPortOf(carriedPort) === null);
check('a door that closed is forgotten', carry.carriedPortOf(carriedPort) === null);

// An upgrade to any other path is refused out loud — reaching the close is the check.
const lost = new WebSocket(`ws://127.0.0.1:${String(doorPort)}/nowhere`);
await new Promise<void>((done) => lost.addEventListener('close', () => done(), { once: true }));
check('an upgrade to anywhere else is turned away', true);

// ---------------------------------------------------------------------------------
// Closing, both ways round.
// ---------------------------------------------------------------------------------

one.socket.send(streamFrame(FRAME_CLOSE, 7));
await until(() => one.closed(7));
check('a stream closed by the client is closed at the u-lobby service', one.closed(7));

const before = carry.clients();
two.socket.close();
await until(() => carry.clients() === before - 1);
check('a client that leaves is let go of', carry.clients() === before - 1, `${String(carry.clients())} carrying`);

one.socket.close();
await until(() => carry.clients() === 0);
carry.close();
await new Promise<void>((done) => doorServer.close(() => done()));
await new Promise<void>((done) => tcpService.close(() => done()));
udpService.close();

// ---------------------------------------------------------------------------------
// And now against the REAL u-lobby.
//
// Everything above is the carrying, checked against a stub on purpose. This is the
// seam nothing else holds: the door is the u-lobby's own — the upgrade answered on
// the same port as everything else — and a stream that comes through it has to be a
// connection the classifier cannot tell from one the game dialled itself: its own
// first-message reading, its own answer coming back.
//
// The server list is what to ask for. It opens no session, logs nobody in, and the
// answer is a document with a shape: `[Servers]`, and every address in it the one the
// u-lobby was told to advertise. A live run of this over the internet found nothing
// wrong and would still not belong here — a suite that needs a laptop and Cloudflare
// goes red when the laptop sleeps, which is noise. The trip this checks is the same
// one minus the tunnel provider, which is not our code.
// ---------------------------------------------------------------------------------

console.log('\nthe same, against the u-lobby itself — one port, the door on it');

/** A port nothing is on, by taking one and giving it straight back. */
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((shut) => server.close(() => shut()));
  return port;
}

const realPort = await freePort();
const scratch = mkdtempSync(join(tmpdir(), 'h5e-u-lobby-'));

// Its own database and its own log directory: this must not touch the repository's.
// No core is started — the u-lobby says so and carries on, which is exactly the
// promise `deploy/README.md` makes about `Wants=` rather than `Requires=`.
const uLobby = spawn(
  process.execPath,
  ['services/u-lobby/main.ts', '--http', String(realPort), '--bind', '127.0.0.1', '--host', '127.0.0.1'],
  {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      H5E_DATABASE: join(scratch, 'lobby.db'),
      H5E_LOG_DIR: scratch,
      H5E_CORE_URL: 'ws://127.0.0.1:1/core',
    },
    stdio: 'ignore',
  },
);

/** Wait for it to be listening, rather than guess how long it takes. */
async function listening(port: number, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((answer) => {
      const probe = createConnection({ host: '127.0.0.1', port });
      probe.on('connect', () => { probe.destroy(); answer(true); });
      probe.on('error', () => answer(false));
    });
    if (open) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

const up = await listening(realPort);
check('the u-lobby came up on a port of its own', up, `127.0.0.1:${String(realPort)}`);

if (up) {
  // Straight at the u-lobby's one port: the door is no longer a process in front of it.
  const client = new WebSocket(`ws://127.0.0.1:${String(realPort)}/u-lobby`);
  client.binaryType = 'arraybuffer';
  const back: Buffer[] = [];
  let ended = false;
  client.addEventListener('message', (event) => {
    const bytes = Buffer.from(event.data as ArrayBuffer);
    if (bytes.length < 3) return;
    if (bytes[0] === FRAME_DATA) back.push(bytes.subarray(3));
    if (bytes[0] === FRAME_CLOSE) ended = true;
  });
  await new Promise<void>((open) => client.addEventListener('open', () => open(), { once: true }));

  // Absolute-form, the way the game's curl asks a proxy. The u-lobby answers any GET
  // that is not /health with the ini, and reads neither the path nor the query.
  client.send(streamFrame(FRAME_OPEN, 1));
  client.send(streamFrame(FRAME_DATA, 1, Buffer.from(
    'GET http://gsconnect.ubisoft.com/gsinit.php?dp=HEROES_29988429c481f219 HTTP/1.1\r\n'
    + 'Host: gsconnect.ubisoft.com\r\nAccept: */*\r\nConnection: close\r\n\r\n', 'latin1',
  )));

  await until(() => ended, 15_000);
  const answer = Buffer.concat(back).toString('latin1');
  check('the u-lobby answered a stream that came through its door', ended, `${String(answer.length)} bytes`);
  check('and what came back is a server list', /\r\n\[Servers\]\r\n/.test(answer), answer.split('\r\n')[0] ?? '');
  check(
    'naming the address the u-lobby was told to advertise',
    /RouterIP0=127\.0\.0\.1/.test(answer) && /IRCIP0=127\.0\.0\.1/.test(answer),
    (/RouterIP0=[^\r]*/.exec(answer) ?? ['(no RouterIP0)'])[0],
  );
  check(
    "and its own port — the door and the u-lobby services share the number, which is the point",
    answer.includes(`RouterPort0=${String(realPort)}`),
    (/RouterPort0=[^\r]*/.exec(answer) ?? ['(no RouterPort0)'])[0],
  );

  client.close();
}

uLobby.kill();
await new Promise((done) => setTimeout(done, 200));
rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? '\nall good\n' : `\n${String(failures)} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

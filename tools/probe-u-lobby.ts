// Drive the LIVE u-lobby door the way the mod will, and see what comes back.
//
//   node tools/probe-u-lobby.ts [wss://…/u-lobby]
//
// One stream, one HTTP request on it — the server list. That is the cheapest
// thing to ask for: it opens no session, logs the client in nowhere, and the
// answer is a document we can read and check. What it proves is the whole trip
// over the internet: WebSocket to Cloudflare, cloudflared to the u-lobby's one
// port, the door there taking the upgrade, the classifier deciding the carried
// stream is a GET, and every byte of the answer back again.
//
// A TOOL AND NOT A TEST, deliberately. `tools/test-u-lobby.ts` does the same trip
// against a u-lobby it spawns itself, which is the part that is our code; this one
// needs the fleet up, a laptop awake and Cloudflare reachable, and a suite that goes
// red when a laptop sleeps teaches nobody anything. Run it after a deploy, when the
// question is "is the thing I just changed actually out there".
//
// The address it looks at reads the same setting the fleet does, so a lobby that
// moved does not leave this pointing at where it used to be.

import { config } from '../shared/config.ts';

const settings = config();
const URL_ = process.argv[2] ?? `ws://${settings.host}:${String(settings.httpPort)}/u-lobby`;
const FRAME_DATA = 0x01;
const FRAME_OPEN = 0x02;
const FRAME_CLOSE = 0x03;

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const out = Buffer.alloc(3 + (payload ? payload.length : 0));
  out[0] = type;
  out.writeUInt16BE(id, 1);
  if (payload) payload.copy(out, 3);
  return out;
}

const socket = new WebSocket(URL_);
socket.binaryType = 'arraybuffer';
const heard: Buffer[] = [];
let closed = false;

const done = (code: number): void => {
  if (closed) return;
  closed = true;
  try { socket.close(); } catch {}
  process.exit(code);
};

setTimeout(() => {
  console.log('nothing came back within 10s');
  done(2);
}, 10_000);

socket.addEventListener('open', () => {
  console.log('open  — the door accepted the WebSocket');
  socket.send(frame(FRAME_OPEN, 1));
  // Absolute-form, the way the game's curl asks a proxy. The u-lobby answers any
  // GET that is not /health with the ini, and reads neither the path nor the query.
  const request =
    'GET http://gsconnect.ubisoft.com/gsinit.php?dp=HEROES_29988429c481f219 HTTP/1.1\r\n' +
    'Host: gsconnect.ubisoft.com\r\n' +
    'Accept: */*\r\n' +
    'Connection: close\r\n\r\n';
  socket.send(frame(FRAME_DATA, 1, Buffer.from(request, 'latin1')));
});

socket.addEventListener('message', (event) => {
  const bytes = Buffer.from(event.data as ArrayBuffer);
  if (bytes.length < 3) return;
  const type = bytes[0];
  const id = bytes.readUInt16BE(1);
  if (type === FRAME_DATA) {
    heard.push(bytes.subarray(3));
    return;
  }
  if (type === FRAME_CLOSE) {
    const body = Buffer.concat(heard).toString('latin1');
    console.log(`close — stream ${id} ended, ${Buffer.concat(heard).length} bytes back\n`);
    console.log(body.trimEnd());
    const ok = /\[Servers\]/.test(body) && /RouterIP0=/.test(body);
    console.log(`\n${ok ? 'GOOD' : 'BAD '} — ${ok ? 'the server list came through the tunnel' : 'that is not a server list'}`);
    done(ok ? 0 : 1);
  }
});

socket.addEventListener('error', (e: Event & { message?: string }) => {
  console.log(`error — ${e.message ?? e}`);
  done(2);
});

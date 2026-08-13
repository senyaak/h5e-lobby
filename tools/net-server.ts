// Our own online services for the game, at the stage where they only listen.
//
// The game decides where to play by fetching one URL (docs/NETWORK.md), and its
// libcurl 7.14 honours the `http_proxy` environment variable — so a game started
// with `http_proxy=http://127.0.0.1:8080` asks US for its server list, with no
// patch to the exe and no hosts file. We answer with an ini that points every
// service at this machine, then accept those connections and write down every
// byte the client sends.
//
// The NAT service answers for real (src/net/nat-service.ts) — it is the step the
// game refuses to start without. The router, CD-key and IRC ports still only
// record: there is no live Ubisoft service left to copy, so what the client says
// first is how each of them gets written. Run it, let the game reach the online
// menu, read the log.
//
//   node tools/net-server.ts [--host 127.0.0.1] [--http 8080]
//
// The log goes to logs/ as well as the console, in full — a truncated dump of an
// unknown protocol is worth nothing. logs/latest.log is whichever run is current.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NatService } from '../src/net/nat-service.ts';
import { GUEST, GUEST_LOBBY, RouterService } from '../src/net/router-service.ts';
import { CdKeyService } from '../src/net/cdkey-service.ts';
import { IrcConnection, IrcService, chatLine, lobbyChannel } from '../src/net/irc.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

/** The address the game will be told to connect to — itself, by default. */
const host = arg('host', '127.0.0.1');
const httpPort = Number(arg('http', '8080'));

/**
 * What the ini advertises. `launcher` is only read for Router and CDKeyServer
 * (`%sLauncherPort%i`); what it is for is not known yet.
 */
interface Service {
  prefix: string;
  port: number;
  launcher: number | null;
  kind: 'tcp' | 'tcp+udp';
}

const SERVICES: Service[] = [
  { prefix: 'Router', port: 40000, launcher: 40001, kind: 'tcp+udp' },
  { prefix: 'NATServer', port: 40010, launcher: null, kind: 'tcp+udp' },
  { prefix: 'CDKeyServer', port: 40020, launcher: 40021, kind: 'tcp+udp' },
  { prefix: 'IRC', port: 6667, launcher: null, kind: 'tcp' },
];

// Not in the ini: the client is told where this one lives when it asks for a
// module (PROXY_HANDLER). It is where persistent data and, later, the ladder sit.
const PROXY: Service = { prefix: 'Proxy', port: 40030, launcher: 40031, kind: 'tcp' };

// Also not in the ini: where the lobby itself lives, handed over when the client
// asks to join a lobby server.
const LOBBY: Service = { prefix: 'Lobby', port: 40040, launcher: null, kind: 'tcp' };

function serversIni(): string {
  const lines = ['[Servers]'];
  for (const s of SERVICES) {
    lines.push(`${s.prefix}IP0=${host}`, `${s.prefix}Port0=${s.port}`);
    if (s.launcher !== null) lines.push(`${s.prefix}LauncherPort0=${s.launcher}`);
  }
  // Windows' profile-string reader wants CRLF and a trailing newline.
  return `${lines.join('\r\n')}\r\n`;
}

// Where the log goes: `logs/`, which is where this server's first version put it and
// where Сеня looks. It moved to `_tmp/net/` at some point and the only thing that
// announced the move was a line in this file's own header — so the obvious place kept
// a log from the day before and every run after that looked like a server that had
// stopped writing. Sessions before 13.08.2026 are still in `_tmp/net/`.
//
// TWO files, always: `session-<stamp>.log` keeps every run, and `latest.log` is the
// run happening now — a name that can be tailed without looking up a timestamp first,
// and the reason is that this server is usually started by somebody else's hand.
const logDir = join(repo, 'logs');
mkdirSync(logDir, { recursive: true });
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-');
const sessionPath = join(logDir, `session-${stamp}.log`);
const logFile = createWriteStream(sessionPath);
const latest = createWriteStream(join(logDir, 'latest.log'));

function log(line: string): void {
  const at = new Date().toISOString().slice(11, 23);
  const text = `${at}  ${line}`;
  console.log(text);
  logFile.write(`${text}\n`);
  latest.write(`${text}\n`);
}

/** Hex and text, 16 bytes to a line, however long the buffer is. */
function hexDump(buf: Buffer, indent = '    '): string {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    out.push(`${indent}${i.toString(16).padStart(4, '0')}  ${hex}  ${text}`);
  }
  return out.join('\n');
}

function serve(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  // As a proxy the game's curl sends an absolute URI; asked directly it sends a
  // path. Either way there is only one answer we have to give.
  log(`HTTP ${req.method} ${req.url}`);
  for (const [name, value] of Object.entries(req.headers)) log(`     ${name}: ${value}`);
  const ini = serversIni();
  log(`HTTP -> ${ini.length} bytes of servers ini\n${hexDump(Buffer.from(ini))}`);
  serve(res, ini);
}).listen(httpPort, () => log(`http on ${httpPort} — start the game with http_proxy=http://127.0.0.1:${httpPort}`));

let connections = 0;

// After the login the client asks where to go next. The launcher port we already
// advertise is the obvious place to send it, and it is ours either way.
const router = new RouterService(
  { address: host, port: SERVICES[0]!.launcher ?? SERVICES[0]!.port },
  { address: host, port: PROXY.port },
  { address: host, port: PROXY.launcher ?? PROXY.port },
  { address: host, port: LOBBY.port },
);

// `--ghosts` seats three synthetic players in every channel, each announced a different
// way, so one launch can say what the client's player list actually wants. Diagnostic:
// it puts players there who do not exist.
router.ghosts = process.argv.includes('--ghosts');
if (router.ghosts) log('ghosts on — GhostList, GhostBlob and GhostJoin will be in every channel');

// The guest is not a ghost: he is a player with a name, a blob and a ladder row, and
// he is here so that the things needing SOMEBODY ELSE — a profile read about another
// player, a friend to add, a rating that is not one's own — can be tried with one
// copy of the game. He sits in the Ranked channel — one channel, because a player is
// in one channel at a time and so is he.
router.seedProfile = process.argv.includes('--seed-profile');
if (router.seedProfile) log('seed-profile on — a player with no profile is handed a minimal one, to see what his profile screen does with it');

// One database now holds accounts, profiles, ratings and friendships (src/net/database.ts).
if (router.imported.length) log(`brought across from the old JSON files: ${router.imported.join(', ')}`);
log(`accounts: ${router.accounts.size} — a name is created by its first login, and the password is checked from then on`);

log(`${GUEST} is seated in channel ${GUEST_LOBBY} — rating ${router.ladder.row(GUEST)['RATING']}`);

// Every key the player types is accepted; see src/net/cdkey-service.ts for why
// that is the honest answer rather than a shortcut.
const cdkey = new CdKeyService();

// Chat — and the reason a lobby channel can be entered at all: joining a lobby
// makes the client join an IRC channel. See src/net/irc.ts.
const irc = new IrcService();
// The guest is in the chat's name list too. The player panel and the chat are two
// different lists — the panel comes from GROUP_INFO, this one from the 353 numeric —
// and a name that talks without being in this one looks like nobody.
irc.residents = [GUEST];

/**
 * And he says something, on a timer.
 *
 * Not a joke, or not only: nothing has ever tested that a line reaches a client from
 * anyone other than himself, and the whole of "two players" rests on that. A message
 * every two minutes says whether chat carries what the server pushes into it, whether
 * the client draws a nick that has no connection of its own, and — because it keeps
 * happening — whether the session is still alive after five minutes of sitting in a
 * channel doing nothing.
 *
 * `--quiet-bot` turns it off for a run where it would be in the way.
 */
const BOT_SAYS = "I'M THE BEST!";
const BOT_EVERY = 2 * 60 * 1000;
if (!process.argv.includes('--quiet-bot')) {
  setInterval(() => {
    // Only where he actually is: his channel, named the way the client spells it —
    // `#LobbyGrp<server>.<group>`, server FIRST. Written the other way round the first
    // time, and he then talked into a channel that does not exist, which is why the
    // first run of this bot was silent. The other half of that silence was the text:
    // a chat line carries the client's own presentation inside it (`chatLine`), and a
    // bare sentence is not something it knows how to draw.
    for (const channel of irc.channels.filter((name) => name === lobbyChannel(GUEST_LOBBY))) {
      const { line, to } = irc.say(GUEST, channel, chatLine(GUEST, BOT_SAYS));
      for (const listener of to) chatSockets.get(listener)?.write(line);
      if (to.length) log(`IRC  ${GUEST} -> ${channel}: ${BOT_SAYS} (to ${to.length} listener(s))`);
    }
  }, BOT_EVERY).unref();
  log(
    `${GUEST} sits in channel ${GUEST_LOBBY} and will say "${BOT_SAYS}" there every ${BOT_EVERY / 1000}s` +
      ' — --quiet-bot stops him',
  );
}

/** Which socket carries which chat connection, so a line can be relayed on. */
const chatSockets = new Map<IrcConnection, Socket>();

for (const service of [...SERVICES, PROXY, LOBBY]) {
  for (const port of [service.port, service.launcher].filter((p): p is number => p !== null)) {
    const label = port === service.port ? service.prefix : `${service.prefix}Launcher`;

    createTcpServer((socket: Socket) => {
      const id = ++connections;
      const peer = `${socket.remoteAddress}:${socket.remotePort}`;
      log(`TCP  #${id} ${label}:${port} <- ${peer} connected`);
      // Four desks speak the GS protocol; the chat port speaks IRC in a wrapper.
      const session =
        label === 'Router' || label === 'RouterLauncher'
          ? router.session('router')
          : label === 'Proxy' || label === 'ProxyLauncher'
            ? router.session('proxy')
            : label === 'Lobby'
              ? router.session('lobby')
              : null;
      // Which desk this socket is, so a reply can go out on a connection other than
      // the one that asked. Only the newest socket per desk is kept: with one player
              // there is only ever one of each.
      if (session) {
        // How to write on THIS connection — which is what a second player needs and the
        // desks map cannot give: it holds one socket per desk name, so two players'
        // Lobby sockets are the same name and the second replaced the first.
        session.send = (bytes: Buffer) => {
          socket.write(bytes);
          log(`TCP  #${id} ${label}:${port} -> ${bytes.length} bytes, sent unasked\n${hexDump(bytes)}`);
        };
        router.desks.set(label, (bytes: Buffer) => {
          socket.write(bytes);
          log(`TCP  #${id} ${label}:${port} -> ${bytes.length} bytes, asked for by another desk\n${hexDump(bytes)}`);
        });
        socket.on('close', () => {
          session.send = null;
          if (router.desks.get(label)) router.desks.delete(label);
        });
      }
      const chat = label === 'IRC' ? irc.connection() : null;
      if (chat) {
        chatSockets.set(chat, socket);
        socket.on('close', () => {
          chatSockets.delete(chat);
          irc.drop(chat);
        });
      }
      socket.on('data', (data: Buffer) => {
        log(`TCP  #${id} ${label}:${port} <- ${data.length} bytes\n${hexDump(data)}`);
        if (chat) {
          for (const event of chat.receive(data)) {
            log(`IRC  #${id} ${event.note}`);
            for (const answer of event.replies) socket.write(answer);
            // What one player says reaches whoever else is in that channel.
            for (const out of event.broadcast) {
              for (const other of irc.others(out.channel, chat)) chatSockets.get(other)?.write(out.line);
            }
          }
          return;
        }
        if (!session) return;
        let events;
        try {
          events = session.receive(data);
        } catch (err) {
          log(`TCP  #${id} ${label}:${port} !! ${(err as Error).message}`);
          return;
        }
        for (const event of events) {
          log(`RTR  #${id} ${event.note}`);
          for (const answer of event.replies) {
            socket.write(answer);
            log(`TCP  #${id} ${label}:${port} -> ${answer.length} bytes\n${hexDump(answer)}`);
          }
        }
      });
      socket.on('close', () => {
        const gone = session?.close();
        if (gone) log(`RTR  #${id} ${gone}`);
        log(`TCP  #${id} ${label}:${port} closed`);
      });
      socket.on('error', (err: Error) => log(`TCP  #${id} ${label}:${port} error: ${err.message}`));
    })
      .on('error', (err: Error) => log(`TCP  ${label}:${port} listen failed: ${err.message}`))
      .listen(port, () => log(`tcp  ${label} on ${port}`));

    if (service.kind === 'tcp+udp') {
      // Two of the UDP services answer: the NAT mirror and the CD-key desk. Each
      // keeps its own state, so the instance is made once per port, not per
      // datagram.
      const nat = label === 'NATServer' ? new NatService(port) : null;
      const service = nat
        ? { tag: 'NAT', handle: (data: Buffer, from: { address: string; port: number }) => nat.handle(data, from) }
        : label === 'CDKeyServer'
          ? { tag: 'KEY', handle: (data: Buffer, from: { address: string; port: number }) => cdkey.handle(data, from) }
          : null;
      const udp = createSocket('udp4');
      udp.on('message', (data: Buffer, from) => {
        log(`UDP  ${label}:${port} <- ${from.address}:${from.port}, ${data.length} bytes\n${hexDump(data)}`);
        if (!service) return;
        let result;
        try {
          result = service.handle(data, from);
        } catch (err) {
          log(`UDP  ${label}:${port} !! ${(err as Error).message}`);
          return;
        }
        log(`${service.tag}  ${result.note}`);
        for (const reply of result.replies) {
          udp.send(reply, from.port, from.address);
          log(`UDP  ${label}:${port} -> ${from.address}:${from.port}, ${reply.length} bytes\n${hexDump(reply)}`);
        }
        // Some answers go out a second time a moment later — see `againAfterMs`
        // in src/net/nat-service.ts for the race that makes that necessary.
        const again = (result as { againAfterMs?: number }).againAfterMs;
        if (again) {
          setTimeout(() => {
            for (const reply of result.replies) udp.send(reply, from.port, from.address);
            log(`UDP  ${label}:${port} -> ${from.address}:${from.port}, the same ${result.replies.length} answer(s) again`);
          }, again);
        }
      });
      udp.on('error', (err: Error) => log(`UDP  ${label}:${port} bind failed: ${err.message}`));
      udp.bind(port, () => log(`udp  ${label} on ${port}`));
    }
  }
}

log(`logging to ${sessionPath} — and to ${join(logDir, 'latest.log')}, which is always this run`);
log(`serving this list:\n${serversIni().replace(/\r\n/g, '\n')}`);

// The game gateway: the desks the game itself connects to.
//
//   node services/gateway/main.ts [--host 127.0.0.1] [--http 8080] [--ghosts] [--quiet-bot]
//
// This was `tools/net-server.ts`, the one process that was everything. What left it is
// chat, which now belongs to the core so that a browser can be in the same conversation;
// what stayed is every byte of the game's own protocol — the server list, NAT, the CD-key
// desk, the router and its wait modules, the proxy and the lobby.
//
// The game decides where to play by fetching one URL (docs/NETWORK.md), and its libcurl
// 7.14 honours the `http_proxy` environment variable — so a game started with
// `http_proxy=http://127.0.0.1:8080` asks US for its server list, with no patch to the exe
// and no hosts file. We answer with an ini that points every service at this machine.
//
// The log goes to logs/gateway-latest.log AND, unchanged, to logs/latest.log — see
// shared/log.ts for why the old name is kept.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { config } from '../../shared/config.ts';
import { hexDump, openLog } from '../../shared/log.ts';
import { CoreClient } from '../../shared/core-client.ts';
import type { PresenceEntry, RoomInfo } from '../../shared/core-protocol.ts';
import { NatService } from './nat-service.ts';
import { GUEST, GUEST_LOBBY, RouterService } from './router-service.ts';
import { CdKeyService } from './cdkey-service.ts';
import { IrcConnection, IrcService, chatLine, frame, fromGameText, toGameText } from './irc.ts';
import { probePeerAddress, probeRoomFields } from './lobby.ts';
import { DEFAULT_LOBBIES, lobbyChannel } from '../../shared/channels.ts';

const settings = config();

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

/** The address the game will be told to connect to — itself, by default. */
const host = arg('host', settings.host);
const httpPort = Number(arg('http', String(settings.httpPort)));

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
// module (PROXY_HANDLER). It is where persistent data and the ladder sit.
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

const log = openLog('gateway', { alsoPlainLatest: true });

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
  settings.database,
);

// `--ghosts` seats three synthetic players in every channel, each announced a different
// way, so one launch can say what the client's player list actually wants. Diagnostic:
// it puts players there who do not exist.
router.ghosts = process.argv.includes('--ghosts');
if (router.ghosts) log('ghosts on — GhostList, GhostBlob and GhostJoin will be in every channel');

// A diagnostic for one launch: every room field we are unsure of goes out as its own
// number, so the extension's dump of the record says where each of them landed. Games
// are not joinable while it is on — the version field is deliberately nonsense.
probeRoomFields.on = process.argv.includes('--probe-room-fields');
if (probeRoomFields.on)
  log('probe-room-fields on — room fields 3,4,5,6,11,14,15 go out as 8003…8015; nothing will be joinable');

// A diagnostic for one launch: every player is announced to the OTHERS at an address of
// ours, so that `tools/peer-probe.ts` can say whether the peer a client dials comes from
// the fields we fill in or from the blob he wrote himself. Nothing answers on those
// addresses — a game started while this is on will not connect.
probePeerAddress.on = process.argv.includes('--probe-peer-address');
if (probePeerAddress.on)
  log(
    `probe-peer-address on — players are announced at ${probePeerAddress.pool.join(', ')}; run tools/peer-probe.ts and expect no game to connect`,
  );

// One database holds accounts, profiles, ratings and friendships (services/core/rules/database.ts).
// The core has it open too, for chat — see docs/ARCHITECTURE.md for where that seam is.
if (router.imported.length) log(`brought across from the old JSON files: ${router.imported.join(', ')}`);
log(`accounts: ${router.accounts.size} — a name is created by its first login, and the password is checked from then on`);
log(`${GUEST} is seated in channel ${GUEST_LOBBY} — rating ${router.ladder.row(GUEST)['RATING']}`);

// Every key the player types is accepted; see services/gateway/cdkey-service.ts for why
// that is the honest answer rather than a shortcut.
const cdkey = new CdKeyService();

// Chat — and the reason a lobby channel can be entered at all: joining a lobby
// makes the client join an IRC channel. See services/gateway/irc.ts.
const irc = new IrcService();
// The guest is in the chat's name list too. The player panel and the chat are two
// different lists — the panel comes from GROUP_INFO, this one from the 353 numeric —
// and a name that talks without being in this one looks like nobody.
irc.residents = [GUEST];

/** Which socket carries which chat connection, so a line can be relayed on. */
const chatSockets = new Map<IrcConnection, Socket>();

// ---------------------------------------------------------------------------------
// Chat through the core
//
// Every line a player types is still fanned out here, to the other game clients on this
// process, exactly as before — so two players in one channel keep talking to each other
// whatever the core is doing. It is ALSO posted to the core, which stores it and hands it
// to the browser.
//
// The other direction is the core's echo. Our own lines come back with `sender` set to
// this process and are dropped on arrival; anything else — a line typed in the browser —
// is written to every game client sitting in that channel.
// ---------------------------------------------------------------------------------

/** Who this process is, so its own echo is recognisable. Two gateways will not collide. */
const GATEWAY_ID = `gateway-${process.pid}`;

/** Grey, so a line replayed out of history does not look like something just said. */
const HISTORY_COLOUR = 0x9a9a9a;
/** Light blue: somebody who is in the browser and not in the game. */
const WEB_COLOUR = 0x66ccff;

const core = new CoreClient({ url: settings.coreUrl, token: settings.coreToken, service: 'gateway', log });

core.onChat = (message, sender) => {
  if (sender === GATEWAY_ID) return; // already drawn, by the fan-out below
  const colour = message.origin === 'web' ? WEB_COLOUR : 0xffffff;
  // Into the client's codepage on the way out; it draws bytes, not UTF-8.
  const nick = toGameText(message.nick);
  const line = frame(`:${nick} PRIVMSG ${message.channel} :${chatLine(nick, toGameText(message.text), colour)}`);
  let seen = 0;
  for (const listener of irc.everyone(message.channel)) {
    chatSockets.get(listener)?.write(line);
    seen++;
  }
  if (seen) log(`IRC  ${message.origin} ${message.nick} -> ${message.channel}: ${message.text} (to ${seen} client(s))`);
};

core.start();

/**
 * What the core is told about who is where: the channels, and the rooms.
 *
 * There is no event for either — both live inside the router's own state and nothing
 * announces a change. Two seconds of polling costs nothing next to reaching into the
 * session machinery for a hook, and a picture that is two seconds old is one nobody can
 * tell from a fresh one. Each is sent only when it is not what was sent last.
 *
 * The presence half is drawn by the browser. The rooms half answers the relay's one
 * question — "which room is this agent in" — and it is a whole list rather than "X joined
 * Y" on purpose: rooms appear, fill, empty and vanish on the client's own messages, and a
 * missed delta would leave the core routing a game that has finished.
 */
let lastPresence = '';
let lastRooms = '';
setInterval(() => {
  const entries: PresenceEntry[] = [];
  for (const lobby of DEFAULT_LOBBIES) {
    for (const nick of router.presence.inLobby(lobby.id)) {
      entries.push({ nick, channel: lobbyChannel(lobby.id), origin: 'game' });
    }
  }
  const shape = JSON.stringify(entries);
  if (shape !== lastPresence) {
    lastPresence = shape;
    core.replacePresence('game', entries);
  }

  const rooms: RoomInfo[] = router.openRooms.map((room) => ({
    id: room.id,
    name: room.name,
    master: room.master,
    members: [...room.members],
  }));
  const roomShape = JSON.stringify(rooms);
  if (roomShape !== lastRooms) {
    lastRooms = roomShape;
    core.replaceRooms(rooms);
    log(`RTR  rooms -> core: ${rooms.map((room) => `${room.id} [${room.members.join(', ')}]`).join('; ') || 'none'}`);
  }
}, 2000).unref();

/**
 * And the guest says something, on a timer.
 *
 * Not a joke, or not only: nothing has ever tested that a line reaches a client from
 * anyone other than himself, and the whole of "two players" rests on that. A message
 * every two minutes says whether chat carries what the server pushes into it, whether
 * the client draws a nick that has no connection of its own, and — because it keeps
 * happening — whether the session is still alive after five minutes of sitting in a
 * channel doing nothing.
 *
 * It goes through the core now, like everything else said in a channel, which means it
 * lands in the history and in the browser as well.
 *
 * `--quiet-bot` turns it off for a run where it would be in the way.
 */
const BOT_SAYS = "I'M THE BEST!";
const BOT_EVERY = 2 * 60 * 1000;
if (!process.argv.includes('--quiet-bot')) {
  setInterval(() => {
    core.post({ channel: lobbyChannel(GUEST_LOBBY), nick: GUEST, text: BOT_SAYS, origin: 'server' });
  }, BOT_EVERY).unref();
  log(
    `${GUEST} sits in channel ${GUEST_LOBBY} and will say "${BOT_SAYS}" there every ${BOT_EVERY / 1000}s` +
      ' — --quiet-bot stops him',
  );
}

/** What a client is owed the moment it joins a channel: what was said while it was away. */
async function replayHistory(channel: string, socket: Socket): Promise<void> {
  if (!core.connected) return;
  try {
    const messages = await core.history(channel, 20);
    for (const message of messages) {
      const when = new Date(message.at).toISOString().slice(11, 16);
      const nick = toGameText(message.nick);
      const text = chatLine(nick, toGameText(`[${when}] ${message.text}`), HISTORY_COLOUR);
      socket.write(frame(`:${nick} PRIVMSG ${channel} :${text}`));
    }
    if (messages.length) log(`IRC  replayed ${messages.length} line(s) of ${channel}`);
  } catch (error) {
    log(`IRC  no history for ${channel}: ${(error as Error).message}`);
  }
}

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
            // And it reaches the core, which keeps it and passes it to the browser.
            if (event.said) {
              core.post({
                channel: event.said.channel,
                nick: fromGameText(event.said.nick),
                text: fromGameText(event.said.text),
                origin: 'game',
                sender: GATEWAY_ID,
              });
            }
            if (event.joined) void replayHistory(event.joined, socket);
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
        // in services/gateway/nat-service.ts for the race that makes that necessary.
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

log(`chat goes through the core at ${settings.coreUrl} — game clients here still hear each other if it is away`);
log(`logging to ${log.session} — and to ${log.latest}, which is always this run`);
log(`serving this list:\n${serversIni().replace(/\r\n/g, '\n')}`);

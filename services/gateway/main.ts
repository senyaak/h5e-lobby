// The game gateway: the desks the game itself connects to.
//
//   node services/gateway/main.ts [--host 127.0.0.1] [--bind 0.0.0.0] [--http 8080] [--ghosts] [--quiet-bot]
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
import { NatService, setMirrorPort } from './nat-service.ts';
import { GUEST, GUEST_LOBBY, RouterService } from './router-service.ts';
import { CdKeyService } from './cdkey-service.ts';
import { IrcConnection, IrcService, chatLine, frame, fromGameText, toGameText } from './irc.ts';
import { probePeerAddress, probeRoomFields, roomEndpoints } from './lobby.ts';
import { classifyDatagram, classifyDesk, type Desk } from './desk.ts';
import { StateFeed } from './state-feed.ts';
import { DEFAULT_LOBBIES, lobbyChannel } from '../../shared/channels.ts';

const settings = config();

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

/**
 * The address the game will be told to connect to — itself, by default. Advertised only:
 * it is what goes into the ini and into the endpoints, and no socket is bound to it.
 */
const host = arg('host', settings.host);
/** What the desks actually bind — every interface unless `H5E_BIND` says otherwise. */
const bind = arg('bind', settings.bind);
const httpPort = Number(arg('http', String(settings.httpPort)));

/**
 * What the ini advertises. `launcher` is only read for Router and CDKeyServer
 * (`%sLauncherPort%i`); what it is for is not known yet.
 *
 * A launcher port equal to its desk's own is deliberate and is the first step of
 * SLICE §2.3: the wait module and the desk that hands it out run byte-identical
 * code — the handler takes its behaviour from the role, and the role comes from the
 * desk, never from the port — so one number serves both and one socket is bound.
 * The client is told the launcher's address twice over (the ini, the wait-module
 * reply, `PROXY_HANDLER`, the join hand-off) and nothing in it or in us compares
 * the two.
 */
interface Service {
  prefix: string;
  port: number;
  launcher: number | null;
  /**
   * Which sockets are opened. Not what the desk could conceivably speak — what it was
   * measured speaking, and what there is a handler for here. The ini advertises a desk
   * once; whether that address answers in TCP, in UDP or in both is ours to say, and the
   * client only ever dials one of them.
   */
  listens: ('tcp' | 'udp')[];
}

/**
 * The one number every TCP desk is at. It was five — `8080` for the ini and then `40000`,
 * `6667`, `40030`, `40040` — and they are one, because the desk a connection wants is in
 * the first thing it says and not in the port it said it on (`services/gateway/desk.ts`).
 *
 * The number is the ini's, not the router's, and that is the whole reason to prefer it:
 * `http_proxy` is set by hand in each game copy's `run-net.bat`, while every desk address
 * is read out of the ini we serve. Keep the hand-written one and the rest follow by
 * themselves; keep the router's instead and three bat files have to be edited.
 *
 * It must not be a number a game listens on for its peers — `8888` upward here — because
 * the agent tells a desk from a player by port and nothing else.
 */
const DESKS = httpPort;

// The mirror answers on it too, and `lobby.ts` writes that number into the room
// description as the address the other players are told to dial. One writer, at startup.
setMirrorPort(DESKS);

const SERVICES: Service[] = [
  { prefix: 'Router', port: DESKS, launcher: DESKS, listens: ['tcp'] },
  { prefix: 'NATServer', port: DESKS, launcher: null, listens: ['udp'] },
  { prefix: 'CDKeyServer', port: DESKS, launcher: DESKS, listens: ['udp'] },
  { prefix: 'IRC', port: DESKS, launcher: null, listens: ['tcp'] },
];

// Not in the ini: the client is told where this one lives when it asks for a
// module (PROXY_HANDLER). It is where persistent data and the ladder sit.
const PROXY: Service = { prefix: 'Proxy', port: DESKS, launcher: DESKS, listens: ['tcp'] };

// Also not in the ini: where the lobby itself lives, handed over when the client
// asks to join a lobby server.
const LOBBY: Service = { prefix: 'Lobby', port: DESKS, launcher: null, listens: ['tcp'] };

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

/**
 * The server list, answered by Node's own HTTP parser — but on no port of its own.
 *
 * The last step of §2.3: a `GET ` is one of the things a desk connection can turn out to
 * be, so the ini is served on the desks' port like everything else, and this server is
 * never listened on. `iniServer.emit('connection', socket)` is how a socket that has
 * already been read from is handed over; the bytes that were read to classify it go back
 * on the stream first with `unshift`, so the parser sees the request whole.
 */
const iniServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  // As a proxy the game's curl sends an absolute URI; asked directly it sends a
  // path. Either way there is only one answer we have to give.
  log(`HTTP ${req.method} ${req.url}`);
  for (const [name, value] of Object.entries(req.headers)) log(`     ${name}: ${value}`);
  const ini = serversIni();
  log(`HTTP -> ${ini.length} bytes of servers ini\n${hexDump(Buffer.from(ini))}`);
  serve(res, ini);
});

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

const core = new CoreClient({ url: settings.coreUrl, service: 'gateway', log });

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
 * **On the event, not on a clock.** Every room and every presence entry changes because a
 * client said something or a socket closed, and both of those are handled a few hundred
 * lines below — so `stateMayHaveChanged()` is called there and nothing has to reach into
 * the router's own state for a hook. This used to be a two-second poll, and two seconds is
 * a long time to be admitted to a game you have joined.
 *
 * What goes out is still a WHOLE LIST and still only when it differs from the last one.
 * Not "X joined Y": rooms appear, fill, empty and vanish on the client's own messages, and
 * a missed delta would leave the core routing a game that has finished. The throttle in
 * `state-feed.ts` keeps a burst from becoming a burst of pushes: the first change opens a
 * window of `STATE_WINDOW`, and everything inside it leaves together at its end.
 *
 * The presence half is drawn by the browser. The rooms half is what lets the relay admit
 * an agent at all.
 */
const STATE_WINDOW = 20;

function presenceNow(): PresenceEntry[] {
  const entries: PresenceEntry[] = [];
  for (const lobby of DEFAULT_LOBBIES) {
    for (const nick of router.presence.inLobby(lobby.id)) {
      entries.push({ nick, channel: lobbyChannel(lobby.id), origin: 'game' });
    }
  }
  return entries;
}

function roomsNow(): RoomInfo[] {
  return router.openRooms.map((room) => ({
    id: room.id,
    name: room.name,
    master: room.master,
    members: [...room.members],
    // Where each of them is playing, out of the host's own description. Empty
    // when it does not parse, and that is a working state: with two players the
    // relay has only one other agent to hand a datagram to.
    endpoints: roomEndpoints(room.info),
  }));
}

const feed = new StateFeed({
  window: STATE_WINDOW,
  presence: presenceNow,
  rooms: roomsNow,
  sendPresence: (entries) => core.replacePresence('game', entries),
  sendRooms: (rooms) => {
    core.replaceRooms(rooms);
    log(
      `RTR  rooms -> core: ${
        rooms
          .map(
            (room) =>
              `${room.id} [${room.members.join(', ')}] at [${room.endpoints
                .map((one) => `${one.nick}@${one.address}:${one.port}`)
                .join(', ')}]`,
          )
          .join('; ') || 'none'
      }`,
    );
  },
});

/** Called from wherever a socket said something; see `state-feed.ts` for the rules. */
function stateMayHaveChanged(): void {
  feed.touch();
}

/**
 * A core that has just come back knows nothing, and nothing here has changed.
 *
 * The events cannot miss a room — every room moves on socket data or on socket close, and
 * both are handled in one place below — but a core that restarts loses the list and no
 * event follows, because on this side nothing happened. That was broken before the events
 * too: the old poll compared against the same memory and would not have re-sent either.
 */
core.onConnected = () => feed.reconnected();

// The guest and the ghosts are seated before any client connects, so the first picture is
// not owed to an event either.
setImmediate(() => feed.pushNow());

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

/**
 * One listener, every TCP desk.
 *
 * The desk is not the port any more — it is what the connection says first
 * (`services/gateway/desk.ts`). Nothing can be built at connect time, then: the session
 * or the chat connection is made once the first message has been read, and that first
 * message is then handed on as if it had arrived afterwards. The rest of this is what it
 * always was; only the way a connection is given its role changed.
 */
function openDeskListener(port: number): void {
  createTcpServer((socket: Socket) => {
    const id = ++connections;
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`TCP  #${id} :${port} <- ${peer} connected`);
    /** Set the moment the desk is known; until then every read goes into `waiting`. */
    let take: ((data: Buffer) => void) | null = null;
    let waiting: Buffer | null = null;

    socket.on('data', (data: Buffer) => {
      if (take) {
        take(data);
        return;
      }
      waiting = waiting ? Buffer.concat([waiting, data]) : data;
      const verdict = classifyDesk(waiting);
      if (verdict.wait) {
        log(`TCP  #${id} :${port} <- ${waiting.length} bytes, undecided — ${verdict.note}`);
        return;
      }
      if (verdict.desk === 'HTTP') {
        log(`TCP  #${id} HTTP:${port} — ${verdict.note}`);
        // Ours no longer: the bytes go back on the stream, our reader steps off it, and
        // Node's HTTP server takes the socket as if it had just been accepted.
        socket.removeAllListeners('data');
        socket.pause();
        socket.unshift(waiting);
        iniServer.emit('connection', socket);
        socket.resume();
        return;
      }
      if (!verdict.desk) {
        log(`TCP  #${id} :${port} !! ${verdict.note} — closing\n${hexDump(waiting)}`);
        socket.end();
        return;
      }
      log(`TCP  #${id} ${verdict.desk}:${port} — ${verdict.note}`);
      take = attach(verdict.desk, socket, id, port);
      const first = waiting;
      waiting = null;
      take(first);
    });

    socket.on('error', (err: Error) => log(`TCP  #${id} :${port} error: ${err.message}`));
  })
    .on('error', (err: Error) => log(`TCP  desks:${port} listen failed: ${err.message}`))
    .listen(port, bind, () => log(`tcp  desks on ${bind}:${port}`));
}

/**
 * Give a classified connection its desk, and hand back how to feed it.
 *
 * Everything here used to happen at connect time, when the label came from the port.
 * The only change is when it runs — after the first message rather than before it.
 */
function attach(label: Desk, socket: Socket, id: number, port: number): (data: Buffer) => void {
  {
    // Four desks speak the GS protocol; the chat one speaks IRC in a wrapper.
    const session =
      label === 'Router'
        ? router.session('router')
        : label === 'Proxy'
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
    socket.on('close', () => {
      const gone = session?.close();
      if (gone) log(`RTR  #${id} ${gone}`);
      log(`TCP  #${id} ${label}:${port} closed`);
      // A player who drops out of a room does it by his socket going away, and this is
      // the only place that hears about it.
      if (session) stateMayHaveChanged();
    });
    return (data: Buffer) => {
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
      // Every room and every presence entry moves because of a message that just went
      // through here. Comparing is what decides whether the core hears anything.
      if (events.length) stateMayHaveChanged();
    };
  }
}

/**
 * One socket, both UDP windows.
 *
 * The same trick as the TCP desks and a smaller one: a datagram carries no connection to
 * remember, so every one of them is classified on its own (`services/gateway/desk.ts`).
 * Each window keeps its own state, so the two services are made once here rather than
 * per datagram.
 */
function openUdpWindow(port: number): void {
  const nat = new NatService(port);
  const handlers = {
    NAT: { tag: 'NAT', handle: (data: Buffer, from: { address: string; port: number }) => nat.handle(data, from) },
    CDKey: { tag: 'KEY', handle: (data: Buffer, from: { address: string; port: number }) => cdkey.handle(data, from) },
  };
  const udp = createSocket('udp4');
  udp.on('message', (data: Buffer, from) => {
    const { window, note } = classifyDatagram(data);
    log(`UDP  ${window}:${port} <- ${from.address}:${from.port}, ${data.length} bytes — ${note}\n${hexDump(data)}`);
    const service = handlers[window];
    let result;
    try {
      result = service.handle(data, from);
    } catch (err) {
      log(`UDP  ${window}:${port} !! ${(err as Error).message}`);
      return;
    }
    log(`${service.tag}  ${result.note}`);
    for (const reply of result.replies) {
      udp.send(reply, from.port, from.address);
      log(`UDP  ${window}:${port} -> ${from.address}:${from.port}, ${reply.length} bytes\n${hexDump(reply)}`);
    }
    // Some answers go out a second time a moment later — see `againAfterMs`
    // in services/gateway/nat-service.ts for the race that makes that necessary.
    const again = (result as { againAfterMs?: number }).againAfterMs;
    if (again) {
      setTimeout(() => {
        for (const reply of result.replies) udp.send(reply, from.port, from.address);
        log(`UDP  ${window}:${port} -> ${from.address}:${from.port}, the same ${result.replies.length} answer(s) again`);
      }, again);
    }
  });
  udp.on('error', (err: Error) => log(`UDP  windows:${port} bind failed: ${err.message}`));
  udp.bind(port, bind, () => log(`udp  windows on ${bind}:${port}`));
}

// A desk opens the sockets it was measured using and no others (SLICE §2.3, step 2).
// The ones we used to bind and nobody ever spoke to — TCP on the NAT mirror and on the
// CD-key window, UDP on the router and on the launchers — are gone, and closing them is
// how it gets proved they were dead. A client that turns up at one now hears a refusal
// instead of a silence, which is the loudest way there is of being told.
//
// And the TCP desks share a number now (step 3), so this is one listener however many
// desks name it. `Set` on the numbers, not on the desks: if a desk is ever moved back to
// one of its own, this loop opens a second listener for it and nothing else changes.
const tcpPorts = new Set<number>();
const udpPorts = new Set<number>();
for (const service of [...SERVICES, PROXY, LOBBY]) {
  for (const port of [service.port, service.launcher].filter((p): p is number => p !== null)) {
    if (service.listens.includes('tcp')) tcpPorts.add(port);
    if (service.listens.includes('udp')) udpPorts.add(port);
  }
}
for (const port of tcpPorts) openDeskListener(port);
for (const port of udpPorts) openUdpWindow(port);

log(`chat goes through the core at ${settings.coreUrl} — game clients here still hear each other if it is away`);
log(`logging to ${log.session} — and to ${log.latest}, which is always this run`);
log(`serving this list:\n${serversIni().replace(/\r\n/g, '\n')}`);

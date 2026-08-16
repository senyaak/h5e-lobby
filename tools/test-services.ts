// The four services, checked where they meet each other.
//
// `tools/test-net.ts` checks our layers against bytes a real client sent; this one checks
// the thing that has no captured bytes at all — a line typed in the game arriving in a
// browser, a line typed in a browser arriving in the game, and both of them still being
// there for whoever opens the page an hour later.
//
// Everything runs for real: a core on an ephemeral port with its database in memory, a
// web service in front of it, browsers that are Node's own WebSocket client, and a relay
// with three agents. Nothing is stubbed, because what is being tested IS the wiring.
//
// Usage: `node tools/test-services.ts`

import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { openDatabase } from '../services/core/rules/database.ts';
import { Accounts } from '../services/core/rules/accounts.ts';
import { startCore } from '../services/core/server.ts';
import { CoreClient } from '../shared/core-client.ts';
import { ChatStore } from '../services/core/chat.ts';
import type { ChannelInfo, ChatMessage, PresenceEntry } from '../shared/core-protocol.ts';
import { startWeb } from '../services/web/web-service.ts';
import { startRelay } from '../services/relay/relay-service.ts';
import { IrcConnection, chatLine, frame, fromGameText, parseChatLine, toGameText } from '../services/u-lobby/irc.ts';
import { gameChannels, lobbyChannel } from '../shared/channels.ts';

/**
 * A suite that hangs says nothing, and nothing is worse than a red line.
 *
 * This came from a sabotage run that never returned: the defect being sabotaged also kept
 * a socket open, so `close()` waited for ever and forty minutes passed before anybody
 * noticed there was no verdict.
 *
 * It is deliberately NOT unref'd. A hang comes in two shapes — a loop still holding a
 * handle, and a loop gone empty under a promise that will never settle — and an unref'd
 * timer only ever catches the first: in the second Node just leaves, quietly, with a code
 * nobody reads as "this hung". Keeping it alive costs nothing here because both suites end
 * by calling `process.exit` themselves.
 */
const WATCHDOG_MS = 5 * 60 * 1000;
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

/** Wait for something to become true, or give up — a test must not hang forever. */
async function until(ready: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ready();
}

/** The real list, the one the core publishes — not a copy of it that can drift. */
const CHANNELS: ChannelInfo[] = gameChannels();
const RANKED = lobbyChannel(2);

// ---------------------------------------------------------------------------------
console.log('\nchat storage');
// ---------------------------------------------------------------------------------
{
  const { db } = openDatabase(':memory:');
  const chat = new ChatStore(db);
  const first = chat.post({ channel: RANKED, nick: 'Senyaak', text: 'one', origin: 'game' });
  chat.post({ channel: RANKED, nick: 'Senyaak', text: 'two', origin: 'web' });
  const third = chat.post({ channel: RANKED, nick: 'Guest', text: 'three', origin: 'server' });
  chat.post({ channel: lobbyChannel(1), nick: 'Senyaak', text: 'elsewhere', origin: 'game' });

  check('a stored line comes back with an id and a time', first.id > 0 && first.at > 0, JSON.stringify(first));
  check('ids ascend', third.id > first.id);
  const all = chat.history(RANKED);
  check('history is only this channel', all.length === 3, `${all.length} line(s)`);
  check('and reads oldest first', all.map((m) => m.text).join(',') === 'one,two,three', all.map((m) => m.text).join(','));
  const last = chat.history(RANKED, 2);
  check('a limit keeps the LAST lines, not the first', last.map((m) => m.text).join(',') === 'two,three', last.map((m) => m.text).join(','));
  check('where a line came from survives the round trip', all[1]?.origin === 'web' && all[2]?.origin === 'server');
}

// ---------------------------------------------------------------------------------
console.log('\nthe game and the browser in one chat');
// ---------------------------------------------------------------------------------

/** A browser, which is to say a WebSocket and everything it was sent. */
interface Browser {
  seen: Record<string, unknown>[];
  say(message: Record<string, unknown>): void;
  close(): void;
  of(kind: string): Record<string, unknown>[];
}

async function openBrowser(url: string, cookie = ''): Promise<Browser> {
  // The session travels in the handshake, the way a browser sends it — so a test that
  // wants to be a logged-in page has to present it here and not in a message.
  const socket = new WebSocket(url, cookie ? ({ headers: { cookie } } as unknown as string[]) : undefined);
  const seen: Record<string, unknown>[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    seen.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  return {
    seen,
    say: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    of: (kind) => seen.filter((message) => message['kind'] === kind),
  };
}

const { db } = openDatabase(':memory:');
const core = await startCore({ bind: '127.0.0.1', port: 0, db, channels: CHANNELS });

// ---------------------------------------------------------------------------------
console.log('\nthe core stays on loopback');
// ---------------------------------------------------------------------------------
{
  // `H5E_BIND` moved the other three off loopback so a second machine can reach them
  // (SLICE §2.1). The core must not have come along — nothing stands in front of it, so
  // this bind IS the whole of its defence.
  const bound = core.server.address() as { address: string };
  check('the running core listens on loopback', bound.address === '127.0.0.1', bound.address);

  // Refused means refused *quickly*: without the guard, a core handed an address this
  // machine does not have neither throws nor listens — it waits forever, and a hanging
  // suite says nothing. The deadline turns that into a red line like any other.
  async function refused(bind: string): Promise<boolean> {
    // `Promise.resolve().then` and not a bare call, because the guard says no by throwing
    // where it stands — a synchronous throw would go straight past a `.catch` on the
    // returned promise.
    const listening = Promise.resolve()
      .then(() => startCore({ bind, port: 0, db, channels: CHANNELS }))
      .then(async (stray) => {
        await stray.close();
        return 'listened';
      })
      .catch(() => 'refused');
    const verdict = await Promise.race([
      listening,
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    return verdict === 'refused';
  }
  // The sabotage half: hand it the two addresses a "make it reachable" edit reaches for,
  // and the checks go red the moment the guard in services/core/server.ts is gone.
  check('every interface is refused', await refused('0.0.0.0'));
  check('a LAN address is refused', await refused('192.168.1.5'));
  check('loopback by another name is allowed', !(await refused('::1')));
}

// The u-lobby's side of the wire, which is a CoreClient and nothing else — the same
// object services/u-lobby/main.ts holds.
const heard: { message: ChatMessage; sender?: string }[] = [];
let presenceSeen: PresenceEntry[] = [];
const uLobby = new CoreClient({ url: core.url(), service: 'u-lobby' });
uLobby.onChat = (message, sender) => heard.push(sender === undefined ? { message } : { message, sender });
uLobby.onPresence = (entries) => (presenceSeen = entries);
uLobby.start();
check('the u-lobby reaches the core', await until(() => uLobby.connected));

const web = await startWeb({ bind: '127.0.0.1', port: 0, coreUrl: core.url() });
const pageUrl = `http://127.0.0.1:${web.port()}`;

const page = await fetch(pageUrl);
const html = await page.text();
check('the page is served', page.status === 200 && html.includes('Heroes V lobby'), `status ${page.status}`);
const health = (await (await fetch(`${pageUrl}/health`)).json()) as { core: boolean };
check('and it says the core is up', health.core === true, JSON.stringify(health));

// ---------------------------------------------------------------------------------
console.log('\nthe login, which is the game s login');
// ---------------------------------------------------------------------------------

/** What the game does on a player's first connection: the account is made there. */
new Accounts(db).login('Senyaak', 'swordsman');

interface LoginAnswer {
  status: number;
  ok?: boolean;
  name?: string;
  reason?: string;
  /** The whole `Set-Cookie`, and the `name=value` out of it to send back. */
  setCookie: string;
  cookie: string;
}

async function tryLogin(name: string, password: string, where = pageUrl): Promise<LoginAnswer> {
  const response = await fetch(`${where}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const setCookie = response.headers.getSetCookie()[0] ?? '';
  return {
    status: response.status,
    setCookie,
    cookie: setCookie.split(';')[0] ?? '',
    ...((await response.json()) as Record<string, unknown>),
  };
}

// Case first, because it decides which name everyone else sees him under.
const admitted = await tryLogin('senyaak', 'swordsman');
check('the game s password lets him into the browser', admitted.ok === true, JSON.stringify(admitted.reason));
check('and he is named the way the account is spelled', admitted.name === 'Senyaak', String(admitted.name));
check('the session comes back as a cookie', admitted.cookie.startsWith('h5e_session='), admitted.setCookie);
check('the page cannot read it', admitted.setCookie.includes('HttpOnly'), admitted.setCookie);
check('and another site cannot spend it', admitted.setCookie.includes('SameSite=Lax'), admitted.setCookie);
check(
  'nothing in the body carries the session',
  !JSON.stringify({ ok: admitted.ok, name: admitted.name }).includes('h5e_session'),
);
check(
  'and it is not marked Secure over plain http, or the browser would drop it',
  !admitted.setCookie.includes('Secure'),
  admitted.setCookie,
);
check('it runs out in an hour', admitted.setCookie.includes('Max-Age=3600'), admitted.setCookie);

const wrong = await tryLogin('Senyaak', 'archer');
check('a wrong password is refused', wrong.ok !== true && wrong.status === 401, `${wrong.status} ${wrong.reason}`);
check('and says so, rather than that there is no such name', wrong.reason === 'wrong-password', String(wrong.reason));
check('with no cookie', wrong.setCookie === '', wrong.setCookie);

const unknown = await tryLogin('Nobody', 'anything');
check('a name the game never saw is refused', unknown.ok !== true, String(unknown.reason));
check(
  'and told to go and make it in the game',
  unknown.reason === 'no-such-account',
  String(unknown.reason),
);
check('the browser CANNOT create an account', !core.core.accounts.has('Nobody'));

const nosession = await openBrowser(`ws://127.0.0.1:${web.port()}/`, 'h5e_session=made-up');
nosession.say({ kind: 'hello' });
check('a made-up cookie is denied', await until(() => nosession.of('denied').length > 0));
nosession.say({ kind: 'say', text: 'let me through' });
await until(() => false, 200);
check(
  'and nothing said without a session is kept',
  core.core.chat.history(RANKED).every((message) => message.text !== 'let me through'),
);
nosession.close();

const senya = await openBrowser(`ws://127.0.0.1:${web.port()}/`, admitted.cookie);
senya.say({ kind: 'hello', channel: RANKED });
check('the browser is welcomed', await until(() => senya.of('welcome').length > 0));
check('under the account s own name', senya.of('welcome')[0]?.['nick'] === 'Senyaak', String(senya.of('welcome')[0]?.['nick']));
check(
  'with the channels the game has',
  (senya.of('welcome')[0]?.['channels'] as ChannelInfo[])?.length === 3,
  JSON.stringify(senya.of('welcome')[0]?.['channels']),
);

// Game -> browser.
uLobby.post({ channel: RANKED, nick: 'Player', text: 'anyone for a duel?', origin: 'game', sender: 'u-lobby-1' });
check('a line said in the game reaches the browser', await until(() => senya.of('message').length > 0));
const fromGame = senya.of('message')[0]?.['message'] as ChatMessage | undefined;
check('with its text and its origin', fromGame?.text === 'anyone for a duel?' && fromGame?.origin === 'game', JSON.stringify(fromGame));
check(
  'and the u-lobby hears its own line back, marked as its own',
  await until(() => heard.some((one) => one.sender === 'u-lobby-1')),
  JSON.stringify(heard.map((one) => one.sender)),
);

// Browser -> game.
senya.say({ kind: 'say', text: 'I am in the browser' });
check('a line typed in the browser reaches the u-lobby', await until(() => heard.some((one) => one.message.origin === 'web')));
const fromWeb = heard.find((one) => one.message.origin === 'web');
check('with the browser nick on it', fromWeb?.message.nick === 'Senyaak', JSON.stringify(fromWeb?.message));
check('and no sender, so the u-lobby knows to draw it', fromWeb?.sender === undefined, String(fromWeb?.sender));

// Presence, both ways.
uLobby.replacePresence('game', [{ nick: 'Player', channel: RANKED, origin: 'game' }]);
check('the browser is told who is in the game', await until(() => senya.of('presence').some((p) => JSON.stringify(p).includes('Player'))));
check(
  'and the u-lobby is told who is in the browser',
  await until(() => presenceSeen.some((entry) => entry.nick === 'Senyaak' && entry.origin === 'web')),
  JSON.stringify(presenceSeen),
);

// History — the requirement, not the nicety. A second account, made the way the first
// one was, so that this is a different person and not the same tab twice.
new Accounts(db).login('Somebody', 'peasant');
const second = await tryLogin('Somebody', 'peasant');
check('a second player logs in the same way', second.ok === true, String(second.reason));

const latecomer = await openBrowser(`ws://127.0.0.1:${web.port()}/`, second.cookie);
latecomer.say({ kind: 'hello', channel: RANKED });
check('somebody arriving later is given the history', await until(() => latecomer.of('history').length > 0));
const history = latecomer.of('history')[0]?.['messages'] as ChatMessage[] | undefined;
check(
  'and it holds both sides of the conversation, in order',
  history?.map((m) => m.text).join(' | ') === 'anyone for a duel? | I am in the browser',
  history?.map((m) => m.text).join(' | '),
);
check('with the times they were said', typeof history?.[0]?.at === 'number' && history[0]!.at > 0);

// A channel nobody has spoken in is empty rather than everyone else's conversation.
latecomer.say({ kind: 'channel', channel: lobbyChannel(1) });
check(
  'another channel is a different conversation',
  await until(() => latecomer.of('history').length === 2 && (latecomer.of('history')[1]?.['messages'] as unknown[]).length === 0),
  JSON.stringify(latecomer.of('history')[1]),
);

// Logging out takes the session with it — the cookie names which one, so a page cannot
// end somebody else's by asking.
const goodbye = await fetch(`${pageUrl}/logout`, { method: 'POST', headers: { cookie: second.cookie } });
check(
  'logging out clears the cookie in the browser too',
  (goodbye.headers.getSetCookie()[0] ?? '').includes('Max-Age=0'),
  goodbye.headers.getSetCookie()[0],
);
const returning = await openBrowser(`ws://127.0.0.1:${web.port()}/`, second.cookie);
returning.say({ kind: 'hello', channel: RANKED });
check('a session that was logged out is dead', await until(() => returning.of('denied').length > 0));
returning.close();

// Guessing. Five misses from one address and the sixth is not even asked about — which
// has to hold for the RIGHT password too, or it is a filter that stops nobody.
let throttled = 0;
for (let attempt = 0; attempt < 8 && !throttled; attempt += 1) {
  const miss = await tryLogin('Senyaak', `guess-${attempt}`);
  if (miss.status === 429) throttled = attempt + 1;
}
check('a run of wrong passwords starts being refused unasked', throttled > 0, `after ${throttled} tries`);
const duringThrottle = await tryLogin('Senyaak', 'swordsman');
check(
  'and the real password is refused too while it lasts',
  duringThrottle.status === 429,
  `${duringThrottle.status} ${duringThrottle.reason}`,
);

// There was a shared token here and a check that a wrong one was refused. Both went on
// 15.08.2026: the token's default was written in this repository, so the test proved only
// that a lock whose key everybody has can be locked. What guards the core is that it will
// not listen anywhere but loopback, and THAT is checked above, with its sabotage half.

// ---------------------------------------------------------------------------------
console.log('\nthe games list the browser draws, and the half of it it must not get');
// ---------------------------------------------------------------------------------

// The gateway's part, played here by the u-lobby client: the whole list, whenever it
// changes. `endpoints` is in it because the relay needs it — that is the field this
// section exists to keep off the page.
uLobby.replaceRooms([
  {
    id: 100,
    name: 'Сервер — Senyaak',
    master: 'Senyaak',
    members: ['Senyaak', 'Player2'],
    maxPlayers: 3,
    build: 'HEROES_29988429c481f219',
    gameVersion: '',
    gsVersion: 'HEROES_a3e9d5c9b79a1a57',
    mapName: 'Rules Test',
    mapGenerated: false,
    computers: 1,
    facts: [{ name: 'goal', value: 'goal_default' }],
    endpoints: [
      { nick: 'Senyaak', address: '10.44.253.104', port: 8888 },
      { nick: 'Player2', address: '10.44.253.104', port: 8889 },
    ],
  },
]);
// The LAST such message, not the first: an empty one arrives with the welcome, and a test
// that waits for "a games message" is satisfied by it and then reads nothing.
const drawnNow = (): Record<string, unknown>[] | undefined =>
  senya.of('games').at(-1)?.['games'] as Record<string, unknown>[] | undefined;
check('a game opened in the game reaches the browser', await until(() => drawnNow()?.length === 1));
const drawn = drawnNow() ?? [];
check('as one game', drawn.length === 1, JSON.stringify(drawn));
check('with the name the host gave it', drawn[0]?.['name'] === 'Сервер — Senyaak', String(drawn[0]?.['name']));
check('and who is playing it', JSON.stringify(drawn[0]?.['players']) === '["Senyaak","Player2"]', JSON.stringify(drawn[0]?.['players']));

// THE POINT OF THIS SECTION. The page is served over the tunnel to anybody with an
// account, and `endpoints` is every player's address and the port his game is on. It is
// not filtered out of the core's shape — the browser is given a different shape that
// never had it — and this is what says so if anybody ever widens that again.
check('the address of nobody is in it', !('endpoints' in (drawn[0] ?? {})), JSON.stringify(Object.keys(drawn[0] ?? {})));
check(
  'and no field of it carries one, under any name',
  !JSON.stringify(drawn).includes('10.44.253.104') && !JSON.stringify(drawn).includes('8888'),
  JSON.stringify(drawn),
);

// And it empties the same way it filled: the whole list, never a change to apply.
uLobby.replaceRooms([]);
check('a game that ends empties the list', await until(() => drawnNow()?.length === 0), JSON.stringify(drawnNow()));

// ---------------------------------------------------------------------------------
console.log('\nsessions that run out, and sockets that hold them open');
// ---------------------------------------------------------------------------------
{
  // The real windows are an hour and a minute; these are the same mechanism wound down
  // so the test can watch it happen. Its own service, so nothing above is disturbed —
  // including the throttle, which by now has this address on it.
  const IDLE = 1200;
  const brief = await startWeb({
    bind: '127.0.0.1',
    port: 0,
    coreUrl: core.url(),
    sessionIdleMs: IDLE,
    sessionTouchMs: 150,
  });
  const briefUrl = `http://127.0.0.1:${brief.port()}`;
  const touch = (cookie: string): Promise<Response> =>
    fetch(`${briefUrl}/session`, { method: 'POST', headers: { cookie } });

  const held = await tryLogin('Senyaak', 'swordsman', briefUrl);
  check('logging in against the brief service works', held.ok === true, String(held.reason));
  check('and its cookie says its own hour', held.setCookie.includes(`Max-Age=${Math.floor(IDLE / 1000)}`), held.setCookie);

  const sitting = await openBrowser(`ws://127.0.0.1:${brief.port()}/`, held.cookie);
  sitting.say({ kind: 'hello', channel: RANKED });
  check('the socket is welcomed', await until(() => sitting.of('welcome').length > 0));

  // Twice the whole idle window, spent doing nothing but holding the socket open.
  await until(() => false, IDLE * 2);
  const stillGood = await touch(held.cookie);
  check('a session with a live socket is still there after twice its idle time', stillGood.status === 200, `status ${stillGood.status}`);
  check('and the socket was never told otherwise', sitting.of('denied').length === 0);

  // Now let go of it.
  sitting.close();
  await until(() => false, IDLE * 2);
  const lapsed = await touch(held.cookie);
  check('with nobody connected it runs out', lapsed.status === 401, `status ${lapsed.status}`);

  const returning = await openBrowser(`ws://127.0.0.1:${brief.port()}/`, held.cookie);
  returning.say({ kind: 'hello', channel: RANKED });
  check('and the cookie is no longer worth anything', await until(() => returning.of('denied').length > 0));
  returning.close();
  await brief.close();
}

// ---------------------------------------------------------------------------------
console.log('\nthe relay');
// ---------------------------------------------------------------------------------

// Nothing is enrolled and nothing is issued. An agent says where its game plays and the
// room list is what turns that into a player — so these are the rooms first, and the
// agents afterwards know nothing but their own address and port.
/**
 * The parts of a room the RELAY never reads, so the fixtures below can leave them out.
 *
 * Seats and version are for a person looking at a list; what the relay wants is who is at
 * which endpoint. Spelling them out in every fixture down here would say they mattered.
 */
const anyGame = { maxPlayers: 2, build: '', gameVersion: '', gsVersion: '', mapName: '', mapGenerated: false, computers: 0, facts: [] };

uLobby.replaceRooms([
  {
    ...anyGame,
    id: 7,
    name: 'a duel',
    master: 'PlayerA',
    members: ['PlayerA', 'PlayerB'],
    endpoints: [
      { nick: 'PlayerA', address: '192.168.178.27', port: 8888 },
      { nick: 'PlayerB', address: '192.168.178.27', port: 8889 },
    ],
  },
  {
    ...anyGame,
    id: 9,
    name: 'somewhere else',
    master: 'PlayerC',
    members: ['PlayerC'],
    endpoints: [{ nick: 'PlayerC', address: '192.168.178.27', port: 8890 }],
  },
  // A room the host's description said nothing readable about. It has a member and no
  // endpoint, which under this rule means nobody in it can be admitted at all — the old
  // secret would have let him in and left the relay shouting into the room.
  { ...anyGame, id: 11, name: 'a room we cannot read', master: 'PlayerE', members: ['PlayerE'], endpoints: [] },
]);
await until(() => false, 100);

const relay = await startRelay({ bind: '127.0.0.1', port: 0, coreUrl: core.url() });

interface Agent {
  got: Buffer[];
  send(bytes: Uint8Array): void;
  closed(): boolean;
  close(): void;
}

/** The seven bytes an agent opens with: 0x02, then where its game plays. */
function identifyFrame(address: string, port: number): Uint8Array {
  const out = new Uint8Array(7);
  out[0] = 0x02;
  address.split('.').forEach((octet, i) => (out[1 + i] = Number(octet)));
  out[5] = (port >> 8) & 0xff;
  out[6] = port & 0xff;
  return out;
}

/**
 * An agent: a WebSocket that says where it plays and then carries datagrams.
 *
 * That first frame is the whole of what it presents. It holds no secret, and it could not
 * have been given one — which was the point of taking them out.
 */
async function openAgentOn(port: number, address: string, gamePort: number): Promise<Agent> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  socket.binaryType = 'arraybuffer';
  const got: Buffer[] = [];
  let closed = false;
  socket.addEventListener('message', (event: MessageEvent) => got.push(Buffer.from(event.data as ArrayBuffer)));
  socket.addEventListener('close', () => (closed = true));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  socket.send(identifyFrame(address, gamePort));
  return { got, send: (bytes) => socket.send(bytes), closed: () => closed, close: () => socket.close() };
}

const agentA = await openAgentOn(relay.port(), '192.168.178.27', 8888);
const agentB = await openAgentOn(relay.port(), '192.168.178.27', 8889);
const agentC = await openAgentOn(relay.port(), '192.168.178.27', 8890);
// Admission is one question to the core each, answered in whatever order they come back,
// so this waits for all three rather than assuming the order they connected in.
const seated = (): string => {
  const rooms = relay.rooms();
  return Object.keys(rooms)
    .sort()
    .map((room) => `${room}=${rooms[room]!.slice().sort().join('+')}`)
    .join(' ');
};
check('the relay admits an agent the lobby is playing', await until(() => Object.values(relay.rooms()).flat().length === 3), seated());
check('and puts them in their own rooms', seated() === 'room-7=PlayerA+PlayerB room-9=PlayerC', seated());

agentA.send(new Uint8Array([1, 2, 3, 4]));
check('a datagram reaches the other agent in the room', await until(() => agentB.got.length > 0));
check('unchanged', agentB.got[0]?.equals(Buffer.from([1, 2, 3, 4])) === true, agentB.got[0]?.toString('hex'));
check('and nobody in another room sees it', agentC.got.length === 0, `${agentC.got.length} datagram(s)`);
check('nor does the sender', agentA.got.length === 0, `${agentA.got.length} datagram(s)`);

const stranger = await openAgentOn(relay.port(), '10.9.9.9', 8888);
check('an endpoint nobody is playing at is dropped', await until(() => stranger.closed()));
check('and never joins a room', Object.values(relay.rooms()).flat().length === 3, JSON.stringify(relay.rooms()));

// The same address on a port nobody plays on is a stranger too — the port is what
// separates two players behind one NAT, so it has to be part of the match.
const wrongPort = await openAgentOn(relay.port(), '192.168.178.27', 9999);
check('and so is the right address on the wrong port', await until(() => wrongPort.closed()));

// Nothing in the handshake says who a connection is, so a connection that says nothing at
// all cannot be waited on for ever. This is the door the old `?token=` used to shut.
{
  const quiet = await startRelay({
    bind: '127.0.0.1',
    port: 0,
    coreUrl: core.url(),
    identifyMs: 150,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${quiet.port()}/agent`);
  let closed = false;
  socket.addEventListener('close', () => (closed = true));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  check('a connection that never says where it plays is dropped', await until(() => closed, 3000));
  await quiet.close();
}

// A datagram frame is seven bytes too when it carries nothing, and it must not be mistaken
// for the frame that identifies. These seven say 0x01 and then an endpoint that IS a real
// player, so a reader that looked at the length and not at the type would admit him.
{
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port()}/agent`);
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  socket.send(new Uint8Array([0x01, 192, 168, 178, 27, 8888 >> 8, 8888 & 0xff]));
  await until(() => false, 150);
  check(
    'a datagram frame is not an identity, however long it is',
    Object.values(relay.rooms()).flat().length === 3,
    JSON.stringify(relay.rooms()),
  );
  socket.close();
}

// A member of a room whose description we could not read. Under the old secret he was
// admitted and the relay had nowhere to aim; now he is refused, and that is the price of
// the endpoint being the whole of the identity.
const unreadable = await openAgentOn(relay.port(), '192.168.178.27', 8891);
check('a player in a room with no endpoints cannot be admitted at all', await until(() => unreadable.closed()));

// And when the game ends, the room goes — the next connection has nothing to join.
uLobby.replaceRooms([
  {
    ...anyGame,
    id: 9,
    name: 'somewhere else',
    master: 'PlayerC',
    members: ['PlayerC'],
    endpoints: [{ nick: 'PlayerC', address: '192.168.178.27', port: 8890 }],
  },
]);
await until(() => false, 100);
const afterwards = await openAgentOn(relay.port(), '192.168.178.27', 8889);
check('once the room is gone, its agents are no longer admitted', await until(() => afterwards.closed()));
check(
  'while the game that is still open keeps its own',
  relay.rooms()['room-9']?.join(',') === 'PlayerC',
  JSON.stringify(relay.rooms()),
);

// A GAME THAT DIES RATHER THAN SAYS GOODBYE.
//
// Every agent above leaves through Node's WebSocket client, which is polite: it sends a
// close frame and the relay reads it. A real one is not polite — the game exits, the
// process goes, and what arrives is a bare TCP FIN with no frame in front of it. The
// tunnel delivers exactly that, and for a while nothing on our side listened for it: the
// socket sat in CLOSE-WAIT, `onClose` never ran, and the player stayed in his room
// forever. Observed 15.08.2026 — three agents still seated ten minutes after the match,
// and rooms are numbered from the lobby, so the next game to be given that id would have
// inherited three ghosts holding its own players' endpoints.
//
// So this one speaks WebSocket by hand, only as far as it must, and then hangs up mid-word.
{
  const rude = connect(relay.port(), '127.0.0.1');
  await new Promise<void>((resolve) => rude.on('connect', () => resolve()));
  const key = Buffer.alloc(16, 7).toString('base64');
  rude.write(
    `GET /agent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const upgraded = await new Promise<boolean>((resolve) => {
    let seen = '';
    rude.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1');
      if (seen.includes('\r\n\r\n')) resolve(seen.includes(accept));
    });
    setTimeout(() => resolve(false), 2000);
  });
  check('a hand-written client is upgraded', upgraded);

  // The identify frame, masked — a client frame always is, and the relay refuses one that
  // is not. PlayerC's endpoint, so the core admits him into a room that exists.
  const body = identifyFrame('192.168.178.27', 8890);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i]! ^ mask[i & 3]!;
  rude.write(Buffer.concat([Buffer.from([0x82, 0x80 | body.length]), mask, masked]));
  check(
    'and joins his room',
    await until(() => (relay.rooms()['room-9'] ?? []).filter((nick) => nick === 'PlayerC').length === 2),
    JSON.stringify(relay.rooms()),
  );

  // And now the game dies. No close frame, no warning — just the FIN.
  rude.end();
  check(
    'a bare FIN empties his seat too',
    await until(() => (relay.rooms()['room-9'] ?? []).filter((nick) => nick === 'PlayerC').length === 1),
    JSON.stringify(relay.rooms()),
  );
  rude.destroy();
}

// ---------------------------------------------------------------------------------
console.log('\nthree in a room, each datagram to the one it names');
// ---------------------------------------------------------------------------------
{
  // What two players never needed: with three, "to the others in my room" sends
  // every datagram to somebody it was not for. The frame carries the address the
  // game dialled, and the relay turns that into a player — the one thing the
  // agent cannot do, since all it ever sees is an address.
  const HEADER = 7;
  const framed = (address: string, port: number, payload: number[]): Uint8Array => {
    const out = Buffer.alloc(HEADER + payload.length);
    out[0] = 0x01;
    for (const [i, octet] of address.split('.').map(Number).entries()) out[1 + i] = octet;
    out.writeUInt16BE(port, 5);
    Buffer.from(payload).copy(out, HEADER);
    return out;
  };
  const stampOf = (bytes: Buffer): string =>
    `${bytes[1]}.${bytes[2]}.${bytes[3]}.${bytes[4]}:${bytes.readUInt16BE(5)}`;

  uLobby.replaceRooms([
    {
      ...anyGame,
      id: 12,
      name: 'three of us',
      master: 'PlayerA',
      members: ['PlayerA', 'PlayerB', 'PlayerC'],
      endpoints: [
        { nick: 'PlayerA', address: '192.168.178.27', port: 8888 },
        { nick: 'PlayerB', address: '192.168.178.27', port: 8889 },
        { nick: 'PlayerC', address: '192.168.178.27', port: 8890 },
      ],
    },
  ]);
  await until(() => false, 100);

  const three = await startRelay({ bind: '127.0.0.1', port: 0, coreUrl: core.url() });
  const a = await openAgentOn(three.port(), '192.168.178.27', 8888);
  const b = await openAgentOn(three.port(), '192.168.178.27', 8889);
  const c = await openAgentOn(three.port(), '192.168.178.27', 8890);
  check('all three are in one room now', await until(() => Object.values(three.rooms()).flat().length === 3), JSON.stringify(three.rooms()));

  a.send(framed('192.168.178.27', 8890, [9, 9]));
  check('the datagram reaches the player it named', await until(() => c.got.length > 0));
  check('and nobody else in the room', b.got.length === 0, `${b.got.length} at the wrong player`);
  check(
    'stamped with where it came from, so the game is answered by a peer it knows',
    stampOf(c.got[0]!) === '192.168.178.27:8888',
    stampOf(c.got[0]!),
  );
  check(
    'and the datagram itself is untouched',
    c.got[0]!.subarray(HEADER).equals(Buffer.from([9, 9])),
    c.got[0]!.toString('hex'),
  );

  b.send(framed('192.168.178.27', 8890, [7]));
  check('the other way round too', await until(() => c.got.length > 1));
  check('from the one who sent it', stampOf(c.got[1]!) === '192.168.178.27:8889', stampOf(c.got[1]!));
  check('and A, who was not addressed, has nothing', a.got.length === 0, `${a.got.length} at the sender`);

  // An address nobody in the room is at: it cannot be dropped — with two players
  // that is the normal case before the room description is read — so it goes to
  // the others, and the relay says so rather than pretending it routed.
  a.send(framed('10.0.0.1', 9999, [5]));
  check('an address that is nobody goes to the rest of the room', await until(() => b.got.length > 0 && c.got.length > 2));

  a.close();
  b.close();
  c.close();
  await three.close();
}

// ---------------------------------------------------------------------------------
console.log('\nthe relay with the core away');
// ---------------------------------------------------------------------------------
{
  // The property the whole design turns on: everything else may restart, and a game in
  // progress must not notice. Its own core and its own relay, because this one is going
  // to be killed — with its connections cut, or "away" would mean "still answering".
  const spare = await startCore({ bind: '127.0.0.1', port: 0, db, channels: CHANNELS });
  const feed = new CoreClient({ url: spare.url(), service: 'u-lobby' });
  feed.start();
  await until(() => feed.connected);
  feed.replaceRooms([
    {
      ...anyGame,
      id: 5,
      name: 'a game in progress',
      master: 'PlayerA',
      members: ['PlayerA', 'PlayerB'],
      endpoints: [
        { nick: 'PlayerA', address: '192.168.178.27', port: 8888 },
        { nick: 'PlayerB', address: '192.168.178.27', port: 8889 },
      ],
    },
  ]);
  await until(() => false, 100);

  const spareRelay = await startRelay({ bind: '127.0.0.1', port: 0, coreUrl: spare.url() });
  const before = await openAgentOn(spareRelay.port(), '192.168.178.27', 8888);
  check('an agent is admitted while the core is up', await until(() => Object.values(spareRelay.rooms()).flat().length === 1));
  before.close();
  await until(() => Object.values(spareRelay.rooms()).flat().length === 0);

  feed.stop();
  await spare.close();

  const during = await openAgentOn(spareRelay.port(), '192.168.178.27', 8888);
  check(
    'and again after the core has gone, on the identity it confirmed a moment ago',
    await until(() => Object.values(spareRelay.rooms()).flat().length === 1, 6000),
    JSON.stringify(spareRelay.rooms()),
  );
  check('into the same room, so a game in progress carries on', spareRelay.rooms()['room-5']?.join(',') === 'PlayerA');

  const unknown = await openAgentOn(spareRelay.port(), '192.168.178.27', 8890);
  check('but one it has never confirmed is refused rather than guessed at', await until(() => unknown.closed(), 6000));

  during.close();
  await spareRelay.close();
}

// ---------------------------------------------------------------------------------
console.log('\nthe chat line, in and out of the game s wrapper');
// ---------------------------------------------------------------------------------
{
  const wrapped = chatLine('Senyaak', 'well played');
  const back = parseChatLine(wrapped);
  check('a wrapped line reads back as what was said', back.nick === 'Senyaak' && back.text === 'well played', JSON.stringify(back));
  const percent = parseChatLine(chatLine('Senyaak', '100% mine'));
  check('and a percent sign in the text survives it', percent.text === '100% mine', percent.text);
  const bare = parseChatLine('just a sentence');
  check('something that is not in that shape is all text', bare.text === 'just a sentence' && bare.nick === '', JSON.stringify(bare));

  // The encoding. The game's chat is UTF-8 — captured 15.08.2026, a player typed Cyrillic
  // and it arrived as `d0b9 d186 d0b2`. It was read as windows-1251 for a year without
  // anyone noticing, because game-to-game the two errors cancel: UTF-8 misread as 1251 is
  // mojibake, and mojibake written back as 1251 is the original bytes again. Only the
  // stored copy was wrong — until the browser put real UTF-8 into the history.
  const russian = 'кто-нибудь тут есть?';
  const wire = toGameText(russian);
  check('Cyrillic goes out as UTF-8, two bytes a letter', wire.length === Buffer.byteLength(russian, 'utf8'), `${wire.length} vs ${russian.length} char(s)`);
  check('and comes back as what was typed', fromGameText(wire) === russian, fromGameText(wire));
  check('ASCII is untouched in both directions', toGameText('gg wp') === 'gg wp' && fromGameText('gg wp') === 'gg wp');
  check('and nothing has to be dropped — an emoji survives the round trip', fromGameText(toGameText('nice 🙂')) === 'nice 🙂', fromGameText(toGameText('nice 🙂')));

  // THE LINE THAT KILLED THE CLIENT.
  //
  // A sentence typed in the BROWSER is stored as the UTF-8 it is, and then replayed into
  // the game when somebody joins that channel. Under 1251 it left as `e4 f0 e0 f2 f3 f2 e5`
  // — a byte sequence that is not valid UTF-8 in any reading — and the client did not draw
  // it, it died on it: every copy that entered #LobbyGrp1.2 on 15.08.2026 was reset within
  // 1.2 seconds of the replay. What goes out must be decodable by the thing decoding it.
  const fromBrowser = 'дратуте';
  const sent = Buffer.from(toGameText(fromBrowser), 'latin1');
  check(
    'a browser-typed line reaches the game as valid UTF-8',
    Buffer.from(sent.toString('utf8'), 'utf8').equals(sent),
    sent.toString('hex'),
  );
  check('and says what was typed', sent.toString('utf8') === fromBrowser, sent.toString('utf8'));

  // What the u-lobby watches for: an IRC connection that says what was said and where.
  const connection = new IrcConnection();
  connection.receive(frame('NICK Senyaak'));
  const joined = connection.receive(frame(`JOIN :${RANKED}`));
  check('a JOIN names the channel to replay history into', joined[0]?.joined === RANKED, joined[0]?.joined);
  const said = connection.receive(frame(`PRIVMSG ${RANKED} :${chatLine('Senyaak', 'hello there')}`));
  check(
    'a PRIVMSG carries the bare sentence for the core',
    said[0]?.said?.text === 'hello there' && said[0]?.said?.channel === RANKED,
    JSON.stringify(said[0]?.said),
  );
  check('and still goes out to the other clients as bytes', (said[0]?.broadcast.length ?? 0) === 1);
}

// ---------------------------------------------------------------------------------
senya.close();
latecomer.close();
agentA.close();
agentB.close();
agentC.close();
stranger.close();
uLobby.stop();
await relay.close();
await web.close();
await core.close();

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);

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

import { openDatabase } from '../services/core/rules/database.ts';
import { Accounts } from '../services/core/rules/accounts.ts';
import { startCore } from '../services/core/server.ts';
import { CoreClient } from '../shared/core-client.ts';
import { ChatStore } from '../services/core/chat.ts';
import type { ChannelInfo, ChatMessage, PresenceEntry } from '../shared/core-protocol.ts';
import { startWeb } from '../services/web/web-service.ts';
import { startRelay } from '../services/relay/relay-service.ts';
import { IrcConnection, chatLine, frame, fromGameText, parseChatLine, toGameText } from '../services/gateway/irc.ts';
import { gameChannels, lobbyChannel } from '../shared/channels.ts';

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
const TOKEN = 'test-token';

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
const core = await startCore({ host: '127.0.0.1', port: 0, db, token: TOKEN, channels: CHANNELS });

// The gateway's side of the wire, which is a CoreClient and nothing else — the same
// object services/gateway/main.ts holds.
const heard: { message: ChatMessage; sender?: string }[] = [];
let presenceSeen: PresenceEntry[] = [];
const gateway = new CoreClient({ url: core.url(), token: TOKEN, service: 'gateway' });
gateway.onChat = (message, sender) => heard.push(sender === undefined ? { message } : { message, sender });
gateway.onPresence = (entries) => (presenceSeen = entries);
gateway.start();
check('the gateway reaches the core', await until(() => gateway.connected));

const web = await startWeb({ host: '127.0.0.1', port: 0, coreUrl: core.url(), coreToken: TOKEN });
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
gateway.post({ channel: RANKED, nick: 'Player', text: 'anyone for a duel?', origin: 'game', sender: 'gateway-1' });
check('a line said in the game reaches the browser', await until(() => senya.of('message').length > 0));
const fromGame = senya.of('message')[0]?.['message'] as ChatMessage | undefined;
check('with its text and its origin', fromGame?.text === 'anyone for a duel?' && fromGame?.origin === 'game', JSON.stringify(fromGame));
check(
  'and the gateway hears its own line back, marked as its own',
  await until(() => heard.some((one) => one.sender === 'gateway-1')),
  JSON.stringify(heard.map((one) => one.sender)),
);

// Browser -> game.
senya.say({ kind: 'say', text: 'I am in the browser' });
check('a line typed in the browser reaches the gateway', await until(() => heard.some((one) => one.message.origin === 'web')));
const fromWeb = heard.find((one) => one.message.origin === 'web');
check('with the browser nick on it', fromWeb?.message.nick === 'Senyaak', JSON.stringify(fromWeb?.message));
check('and no sender, so the gateway knows to draw it', fromWeb?.sender === undefined, String(fromWeb?.sender));

// Presence, both ways.
gateway.replacePresence('game', [{ nick: 'Player', channel: RANKED, origin: 'game' }]);
check('the browser is told who is in the game', await until(() => senya.of('presence').some((p) => JSON.stringify(p).includes('Player'))));
check(
  'and the gateway is told who is in the browser',
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

// The token.
const impostor = new CoreClient({ url: core.url(), token: 'not-the-token', service: 'gateway' });
let welcomed = false;
impostor.onConnected = () => (welcomed = true);
impostor.start();
await until(() => false, 300);
impostor.post({ channel: RANKED, nick: 'nobody', text: 'let me in', origin: 'web' });
await until(() => false, 200);
check('a wrong token is not welcomed', !welcomed);
check(
  'and nothing it says is stored',
  core.core.chat.history(RANKED).every((message) => message.nick !== 'nobody'),
);
impostor.stop();

// ---------------------------------------------------------------------------------
console.log('\nsessions that run out, and sockets that hold them open');
// ---------------------------------------------------------------------------------
{
  // The real windows are an hour and a minute; these are the same mechanism wound down
  // so the test can watch it happen. Its own service, so nothing above is disturbed —
  // including the throttle, which by now has this address on it.
  const IDLE = 1200;
  const brief = await startWeb({
    host: '127.0.0.1',
    port: 0,
    coreUrl: core.url(),
    coreToken: TOKEN,
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

// Three enrolled copies of the game — a secret each, the way `tools/issue-agent.ts` asks
// for one. Nobody says which room they are in: that comes from the gateway's room list.
const secretA = await gateway.issueAgent('PlayerA');
const secretB = await gateway.issueAgent('PlayerB');
const secretC = await gateway.issueAgent('PlayerC');
check('an agent secret is long and not the player s name', secretA.length >= 32 && !secretA.includes('PlayerA'));
check('and each is different', new Set([secretA, secretB, secretC]).size === 3);

// The rooms, as the gateway sees them: two players in one game, one in another.
gateway.replaceRooms([
  { id: 7, name: 'a duel', master: 'PlayerA', members: ['PlayerA', 'PlayerB'] },
  { id: 9, name: 'somewhere else', master: 'PlayerC', members: ['PlayerC'] },
]);
await until(() => false, 100);

const relay = await startRelay({ host: '127.0.0.1', port: 0, coreUrl: core.url(), coreToken: TOKEN });

interface Agent {
  got: Buffer[];
  send(bytes: Uint8Array): void;
  closed(): boolean;
  close(): void;
}

/** An agent: a WebSocket that says who it is by its secret and then carries datagrams. */
async function openAgentOn(port: number, token: string): Promise<Agent> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${token}`);
  socket.binaryType = 'arraybuffer';
  const got: Buffer[] = [];
  let closed = false;
  socket.addEventListener('message', (event: MessageEvent) => got.push(Buffer.from(event.data as ArrayBuffer)));
  socket.addEventListener('close', () => (closed = true));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  return { got, send: (bytes) => socket.send(bytes), closed: () => closed, close: () => socket.close() };
}

const agentA = await openAgentOn(relay.port(), secretA);
const agentB = await openAgentOn(relay.port(), secretB);
const agentC = await openAgentOn(relay.port(), secretC);
// Admission is one question to the core each, answered in whatever order they come back,
// so this waits for all three rather than assuming the order they connected in.
const seated = (): string => {
  const rooms = relay.rooms();
  return Object.keys(rooms)
    .sort()
    .map((room) => `${room}=${rooms[room]!.slice().sort().join('+')}`)
    .join(' ');
};
check('the relay admits agents the core knows', await until(() => Object.values(relay.rooms()).flat().length === 3), seated());
check('and puts them in their own rooms', seated() === 'room-7=PlayerA+PlayerB room-9=PlayerC', seated());

agentA.send(new Uint8Array([1, 2, 3, 4]));
check('a datagram reaches the other agent in the room', await until(() => agentB.got.length > 0));
check('unchanged', agentB.got[0]?.equals(Buffer.from([1, 2, 3, 4])) === true, agentB.got[0]?.toString('hex'));
check('and nobody in another room sees it', agentC.got.length === 0, `${agentC.got.length} datagram(s)`);
check('nor does the sender', agentA.got.length === 0, `${agentA.got.length} datagram(s)`);

const stranger = await openAgentOn(relay.port(), 'a-secret-nobody-issued');
check('an agent the core does not know is dropped', await until(() => stranger.closed()));
check('and never joins a room', Object.values(relay.rooms()).flat().length === 3, JSON.stringify(relay.rooms()));

// The room is the fresh half of the answer: the secret says who, the gateway says where.
const secretD = await gateway.issueAgent('PlayerD');
const homeless = await openAgentOn(relay.port(), secretD);
check('an enrolled agent whose player is in no room is refused too', await until(() => homeless.closed()));

// And when the game ends, the room goes — the next connection has nothing to join.
gateway.replaceRooms([{ id: 9, name: 'somewhere else', master: 'PlayerC', members: ['PlayerC'] }]);
await until(() => false, 100);
const afterwards = await openAgentOn(relay.port(), secretB);
check('once the room is gone, its agents are no longer admitted', await until(() => afterwards.closed()));
check(
  'while the game that is still open keeps its own',
  relay.rooms()['room-9']?.join(',') === 'PlayerC',
  JSON.stringify(relay.rooms()),
);

// ---------------------------------------------------------------------------------
console.log('\nthe relay with the core away');
// ---------------------------------------------------------------------------------
{
  // The property the whole design turns on: everything else may restart, and a game in
  // progress must not notice. Its own core and its own relay, because this one is going
  // to be killed — with its connections cut, or "away" would mean "still answering".
  const spare = await startCore({ host: '127.0.0.1', port: 0, db, token: TOKEN, channels: CHANNELS });
  const feed = new CoreClient({ url: spare.url(), token: TOKEN, service: 'gateway' });
  feed.start();
  await until(() => feed.connected);
  feed.replaceRooms([{ id: 5, name: 'a game in progress', master: 'PlayerA', members: ['PlayerA', 'PlayerB'] }]);
  await until(() => false, 100);

  const spareRelay = await startRelay({ host: '127.0.0.1', port: 0, coreUrl: spare.url(), coreToken: TOKEN });
  const before = await openAgentOn(spareRelay.port(), secretA);
  check('an agent is admitted while the core is up', await until(() => Object.values(spareRelay.rooms()).flat().length === 1));
  before.close();
  await until(() => Object.values(spareRelay.rooms()).flat().length === 0);

  feed.stop();
  await spare.close();

  const during = await openAgentOn(spareRelay.port(), secretA);
  check(
    'and again after the core has gone, on the identity it confirmed a moment ago',
    await until(() => Object.values(spareRelay.rooms()).flat().length === 1, 6000),
    JSON.stringify(spareRelay.rooms()),
  );
  check('into the same room, so a game in progress carries on', spareRelay.rooms()['room-5']?.join(',') === 'PlayerA');

  const unknown = await openAgentOn(spareRelay.port(), secretC);
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

  // The codepage. IRC here is one byte per character in the client's own Windows ANSI
  // page, so a Russian sentence has to be converted at the gateway's edge or it is stored
  // as `:B>-=81C4L` and lost — which is exactly what the first live run did.
  const russian = 'кто-нибудь тут есть?';
  const wire = toGameText(russian);
  check('Cyrillic goes out as one byte a character', wire.length === russian.length, `${wire.length} vs ${russian.length}`);
  check('and comes back as what was typed', fromGameText(wire) === russian, fromGameText(wire));
  check('ASCII is untouched in both directions', toGameText('gg wp') === 'gg wp' && fromGameText('gg wp') === 'gg wp');
  check('and a character the codepage has no room for becomes a question mark', toGameText('nice 🙂') === 'nice ?', toGameText('nice 🙂'));

  // What the gateway watches for: an IRC connection that says what was said and where.
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
gateway.stop();
await relay.close();
await web.close();
await core.close();

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);

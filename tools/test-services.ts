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

async function openBrowser(url: string): Promise<Browser> {
  const socket = new WebSocket(url);
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

const senya = await openBrowser(`ws://127.0.0.1:${web.port()}/`);
senya.say({ kind: 'hello', nick: 'Senyaak', channel: RANKED });
check('the browser is welcomed', await until(() => senya.of('welcome').length > 0));
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

// History — the requirement, not the nicety.
const latecomer = await openBrowser(`ws://127.0.0.1:${web.port()}/`);
latecomer.say({ kind: 'hello', nick: 'Somebody', channel: RANKED });
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
console.log('\nthe relay');
// ---------------------------------------------------------------------------------

await gateway.registerAgent('token-a', 'PlayerA', 'room-7');
await gateway.registerAgent('token-b', 'PlayerB', 'room-7');
await gateway.registerAgent('token-c', 'PlayerC', 'room-9');

const relay = await startRelay({ host: '127.0.0.1', port: 0, coreUrl: core.url(), coreToken: TOKEN });

/** An agent: a WebSocket that says who it is by its token and then carries datagrams. */
async function openAgent(token: string): Promise<{ got: Buffer[]; send(bytes: Uint8Array): void; closed(): boolean; close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port()}/agent?token=${token}`);
  socket.binaryType = 'arraybuffer';
  const got: Buffer[] = [];
  let closed = false;
  socket.addEventListener('message', (event: MessageEvent) => got.push(Buffer.from(event.data as ArrayBuffer)));
  socket.addEventListener('close', () => (closed = true));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  return { got, send: (bytes) => socket.send(bytes), closed: () => closed, close: () => socket.close() };
}

const agentA = await openAgent('token-a');
const agentB = await openAgent('token-b');
const agentC = await openAgent('token-c');
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

const stranger = await openAgent('token-nobody-issued');
check('an agent the core does not know is dropped', await until(() => stranger.closed()));
check('and never joins a room', !JSON.stringify(relay.rooms()).includes('token-nobody-issued'), JSON.stringify(relay.rooms()));

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

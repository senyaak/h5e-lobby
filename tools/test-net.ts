// Checks our Game Service layers against bytes a real client sent.
//
// The recorded packets are the two the game put on our NAT port (captured
// 12.08.2026, docs/NETWORK.md): an SRP SYN with its window, and the FIN it sends
// when it gives up waiting. They are the only ground truth we have, so the
// checksum test is the one that matters most — it is the piece a wrong answer
// dies on silently.
//
// Usage: `node tools/test-net.ts`

import { decode, decodeBody, encode, encodeBody, type GSValue } from '../services/u-lobby/gs-data.ts';
import { decrypt, encrypt } from '../services/u-lobby/gs-xor.ts';
import { HEADER_SIZE, Flags, buildSegment, checksum, parseSegment, verify } from '../services/u-lobby/srp.ts';
import { MessageType, Property, build, parse } from '../services/u-lobby/gs-message.ts';
import { NatService, inetU32 } from '../services/u-lobby/nat-service.ts';
import { KEY_BLOB_SIZE, decryptWith, encryptTo, generateKeyPair, parsePublicKey, publicKeyBlob } from '../services/u-lobby/pkc.ts';
import { GUEST, GUEST_LOBBY, RouterService, type RouterSession } from '../services/u-lobby/router-service.ts';
import { Blowfish } from '../services/u-lobby/blowfish.ts';
import { CdKeyRequest, CdKeyService } from '../services/u-lobby/cdkey-service.ts';
import { GAME_PORT, LobbyMsg, Lsm, RoomUpdate, playerInfo, roomEndpoints, withRating } from '../services/u-lobby/lobby.ts';
import { findField, readFields, writeFields } from '../services/u-lobby/structure.ts';
import { FACTIONS, LADDER_KEYS, Ladder, STARTING_RATING } from '../services/core/rules/ladder.ts';
import { Accounts } from '../services/core/rules/accounts.ts';
import { Friends } from '../services/core/rules/friends.ts';
import { openDatabase } from '../services/core/rules/database.ts';
import { IrcService, chatLine, frame, unframe } from '../services/u-lobby/irc.ts';
import { classifyDatagram, classifyUService } from '../services/u-lobby/classify.ts';
import { StateFeed } from '../services/u-lobby/state-feed.ts';
import type { PresenceEntry, RoomInfo } from '../shared/core-protocol.ts';
import { lobbyChannel } from '../shared/channels.ts';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The CREATE_ROOM the player really sent, off disk. */
function capturedCreateRoom(): Buffer {
  return Buffer.from(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'net', 'create-room.hex'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('#'))
      .join('')
      .replace(/[^0-9a-f]/gi, ''),
    'hex',
  );
}

/** The host's description of a room with two players in it, off disk. */
function capturedRoomPlayers(): Buffer {
  return Buffer.from(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'net', 'room-players.hex'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('#'))
      .join('')
      .replace(/[^0-9a-f]/gi, ''),
    'hex',
  );
}

/** A GS_ENCRYPT message, built the way the client builds one. */
function encryptedMessage(type: number, body: GSValue[], key: Buffer): Buffer {
  const encrypted = new Blowfish(key).encrypt(encodeBody(body));
  const size = 6 + encrypted.length;
  const header = Buffer.alloc(6);
  header[0] = (size >>> 16) & 0xff;
  header[1] = (size >>> 8) & 0xff;
  header[2] = size & 0xff;
  header[3] = Property.GS_ENCRYPT << 6;
  header[4] = type & 0xff;
  header[5] = (8 << 4) | 2;
  return Buffer.concat([header, encrypted]);
}

/** The client's opening SYN, exactly as it arrived. */
const CLIENT_SYN = Buffer.from('9388000008004230000000000a000100ff441802', 'hex');
/** And the FIN+URG it repeats nine times before starting over. */
const CLIENT_FIN = Buffer.from('b6cf000000004930ffff0000', 'hex');
/**
 * The first thing it says on the router socket once the NAT step succeeds: a
 * KEY_EXCHANGE carrying its own 512-bit RSA public key.
 */
const ROUTER_KEY_EXCHANGE = Buffer.from(
  '00011c00db82fa8bbfa4979da4acb5bfcad69f44b0b121bbfea3969ca3abb4bec9d5c96be35b2031d7e3f799a2aab3bd' +
    'c8d4ccddcaef1f30408f949aa1a9b2bcc7d36c70d6d11e2f3f4ea39da0a8b1bbc6d2b50bef751e2e3e4d5b999fa7b0ba' +
    'c5d105b26801f42d3d4c5a679ea6afb9c4d0ddc1b9e5ba2c3c4b596672a5aeb8c3cfdce561bea02b3b4a5865717cadb7' +
    'c2cedbbd1bed6a2a3a495764707b85b6c1cdda7ce0be8e29394856636f7a848dc0ccd9a557b5f328384755626e79838c' +
    '94cbd807935fe527374654616d78828b939ad79fa36b7b26364553606c77818a9299aeeede76253544525f6b76808991' +
    '98c373382f243443515e6a757f8890979ee9f7233342505d69747e878f969c4e2232414f5c68737d868e959b',
  'hex',
);

console.log('\nSRP against recorded client packets');
{
  const segment = parseSegment(CLIENT_SYN);
  check('SYN header reads back', segment.header.dataSize === 8 && segment.header.seg === 0);
  check('flags are the marker plus SYN', segment.header.flags === (Flags.MARKER | Flags.SYN), `0x${segment.header.flags.toString(16)}`);
  check('window is there', segment.window !== undefined);
  check(
    'window says seed 0x44ff, signature 1, buffer 536',
    segment.window?.checksumSeed === 0x44ff && segment.window?.senderSignature === 1 && segment.window?.bufferSize === 0x218,
  );

  // The one that proves the algorithm: the client's own checksum, recomputed.
  check('checksum of the SYN is the one the client wrote', checksum(CLIENT_SYN) === 0x8893, `0x${checksum(CLIENT_SYN).toString(16)}`);
  check('a segment as sent sums to a valid checksum', verify(CLIENT_SYN));

  // And it has to be able to FAIL: one flipped byte must not still verify.
  const tampered = Buffer.from(CLIENT_SYN);
  tampered[13]! ^= 0x01;
  check('a flipped byte no longer verifies', !verify(tampered));

  // The odd-length rule, read out of the routine at 0x4796E0: the lone first byte
  // is SIGN-EXTENDED (`movsx`), and during verification that byte is the seed's own
  // low byte. So a seed with its low bit-7 set must land 0x100 away from the naive
  // unsigned reading — which is what silently killed every second session, because
  // the client picks its seed at random and half of them have that byte >= 0x80.
  const odd = Buffer.concat([Buffer.alloc(HEADER_SIZE), Buffer.alloc(31, 0x5a)]);
  const naive = (buf: Buffer, seed: number): number => {
    // Deliberately the WRONG arithmetic, kept here as the thing we must differ from.
    const data = Buffer.from(buf);
    data.writeUInt16LE(seed & 0xffff, 0);
    let total = data[0]!;
    for (let at = 1; at + 1 < data.length; at += 2) total += data.readUInt16LE(at);
    const once = (total & 0xffff) + (total >>> 16);
    return ~((once + (once >>> 16)) & 0xffff) & 0xffff;
  };
  check('an odd segment with a low seed byte under 0x80 reads the same either way', checksum(odd, 0xc40b) === naive(odd, 0xc40b));
  check(
    'and with 0xb5 it does NOT — the byte counts as negative',
    checksum(odd, 0x74b5) !== naive(odd, 0x74b5),
    `signed 0x${checksum(odd, 0x74b5).toString(16)} vs unsigned 0x${naive(odd, 0x74b5).toString(16)}`,
  );
  // A complemented sum, so counting the byte as negative moves the result UP by 256.
  check(
    'the difference is exactly the 256 the sign costs',
    ((checksum(odd, 0x74b5) - naive(odd, 0x74b5)) & 0xffff) === 0x100,
    String((checksum(odd, 0x74b5) - naive(odd, 0x74b5)) & 0xffff),
  );

  const fin = parseSegment(CLIENT_FIN);
  check('FIN carries FIN+URG', (fin.header.flags & Flags.FIN) !== 0 && (fin.header.flags & Flags.URG) !== 0);
  check('checksum of the FIN also matches', checksum(CLIENT_FIN) === 0xcfb6, `0x${checksum(CLIENT_FIN).toString(16)}`);
}

console.log('\nSRP segments we build');
{
  const seed = 0x44ff;
  const bytes = buildSegment(
    {
      header: { checksum: 0, signature: 1, dataSize: 0, flags: Flags.MARKER | Flags.SYN | Flags.ACK, seg: 0, ack: 0 },
      window: { tail: 10, senderSignature: 2, checksumSeed: 0, bufferSize: 0x218 },
    },
    seed,
  );
  check('a built SYN+ACK is header plus window', bytes.length === HEADER_SIZE + 8);
  check('its length field matches its body', parseSegment(bytes).header.dataSize === 8);
  check('it verifies against the seed we signed it with', verify(bytes, seed));
  check('and not against a different seed', !verify(bytes, 0));
}

console.log('\nGS list codec');
{
  const list: GSValue[] = ['2', ['7', '16777343', '40010'], new Uint8Array([1, 2, 3])];
  const round = decode(encode(list));
  check('a list survives a round trip', JSON.stringify(round) === JSON.stringify(list));
  check('a body round trips without its brackets', JSON.stringify(decodeBody(encodeBody(list))) === JSON.stringify(list));
  check('a body is the list minus two bytes', encodeBody(list).length === encode(list).length - 2);
}

console.log('\nGS obfuscation');
{
  let sizes = 0;
  let same = 0;
  for (let size = 1; size <= 200; size++) {
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) body[i] = (i * 37 + size) & 0xff;
    sizes++;
    if (decrypt(encrypt(body)).equals(body)) same++;
  }
  check('every length from 1 to 200 survives the shuffle', same === sizes, `${same}/${sizes}`);
  const body = Buffer.from('hello ubi', 'utf8');
  check('the shuffle actually changes the bytes', !encrypt(body).equals(body));
}

console.log('\nGS messages');
{
  const bytes = build({ property: Property.GS, priority: 0, type: MessageType.NAT, sender: 4, receiver: 8, body: ['3', ['7']] });
  const message = parse(bytes);
  check('a message reads back its own header', message?.type === MessageType.NAT && message?.sender === 4 && message?.receiver === 8);
  check('size counts the header', message?.size === bytes.length);
  check('and the body comes back', JSON.stringify(message?.body) === JSON.stringify(['3', ['7']]));
  check('a truncated message is refused, not guessed', parse(bytes.subarray(0, bytes.length - 1)) === null);
}

console.log('\nNAT service, driven by the recorded packets');
{
  const service = new NatService(40010);
  const from = { address: '127.0.0.1', port: 1024 };
  check('the NAT mirror uses the inet_addr form', inetU32('127.0.0.1') === 16777343, String(inetU32('127.0.0.1')));

  const opened = service.handle(CLIENT_SYN, from);
  check('the SYN gets exactly one answer', opened.replies.length === 1, opened.note);
  const answer = parseSegment(opened.replies[0]!);
  check('the answer is SYN+ACK', (answer.header.flags & Flags.SYN) !== 0 && (answer.header.flags & Flags.ACK) !== 0);
  check('it acknowledges the segment that opened it', answer.header.ack === 0);
  check('it carries our window', answer.window?.bufferSize === 0x218);
  check('it is signed with the seed the client announced', verify(opened.replies[0]!, 0x44ff));

  // A NAT ask, in the shape the client sends: [subtype, [socketId]].
  const ask = build({ property: Property.GS, priority: 0, type: MessageType.NAT, sender: 4, receiver: 8, body: ['1', ['7']] });
  const asked = service.handle(
    buildSegment(
      { header: { checksum: 0, signature: 1, dataSize: 0, flags: Flags.MARKER, seg: 1, ack: 1 }, message: ask },
      0x44ff,
    ),
    from,
  );
  check('an ask gets the three answers that were accepted together', asked.replies.length === 3, asked.note);
  const first = parse(parseSegment(asked.replies[0]!).message!);
  check('the answer is a NAT message', first?.type === MessageType.NAT);
  // The one configuration the client has ever accepted — see NAT_ANSWERS for the
  // four runs that established it, including the two where "fixing" this broke it.
  check(
    'it answers in inet_addr order, with the port of the mirror itself',
    JSON.stringify(first?.body) === JSON.stringify(['1', ['7', '16777343', '40010']]),
    JSON.stringify(first?.body),
  );

  const ping = service.handle(Buffer.from([1, 2, 3, 4]), from);
  check('a short packet is echoed as a ping', ping.replies.length === 1 && ping.replies[0]!.length === 4);

  const closed = service.handle(CLIENT_FIN, from);
  check('a FIN is answered with silence', closed.replies.length === 0, closed.note);
  const after = service.handle(
    buildSegment({ header: { checksum: 0, signature: 1, dataSize: 0, flags: Flags.MARKER, seg: 2, ack: 1 }, message: ask }, 0x44ff),
    from,
  );
  check('and the client is forgotten', after.replies.length === 0, after.note);
}

console.log('\nRSA key blobs, against the key a real client sent');
{
  // The KEY_EXCHANGE body the game put on our router port, captured 12.08.2026.
  const message = parse(ROUTER_KEY_EXCHANGE);
  const payload = message?.body?.[1];
  const blob = Array.isArray(payload) ? payload[2] : undefined;
  check('the captured packet is a KEY_EXCHANGE', message?.type === MessageType.KEY_EXCHANGE);
  check('its body says step 1', message?.body?.[0] === '1');
  check('the key blob is 260 bytes', blob instanceof Uint8Array && blob.length === KEY_BLOB_SIZE, String((blob as Uint8Array)?.length));

  const key = parsePublicKey(blob as Uint8Array);
  check('the client key is 512 bits with exponent 3', key.bits === 512 && key.exponent === 3n, `${key.bits} bits, e=${key.exponent}`);
  check('its modulus really is 512 bits', key.modulus.toString(2).length === 512);
  check('re-serializing gives back the same bytes', publicKeyBlob(key).equals(Buffer.from(blob as Uint8Array)));

  // Our own key has to survive the same round trip, and be usable.
  const pair = generateKeyPair();
  check('our key round trips through the blob', parsePublicKey(publicKeyBlob(pair.publicKey)).modulus === pair.publicKey.modulus);
  const secret = Buffer.from('0123456789abcdef', 'utf8');
  check('a session key encrypted to us comes back', decryptWith(pair.privateKey, encryptTo(pair.publicKey, secret)).equals(secret));
}

console.log('\nWhich u-lobby service a connection is, from what it says first');
{
  // The four TCP u-lobby services share one port now (SLICE §2.3), so this is what decides which of
  // them a connection wants. The router's case is the recorded packet itself; the others
  // are built from the type each u-lobby service was measured opening with, which is the only part
  // of the message the classifier is allowed to look at.
  const opener = (type: number): Buffer =>
    build({ property: Property.GS, priority: 0, type, sender: 8, receiver: 2, body: ['senyaak', 'secret'] });

  check('the recorded KEY_EXCHANGE is the router', classifyUService(ROUTER_KEY_EXCHANGE).service === 'Router', classifyUService(ROUTER_KEY_EXCHANGE).note);
  check('a LOGIN is the proxy', classifyUService(opener(MessageType.LOGIN)).service === 'Proxy');
  check('and so is a LOGINWAITMODULE', classifyUService(opener(MessageType.LOGINWAITMODULE)).service === 'Proxy');
  check('a LOBBYSERVERLOGIN is the lobby', classifyUService(opener(MessageType.LOBBYSERVERLOGIN)).service === 'Lobby');
  check('the ini fetch is HTTP', classifyUService(Buffer.from('GET http://ubi.com/servers.ini HTTP/1.1\r\n', 'latin1')).service === 'HTTP');

  // Chat is what is left, and it has to survive being read as a GS header: the frame's
  // u16 length in the top two bytes makes a size far bigger than the bytes that arrived.
  const nick = frame('NICK Senyaak');
  check('a wrapped IRC line is chat', classifyUService(nick).service === 'IRC', classifyUService(nick).note);
  check('and it is not mistaken for a size that fits', ((nick[0]! << 16) | (nick[1]! << 8) | nick[2]!) > nick.length);

  // Half a header decides nothing, and neither does half a message.
  check('two bytes are not enough to say', classifyUService(ROUTER_KEY_EXCHANGE.subarray(0, 2)).wait);
  check('a GET still arriving is not chat', classifyUService(Buffer.from('GE', 'latin1')).wait);
  const half = ROUTER_KEY_EXCHANGE.subarray(0, 20);
  check('a message still arriving waits rather than falls through', classifyUService(half).wait, classifyUService(half).note);
  check('and the wait says how much is still to come', classifyUService(half).note.includes('20 here so far'), classifyUService(half).note);

  // The one thing it refuses: a message that IS a GS message but opens no u-lobby service. Guessing
  // would put it in somebody's conversation and the log would not say which.
  const alive = classifyUService(Buffer.from('000006003a41', 'hex'));
  check('a STILLALIVE opens no service and is refused, not guessed at', alive.service === null && !alive.wait, alive.note);
  check('and the refusal names the type, for whoever reads the log', alive.note.includes('STILLALIVE'), alive.note);
}

console.log('\nWhich window a datagram is for');
{
  // Both UDP windows are one socket too (SLICE §2.3, step 4), and a datagram has no
  // connection to remember it by, so each one is sorted on its own.
  const cipher = new Blowfish(Buffer.from('SKJDHF$0maoijfn4i8$aJdnv1jaldifar93-AS_dfo;hjhC4jhflasnF3fnd', 'utf8'));
  const cdkey = (): Buffer => {
    const body = cipher.encrypt(encodeBody(['17', String(CdKeyRequest.CHALLENGE), '0', []]));
    const out = Buffer.alloc(5 + body.length);
    out[0] = 0xd3;
    out.writeUInt32BE(body.length, 1);
    body.copy(out, 5);
    return out;
  };

  check('a CD-key request adds up, so it is the CD-key window', classifyDatagram(cdkey()).window === 'CDKey', classifyDatagram(cdkey()).note);
  check('the SYN the client really sent is the mirror', classifyDatagram(CLIENT_SYN).window === 'NAT', classifyDatagram(CLIENT_SYN).note);
  check('and so is the FIN', classifyDatagram(CLIENT_FIN).window === 'NAT');
  // The trap: the mirror echoes anything under twelve bytes, so it must be tried last or
  // it swallows whatever short thing was meant for the other window.
  const short = Buffer.from('d300000003010203', 'hex'); // eight bytes: header, a body of three
  check('a short datagram that adds up is still the CD-key window', classifyDatagram(short).window === 'CDKey', classifyDatagram(short).note);
  check('a short one that does not is the mirror keep-alive', classifyDatagram(Buffer.from('0102030405060708', 'hex')).window === 'NAT');
}

console.log('\nRouter, driven by the recorded packet');
{
  const session = new RouterService({ address: '127.0.0.1', port: 40001 }, { address: '127.0.0.1', port: 40030 }, { address: '127.0.0.1', port: 40031 }, { address: '127.0.0.1', port: 40040 }, join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db')).session();
  const events = session.receive(ROUTER_KEY_EXCHANGE);
  check('the key exchange gets exactly one answer', events.length === 1 && events[0]!.replies.length === 1, events[0]?.note);

  const answer = parse(events[0]!.replies[0]!);
  check('the answer is a KEY_EXCHANGE too', answer?.type === MessageType.KEY_EXCHANGE);
  check('with the parties turned round', answer?.sender === 2 && answer?.receiver === 8, `${answer?.sender}->${answer?.receiver}`);
  const ours = Array.isArray(answer?.body?.[1]) ? (answer!.body![1] as GSValue[]) : [];
  check('it says step 1 and carries a key', answer?.body?.[0] === '1' && ours[0] === '1');
  check('the length it states matches the blob', ours[1] === String(KEY_BLOB_SIZE) && (ours[2] as Uint8Array)?.length === KEY_BLOB_SIZE);
  check('and that blob parses as a 512-bit key', parsePublicKey(ours[2] as Uint8Array).bits === 512);

  // Where the client is sent next, and in the form it can actually use: a
  // decimal u32, because a dotted string reaches it as its first octet.
  const jwm = build({ property: Property.GS, priority: 0, type: MessageType.JOINWAITMODULE, sender: 4, receiver: 1, body: null });
  const sent = session.receive(jwm);
  const answer2 = parse(sent[0]!.replies[0]!);
  const where = answer2?.body?.[1] as GSValue[];
  check('the wait module answer is a success', answer2?.type === MessageType.GSSUCCESS, sent[0]?.note);
  check('the address is 127.0.0.1 in host order', where?.[0] === '2130706433', String(where?.[0]));
  check('the port is four raw bytes, little-endian', Buffer.from(where?.[1] as Uint8Array).readUInt32LE(0) === 40001);

  // A login is accepted and answered as success, naming the message it answers.
  const login = build({ property: Property.GS, priority: 0, type: MessageType.LOGIN, sender: 8, receiver: 2, body: ['senyaak', 'secret'] });
  const loggedIn = session.receive(login);
  const success = parse(loggedIn[0]!.replies[0]!);
  check('a login is answered with GSSUCCESS', success?.type === MessageType.GSSUCCESS, loggedIn[0]?.note);
  check('the answer names LOGIN', (success?.body?.[0] as Uint8Array)?.[0] === MessageType.LOGIN);
  check('the name is remembered', session.username === 'senyaak');

  // Two messages in one read must both be handled, and a split one must wait.
  const alive = build({ property: Property.GS, priority: 0, type: MessageType.STILLALIVE, sender: 8, receiver: 2, body: null });
  const bundled = session.receive(Buffer.concat([alive, login]));
  check('a bundle of two is walked, not truncated', bundled.length === 2, bundled.map((e) => e.note).join(' | '));
  const half = session.receive(login.subarray(0, 4));
  check('half a message waits for its other half', half.length === 0);
  check('and completes when the rest arrives', session.receive(login.subarray(4)).length === 1);
}

console.log('\nRouter, once the session keys are up');
{
  const session = new RouterService({ address: '127.0.0.1', port: 40001 }, { address: '127.0.0.1', port: 40030 }, { address: '127.0.0.1', port: 40031 }, { address: '127.0.0.1', port: 40040 }, join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db')).session();
  // Step one gives us the key the client should seal its session key to.
  const opened = session.receive(ROUTER_KEY_EXCHANGE);
  const ourBlob = (parse(opened[0]!.replies[0]!)!.body![1] as GSValue[])[2] as Uint8Array;
  const ourKey = parsePublicKey(ourBlob);
  const sessionKey = Buffer.from('0123456789abcdef', 'utf8');
  const sealed = encryptTo(ourKey, sessionKey);
  const step2 = build({
    property: Property.GS,
    priority: 0,
    type: MessageType.KEY_EXCHANGE,
    sender: 8,
    receiver: 2,
    body: ['2', ['1', String(sealed.length), new Uint8Array(sealed)]],
  });
  const keyed = session.receive(step2);
  check('the session key is taken', keyed[0]!.replies.length === 1, keyed[0]?.note);
  check('and it is the one the client sealed', session.clientBlowfishKey?.equals(sessionKey) === true);

  // A login the way it really arrived: GS_ENCRYPT, keyed with OUR session key.
  const encrypted = encryptedMessage(MessageType.LOGIN, ['senyaak', 'secret'], session.serverBlowfishKey!);
  const loggedIn = session.receive(encrypted);
  check('an encrypted login is opened and answered', loggedIn[0]!.replies.length === 1, loggedIn[0]?.note);
  check('the name inside it is read', session.username === 'senyaak');
  check('and we know which key opened it', session.encryptedWith !== null, String(session.encryptedWith));

  // What the client asked next, verbatim from the wire: where does the module
  // "persistantdata" live? (Its spelling, not ours.)
  const asked = session.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 4,
      receiver: 1,
      body: ['1', ['persistantdata', '0', '0']],
    }),
  );
  const proxied = parse(asked[0]!.replies[0]!);
  check('a module request is answered', asked[0]!.replies.length === 1, asked[0]?.note);
  check('the answer keeps the PROXY_HANDLER type', proxied?.type === MessageType.PROXY_HANDLER);
  check(
    'and names the module with our proxy behind it',
    JSON.stringify(proxied?.body) === JSON.stringify(['38', ['1', ['persistantdata', '0', '0', [['1', '2130706433', '40030']]]]]),
    JSON.stringify(proxied?.body),
  );
  check(
    'an unknown module is not invented',
    session.receive(
      build({ property: Property.GS, priority: 0, type: MessageType.PROXY_HANDLER, sender: 4, receiver: 1, body: ['1', ['clanservice', '0', '0']] }),
    )[0]!.replies.length === 0,
  );

  // The bug that stalled the first real login: a body we cannot open must not
  // stay at the front of the stream.
  const gibberish = encryptedMessage(MessageType.LOGIN, ['nobody'], Buffer.from('a-key-we-never-agreed', 'utf8'));
  const alive = build({ property: Property.GS, priority: 0, type: MessageType.STILLALIVE, sender: 8, receiver: 2, body: null });
  const mixed = session.receive(Buffer.concat([gibberish, alive]));
  check('an unreadable message is reported, not left in the way', mixed.length === 2, mixed.map((e) => e.note).join(' | '));
  check('and the stream keeps working after it', session.receive(alive).length === 1);
}

console.log('\nBlowfish');
{
  // The 1993 test vector: an all-zero key and an all-zero block encrypt to
  // 4EF997456198DD78. Our blocks are read little-endian, so those two halves come
  // out byte-reversed — round-tripping alone would not catch a wrong S-box.
  const zeros = new Blowfish(Buffer.alloc(8));
  const block = zeros.encrypt(Buffer.alloc(8)).subarray(0, 8);
  check('the standard test vector comes out right', block.toString('hex') === '4597f94e78dd9861', block.toString('hex'));

  const cipher = new Blowfish(Buffer.from('SKJDHF$0maoijfn4i8$aJdnv1jaldifar93-AS_dfo;hjhC4jhflasnF3fnd', 'utf8'));
  let ok = 0;
  for (let size = 1; size <= 64; size++) {
    const plain = Buffer.alloc(size);
    for (let i = 0; i < size; i++) plain[i] = (i * 91 + size) & 0xff;
    if (cipher.decrypt(cipher.encrypt(plain)).equals(plain)) ok++;
  }
  check('every length from 1 to 64 survives a round trip', ok === 64, `${ok}/64`);
  check('the length trailer is where the padding is trimmed', cipher.encrypt(Buffer.alloc(5)).length === 10);
}

console.log('\nCD-key service');
{
  const service = new CdKeyService();
  const cipher = new Blowfish(Buffer.from('SKJDHF$0maoijfn4i8$aJdnv1jaldifar93-AS_dfo;hjhC4jhflasnF3fnd', 'utf8'));
  const from = { address: '127.0.0.1', port: 1030 };

  /** A request in the client's framing: type byte, big-endian size, body. */
  const ask = (request: number, inner: GSValue[] = []): Buffer => {
    const body = cipher.encrypt(encodeBody(['17', String(request), '0', inner]));
    const out = Buffer.alloc(5 + body.length);
    out[0] = 1;
    out.writeUInt32BE(body.length, 1);
    body.copy(out, 5);
    return out;
  };

  for (const [name, request] of [
    ['challenge', CdKeyRequest.CHALLENGE],
    ['activation', CdKeyRequest.ACTIVATION],
    ['authorisation', CdKeyRequest.AUTH],
  ] as const) {
    const result = service.handle(ask(request, ['ABCD-EFGH-IJKL-MNOP']), from);
    const body = decodeBody(cipher.decrypt(result.replies[0]!.subarray(5)));
    const inner = body[3] as GSValue[];
    check(`a ${name} request is answered`, result.replies.length === 1, result.note);
    check(`the ${name} answer echoes the message id and type`, body[0] === '17' && body[1] === String(request));
    check(`the ${name} answer says success`, inner?.[0] === String(MessageType.GSSUCCESS), String(inner?.[0]));
  }

  const validated = service.handle(ask(CdKeyRequest.VALIDATION), from);
  const inner = (decodeBody(cipher.decrypt(validated.replies[0]!.subarray(5)))[3] as GSValue[])[1] as GSValue[];
  check('a validation says the player is valid', inner[0] === '2', String(inner[0]));

  check('a keep-alive is not answered', service.handle(ask(CdKeyRequest.STILL_ALIVE), from).replies.length === 0);
  // The same question twice has to get the same token, or the client sees its
  // activation change under it.
  const first = service.handle(ask(CdKeyRequest.ACTIVATION), from).replies[0]!;
  const again = service.handle(ask(CdKeyRequest.ACTIVATION), from).replies[0]!;
  check('the same request gets the same answer', first.equals(again));
}

console.log('\nThe proxy service answers differently, because the client asked it to');
{
  const proxy = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('proxy');

  const login = build({ property: Property.GS, priority: 0, type: MessageType.LOGIN, sender: 4, receiver: 1, body: ['Senyaak', 'secret'] });
  const loggedIn = proxy.receive(login);
  const answer = parse(loggedIn[0]!.replies[0]!);
  check('the proxy login is a success', answer?.type === MessageType.GSSUCCESS, loggedIn[0]?.note);
  check(
    'and carries the empty list the proxy expects beside the id',
    Array.isArray(answer?.body?.[1]) && (answer!.body![1] as GSValue[]).length === 0,
    JSON.stringify(answer?.body),
  );

  const jwm = build({ property: Property.GS, priority: 0, type: MessageType.JOINWAITMODULE, sender: 4, receiver: 1, body: null });
  const handed = proxy.receive(jwm);
  const onwards = parse(handed[0]!.replies[0]!)?.body?.[1] as GSValue[];
  check('the proxy names the user in its hand-off', onwards?.[0] === 'Senyaak', JSON.stringify(onwards));
  check('the address is still host order', onwards?.[1] === '2130706433');
  check('but the port is spelled out here, not four bytes', onwards?.[2] === '40031');
}

console.log('\nThe lobby, as far as the wait module goes');
{
  const lobbyService = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('router');

  const lobbyMessage = (subtype: number, inner: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 1, body: [String(subtype), inner] });

  // Verbatim from the wire: the client logs in to the lobby naming the game.
  const loggedIn = lobbyService.receive(lobbyMessage(LobbyMsg.LOGIN, ['HEROES_29988429c481f219']));
  const ok = parse(loggedIn[0]!.replies[0]!);
  // Two answers: the success, and the channels behind it — the client asks for
  // neither, it just waits, which is how the first channel screen came up empty.
  check('the lobby login is answered and the channels follow', loggedIn[0]!.replies.length === 2, loggedIn[0]?.note);
  check('as a LOBBY_MSG saying success', ok?.type === MessageType.LOBBY_MSG && ok?.body?.[0] === '38');
  const pushed = parse(loggedIn[0]!.replies[1]!);
  const channels = (pushed?.body?.[1] as GSValue[])?.[3] as GSValue[];
  check('the push is a GROUP_INFO with three channels', pushed?.body?.[0] === String(LobbyMsg.GROUP_INFO) && channels?.length === 3);
  check(
    'and each channel names the game the client logged in with',
    (channels?.[0] as GSValue[])?.[8] === 'HEROES_29988429c481f219',
    String((channels?.[0] as GSValue[])?.[8]),
  );

  const listed = lobbyService.receive(lobbyMessage(LobbyMsg.CHANGE_REQUESTED_LOBBIES, ['HEROES_29988429c481f219']));
  const info = parse(listed[0]!.replies[0]!);
  const groups = (info?.body?.[1] as GSValue[])?.[3] as GSValue[];
  check('the lobby list comes back as GROUP_INFO', info?.body?.[0] === String(LobbyMsg.GROUP_INFO), listed[0]?.note);
  check('with our three lobbies', Array.isArray(groups) && groups.length === 3, String(groups?.length));
  const ranked = (groups?.[1] as GSValue[]) ?? [];
  check('each is fourteen fields', ranked.length === 14, String(ranked.length));
  check('Ranked is named and rated', ranked[1] === 'Ranked' && ranked[11] === '1', `${String(ranked[1])}, mode ${String(ranked[11])}`);

  const joined = lobbyService.receive(lobbyMessage(LobbyMsg.JOIN_SERVER, ['1']));
  const where = (parse(joined[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[];
  check('joining a server hands over the lobby address', where?.[1] === '2130706433' && where?.[2] === '40040', JSON.stringify(where));
}

console.log('\nThe lobby server, from the words the client really said');
{
  const lobby = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('lobby');

  // Verbatim: name, server id, its own address, its netmask, and a zero.
  const hello = build({
    property: Property.GS,
    priority: 0,
    type: MessageType.LOBBYSERVERLOGIN,
    sender: 4,
    receiver: 2,
    body: ['Senyaak', '1', '192.168.178.27', '255.255.255.0', '0'],
  });
  const greeted = lobby.receive(hello);
  const back = parse(greeted[0]!.replies[0]!);
  check('the lobby server login is answered', greeted[0]!.replies.length === 1, greeted[0]?.note);
  check('it echoes the server id', JSON.stringify(back?.body) === JSON.stringify(['210', ['1']]), JSON.stringify(back?.body));
  check('and we keep the address the client reported', lobby.localAddress === '192.168.178.27' && lobby.localNetmask === '255.255.255.0');

  // Verbatim off the wire: the channel id, a password, and the mask — field 2, which
  // is the one the answer has to echo.
  const joined = lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.JOIN_LOBBY), ['2', '', '384']],
    }),
  );
  check('the mask comes back as asked', (parse(joined[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[1] === '384', String((parse(joined[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[1]));
  check(
    'and it says members are in there, which is what makes the list draw',
    (Number((parse(joined[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[1]) & Lsm.GROUPMEMBERS) !== 0,
  );
  check('joining a channel is answered and its contents follow', joined[0]!.replies.length === 2, joined[0]?.note);
  const contents = parse(joined[0]!.replies[1]!);
  const inside = contents?.body?.[1] as GSValue[];
  check('the contents name the channel joined', ((inside?.[2] as GSValue[]) ?? [])[1] === 'Ranked', JSON.stringify((inside?.[2] as GSValue[])?.[1]));
  check('with no games in it yet', Array.isArray(inside?.[3]) && (inside[3] as GSValue[]).length === 0);

  // But WITH the player himself. An empty list leaves the client's player panel empty,
  // and then "Profile" — "look at the results of the selected players" — is grey,
  // because there is nobody to select.
  //
  // Two of them, because the guest is seated by the server itself: he is the other
  // player a lone tester needs — somebody to select, to read a ladder row about, and
  // to add as a friend — and he follows whoever enters a channel into it.
  const listed = inside?.[4] as GSValue[];
  // Looked up BY NAME rather than by position: the panel keys its rows by name too
  // (0x911b90), and who comes first in the list is an accident of who entered when —
  // the guest is seated before anyone connects, so he is first here.
  const memberNamed = (who: string): GSValue[] =>
    (listed ?? []).map((entry) => entry as GSValue[]).find((entry) => entry[0] === who) ?? [];
  check('and with him in its player list', listed?.length === 2, String(listed?.length));
  check('under his own name', memberNamed('Senyaak')[0] === 'Senyaak', JSON.stringify((listed ?? []).map((e) => (e as GSValue[])[0])));
  check('with the guest beside him, to have somebody to select', memberNamed(GUEST)[0] === GUEST, JSON.stringify(memberNamed(GUEST)[0]));
  check(
    'and the guest carries a blob, so his record is not an empty name',
    memberNamed(GUEST)[4] instanceof Uint8Array,
    JSON.stringify(memberNamed(GUEST)[4]),
  );
  check(
    'at the address he reported for himself',
    memberNamed('Senyaak')[2] === '192.168.178.27',
    String(memberNamed('Senyaak')[2]),
  );
  // And with the status the panel insists on. This is the field that kept the list
  // empty while every other part of the message was right: the client's own
  // CPlayersController::OnMemberJoined (0x9108f0) drops a member whose status is
  // anything but 0, silently, after the game log has already said he arrived.
  check('and with a status the player panel accepts', memberNamed('Senyaak')[7] === '0', String(memberNamed('Senyaak')[7]));
  check('and the channel says how many are in it', ((inside?.[2] as GSValue[]) ?? [])[13] === '2', String(((inside?.[2] as GSValue[]) ?? [])[13]));

  // He sends his own player-info blob a second AFTER this list went out — the client
  // composes it only once its ladder row has arrived — and the rating the panel draws
  // lives inside that blob. So the refresh he asks for on every return to
  // CStateOutOfRoom has to carry the members again, or his rating stays "…" for the
  // whole session. The body of that request is [group, mask], measured off the wire.
  const own = Buffer.from('0408040000000176020e53656e7961616b0508dc050000', 'hex');
  lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.SET_PLAYER_INFO), ['0', new Uint8Array(own)]],
    }),
  );
  // And the channel is told again the moment that blob arrives, without being asked:
  // his rating lives inside it, the member list went out a second before he had one,
  // and until this the panel drew "…" beside his own name for the whole session.
  const told = lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.SET_PLAYER_INFO), ['0', new Uint8Array(own)]],
    }),
  );
  check('a player-info is acknowledged and the channel told again', told[0]!.replies.length === 2, told[0]?.note);
  const pushed = parse(told[0]!.replies[1]!);
  check('what follows the acknowledgement is the channel', pushed?.body?.[0] === String(LobbyMsg.GROUP_INFO), String(pushed?.body?.[0]));
  const pushedMembers = (pushed?.body?.[1] as GSValue[])?.[4] as GSValue[];
  const pushedHim = pushedMembers.map((e) => e as GSValue[]).find((e) => e[0] === 'Senyaak') ?? [];
  check('carrying his record with the blob in it this time', Buffer.from(pushedHim[4] as Uint8Array).equals(own), JSON.stringify(pushedHim[4]));
  check('and the log says why it was sent', told[0]!.note.includes('so his rating is drawn'), told[0]?.note);

  const asked = lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.GROUP_INFO_GET), ['2', '384']],
    }),
  );
  check('a group-info refresh is more than an acknowledgement', asked[0]!.replies.length === 2, asked[0]?.note);
  const refreshed = parse(asked[0]!.replies[1]!);
  check('what follows it is a GROUP_INFO', refreshed?.body?.[0] === String(LobbyMsg.GROUP_INFO), String(refreshed?.body?.[0]));
  const refreshedInside = refreshed?.body?.[1] as GSValue[];
  check('for the channel he asked about, with the mask he asked with', refreshedInside?.[0] === '2' && refreshedInside?.[1] === '384', JSON.stringify([refreshedInside?.[0], refreshedInside?.[1]]));
  const again = refreshedInside?.[4] as GSValue[];
  check('and both players in it again', again?.length === 2, String(again?.length));
  const refreshedNamed = (who: string): GSValue[] =>
    (again ?? []).map((entry) => entry as GSValue[]).find((entry) => entry[0] === who) ?? [];
  check(
    'his record now carrying the blob he sent, which is where the rating is',
    Buffer.from(refreshedNamed('Senyaak')[4] as Uint8Array).equals(own),
    JSON.stringify(refreshedNamed('Senyaak')[4]),
  );
}

console.log("\nThe game's own serialisation, the format inside a blob");
{
  // Read off 0x94ef30: tag byte, then the size doubled — in one byte, or in four
  // with bit 0 set. The client's own room settings are the proof: a 555-byte
  // document that divides into fields edge to edge, with the two unset ids in it.
  const settings = (parse(capturedCreateRoom())?.body?.[1] as GSValue[])?.[6] as Uint8Array;
  const fields = readFields(Buffer.from(settings));
  check('the settings blob the client sent is a document of whole fields', fields.length === 5, String(fields.length));
  check('with the game data under tag 1', fields[1]?.tag === 1 && fields[1]?.value.length === 538, String(fields[1]?.value.length));
  const inner = readFields(fields[1]!.value);
  check('whose first field is the room id, still unset', inner[0]?.tag === 2 && inner[0]?.value.readInt32LE(0) === -1);
  check('and whose second is the lobby server id, the same', inner[1]?.tag === 3 && inner[1]?.value.readInt32LE(0) === -1);
  const path = inner.find((f) => f.tag === 15);
  check(
    'and the map is in there as a narrow string one level down',
    readFields(path!.value)[0]?.value.toString() === '/Maps/Multiplayer/Rules Test/map.xdb#xpointer(/AdvMapDesc)',
    readFields(path!.value)[0]?.value.toString(),
  );

  // A length of 128 or more is where the two forms part, so it is the one to check.
  const long = Buffer.alloc(200, 3);
  const written = writeFields([
    { tag: 2, value: Buffer.from('Senyaak') },
    { tag: 5, value: long },
  ]);
  check('a short field is written in two bytes', written[0] === 2 && written[1] === 7 << 1);
  check('a long one in five, with bit 0 marking it', written[9] === 5 && written.readUInt32LE(10) === ((200 << 1) | 1));
  const back = readFields(written);
  check('and both come back as they went in', back[0]!.value.toString() === 'Senyaak' && back[1]!.value.equals(long));
  check('a document that does not divide into fields is refused', (() => {
    try {
      readFields(Buffer.from([2, 0xfe]));
      return false;
    } catch {
      return true;
    }
  })());

  // The blob we compose for an invented player is checked against the one the client
  // composed for itself, because "the reader would accept this" is exactly the reasoning
  // that put a nameless player in the channel: every read is guarded by "is this tag
  // here", so a document with the name at the TOP level is legal and empty.
  const invented = readFields(Buffer.from(playerInfo('GhostList', 1234)));
  check('an invented player info opens with the kind, as his own does', invented[0]?.tag === 4 && invented[0]?.value.length === 4, JSON.stringify(invented[0]?.tag));
  const inside = readFields(invented[1]!.value);
  check('and puts everything one level down, under tag 1', invented[1]?.tag === 1, String(invented[1]?.tag));
  check('with the name under tag 2 in there', inside.find((f) => f.tag === 2)?.value.toString() === 'GhostList', JSON.stringify(inside.map((f) => f.tag)));
  // Tag 5 is what the panel shows as the rating: OnMemberJoined copies [member+0x38]
  // into the row, and +0x38 is where 0xdfea70 puts these four bytes.
  check('and the rating under tag 5, which is the column that said "…"', inside.find((f) => f.tag === 5)?.value.readInt32LE(0) === 1234, JSON.stringify(inside.find((f) => f.tag === 5)?.value));
  // The shape is the client's own, so its own blob has to parse the same way.
  const his = readFields(Buffer.from('0408040000000176020e53656e7961616b0324022002009c4a0100007f0000000000000000042c0204b8220320c0a8b21b0000000000000000000000000508dc050000', 'hex'));
  const hisInside = readFields(his[1]!.value);
  check('the blob the client really sent has the same skeleton', his[0]?.tag === 4 && his[1]?.tag === 1, JSON.stringify(his.map((f) => f.tag)));
  check('his name in the same place', hisInside.find((f) => f.tag === 2)?.value.toString() === 'Senyaak');
  check('and his rating where ours goes — 1500, the row we had just sent him', hisInside.find((f) => f.tag === 5)?.value.readInt32LE(0) === 1500);
}

console.log('\nHosting a game, from the CREATE_ROOM the player really sent');
{
  const lobby = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('lobby');
  lobby.username = 'Senyaak';

  const captured = capturedCreateRoom();
  const asked = parse(captured);
  check('the capture is a CREATE_ROOM', asked?.type === MessageType.LOBBY_MSG && asked?.body?.[0] === String(LobbyMsg.CREATE_ROOM));

  const made = lobby.receive(captured);
  check('it is answered, and the room announced', made[0]!.replies.length === 2, made[0]?.note);
  const confirmed = parse(made[0]!.replies[0]!)?.body?.[1] as GSValue[];
  const room = (confirmed?.[1] as GSValue[]) ?? [];
  check('the answer carries an id, the name and the server', room.length === 3, JSON.stringify(room));
  check('the name is the one the player composed', String(room[1]).includes('Senyaak'), String(room[1]));

  const announced = parse(made[0]!.replies[1]!);
  const entry = (announced?.body?.[1] as GSValue[])?.[0] as GSValue[];
  check('the announcement is a NEW_GROUP', announced?.body?.[0] === String(LobbyMsg.NEW_GROUP));
  check('the room is peer-to-peer type 7', entry?.[0] === '7', String(entry?.[0]));
  check('its master is the host', entry?.[7] === 'Senyaak', String(entry?.[7]));
  check(
    'the settings blob keeps its size',
    entry?.[10] instanceof Uint8Array && (entry[10] as Uint8Array).length === 555,
    String((entry?.[10] as Uint8Array)?.length),
  );

  // A room is twenty fields, a channel is fourteen, and the client tells a new game
  // from a new channel by exactly that. Sent in the channel's shape, our room was
  // logged as LobbyRcv_NewLobby and then refused: "no such room in internal list".
  check('the room is announced in the twenty-field room shape', entry?.length === 20, String(entry?.length));
  check('its config is the all-info mask', entry?.[5] === String(Lsm.ALLINFO), String(entry?.[5]));
  check('it carries the version the client sent', entry?.[17] === 'HEROES_a3e9d5c9b79a1a57', String(entry?.[17]));
  check('and an address for the host', typeof entry?.[18] === 'string' && (entry[18] as string).length > 0, String(entry?.[18]));

  // The host wrote -1 for both ids, because when he composed the blob there was no
  // room. Leaving them at -1 hands him back a game he cannot recognise.
  const stamped = entry?.[10] as Uint8Array;
  const unset = Buffer.from([0x02, 0x08, 0xff, 0xff, 0xff, 0xff, 0x03, 0x08, 0xff, 0xff, 0xff, 0xff]);
  const idsAt = Buffer.from(stamped).indexOf(Buffer.from([0x02, 0x08]));
  check('the room id is stamped into the blob', Buffer.from(stamped).indexOf(unset) === -1);
  check(
    'and it is the id we handed out',
    idsAt >= 0 && Buffer.from(stamped).readInt32LE(idsAt + 2) === Number(room[0]),
    `${Buffer.from(stamped).readInt32LE(idsAt + 2)} vs ${String(room[0])}`,
  );

  // Entering the room. The reply is only "yes"; the GROUP_INFO after it is what puts
  // the room in the client's list, and it has to come back with the mask asked for.
  const entered = lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.JOIN_ROOM), [String(room[0]), '', '448', '0', 'HEROES_a3e9d5c9b79a1a57']],
    }),
  );
  check('joining the room is answered, with its info as well', entered[0]!.replies.length === 2, entered[0]?.note);
  // Order is part of the answer: the client dispatches in arrival order, so the room
  // has to be in its list BEFORE it reads the "yes".
  check('the room info comes first', parse(entered[0]!.replies[0]!)?.body?.[0] === String(LobbyMsg.GROUP_INFO), String(parse(entered[0]!.replies[0]!)?.body?.[0]));
  check('and the "you are in" second', parse(entered[0]!.replies[1]!)?.body?.[0] === '38', String(parse(entered[0]!.replies[1]!)?.body?.[0]));
  const info = parse(entered[0]!.replies[0]!)?.body?.[1] as GSValue[];
  check('the info echoes the mask the client asked with', info?.[1] === '448', String(info?.[1]));
  check('the room in it is the twenty-field shape too', (info?.[2] as GSValue[])?.length === 20, String((info?.[2] as GSValue[])?.length));
  const member = (info?.[4] as GSValue[])?.[0] as GSValue[];
  check('one member is listed, in eight fields', member?.length === 8, JSON.stringify(member?.length));
  check('it is the host', member?.[0] === 'Senyaak', String(member?.[0]));
  // No blob invented for him: the client only reads that field if it has bytes, and
  // then it reads nothing else — so an empty one leaves it reading his name here.
  check(
    'and he carries no player info we made up',
    member?.[4] instanceof Uint8Array && (member[4] as Uint8Array).length === 0,
    String((member?.[4] as Uint8Array)?.length),
  );

  // Backing out of the channel is what the host really does when he abandons a
  // game: `GROUP_LEAVE` with the CHANNEL's id, never the room's. Left listed, that
  // room made the client refuse the next game — "a game with this name already
  // exists" — without sending anything, so this is checked from the other side too:
  // the channel must come back empty.
  const lobbyMsg = (body: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 2, body });
  const parentId = String((entry?.[4] as string) ?? '1');
  const left = lobby.receive(lobbyMsg([String(LobbyMsg.GROUP_LEAVE), [parentId]]));
  check('leaving the channel takes the host’s own game with it', left[0]?.note.includes('gone') === true, left[0]?.note);
  // And he is TOLD, so his own list drops it. Left to find out by clicking, he sent a
  // JOIN_ROOM for a game that no longer existed and waited for an answer for ever.
  check(
    'and the game is announced as removed',
    left[0]!.replies.some((r) => parse(r)?.body?.[0] === String(LobbyMsg.GROUP_REMOVE)),
    String(left[0]!.replies.length),
  );

  // A game that is gone is refused, out loud.
  const missing = lobby.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), ['999', '', '448', '0', '']]));
  check('joining a game that does not exist is refused, not ignored', missing[0]!.replies.length === 2, missing[0]?.note);
  check('with GSFAIL rather than GSSUCCESS', parse(missing[0]!.replies[0]!)?.body?.[0] === '39', String(parse(missing[0]!.replies[0]!)?.body?.[0]));
  const relisted = lobby.receive(lobbyMsg([String(LobbyMsg.JOIN_LOBBY), [parentId]]));
  const listed = (parse(relisted[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[3];
  check('so the channel lists no games again', Array.isArray(listed) && (listed as GSValue[]).length === 0, relisted[0]?.note);

  // And when the host goes, the game goes with him — otherwise the next player is
  // told the name is taken by somebody who left. Which is what happened.
  const again = lobby.receive(captured);
  check('he can host the same name once more', again[0]?.note.includes('CREATE_ROOM') === true, again[0]?.note);
  const dropped = lobby.close();
  check('closing the host connection drops his game', dropped?.includes('Senyaak') === true, String(dropped));
  check('and closing again drops nothing', lobby.close() === null);
}

console.log('\nInside the room: his own info, and changing the settings');
{
  const lobby = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('lobby');
  lobby.username = 'Senyaak';
  const lobbyMsg = (body: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 2, body });

  const roomId = String(
    ((parse(lobby.receive(capturedCreateRoom())[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0],
  );

  // He waits for a reply to this one, so silence is thirty seconds; and the blob is
  // his own account of where he can be reached, which beats the one we synthesise.
  // Before he has told us anything, his member record carries NO blob: the client
  // then reads his name out of the record itself. A blob of our own invention is
  // read as a nameless stranger — see memberEntry.
  const anonymous = lobby.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [roomId, '', '448', '0', '']]));
  const first = ((parse(anonymous[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[4] as GSValue[])?.[0] as GSValue[];
  check('with nothing told about him, his record carries an empty blob', (first?.[4] as Uint8Array)?.length === 0, String((first?.[4] as Uint8Array)?.length));
  check('and his name is in the record where the client falls back to it', first?.[0] === 'Senyaak', String(first?.[0]));

  const own = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const told = lobby.receive(lobbyMsg([String(LobbyMsg.SET_PLAYER_INFO), [roomId, own]]));
  check('his player info is answered', told[0]!.replies.length === 1, told[0]?.note);
  check('and the answer names the subtype back', parse(told[0]!.replies[0]!)?.body?.[0] === '38');

  const entered = lobby.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [roomId, '', '448', '0', '']]));
  // replies[0] is the room info; the "you are in" follows it — see the order check
  // in the hosting block for why.
  const member = ((parse(entered[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[4] as GSValue[])?.[0] as GSValue[];
  check(
    'from then on his member record carries his own blob, not ours',
    member?.[4] instanceof Uint8Array && Buffer.from(member[4] as Uint8Array).equals(own),
    JSON.stringify(member?.[4]),
  );

  // The flags are the payload's shape: max players, then the settings blob.
  const settings = Buffer.alloc(16, 7);
  const updated = lobby.receive(
    lobbyMsg([String(LobbyMsg.GROUP_CONFIG_UPDATE_RES), [roomId, String(RoomUpdate.MAX_PLAYERS | RoomUpdate.GROUP_INFO), '4', settings]]),
  );
  check('a settings change is answered, and the room sent back out', updated[0]!.replies.length === 2, updated[0]?.note);
  const room = (parse(updated[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[2] as GSValue[];
  check('the new player count took', room?.[12] === '4', String(room?.[12]));
  check(
    'and the new settings blob is the one he sent',
    room?.[10] instanceof Uint8Array && Buffer.from(room[10] as Uint8Array).equals(settings),
    String((room?.[10] as Uint8Array)?.length),
  );
  // And it must NOT list members: the client reads a member list as an arrival, and
  // answers an arrival with another settings update — that is the loop that spammed
  // "somebody joined" until the room was closed.
  check(
    'the settings notification lists no members',
    ((parse(updated[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[4] as GSValue[])?.length === 0,
    JSON.stringify((parse(updated[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[4]),
  );
  check(
    'and its mask does not ask for them either',
    (Number((parse(updated[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[1]) & Lsm.GROUPMEMBERS) === 0,
    String((parse(updated[0]!.replies[1]!)?.body?.[1] as GSValue[])?.[1]),
  );

  // Told, not asked: no reply, but it must be named in the log rather than land in
  // "not implemented", which is how a real gap stays visible.
  const connected = lobby.receive(lobbyMsg([String(LobbyMsg.GAME_CONNECTED), [roomId]]));
  check('being connected to his own game needs no answer', connected[0]!.replies.length === 0, connected[0]?.note);
  check('but it is named', connected[0]!.note.includes('GAME_CONNECTED'), connected[0]?.note);
}

console.log('\nThe ladder, from the query the client really sent');
{
  const proxy = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  ).session('proxy');

  // The body verbatim, as it arrived twice on the proxy wait module: the request
  // number, the request id, and a query whose fifth field holds the pivot user.
  const asked = proxy.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 8,
      receiver: 11,
      body: [
        '1281',
        '1',
        ['1', ['1', 'HEROES_29988429c481f219', '1', '0', ['1', ['Senyaak', '1']], [[], [], []]]],
      ],
    }),
  );
  check('the ladder query is answered at all', asked[0]!.replies.length === 1, asked[0]?.note);
  check('and it is about the pivot user, not the socket', asked[0]!.note.includes('"Senyaak"'), asked[0]?.note);

  const answer = parse(asked[0]!.replies[0]!);
  check('the answer is a PROXY_HANDLER', answer?.type === MessageType.PROXY_HANDLER, String(answer?.type));
  // A REAL ROW since 13.08.2026: the refusal was only ever a stand-in for a payload
  // nobody had read, and 0x432c80 is that payload's parser.
  check('and it succeeds, with 38 rather than 39', answer?.body?.[0] === '38', String(answer?.body?.[0]));
  const carried = answer?.body?.[1] as GSValue[];
  check('the request number is nested where the matcher looks for it', carried?.[0] === '1281', String(carried?.[0]));
  // The three, and the third is the REQUEST ID. 0x42c8d2 reads index 2 as a number and
  // 0x42b810 then looks it up among the requests still pending; anything that matches
  // nothing pending ends the read without a word, which is what "the ladder read said
  // 0" was while the status right before it read fine.
  check('and it is a THREE: number, payload, request id', carried?.length === 3, String(carried?.length));
  check('with the id the client asked with, which is what is looked up', carried?.[2] === '1', JSON.stringify(carried?.[2]));

  // The payload, field by field, against what 0x432c80 does with each one. Every one of
  // these refuses in silence, so each is worth its own line.
  const payload = carried?.[1] as GSValue[];
  check('the payload opens with the tag the parser insists reads as 1', payload?.[0] === '1', JSON.stringify(payload?.[0]));
  const table = payload?.[1] as GSValue[];
  check('and the table under it is a four', table?.length === 4, String(table?.length));
  check("whose first number is the ladder's own request id", table?.[0] === '1', JSON.stringify(table?.[0]));
  const columns = table?.[2] as GSValue[];
  const rows = table?.[3] as GSValue[];
  check('the columns are the 46 keys the exe names', columns?.length === LADDER_KEYS.length, String(columns?.length));
  check('each one a pair whose first string is the name', (columns?.[0] as GSValue[])?.[0] === 'RATING', JSON.stringify(columns?.[0]));
  check('no column name is longer than the 32 characters the getter copies', columns.every((column) => ((column as GSValue[])[0] as string).length <= 32));
  // The rule that decides everything: 0x432b10 counts the cells against the columns and
  // returns error 3 if they differ. A row is never shortened, however empty the stat.
  check('one row came back', rows?.length === 1, String(rows?.length));
  check('with exactly one cell per column, which 0x432b10 checks', (rows?.[0] as GSValue[])?.length === columns?.length, String((rows?.[0] as GSValue[])?.length));
  // And every cell is a whole decimal number: the field getter runs strtol over it and
  // insists the whole string was consumed (0x431f20), so "1500 " or "N/A" is a refusal.
  check(
    'and every cell a plain decimal, which is all strtol will take',
    (rows?.[0] as GSValue[]).every((cell) => typeof cell === 'string' && /^-?\d+$/.test(cell)),
    JSON.stringify((rows?.[0] as GSValue[])?.slice(0, 4)),
  );
  check('the rating in it is the one we hold', (rows?.[0] as GSValue[])?.[0] === String(STARTING_RATING), JSON.stringify((rows?.[0] as GSValue[])?.[0]));
  check('the rating is named in the log too', asked[0]!.note.includes(String(STARTING_RATING)), asked[0]?.note);

  // THE SECOND QUERY, which is where this went wrong for a whole session. Two ids
  // travel with a ladder query: the module's (`body[1]`, counting 1, 3, 5, 7 because
  // the profile takes the even ones) and the ladder's own, the first field of the
  // query, counting 1, 2, 3. The reply is MATCHED by the first and JUDGED by the
  // second — 0x42c987 overwrites the correctly-resolved id with whatever the table's
  // first number says, and the game then drops anything it is not waiting for.
  //
  // The first query hides it, because both ids are 1 and so is the row count that used
  // to be sent there. So this asks with a query whose ids DIFFER, which is the only
  // shape that can fail.
  const second = proxy.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 8,
      receiver: 11,
      body: [
        '1281',
        '3',
        ['1', ['2', 'HEROES_29988429c481f219', '1', '0', ['1', ['Senyaak', '1']], [[], [], []]]],
      ],
    }),
  );
  const secondCarried = parse(second[0]!.replies[0]!)?.body?.[1] as GSValue[];
  check('a second query is answered too', second[0]!.replies.length === 1, second[0]?.note);
  check('matched by the MODULE id it asked with', secondCarried?.[2] === '3', JSON.stringify(secondCarried?.[2]));
  const secondTable = (secondCarried?.[1] as GSValue[])?.[1] as GSValue[];
  check("and judged by the LADDER's id, which is 2 here and not the row count", secondTable?.[0] === '2', JSON.stringify(secondTable?.[0]));
  check('the log names both, so a mismatch is visible without a launch', second[0]!.note.includes('query 3 (the ladder\'s own id 2)'), second[0]?.note);
  const stats = new Ladder(openDatabase(join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db')).db).row('Senyaak');
  check('with all 46 named fields in the store', Object.keys(stats).length === 46, String(Object.keys(stats).length));
  check('starting rated, not at zero', stats['RATING'] === STARTING_RATING, String(stats['RATING']));
  check('and with nothing played', stats['GAMES_PLAYED'] === 0, String(stats['GAMES_PLAYED']));
  check('in the exe order, Heaven first and Orcs last', LADDER_KEYS[12] === 'W_HEAVEN' && LADDER_KEYS[19] === 'W_ORCS');
}

console.log('\nAdding a friend, from the right-click the client really sent');
{
  // Its own file, emptied first: a store that outlives the process would otherwise
  // answer "already there" to the first check and pass for last week's reasons.
  const friendsDb = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-friends.db');
  rmSync(friendsDb, { force: true });
  const router = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    friendsDb,
  ).session('router');
  router.username = 'Senyaak';

  // Verbatim off the wire (12.08.2026): he right-clicked his own name in the channel.
  // Which is the one ADDFRIEND that has to be REFUSED — the client offers the option on
  // anybody, himself included, and a list with yourself on it is what came of saying yes.
  const clicked = router.receive(Buffer.from('00001a004b41faeeefe197d9f491969be2fb959aeef699939c9c', 'hex'));
  check('the right-click is an ADDFRIEND', clicked[0]?.note.startsWith('ADDFRIEND'), clicked[0]?.note);
  check('and it is answered rather than ignored', clicked[0]!.replies.length === 1, clicked[0]?.note);
  check('adding himself is refused', parse(clicked[0]!.replies[0]!)?.type === MessageType.GSFAIL, clicked[0]?.note);
  check('and he is on nobody\'s list, his own least of all', clicked[0]!.note.includes('not his own friend'), clicked[0]?.note);

  // The same click on somebody else. The capture is the only ADDFRIEND ever seen, so
  // the message for a second player is built rather than replayed — the fields are the
  // capture's, with another name in field 0.
  const other = router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.ADDFRIEND, sender: 4, receiver: 2, body: [GUEST, '', new Uint8Array(4)] }),
  );
  check('adding somebody else is answered', other[0]!.replies.length === 2, other[0]?.note);

  const answer = parse(other[0]!.replies[0]!);
  check('the answer is a plain success', answer?.type === MessageType.GSSUCCESS, String(answer?.type));
  // The routing key for a type-38 message is the single byte in field 0, read as a
  // one-byte blob (0x41b150). 75 is what puts this in the friends queue rather than
  // nowhere — the same trick that makes our friends LOGIN reply land.
  const key = answer?.body?.[0] as Uint8Array;
  check('and it names the message it answers, in one byte', key instanceof Uint8Array && key.length === 1 && key[0] === 75, JSON.stringify(key));
  // A STRING, not a list. 0x4292d0 fetches field 1 with the getter at 0x4426c0, which
  // refuses anything whose kind is not 1 — which is exactly how the list we used to
  // send was matched, consumed and then dropped without a word.
  check('with the friend named beside it, as a plain string', answer?.body?.[1] === GUEST, JSON.stringify(answer?.body?.[1]));
  check('and the friendship is kept, not just acknowledged', other[0]!.note.includes('added, 1 friend(s)'), other[0]?.note);

  // A nameless request is refused rather than answered with an empty name, and a
  // refusal's reason is FOUR bytes: 0x442620 compares the blob's length with what the
  // reader asked for and says no to anything else.
  const empty = router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.ADDFRIEND, sender: 4, receiver: 2, body: ['', '', new Uint8Array(4)] }),
  );
  const refused = parse(empty[0]!.replies[0]!);
  check('an ADDFRIEND with no name is refused', refused?.type === MessageType.GSFAIL, String(refused?.type));
  const reason = (refused?.body?.[1] as GSValue[])?.[0];
  check('and its reason is a four-byte blob under the key', reason instanceof Uint8Array && reason.length === 4, JSON.stringify(reason));
}

console.log('\nThe friends list, which the client can only be told and never asks for');
{
  const friendsDb = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-friend-list.db');
  rmSync(friendsDb, { force: true });
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    friendsDb,
  );
  const router = service.session('router');
  router.username = 'Senyaak';

  const number = (value: GSValue | undefined): number =>
    value instanceof Uint8Array && value.length === 4 ? Buffer.from(value).readUInt32LE(0) : NaN;
  const friendsLogin = () =>
    router.receive(
      build({ property: Property.GS, priority: 0, type: MessageType.LOGINFRIENDS, sender: 4, receiver: 1, body: ['Senyaak'] }),
    )[0]!;

  // Nobody on the list is not a reason to say nothing: the login is still answered,
  // and what follows it is just empty.
  const alone = friendsLogin();
  check('a friends login with no friends is one reply', alone.replies.length === 1, alone.note);

  const added = router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.ADDFRIEND, sender: 4, receiver: 2, body: ['Guest', '', new Uint8Array(4)] }),
  )[0]!;
  // The yes names the friend; the push beside it is the row itself, and it is the push
  // that carries everything a list draws.
  const row = parse(added.replies[1]!);
  check('adding a friend also pushes him as an UPDATEFRIEND', row?.type === MessageType.UPDATEFRIEND, String(row?.type));
  // 74 is a push, and its parser proves it: 0x428d90 insists the message's own TYPE
  // byte is 0x4A, where a reply would carry 38 or 39 with the key repeated inside.
  check('which is a message of its own type, not a 38 with a key inside it', row?.body?.[0] === 'Guest', JSON.stringify(row?.body?.[0]));

  const list = friendsLogin();
  check('and logging in again pushes the list after the yes', list.replies.length === 2, list.note);
  check('with the count in the log line', list.note.includes('1 friend(s) pushed'), list.note);

  const entry = parse(list.replies[1]!);
  const body = entry?.body ?? [];
  // Six fields, and the kinds are not ours to choose: 0x428d90 reads 0 and 2 with the
  // string getter, 1, 3 and 4 as four-byte blobs, and refuses the whole message —
  // silently — if any of them is something else.
  check('the pushed friend has six fields', body.length === 6, String(body.length));
  check('his name is a string', body[0] === 'Guest', JSON.stringify(body[0]));
  check('field 1 is four bytes and says he is online', number(body[1]) === 1, JSON.stringify(body[1]));
  check('field 2 is the channel he sits in, as a string', body[2] === 'Ranked', JSON.stringify(body[2]));
  check('field 3 is that channel as a number', number(body[3]) === GUEST_LOBBY, JSON.stringify(body[3]));
  check('field 4 is his rating, and the guest is not a default 1500', number(body[4]) === 1560, JSON.stringify(body[4]));
  check('field 5 is a string, the one field the client will default for us', body[5] === '', JSON.stringify(body[5]));

  // The other half of the right-click. Its reply is the add's with the key changed —
  // 0x429370 is 0x4292d0 to the instruction.
  const dropped = router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.DELFRIEND, sender: 4, receiver: 2, body: ['Guest', '', new Uint8Array(4)] }),
  )[0]!;
  const goodbye = parse(dropped.replies[0]!);
  const delKey = goodbye?.body?.[0] as Uint8Array;
  check('a DELFRIEND is answered with a success', goodbye?.type === MessageType.GSSUCCESS, String(goodbye?.type));
  check('naming message 76 in one byte', delKey instanceof Uint8Array && delKey.length === 1 && delKey[0] === MessageType.DELFRIEND, JSON.stringify(delKey));
  check('and the friend as a plain string', goodbye?.body?.[1] === 'Guest', JSON.stringify(goodbye?.body?.[1]));
  check('and he is gone from the store, not just from the screen', friendsLogin().replies.length === 1, dropped.note);

  // Himself. The client offers "add to friends" on his own name and asks nobody whether
  // that means anything, so the refusal has to be here.
  const self = router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.ADDFRIEND, sender: 4, receiver: 2, body: ['SENYAAK', '', new Uint8Array(4)] }),
  )[0]!;
  check('adding himself is refused', parse(self.replies[0]!)?.type === MessageType.GSFAIL, self.note);
  check('and nothing is pushed for him either', self.replies.length === 1, String(self.replies.length));
  check('however he capitalises it', self.note.includes('not his own friend'), self.note);

  // A friend who is not logged in is still a row — a friends list that only showed the
  // people already visible in the channel would be a second copy of the players panel.
  router.receive(
    build({ property: Property.GS, priority: 0, type: MessageType.ADDFRIEND, sender: 4, receiver: 2, body: ['Nobody', '', new Uint8Array(4)] }),
  );
  const offline = parse(friendsLogin().replies[1]!)?.body ?? [];
  check('an offline friend is still pushed', offline[0] === 'Nobody', JSON.stringify(offline[0]));
  check('with field 1 saying so', number(offline[1]) === 0, JSON.stringify(offline[1]));
  check('and nowhere for a place', offline[2] === '' && number(offline[3]) === 0, JSON.stringify(offline.slice(2, 4)));
}

console.log('\nThe profile, from the read the client really asked for');
{
  // A store that survives its process is the point of this one, so the file has to go
  // before the checks run — otherwise the first assertion reads what the LAST run
  // wrote and passes or fails for reasons that have nothing to do with the code.
  const profileDb = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-profiles.db');
  rmSync(profileDb, { force: true });

  const proxy = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    profileDb,
  );
  const session = proxy.session('proxy');
  session.username = 'Senyaak';

  const read = session.receive(
    Buffer.from(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'net', 'get-profile.hex'), 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('#'))
        .join('')
        .replace(/[^0-9a-f]/gi, ''),
      'hex',
    ),
  );
  check('the profile read is answered at all', read[0]!.replies.length === 1, read[0]?.note);
  check('and it names whose profile, in which game', read[0]!.note.includes("Senyaak's PUBLIC profile"), read[0]?.note);

  // The shape is the client's matcher, read at 0x4286f0 and 0x427170: type 204, the
  // status first, then a LIST whose field 0 is the number of the request. Without the
  // number nested there the reply is passed over in silence.
  const answer = parse(read[0]!.replies[0]!);
  check('the answer is a PROXY_HANDLER', answer?.type === MessageType.PROXY_HANDLER, String(answer?.type));
  // NOTHING STORED IS A SEED, not a refusal and not a success carrying nothing. All
  // three were tried: a zero-length record the client read happily and made nothing of
  // ("could not create a profile"); a refusal it understood and answered by keeping the
  // profile screen shut, which is what двойной клик по игроку hit; a minimal document it
  // takes ("PS get data succeeded") and can then write over.
  check('with nothing stored it seeds, rather than refusing', answer?.body?.[0] === '38', String(answer?.body?.[0]));
  check('and the log says the record was ours, so no reader mistakes it for his own', read[0]!.note.includes('CREATED'), read[0]?.note);
  const carried = answer?.body?.[1] as GSValue[];
  check('the request number is nested where the matcher looks', carried?.[0] === '1025', String(carried?.[0]));
  check('and what carries it is a three, as the reader wants', carried?.length === 3, String(carried?.length));
  // The capture asked with id 2, so 2 is what has to come back: it is looked up among
  // the pending requests, not counted.
  check('its last field being the id the request carried', carried?.[2] === '2', JSON.stringify(carried?.[2]));

  // The record itself, and that it is a whole document rather than a blob of zeroes.
  {
    const payload = (answer?.body?.[1] as GSValue[])?.[1] as GSValue[];
    const record = payload?.[0] as Uint8Array;
    check('carrying a record, with its length beside it as the reader insists', record instanceof Uint8Array && payload?.[1] === String(record.length), JSON.stringify(payload?.[1]));
    check('and the record is a whole document', readFields(Buffer.from(record)).map((f) => f.tag).join(',') === '4,1', JSON.stringify(readFields(Buffer.from(record)).map((f) => f.tag)));
  }

  // It is CREATED, not made up again on every read: the second read hands back what the
  // first one stored, out of the same table his account and his rating live in.
  {
    const again = session.receive(
      build({
        property: Property.GS,
        priority: 0,
        type: MessageType.PROXY_HANDLER,
        sender: 8,
        receiver: 11,
        body: ['1025', '3', ['HEROES_29988429c481f219', '0', 'Senyaak', '0', 'PUBLIC']],
      }),
    );
    check('a second read hands back what was stored', again[0]!.note.includes('handing back'), again[0]?.note);
  }

  // Every player, not only the guest. Double-clicking a name asks for THAT player's
  // profile, and a name nobody has a record for is every name until a client writes one.
  {
    const forOther = parse(
      session.receive(
        build({
          property: Property.GS,
          priority: 0,
          type: MessageType.PROXY_HANDLER,
          sender: 8,
          receiver: 11,
          body: ['1025', '5', ['HEROES_29988429c481f219', '0', 'Nobody', '0', 'PUBLIC']],
        }),
      )[0]!.replies[0]!,
    );
    check('a player who never wrote one is answered too', forOther?.body?.[0] === '38', String(forOther?.body?.[0]));
    const guestAsked = session.receive(
      build({
        property: Property.GS,
        priority: 0,
        type: MessageType.PROXY_HANDLER,
        sender: 8,
        receiver: 11,
        body: ['1025', '4', ['HEROES_29988429c481f219', '0', GUEST, '0', 'PUBLIC']],
      }),
    );
    check('and so is the guest', parse(guestAsked[0]!.replies[0]!)?.body?.[0] === '38', guestAsked[0]?.note);
    check('each under his own name', guestAsked[0]!.note.includes(`${GUEST}'s PUBLIC profile`), guestAsked[0]?.note);
  }

  // WHERE it goes, which cost more to learn than what is in it. The module's queue is
  // fed by the router's connection, and a reply on the socket the request came in on is
  // never queued at all — measured by the probe: the ladder's two copies produced ONE
  // queued message, and the profile answer, sent only on the proxy's wait module, was
  // never seen. So when a router connection is open, that is where the answer goes.
  // The u-lobby service is named 'Router' and not 'RouterLauncher' since the wait module moved onto
  // the router's own port (SLICE §2.3): one socket, so one name.
  const onRouter: Buffer[] = [];
  proxy.services.set('Router', (bytes) => onRouter.push(bytes));
  const routed = session.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 8,
      receiver: 11,
      body: ['1025', '9', ['HEROES_29988429c481f219', '0', 'Senyaak', '0', 'PUBLIC']],
    }),
  );
  check('with a router connection open, nothing goes back down the asking socket', routed[0]!.replies.length === 0, routed[0]?.note);
  check('and the answer went to the router instead', onRouter.length === 1, String(onRouter.length));
  check('the note says so, so a log reader knows which socket it took', routed[0]!.note.includes('on the router connection'), routed[0]?.note);
  check(
    'and it is the same answer, not a different one',
    parse(onRouter[0]!)?.type === MessageType.PROXY_HANDLER && (parse(onRouter[0]!)?.body?.[1] as GSValue[])?.[0] === '1025',
    JSON.stringify(parse(onRouter[0]!)?.body),
  );
  proxy.services.delete('Router');

  // A write, then a read: we are a store, so what comes back is what went in — byte
  // for byte, with no opinion about what a profile means.
  const written = Buffer.from('HEROES-PROFILE-v1:Senyaak:whatever the game puts here');
  const wrote = session.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 8,
      receiver: 11,
      body: ['1026', '3', ['HEROES_29988429c481f219', '0', 'Senyaak', '0', 'PUBLIC', new Uint8Array(written), '0']],
    }),
  );
  check('a profile write is answered', wrote[0]!.replies.length === 1, wrote[0]?.note);
  check('and it says how much was kept', wrote[0]!.note.includes(`saved ${written.length} byte(s)`), wrote[0]?.note);
  // The bytes themselves go in the log. A profile is the client's own composition and we
  // cannot make one up, so the first write to arrive is the only description of the
  // format there will ever be — a byte count would throw it away.
  check('and the record itself is in the log, as hex', wrote[0]!.note.includes(written.toString('hex')), wrote[0]?.note.slice(0, 120));
  // The reply to a write carries an EMPTY payload: its reader (0x42b2e0) takes body[1]
  // as a list, its [1] as a list it never opens, and its [2] as the request id.
  const acknowledged = parse(wrote[0]!.replies[0]!)?.body?.[1] as GSValue[];
  check('the write reply is the three its reader walks', acknowledged?.length === 3 && Array.isArray(acknowledged[1]), JSON.stringify(acknowledged));
  check('with nothing in the payload, which is all it reads', (acknowledged?.[1] as GSValue[])?.length === 0, JSON.stringify(acknowledged?.[1]));
  check('and the id it asked with', acknowledged?.[2] === '3', JSON.stringify(acknowledged?.[2]));
  const again = session.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.PROXY_HANDLER,
      sender: 8,
      receiver: 11,
      body: ['1025', '4', ['HEROES_29988429c481f219', '0', 'Senyaak', '0', 'PUBLIC']],
    }),
  );
  const back = (parse(again[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[];
  check(
    'the record read back is the one written, byte for byte',
    back?.[0] instanceof Uint8Array && Buffer.from(back[0] as Uint8Array).equals(written),
    JSON.stringify(back?.[0]),
  );
  check('and its length is announced beside it', back?.[1] === String(written.length), String(back?.[1]));

  // And it outlives the session, which is the whole point of a profile.
  const later = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    profileDb,
  );
  check(
    'and a new server still has it, because it is on disk',
    later.profiles.get({ game: 'HEROES_29988429c481f219', user: 'Senyaak', section: 'PUBLIC' })?.equals(written) === true,
  );
  // Another player's profile is another record: the key is game, user and section.
  check(
    'while another player has none',
    later.profiles.get({ game: 'HEROES_29988429c481f219', user: 'Somebody', section: 'PUBLIC' }) === null,
  );
}

console.log('\nChat, unwrapped from what the client actually sent');
{
  // Two captures from the chat port: the login bundle, and the channel join the
  // client makes as part of entering a lobby.
  const LOGIN = Buffer.from(
    '00123a7d650293c86ff451cb9fe744672ac10f0000326bd7589f28ee09fd56b647628aa8cc562d8b02' +
      '5803433aa70cf60c8b12ca76e1bc005e9c19d06ca1e805fd4e7b1859c82c00',
    'hex',
  );
  const JOIN = Buffer.from('001a2ff2aca5a8accc752738ad4f223435568782b124be468fc11400', 'hex');

  const opened = unframe(LOGIN);
  check('the login read holds two lines', opened.lines.length === 2, JSON.stringify(opened.lines));
  check('the first is a NICK', opened.lines[0] === 'NICK :Senyaak', String(opened.lines[0]));
  check(
    'the second is a USER naming the game',
    opened.lines[1] === 'USER HEROES_29988429c481f219 +i 0 :Senyaak',
    String(opened.lines[1]),
  );
  check('nothing is left over', opened.rest.length === 0);
  check('and the join reads back too', unframe(JOIN).lines[0] === 'JOIN :#LobbyGrp1.1', String(unframe(JOIN).lines[0]));

  // A line we build has to survive the same unwrapping.
  check('a line we frame comes back as itself', unframe(frame('PING :hello')).lines[0] === 'PING :hello');

  const chat = new IrcService().connection();
  const welcomed = chat.receive(LOGIN);
  check('the client is welcomed on NICK', welcomed[0]!.replies.length === 4, welcomed[0]?.note);
  const numerics = welcomed[0]!.replies.flatMap((reply) => unframe(reply).lines);
  check('with 001 first, which is what it waits for', numerics[0]?.includes(' 001 Senyaak :') === true, String(numerics[0]));
  check('and the nick is remembered', chat.nick === 'Senyaak');

  const joined = chat.receive(JOIN);
  const lines = joined[0]!.replies.flatMap((reply) => unframe(reply).lines);
  check('a channel join is echoed with a member list', lines.length === 3, JSON.stringify(lines));
  // The colon is IRC's "rest of the line" marker, not part of the name: the client
  // JOINs ":#LobbyGrp1.2" and then talks to "#LobbyGrp1.2", and kept as they arrived
  // those are two channels — a message to one reaching nobody sitting in the other.
  check('the echo is the join itself, with the name as a name', lines[0] === ':Senyaak JOIN #LobbyGrp1.1', String(lines[0]));
  check('the names list ends properly', lines[2]?.includes('366') === true, String(lines[2]));
  check('and the channel is remembered without the colon', chat.channels.has('#LobbyGrp1.1'));

  // The guest talks, and he has no connection to talk down. Everything about a second
  // player rests on a line reaching a client from somebody who is not himself, and
  // nothing has ever exercised that — so the server can say something as a name of its
  // own, and this is the shape of what it sends.
  const service = new IrcService();
  service.residents = [GUEST];
  const listener = service.connection();
  listener.receive(LOGIN);
  const namesList = listener.receive(JOIN)[0]!.replies.flatMap((reply) => unframe(reply).lines);
  check('the guest is in the name list a joiner gets', namesList[1]?.endsWith(`:Senyaak ${GUEST}`) === true, String(namesList[1]));

  // And the channel is named server FIRST — entering channel 2 on lobby server 1 joins
  // "#LobbyGrp1.2", off the wire. Read the other way round the guest talked into a
  // channel that does not exist, and his first run was silent.
  check('a lobby channel is server first, group second', lobbyChannel(2) === '#LobbyGrp1.2', lobbyChannel(2));
  const said = service.say(GUEST, '#LobbyGrp1.1', chatLine(GUEST, "I'M THE BEST!"));
  check('a line from the guest reaches whoever is in the channel', said.to.length === 1, String(said.to.length));
  // The text carries the client's own presentation, verbatim from a line Сеня typed:
  // nick, colour, size, two flags, font, and only then the words. A bare sentence is
  // not a chat line to this client, which is the other half of why nothing appeared.
  check(
    'and it is an ordinary PRIVMSG, wrapped the way the client wraps its own',
    unframe(said.line).lines[0] === `:${GUEST} PRIVMSG #LobbyGrp1.1 :${GUEST}%16777215%9%0%0%Arial%I'M THE BEST!`,
    String(unframe(said.line).lines[0]),
  );
  check('nobody hears it in a channel they are not in', service.say(GUEST, '#LobbyGrp9.1', 'hello').to.length === 0);
}

console.log('\nTwo players in one channel, and what the other one is told');
{
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-two.db'),
  );
  const lobbyMsg = (body: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 2, body });

  // Two lobby connections, each with somewhere to write — which is the whole of what
  // the services map could not do: it holds ONE socket per u-lobby service name, so the second
  // player's Lobby socket replaced the first's and nothing could reach him.
  const first: Buffer[] = [];
  const second: Buffer[] = [];
  const one = service.session('lobby');
  one.username = 'Senyaak';
  one.send = (bytes) => first.push(bytes);
  const two = service.session('lobby');
  two.username = 'Player2';
  two.send = (bytes) => second.push(bytes);

  /** The channel a pushed GROUP_INFO describes, and the names and games in it. */
  const pushed = (bytes: Buffer | undefined) => {
    const body = parse(bytes ?? Buffer.alloc(0))?.body ?? [];
    const inner = (body[1] as GSValue[]) ?? [];
    const rooms = (inner[3] as GSValue[][]) ?? [];
    const members = (inner[4] as GSValue[][]) ?? [];
    return {
      subtype: body[0],
      group: inner[0],
      names: members.map((m) => String(m[0])),
      games: rooms.map((r) => String(r[1])),
    };
  };

  one.receive(lobbyMsg([String(LobbyMsg.JOIN_LOBBY), ['1', '', '384']]));
  check('the first player in a channel has nobody to tell', first.length === 0, String(first.length));

  const arrived = two.receive(lobbyMsg([String(LobbyMsg.JOIN_LOBBY), ['1', '', '384']]));
  check('the second joining tells the first', first.length === 1, arrived[0]?.note);
  check('and the log line says whom it told', arrived[0]!.note.includes('1 already there told'), arrived[0]?.note);
  const news = pushed(first[0]);
  // GROUP_INFO and not MEMBER_JOIN: it is the message that already draws this screen,
  // both halves of it, and the narrower announcement drew no reaction when it was tried.
  check('what he gets is a GROUP_INFO', news.subtype === String(LobbyMsg.GROUP_INFO), String(news.subtype));
  check('for the channel he is standing in', news.group === '1', String(news.group));
  check('and it lists them both', news.names.includes('Senyaak') && news.names.includes('Player2'), JSON.stringify(news.names));
  check('nothing was sent to the one who joined', second.length === 0, String(second.length));

  // A game opened by one appears on the other's screen. The channel carries its games
  // as well as its players, so it is the same message again rather than a second shape.
  const hosted = two.receive(capturedCreateRoom());
  check('hosting tells the other player', first.length === 2, hosted[0]?.note);
  check('and says so in the log', hosted[0]!.note.includes('1 player(s) shown it'), hosted[0]?.note);
  const withGame = pushed(first[1]);
  check('his channel now has a game in it', withGame.games.length === 1, JSON.stringify(withGame.games));

  // And leaving takes both away again.
  const gone = two.receive(lobbyMsg([String(LobbyMsg.GROUP_LEAVE), ['1']]));
  check('leaving tells him too', first.length === 3, gone[0]?.note);
  const after = pushed(first[2]);
  check('the game is gone from his channel', after.games.length === 0, JSON.stringify(after.games));
  check('and so is the player', !after.names.includes('Player2'), JSON.stringify(after.names));

  // A room whose settings change is a room everybody else has to be handed again: the
  // host makes it with one description and replaces it a moment later with a bigger one,
  // and the other client builds its own record of the game out of that description.
  {
    const made = two.receive(capturedCreateRoom());
    const id = String(((parse(made[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0]);
    first.length = 0;
    const settings = new Uint8Array(590).fill(7);
    const updated = two.receive(
      lobbyMsg([String(LobbyMsg.GROUP_CONFIG_UPDATE_RES), [id, String(RoomUpdate.GROUP_INFO), settings]]),
    );
    check('changing the settings tells the channel', first.length === 1, updated[0]?.note);
    check('and says so in the log', updated[0]!.note.includes('player(s) told'), updated[0]?.note);
    check('nothing goes back to the host himself, which is what used to loop', second.length === 0, String(second.length));
    // And the same settings again tell nobody: the host repeats himself several times a
    // second, and forwarding each one rebuilt the other player's screen continuously.
    first.length = 0;
    const again = two.receive(
      lobbyMsg([String(LobbyMsg.GROUP_CONFIG_UPDATE_RES), [id, String(RoomUpdate.GROUP_INFO), settings]]),
    );
    check('the same settings a second time tell nobody', first.length === 0, again[0]?.note);
    check('and the log says why', again[0]!.note.includes('the same settings as before'), again[0]?.note);
    two.receive(lobbyMsg([String(LobbyMsg.GROUP_LEAVE), ['1']]));
    first.length = 0;
    second.length = 0;
  }

  // Inside a game, the host has to hear about his guest — nothing else tells him, and a
  // host who thinks he is alone starts nothing.
  {
    const hostRoom = two.receive(capturedCreateRoom());
    const id = String(((parse(hostRoom[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0]);
    second.length = 0;
    first.length = 0;
    const joined = one.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [id, '', '448', '0', '']]));
    check('joining a game tells the people in it', second.length >= 1, joined[0]?.note);
    check('and the log says so', joined[0]!.note.includes('in the room told'), joined[0]?.note);
    const room = pushed(second[0]);
    check('what the host gets is his room', room.group === id, String(room.group));
    check('with both players in it', room.names.length === 2, JSON.stringify(room.names));
    // Leaving is the same message with one name fewer.
    const out = one.receive(lobbyMsg([String(LobbyMsg.GROUP_LEAVE), [id]]));
    check('and leaving tells him too', out[0]!.note.includes('still in it told'), out[0]?.note);
    const lastRoom = second.map(pushed).filter((p) => p.group === id).pop();
    check('with the room down to its host', lastRoom?.names.length === 1, JSON.stringify(lastRoom?.names));
    two.receive(lobbyMsg([String(LobbyMsg.GROUP_LEAVE), ['1']]));
    first.length = 0;
    second.length = 0;
  }

  // A connection dropping is the same news: the client that is still there has no other
  // way of hearing it, and a name that stays is a name nobody can host under again.
  two.receive(lobbyMsg([String(LobbyMsg.JOIN_LOBBY), ['1', '', '384']]));
  first.length = 0;
  const left = two.close();
  check('a dropped connection tells the channel', first.length === 1, String(first.length));
  check('and the log says how many heard it', String(left).includes('1 player(s) told'), String(left));
  check('with him off the list', !pushed(first[0]).names.includes('Player2'), JSON.stringify(pushed(first[0]).names));
}

console.log('\nStarting the game: the chain both players wait on');
{
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-start.db'),
  );
  const lobbyMsg = (body: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 2, body });

  const toHost: Buffer[] = [];
  const toGuest: Buffer[] = [];
  const host = service.session('lobby');
  host.username = 'Senyaak';
  host.send = (bytes) => toHost.push(bytes);
  const guest = service.session('lobby');
  guest.username = 'Player2';
  guest.send = (bytes) => toGuest.push(bytes);

  const made = host.receive(capturedCreateRoom());
  const id = String(((parse(made[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0]);
  guest.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [id, '', '448', '0', '']]));
  toHost.length = 0;
  toGuest.length = 0;

  /** The envelope 0x420B60 insists on, checked as it checks it. */
  const yes = (bytes: Buffer | undefined, subtype: number) => {
    const body = parse(bytes ?? Buffer.alloc(0))?.body ?? [];
    const inner = (body[1] as GSValue[]) ?? [];
    const under = inner[1];
    return {
      success: body[0] === String(MessageType.GSSUCCESS),
      names: inner[0] === String(subtype),
      // A list, and a first field that reads as a number: either one wrong and the
      // reply is dropped without a word, which looks exactly like never sending it.
      list: Array.isArray(under),
      number: Array.isArray(under) && typeof under[0] === 'string' && Number.isFinite(Number(under[0])),
    };
  };

  // He pressed Start. This is the message the last run died on: unanswered, the host
  // sat in CStateWaitStartGameReply and cut every socket 31 seconds later.
  const started = host.receive(lobbyMsg([String(LobbyMsg.START_GAME), [id]]));
  check('START_GAME is answered at all', started[0]!.replies.length === 1, started[0]?.note);
  const startReply = yes(started[0]!.replies[0], LobbyMsg.START_GAME);
  check('with a success', startReply.success);
  check('naming the subtype back', startReply.names);
  check('and a list under it, as the parser demands', startReply.list);
  check('whose first field reads as a number', startReply.number);
  // And NOBODY else hears anything yet: the announcement belongs one step later, and
  // a guest told twice is a guest who answers twice.
  check('nothing is announced to the room yet', toGuest.length === 0, String(toGuest.length));

  // He answers that himself with GAME_READY, and then he waits — and so does the guest,
  // who sends nothing during a start at all. Both leave the wait on GAME_STARTED.
  const ready = host.receive(lobbyMsg([String(LobbyMsg.GAME_READY), [id]]));
  check('GAME_READY is answered', ready[0]!.replies.length === 2, ready[0]?.note);
  check('with a success naming its own subtype', yes(ready[0]!.replies[0], LobbyMsg.GAME_READY).names);
  check('and the game is announced to the host himself', ready[0]!.replies.length === 2, String(ready[0]!.replies.length));
  check('and pushed to the guest, who is waiting on exactly this', toGuest.length === 1, String(toGuest.length));
  check('the log says who was told', ready[0]!.note.includes('1 other(s)'), ready[0]?.note);
  // And the description of the game being played is written down while it still exists:
  // the room goes when the host leaves, and what is in the log above is ciphertext. It is
  // the only thing that says whether this was a duel or a map.
  const described = ready[0]!.note.split('\n').pop() ?? '';
  check(
    'and the game description is logged, in a shape dump-struct can read',
    /^\s+[0-9a-f]{64,}$/.test(described) && ready[0]!.note.includes('dump-struct --hex'),
    `${described.trim().length / 2} bytes`,
  );

  // The five fields of it, by index AND by kind: 0x423910 returns false on the first
  // one that reads wrong, and a message that fails there is never seen by anything.
  for (const [who, bytes] of [['the host', ready[0]!.replies[1]] as const, ['the guest', toGuest[0]] as const]) {
    const body = parse(bytes ?? Buffer.alloc(0))?.body ?? [];
    const fields = (body[1] as GSValue[]) ?? [];
    check(`${who} gets it inside the 38 envelope`, body[0] === String(MessageType.GSSUCCESS), String(body[0]));
    check(`${who}: field 0 is the subtype, which is how it is matched`, fields[0] === String(LobbyMsg.GAME_STARTED), String(fields[0]));
    check(`${who}: field 1 is a blob`, fields[1] instanceof Uint8Array, typeof fields[1]);
    check(
      `${who}: field 2 is a number that fits a short`,
      typeof fields[2] === 'string' && Number(fields[2]) === GAME_PORT && Number(fields[2]) <= 0xffff,
      String(fields[2]),
    );
    check(`${who}: field 3 is a string`, typeof fields[3] === 'string' && fields[3].length > 0, String(fields[3]));
    check(`${who}: field 4 is a string`, typeof fields[4] === 'string' && fields[4].length > 0, String(fields[4]));
  }

  // START_MATCH — the message a RATED game sends, and the one the duel never sent. The
  // push that answers it carries the match id the client quotes back with its results.
  toGuest.length = 0;
  const match = host.receive(lobbyMsg([String(LobbyMsg.START_MATCH), [id]]));
  check('START_MATCH is answered', match[0]!.replies.length === 2, match[0]?.note);
  check('with a success naming its subtype', yes(match[0]!.replies[0], LobbyMsg.START_MATCH).names);
  const running = (parse(match[0]!.replies[1]!)?.body?.[1] as GSValue[]) ?? [];
  check('and the match is announced', running[0] === String(LobbyMsg.MATCH_STARTED), String(running[0]));
  check('carrying the match id the results will quote back', running[1] === id, JSON.stringify(running));
  check('the guest hears it too', toGuest.length === 1, String(toGuest.length));

  // Which both of them answer, and neither waits on.
  const acked = guest.receive(lobbyMsg([String(LobbyMsg.PLAYER_MATCH_STARTED), [id]]));
  check('PLAYER_MATCH_STARTED needs no answer', acked[0]!.replies.length === 0, acked[0]?.note);
  check('but it is named, with whose it is', acked[0]!.note.includes('Player2'), acked[0]?.note);

  // The results of a rated game — the table verbatim off the wire, 13.08.2026, the run
  // whose unanswered submit left "please wait while the results are sent to ubi.com" on
  // both screens. Two things are owed: the reply, and the final-results push.
  const table: GSValue[] = [
    id,
    '0',
    ['Senyaak', '21', '22', '4194303', ['0', '1', '0', '980', '0', '0', '0', '0', '0', '1', '0', '0', '0', '0', '2', '0', '65536', '474', '0', '0', '0', '0']],
    ['Senyaak2', '21', '22', '4194303', ['1', '7', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '65536', '474', '0', '250', '0', '1']],
  ];
  const submitted = host.receive(lobbyMsg([String(LobbyMsg.SUBMIT_MATCH), table]));
  check('SUBMIT_MATCH is answered, and the final results follow', submitted[0]!.replies.length === 2, submitted[0]?.note.split('\n')[0]);
  const submitReply = yes(submitted[0]!.replies[0], LobbyMsg.SUBMIT_MATCH);
  check('the reply is a success naming its subtype', submitReply.success && submitReply.names);
  // The id is quoted from the REQUEST: the client compares it with what MATCH_STARTED
  // told it, and a mismatch is not an error but an endless wait (0xE1340F).
  const quoted = ((parse(submitted[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0];
  check('and carries back the match id the client quoted', quoted === id, String(quoted));

  const final = parse(submitted[0]!.replies[1]!)?.body ?? [];
  // BARE, not wrapped in 38: the parser for 71 reads body[1][0] as the match id, so in an
  // envelope the id would arrive as 71 and never match what the client stored.
  check('the final results go out bare, not in a 38 envelope', final[0] === String(LobbyMsg.FINAL_MATCH_RESULTS), String(final[0]));
  const carried = (final[1] as GSValue[]) ?? [];
  check('with the match id first, where the client reads it', carried[0] === id, String(carried[0]));
  check('then the type byte it insists is 38', carried[1] === String(MessageType.GSSUCCESS), String(carried[1]));
  const standings = (carried[2] as GSValue[][]) ?? [];
  // A row per player, each a name and a list of numbers. An empty list of ROWS makes the
  // client fail itself with reason 65, so there must be at least one.
  check('and a row for each player who played', standings.length === 2, JSON.stringify(standings.map((r) => r[0])));
  check('each row a name and a list of numbers', standings.every((row) => typeof row[0] === 'string' && Array.isArray(row[1])), JSON.stringify(standings[0]));
  check('named as the players the table named', standings[0]?.[0] === 'Senyaak' && standings[1]?.[0] === 'Senyaak2', JSON.stringify(standings.map((r) => r[0])));
  // And the table itself is written down whole — the stat ids in it are named nowhere in
  // the lobby library, so this log line is the only record of what a played game looks like.
  check('the whole table goes into the log', submitted[0]!.note.includes('4194303') && submitted[0]!.note.includes('980'), submitted[0]!.note.split('\n')[1]);

  // And its twin, sent the moment the results are away.
  const done = guest.receive(lobbyMsg([String(LobbyMsg.PLAYER_MATCH_FINISHED), [id]]));
  check('PLAYER_MATCH_FINISHED needs no answer either', done[0]!.replies.length === 0, done[0]?.note);
  check('and is named with whose it is', done[0]!.note.includes('Player2'), done[0]?.note);

  // The last word of a rated game, which the client sends once everybody has stopped.
  const finished = host.receive(lobbyMsg([String(LobbyMsg.MATCH_FINISH), [id]]));
  check('MATCH_FINISH is answered', finished[0]!.replies.length === 1, finished[0]?.note);
  check('with a success naming its subtype', yes(finished[0]!.replies[0], LobbyMsg.MATCH_FINISH).names);

  // The end of the game, which both players report and neither waits on. It is the only
  // word this server gets that a game was played at all.
  toGuest.length = 0;
  const over = host.receive(lobbyMsg([String(LobbyMsg.GAME_FINISH), [id]]));
  check('GAME_FINISH is not answered — nothing in the client reads a reply', over[0]!.replies.length === 0, over[0]?.note);
  check('but it is named, and names the game', over[0]!.note.includes('GAME_FINISH') && over[0]!.note.includes(id), over[0]?.note);
  check('and it is not announced to anybody either', toGuest.length === 0, String(toGuest.length));
  const guestOver = guest.receive(lobbyMsg([String(LobbyMsg.GAME_FINISH), [id]]));
  check('the guest reports it too, and is named as himself', guestOver[0]!.note.includes('Player2'), guestOver[0]?.note);

  // The room is found by MEMBERSHIP, not by trusting a field we have never read: the
  // bodies of these four have only ever been seen encrypted. A start that names
  // nothing still belongs to the one game he is in.
  const nameless = host.receive(lobbyMsg([String(LobbyMsg.START_GAME), []]));
  check('a start naming no room is still placed in his own', nameless[0]!.note.includes(id), nameless[0]?.note);
  // And a stranger's room is not his: he is in none, so there is nothing to announce,
  // but he is still answered rather than left to time out.
  const outsider = service.session('lobby');
  outsider.username = 'Nobody';
  const alone = outsider.receive(lobbyMsg([String(LobbyMsg.START_GAME), [id]]));
  check('a player in no room of ours is answered anyway', alone[0]!.replies.length === 1, alone[0]?.note);
  check('and it is said plainly in the log', alone[0]!.note.includes('no room of his'), alone[0]?.note);
}

console.log('\nRating a rated game: the ladder, written once');
{
  const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-rating.db');
  rmSync(dbPath, { force: true });
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    dbPath,
  );
  const lobbyMsg = (body: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 2, body });

  const host = service.session('lobby');
  host.username = 'Senyaak';
  host.send = () => {};
  const guest = service.session('lobby');
  guest.username = 'Player2';
  guest.send = () => {};

  // A room of our own making, so the CHANNEL can be chosen: rated games are the ones
  // played in the rated channel, which is our rule — the client asks for one ladder and
  // never says which channel it means.
  const settings = Buffer.from([0x02, 0x08, 0xff, 0xff, 0xff, 0xff, 0x03, 0x08, 0xff, 0xff, 0xff, 0xff]);
  const hostRoom = (channel: number, name: string): string => {
    const made = host.receive(
      lobbyMsg([
        String(LobbyMsg.CREATE_ROOM),
        [String(channel), name, 'HEROES', '7', '2', '0', settings, '', '3.1', '1.0', new Uint8Array(0)],
      ]),
    );
    return String(((parse(made[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[1] as GSValue[])?.[0]);
  };

  // The real table of the third rated match, with the names changed: the guest won it
  // playing faction 1, the host lost playing faction 7, and it took 267 seconds.
  const resultsFor = (matchId: string): GSValue[] => [
    matchId,
    '0',
    ['Senyaak', '21', '22', '4194303', ['0', '7', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '2', '0', '65536', '267', '0', '0', '0', '1']],
    ['Player2', '21', '22', '4194303', ['1', '1', '0', '350', '0', '0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '1', '98304', '267', '0', '0', '0', '0']],
  ];

  const rated = hostRoom(2, 'A rated game');
  guest.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [rated, '', '448', '0', '']]));
  const started = host.receive(lobbyMsg([String(LobbyMsg.START_MATCH), [rated]]));
  check('a game in the rated channel is marked rated when it starts', started[0]!.note.includes('RATED'), started[0]?.note);

  const first = host.receive(lobbyMsg([String(LobbyMsg.SUBMIT_MATCH), resultsFor(rated)]));
  check('the result is settled, and the log says how', first[0]!.note.includes('beat'), first[0]?.note.split('\n')[0]);
  const winner = service.ladder.row('Player2');
  const loser = service.ladder.row('Senyaak');
  // RATING is EXPERIENCE — it is what the client turns into a rank, on a scale of points
  // per game — so it goes up for both of them, and further for winning.
  check('the winner earns a win’s worth of experience', winner['RATING'] === 1600, String(winner['RATING']));
  check('and the loser earns something for turning up', loser['RATING'] === 1525, String(loser['RATING']));
  check('nobody’s experience goes down', winner['RATING']! > 1500 && loser['RATING']! > 1500);
  // The competitive number is separate, and even ratings make it half of K each way.
  check('strength is rated separately, sixteen each way', winner['ELO'] === 1516 && loser['ELO'] === 1484, JSON.stringify({ w: winner['ELO'], l: loser['ELO'] }));
  // And it never leaves this server: the client is sent LADDER_KEYS and nothing else.
  check('and it is not one of the keys the client is sent', !LADDER_KEYS.includes('ELO'));
  check('a game is counted for both', winner['GAMES_PLAYED'] === 1 && loser['GAMES_PLAYED'] === 1);
  check('as a win and a loss', winner['WINS'] === 1 && loser['LOSSES'] === 1);
  check('with the streaks each player is on', winner['CUR_WINS_STREAK'] === 1 && loser['CUR_LOSSES_STREAK'] === 1 && winner['MAX_WINS_STREAK'] === 1);
  // The profile draws hours played and average game length out of this one.
  check('the time played is the match, in seconds', winner['TOT_TIME_PLAYED'] === 267, String(winner['TOT_TIME_PLAYED']));
  // Faction 1 is PRESERVE and faction 7 is ORCS, and the profile has a row per faction.
  check('the win is credited to the faction he played', winner['W_PRESERVE'] === 1, JSON.stringify({ W_PRESERVE: winner['W_PRESERVE'] }));
  // The alignment needle and the favourite faction are drawn from G_ and nothing else.
  check('and the faction is counted as played, which is what moves the alignment needle', winner['G_PRESERVE'] === 1 && loser['G_ORCS'] === 1);
  // "Heroes hired" is the sum of H_, and we do not know how many heroes anybody hired —
  // a stand-in there once put the match's seconds on the profile as "Нанято героев: 337".
  check('heroes hired is left empty rather than invented', FACTIONS.every((f) => (winner['H_' + f] ?? 0) === 0));
  // The average hero level travels in the results table already in 16.16, the same fixed
  // point the profile divides by 65536 — 98304 is 1.5.
  check('the average hero level is carried through as it came', winner['AVERAGE_HERO_LEVEL'] === 98304, String(winner['AVERAGE_HERO_LEVEL']));
  check('and the other player’s is his own', loser['AVERAGE_HERO_LEVEL'] === 65536, String(loser['AVERAGE_HERO_LEVEL']));
  check('and the loss to his', loser['L_ORCS'] === 1, JSON.stringify({ L_ORCS: loser['L_ORCS'] }));

  // AND THE SECOND COPY CHANGES NOTHING. Both players submit the same table, a second
  // apart — a ladder written straight from the message would count every game twice.
  const second = guest.receive(lobbyMsg([String(LobbyMsg.SUBMIT_MATCH), resultsFor(rated)]));
  check('the other player’s copy of the same table is answered too', second[0]!.replies.length === 2, second[0]?.note.split('\n')[0]);
  check('but it does not count the game again', service.ladder.row('Player2')['GAMES_PLAYED'] === 1, String(service.ladder.row('Player2')['GAMES_PLAYED']));
  check('nor move the numbers a second time', service.ladder.row('Player2')['RATING'] === 1600 && service.ladder.row('Player2')['ELO'] === 1516, JSON.stringify(service.ladder.row('Player2')));

  // THE PANEL'S NUMBER COMES FROM HIS OWN BLOB, and he composes it once, on entering —
  // so after a rated game it showed what he was worth before it, until he left the channel
  // and came back. The rating is the one field of that document we own, so it is written
  // over on the way out and nothing else is touched.
  const his = playerInfo('Player2', 1500, '192.168.1.5', 8888);
  const fresher = withRating(his, 1516);
  const inner = readFields(Buffer.from(fresher)).find((field) => field.tag === 1);
  const parts = inner ? readFields(inner.value) : [];
  check('the rating in his blob is brought up to date', Buffer.from(findField(parts, 5) ?? Buffer.alloc(0)).readInt32LE(0) === 1516);
  check('and his name is left exactly as he wrote it', findField(parts, 2)?.toString('utf8') === 'Player2');
  check('as is the rest of it, byte for byte', findField(parts, 4)?.equals(findField(readFields(readFields(Buffer.from(his)).find((f) => f.tag === 1)!.value), 4) ?? Buffer.alloc(0)) === true);
  // A document we do not recognise is his and stays his.
  const foreign = new Uint8Array([9, 4, 1, 2]);
  check('a blob we cannot read goes back untouched', Buffer.from(withRating(foreign, 1600)).equals(Buffer.from(foreign)));

  // And a game in an ordinary channel is played, reported, answered — and not rated.
  const casual = hostRoom(1, 'A casual game');
  guest.receive(lobbyMsg([String(LobbyMsg.JOIN_ROOM), [casual, '', '448', '0', '']]));
  const unrated = host.receive(lobbyMsg([String(LobbyMsg.START_MATCH), [casual]]));
  check('a game in another channel is not marked rated', unrated[0]!.note.includes('unrated'), unrated[0]?.note);
  host.receive(lobbyMsg([String(LobbyMsg.SUBMIT_MATCH), resultsFor(casual)]));
  check('and its result leaves the ladder alone', service.ladder.row('Player2')['GAMES_PLAYED'] === 1, String(service.ladder.row('Player2')['GAMES_PLAYED']));
}

console.log('\nThe keep-alive, and the channel counts');
{
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-net.db'),
  );

  // Six bytes, no body, every 31 seconds — verbatim off the wire. Unanswered, the
  // client gives up on the whole session at about two minutes: two of them in one run,
  // 122 and 121 seconds after connecting, both ending in "disconnected from router".
  const alive = service.session('router').receive(Buffer.from('000006003a41', 'hex'));
  check('a keep-alive is answered, not swallowed', alive[0]!.replies.length === 1, alive[0]?.note);
  const back = parse(alive[0]!.replies[0]!);
  check('with the same message type', back?.type === MessageType.STILLALIVE, String(back?.type));
  check('and no body at all, as it came', back?.body === null, JSON.stringify(back?.body));
  check('the parties the other way round', back?.sender === 1 && back?.receiver === 4, `${back?.sender}->${back?.receiver}`);
  check('it is the same six bytes', alive[0]!.replies[0]!.toString('hex') === '000006003a14', alive[0]!.replies[0]!.toString('hex'));

  // The channel list said 0 players in every channel, whoever was standing in them:
  // the count came from a description of the channels rather than from who is there.
  const lobby = service.session('lobby');
  const listed = lobby.receive(
    build({
      property: Property.GS,
      priority: 0,
      type: MessageType.LOBBY_MSG,
      sender: 4,
      receiver: 2,
      body: [String(LobbyMsg.CHANGE_REQUESTED_LOBBIES), ['1']],
    }),
  );
  const channels = (parse(listed[0]!.replies[0]!)?.body?.[1] as GSValue[])?.[3] as GSValue[];
  const counted = (id: string): string =>
    String((channels.map((c) => c as GSValue[]).find((c) => c[2] === id) ?? [])[13]);
  check('the channel list is three channels', channels?.length === 3, String(channels?.length));
  check('Ranked has the guest in it, and says so', counted('2') === '1', counted('2'));
  check('the empty ones say nothing else', counted('1') === '0' && counted('3') === '0', `${counted('1')}, ${counted('3')}`);
}

console.log('\nAccounts: a name belongs to whoever said it first');
{
  // In memory, because an account test that shares a file with the last run is a test
  // that passes for last week's reasons — and because the schema is applied on open,
  // so there is nothing to set up.
  const accounts = new Accounts(openDatabase(':memory:').db);
  check('a name nobody has used is not an account yet', !accounts.has('Senyaak'));
  check('the first login CREATES it', accounts.login('Senyaak', 'swordsman') === 'created');
  check('and the same name and password is welcomed back', accounts.login('Senyaak', 'swordsman') === 'welcome-back');
  check('a different password is refused', accounts.login('Senyaak', 'archer') === 'wrong-password');
  check('and the refusal did not change anything', accounts.login('Senyaak', 'swordsman') === 'welcome-back');
  // Names come from a screen where a player types them, so "senyaak" and "Senyaak"
  // are the same account — the alternative is two accounts and one very confused player.
  check('the name is matched without regard to case', accounts.login('senyaak', 'swordsman') === 'welcome-back');
  check('another name is another account', accounts.login('Guest', '') === 'created' && accounts.size === 2);
  check('an empty password is a password like any other', accounts.login('Guest', '') === 'welcome-back');
  check('and it is not the same as some other empty-ish one', accounts.login('Guest', ' ') === 'wrong-password');

  // What is kept, and what is NOT: the password itself must not be recoverable from
  // the database, which is the whole reason for the salt and the hash.
  const stored = openDatabase(':memory:').db;
  const one = new Accounts(stored);
  one.login('Senyaak', 'swordsman');
  const row = stored.prepare('SELECT salt, hash FROM users WHERE name = ?').get('Senyaak') as {
    salt: Uint8Array;
    hash: Uint8Array;
  };
  check('the salt is sixteen random bytes', row.salt.length === 16, String(row.salt.length));
  check('the hash is sixty-four', row.hash.length === 64, String(row.hash.length));
  check(
    'and the password is nowhere in the row',
    !Buffer.from(row.hash).includes('swordsman') && !Buffer.from(row.salt).includes('swordsman'),
  );
  // Two accounts with the SAME password must not look alike, which is what a per-user
  // salt is for: a table of identical hashes tells an attacker who to try first.
  one.login('Twin', 'swordsman');
  const twin = stored.prepare('SELECT hash FROM users WHERE name = ?').get('Twin') as { hash: Uint8Array };
  check('the same password hashes differently for another user', !Buffer.from(row.hash).equals(Buffer.from(twin.hash)));

  // Deleting is never refused — and it says what it takes with it.
  const full = openDatabase(':memory:').db;
  const its = new Accounts(full);
  its.login('Senyaak', 'x');
  new Ladder(full).record('Senyaak', { RATING: 1600 });
  new Friends(full).add('Senyaak', 'Guest');
  its.forget('Senyaak');
  check('forgetting an account takes the ladder row with it', new Ladder(full).size === 0);
  check('and the friendships', new Friends(full).of('Senyaak').length === 0);
  check('and the account', !its.has('Senyaak'));
}

console.log('\nThe login on the wire, which is where an account is made');
{
  const dbFile = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-login.db');
  rmSync(dbFile, { force: true });
  const service = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    dbFile,
  );
  const login = (name: string, password: string): ReturnType<RouterSession['receive']> =>
    service.session('router').receive(
      build({
        property: Property.GS,
        priority: 0,
        type: MessageType.LOGIN,
        sender: 4,
        receiver: 1,
        body: [name, password],
      }),
    );

  const first = login('Senyaak', 'swordsman');
  check('a first login is accepted', parse(first[0]!.replies[0]!)?.type === MessageType.GSSUCCESS, first[0]?.note);
  check('and the log says an account was made', first[0]!.note.includes('NEW ACCOUNT created'), first[0]?.note);
  check('the account is there afterwards', service.accounts.has('Senyaak'));

  const again = login('Senyaak', 'swordsman');
  check('logging in again is accepted', parse(again[0]!.replies[0]!)?.type === MessageType.GSSUCCESS, again[0]?.note);
  check('and named as a returning player', again[0]!.note.includes('password matched'), again[0]?.note);

  const wrong = login('Senyaak', 'archer');
  const refusal = parse(wrong[0]!.replies[0]!);
  check('a wrong password is REFUSED', refusal?.type === MessageType.GSFAIL, wrong[0]?.note);
  check('and the log says why', wrong[0]!.note.includes('wrong password'), wrong[0]?.note);

  // In the shape the client's own parser reads, and nothing else reaches it: 0x42ac00
  // asks 0x428fd0 for the reply, which wants field 0 to be a ONE-byte blob repeating
  // the request (102) and — for a 39 — field 1 to be a LIST whose field 0 is a
  // FOUR-byte blob. Sent with a string there, the refusal was dropped in the parser
  // and the login screen sat there saying nothing, which is how this was found.
  const key = refusal?.body?.[0];
  check('the refusal repeats the request as a one-byte blob', key instanceof Uint8Array && key.length === 1 && key[0] === MessageType.LOGIN, JSON.stringify(key));
  const why = (refusal?.body?.[1] as GSValue[])?.[0];
  check('and carries a four-byte reason under it', why instanceof Uint8Array && why.length === 4, JSON.stringify(why));
  check('which is 9 — the client\'s own number for a wrong password', why instanceof Uint8Array && Buffer.from(why).readUInt32LE(0) === 9, JSON.stringify(why));

  // The password must not be in the log, and the log is the one place it could leak:
  // everything else about a body goes in whole, and this is the exception that makes
  // that safe.
  check('no log line carries the password itself', !first[0]!.note.includes('swordsman') && !wrong[0]!.note.includes('archer'), first[0]?.note);
  check('though it says how long it was, which is what identifies the field', first[0]!.note.includes('a string of 9'), first[0]?.note);

  // The proxy's login carries the same name and no credentials. Checking it as a
  // second authentication would lock the player out of his own session.
  const onProxy = service.session('proxy').receive(
    build({ property: Property.GS, priority: 0, type: MessageType.LOGIN, sender: 8, receiver: 1, body: ['Senyaak'] }),
  );
  check('the proxy login is not a second password check', parse(onProxy[0]!.replies[0]!)?.type === MessageType.GSSUCCESS, onProxy[0]?.note);
  check('and it says so', onProxy[0]!.note.includes('not the credential service'), onProxy[0]?.note);
}

// ---------------------------------------------------------------------------------
console.log('\nwhere the players are, out of the room description');
// ---------------------------------------------------------------------------------
{
  // Captured from the run of three copies on 14.08.2026. This is the one thing
  // the relay cannot work out for itself: an agent knows the address its game
  // dialled, and only the room description says which player is at it.
  const players = roomEndpoints(capturedRoomPlayers());
  check('both players are found', players.length === 2, JSON.stringify(players));
  // In whatever order the host wrote them — he put the guest first in this
  // capture, and nothing anywhere depends on which came out of the description
  // first, so the test does not either.
  const said = players.map((one) => `${one.nick}:${String(one.port)}`).sort().join(' ');
  check('each with the name the client wrote and the port that copy plays on',
    said === 'Senyaak2:8889 Senyaak:8888', said);
  check(
    'at the LAN address, which is what the peers really dial',
    players.every((one) => one.address === '192.168.178.27'),
    players.map((one) => one.address).join(','),
  );

  // The reader has to be TOLERANT of what it does not understand: the
  // description does not divide into fields all the way to its end, and a
  // reader that threw the document away over its tail found nothing at all —
  // which is exactly what the first version did, on these very bytes.
  const truncated = capturedRoomPlayers().subarray(0, 300);
  check('a description cut in half still gives up what it holds', roomEndpoints(truncated).length >= 1, String(roomEndpoints(truncated).length));
  check('and nothing is invented out of noise', roomEndpoints(Buffer.alloc(64, 0xab)).length === 0);
}

console.log('\nthe state feed, which decides when the core hears about a room');
{
  // The timer is ours, so the window is run out rather than waited out. Nothing here
  // asserts a duration — the feed has no fast path to assert one about.
  const timers: (() => void)[] = [];
  const runWindow = (): void => {
    for (const fire of timers.splice(0)) fire();
  };

  let rooms: RoomInfo[] = [];
  const sentRooms: RoomInfo[][] = [];
  const sentPresence: PresenceEntry[][] = [];
  const feed = new StateFeed({
    window: 20,
    schedule: (fn) => void timers.push(fn),
    presence: () => [],
    rooms: () => rooms,
    sendPresence: (entries) => void sentPresence.push(entries),
    sendRooms: (list) => void sentRooms.push(list),
  });

  const room = (id: number, members: string[]): RoomInfo => ({
    id,
    name: `room ${id}`,
    master: members[0] ?? '',
    members,
    endpoints: [],
  });

  // The window is always waited out, and a lone change waits it out too.
  rooms = [room(1, ['A'])];
  feed.touch();
  check('nothing leaves before the window is out', sentRooms.length === 0, `${sentRooms.length} push(es)`);
  runWindow();
  check('and then it does', sentRooms.length === 1, `${sentRooms.length} push(es)`);

  // A login is a dozen messages in a few milliseconds. They are ONE push, counted from the
  // first of them, and what goes is the LAST state — not the one that opened the window.
  for (let i = 0; i < 12; i++) {
    rooms = [room(1, ['A', `B${i}`])];
    feed.touch();
  }
  check('a burst of twelve is one window', timers.length === 1, `${timers.length} timer(s)`);
  runWindow();
  check('and one push', sentRooms.length === 2, `${sentRooms.length} push(es)`);
  check(
    'carrying the last state, not the one that opened it',
    sentRooms[1]?.[0]?.members.join(',') === 'A,B11',
    sentRooms[1]?.[0]?.members.join(','),
  );

  // The comparison is what makes touch() cheap enough to call from every message. This is
  // the check that goes red if the feed ever sends without looking.
  feed.touch();
  runWindow();
  check('a touch with nothing changed sends nothing', sentRooms.length === 2, `${sentRooms.length} push(es)`);

  // And the hole neither of those covers: the core restarted, so it knows nothing, and
  // nothing here changed to tell it.
  const presenceBefore = sentPresence.length;
  feed.reconnected();
  check('a core that reconnects is told everything again', sentRooms.length === 3, `${sentRooms.length} push(es)`);
  check(
    'the whole list, not a difference',
    sentRooms[2]?.[0]?.members.join(',') === 'A,B11',
    sentRooms[2]?.[0]?.members.join(','),
  );
  check(
    'and presence with it, from the same silence',
    sentPresence.length === presenceBefore + 1,
    `${presenceBefore} -> ${sentPresence.length}`,
  );

  // A room that empties is a change like any other — the relay must stop admitting to it.
  rooms = [];
  feed.touch();
  runWindow();
  check('a room that vanishes is sent as a list without it', sentRooms[3]?.length === 0, String(sentRooms[3]?.length));
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);

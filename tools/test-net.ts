// Checks our Game Service layers against bytes a real client sent.
//
// The recorded packets are the two the game put on our NAT port (captured
// 12.08.2026, docs/NETWORK.md): an SRP SYN with its window, and the FIN it sends
// when it gives up waiting. They are the only ground truth we have, so the
// checksum test is the one that matters most — it is the piece a wrong answer
// dies on silently.
//
// Usage: `node tools/test-net.ts`

import { decode, decodeBody, encode, encodeBody, type GSValue } from '../src/net/gs-data.ts';
import { decrypt, encrypt } from '../src/net/gs-xor.ts';
import { HEADER_SIZE, Flags, buildSegment, checksum, parseSegment, verify } from '../src/net/srp.ts';
import { MessageType, Property, build, parse } from '../src/net/gs-message.ts';
import { NatService, inetU32 } from '../src/net/nat-service.ts';
import { KEY_BLOB_SIZE, decryptWith, encryptTo, generateKeyPair, parsePublicKey, publicKeyBlob } from '../src/net/pkc.ts';
import { GUEST, RouterService } from '../src/net/router-service.ts';
import { Blowfish } from '../src/net/blowfish.ts';
import { CdKeyRequest, CdKeyService } from '../src/net/cdkey-service.ts';
import { LobbyMsg, Lsm, RoomUpdate, playerInfo } from '../src/net/lobby.ts';
import { readFields, writeFields } from '../src/net/structure.ts';
import { LADDER_KEYS, Ladder, STARTING_RATING } from '../src/net/ladder.ts';
import { IrcService, frame, unframe } from '../src/net/irc.ts';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('\nRouter, driven by the recorded packet');
{
  const session = new RouterService({ address: '127.0.0.1', port: 40001 }, { address: '127.0.0.1', port: 40030 }, { address: '127.0.0.1', port: 40031 }, { address: '127.0.0.1', port: 40040 }).session();
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
  const session = new RouterService({ address: '127.0.0.1', port: 40001 }, { address: '127.0.0.1', port: 40030 }, { address: '127.0.0.1', port: 40031 }, { address: '127.0.0.1', port: 40040 }).session();
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

console.log('\nThe proxy desk answers differently, because the client asked it to');
{
  const proxy = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
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
  const desk = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
  ).session('router');

  const lobbyMessage = (subtype: number, inner: GSValue[]): Buffer =>
    build({ property: Property.GS, priority: 0, type: MessageType.LOBBY_MSG, sender: 4, receiver: 1, body: [String(subtype), inner] });

  // Verbatim from the wire: the client logs in to the lobby naming the game.
  const loggedIn = desk.receive(lobbyMessage(LobbyMsg.LOGIN, ['HEROES_29988429c481f219']));
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

  const listed = desk.receive(lobbyMessage(LobbyMsg.CHANGE_REQUESTED_LOBBIES, ['HEROES_29988429c481f219']));
  const info = parse(listed[0]!.replies[0]!);
  const groups = (info?.body?.[1] as GSValue[])?.[3] as GSValue[];
  check('the lobby list comes back as GROUP_INFO', info?.body?.[0] === String(LobbyMsg.GROUP_INFO), listed[0]?.note);
  check('with our three lobbies', Array.isArray(groups) && groups.length === 3, String(groups?.length));
  const ranked = (groups?.[1] as GSValue[]) ?? [];
  check('each is fourteen fields', ranked.length === 14, String(ranked.length));
  check('Ranked is named and rated', ranked[1] === 'Ranked' && ranked[11] === '1', `${String(ranked[1])}, mode ${String(ranked[11])}`);

  const joined = desk.receive(lobbyMessage(LobbyMsg.JOIN_SERVER, ['1']));
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
  check('and with him in its player list', listed?.length === 2, String(listed?.length));
  check('under his own name', (listed?.[0] as GSValue[])?.[0] === 'Senyaak', String((listed?.[0] as GSValue[])?.[0]));
  check('with the guest beside him, to have somebody to select', (listed?.[1] as GSValue[])?.[0] === GUEST, String((listed?.[1] as GSValue[])?.[0]));
  check(
    'and the guest carries a blob, so his record is not an empty name',
    (listed?.[1] as GSValue[])?.[4] instanceof Uint8Array,
    JSON.stringify((listed?.[1] as GSValue[])?.[4]),
  );
  check(
    'at the address he reported for himself',
    (listed?.[0] as GSValue[])?.[2] === '192.168.178.27',
    String((listed?.[0] as GSValue[])?.[2]),
  );
  // And with the status the panel insists on. This is the field that kept the list
  // empty while every other part of the message was right: the client's own
  // CPlayersController::OnMemberJoined (0x9108f0) drops a member whose status is
  // anything but 0, silently, after the game log has already said he arrived.
  check('and with a status the player panel accepts', (listed?.[0] as GSValue[])?.[7] === '0', String((listed?.[0] as GSValue[])?.[7]));
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
  check(
    'his record now carrying the blob he sent, which is where the rating is',
    Buffer.from((again?.[0] as GSValue[])?.[4] as Uint8Array).equals(own),
    JSON.stringify((again?.[0] as GSValue[])?.[4]),
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
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json'),
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
  const stats = new Ladder(join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json')).row('Senyaak');
  check('with all 46 named fields in the store', Object.keys(stats).length === 46, String(Object.keys(stats).length));
  check('starting rated, not at zero', stats['RATING'] === STARTING_RATING, String(stats['RATING']));
  check('and with nothing played', stats['GAMES_PLAYED'] === 0, String(stats['GAMES_PLAYED']));
  check('in the exe order, Heaven first and Orcs last', LADDER_KEYS[12] === 'W_HEAVEN' && LADDER_KEYS[19] === 'W_ORCS');
}

console.log('\nAdding a friend, from the right-click the client really sent');
{
  // Its own file, emptied first: a store that outlives the process would otherwise
  // answer "already there" to the first check and pass for last week's reasons.
  const friendsFile = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-friends.json');
  rmSync(friendsFile, { force: true });
  const router = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-profiles.json'),
    friendsFile,
  ).session('router');
  router.username = 'Senyaak';

  // Verbatim off the wire (12.08.2026): he right-clicked his own name in the channel.
  const clicked = router.receive(Buffer.from('00001a004b41faeeefe197d9f491969be2fb959aeef699939c9c', 'hex'));
  check('the right-click is an ADDFRIEND', clicked[0]?.note.startsWith('ADDFRIEND'), clicked[0]?.note);
  check('and it is answered rather than ignored', clicked[0]!.replies.length === 1, clicked[0]?.note);

  const answer = parse(clicked[0]!.replies[0]!);
  check('the answer is a plain success', answer?.type === MessageType.GSSUCCESS, String(answer?.type));
  // The routing key for a type-38 message is the single byte in field 0, read as a
  // one-byte blob (0x41b150). 75 is what puts this in the friends queue rather than
  // nowhere — the same trick that makes our friends LOGIN reply land.
  const key = answer?.body?.[0] as Uint8Array;
  check('and it names the message it answers, in one byte', key instanceof Uint8Array && key.length === 1 && key[0] === 75, JSON.stringify(key));
  // A STRING, not a list. 0x4292d0 fetches field 1 with the getter at 0x4426c0, which
  // refuses anything whose kind is not 1 — which is exactly how the list we used to
  // send was matched, consumed and then dropped without a word.
  check('with the friend named beside it, as a plain string', answer?.body?.[1] === 'Senyaak', JSON.stringify(answer?.body?.[1]));
  check('and the friendship is kept, not just acknowledged', clicked[0]!.note.includes('added, 1 friend(s)'), clicked[0]?.note);

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

console.log('\nThe profile, from the read the client really asked for');
{
  // A store that survives its process is the point of this one, so the file has to go
  // before the checks run — otherwise the first assertion reads what the LAST run
  // wrote and passes or fails for reasons that have nothing to do with the code.
  const profileFile = join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-profiles.json');
  rmSync(profileFile, { force: true });

  const proxy = new RouterService(
    { address: '127.0.0.1', port: 40001 },
    { address: '127.0.0.1', port: 40030 },
    { address: '127.0.0.1', port: 40031 },
    { address: '127.0.0.1', port: 40040 },
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json'),
    profileFile,
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
  // NOTHING STORED IS A REFUSAL, not a success carrying nothing. Answered "38" with a
  // zero-length record the client read it happily — the probe said "the profile length
  // read said 1" — made no profile of it and put up "could not create a profile". 39 is
  // the truth, and it is the shape the ladder's refusal already travels.
  check('with nothing stored it refuses, rather than saying yes to nothing', answer?.body?.[0] === '39', String(answer?.body?.[0]));
  const carried = answer?.body?.[1] as GSValue[];
  check('the request number is nested where the matcher looks', carried?.[0] === '1025', String(carried?.[0]));
  check('and what carries it is a three, as the reader wants', carried?.length === 3, String(carried?.length));
  // The capture asked with id 2, so 2 is what has to come back: it is looked up among
  // the pending requests, not counted.
  check('its last field being the id the request carried', carried?.[2] === '2', JSON.stringify(carried?.[2]));

  // And with `--seed-profile` the same read is answered with a minimal record instead.
  // That is an EXPERIMENT, not a better answer: nobody has ever seen a profile record,
  // the client composes them, and it will not write one while its own read fails — so
  // the refusal is a closed loop and this is the way out of it. The seed is the skeleton
  // every document the game writes begins with; whether the profile's own tags look
  // anything like it is what the launch is for.
  {
    const seeding = new RouterService(
      { address: '127.0.0.1', port: 40001 },
      { address: '127.0.0.1', port: 40030 },
      { address: '127.0.0.1', port: 40031 },
      { address: '127.0.0.1', port: 40040 },
      join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json'),
      join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-seed-profiles.json'),
    );
    rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-seed-profiles.json'), { force: true });
    seeding.seedProfile = true;
    const asked = seeding.session('proxy').receive(
      build({
        property: Property.GS,
        priority: 0,
        type: MessageType.PROXY_HANDLER,
        sender: 8,
        receiver: 11,
        body: ['1025', '2', ['HEROES_29988429c481f219', '0', 'Senyaak', '0', 'PUBLIC']],
      }),
    );
    const seeded = parse(asked[0]!.replies[0]!);
    check('with --seed-profile the read succeeds instead', seeded?.body?.[0] === '38', String(seeded?.body?.[0]));
    const payload = (seeded?.body?.[1] as GSValue[])?.[1] as GSValue[];
    const record = payload?.[0] as Uint8Array;
    check('carrying a record, with its length beside it as the reader insists', record instanceof Uint8Array && payload?.[1] === String(record.length), JSON.stringify(payload?.[1]));
    check('and the record is a whole document, not a blob of zeroes', readFields(Buffer.from(record)).map((f) => f.tag).join(',') === '4,1', JSON.stringify(readFields(Buffer.from(record)).map((f) => f.tag)));
    check('the log says it was seeded, so no reader mistakes it for his own', asked[0]!.note.includes('seeding'), asked[0]?.note);
  }

  // WHERE it goes, which cost more to learn than what is in it. The module's queue is
  // fed by the router's connection, and a reply on the socket the request came in on is
  // never queued at all — measured by the probe: the ladder's two copies produced ONE
  // queued message, and the profile answer, sent only on the proxy's wait module, was
  // never seen. So when a router connection is open, that is where the answer goes.
  const onRouter: Buffer[] = [];
  proxy.desks.set('RouterLauncher', (bytes) => onRouter.push(bytes));
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
  proxy.desks.delete('RouterLauncher');

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
    join(dirname(fileURLToPath(import.meta.url)), '..', '_tmp', 'test-ladder.json'),
    profileFile,
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
  check('the echo is the join itself', lines[0] === ':Senyaak JOIN :#LobbyGrp1.1', String(lines[0]));
  check('the names list ends properly', lines[2]?.includes('366') === true, String(lines[2]));
  check('and the channel is remembered', chat.channels.has(':#LobbyGrp1.1'));
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);

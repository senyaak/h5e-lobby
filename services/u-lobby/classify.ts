// Which u-lobby service a connection is, read off the first thing it says.
//
// Ubisoft's lobby is several services and the client dials each one separately, but the
// NUMBERS are ours: every address the client uses comes from the ini we serve or from a
// reply we write, and nothing on either side compares one with another. So the u-lobby services can
// share a port, and what tells them apart is the first message — which exists, always,
// because the client speaks first on every one of them (SLICE §2.3).
//
// The order below is the whole of it, and it is an order, not a set of independent tests:
//
//   1. `GET ` is HTTP — the ini being fetched, or the door being opened (an upgrade to
//      `/u-lobby`, `tunnel.ts`). Nothing else here begins with a word, and Node's own
//      parser tells those two apart.
//   2. A GS header that adds up — a size that is at least a header and no longer than
//      what arrived — and whose type is one a u-lobby service opens with. That names the u-lobby service.
//   3. Anything else is IRC, which is what is left. It fails the GS test twice over: its
//      u16 frame length read as a 24-bit size is far larger than the bytes that arrived,
//      and the byte where a type would be is a byte of ciphertext.
//
// The `wait` verdict is the reason this is a function and not an expression: a first read
// can be short, and a decision taken on half a header would be a decision taken on noise.
//
// Exports:
//   UService                     the names — the same strings the log and the services map use
//   classifyUService(bytes)      what this connection is, or that it is too early to say

import { HEADER_SIZE, MessageType } from './gs-message.ts';

/** The u-lobby services a TCP connection can turn out to be. `HTTP` is the ini or the door. */
export type UService = 'HTTP' | 'Router' | 'Proxy' | 'Lobby' | 'IRC';

export interface UServiceVerdict {
  /** The u-lobby service, or null when there is nothing to name yet or nothing that fits. */
  service: UService | null;
  /** True when more bytes could still settle it, so the caller must keep the buffer. */
  wait: boolean;
  /** What was decided and why — this goes in the log, because "which u-lobby service" is the diagnostic. */
  note: string;
}

/**
 * The message each u-lobby service's first one is. Measured on the three-player run: the router is
 * opened with a key exchange, the proxy with a login or a login-wait-module, the lobby
 * with its own login. A type outside this list is not guessed at.
 */
const OPENS_WITH: Record<number, UService> = {
  [MessageType.KEY_EXCHANGE]: 'Router',
  [MessageType.LOGIN]: 'Proxy',
  [MessageType.LOGINWAITMODULE]: 'Proxy',
  [MessageType.LOBBYSERVERLOGIN]: 'Lobby',
};

/** The name of a type, for the log line, since a bare number says nothing to a reader. */
function typeName(type: number): string {
  for (const [name, value] of Object.entries(MessageType)) if (value === type) return name;
  return `type ${type}`;
}

const GET = Buffer.from('GET ', 'latin1');

export function classifyUService(bytes: Buffer): UServiceVerdict {
  if (bytes.length === 0) return { service: null, wait: true, note: 'nothing said yet' };

  // 1. The ini. A short read that is still a prefix of `GET ` is not yet a no.
  const seen = Math.min(bytes.length, GET.length);
  if (bytes.subarray(0, seen).equals(GET.subarray(0, seen))) {
    if (bytes.length < GET.length) return { service: null, wait: true, note: 'may be a GET, waiting' };
    return { service: 'HTTP', wait: false, note: 'a GET — the server list, or the door' };
  }

  // 2. The GS u-lobby services. Half a header decides nothing.
  if (bytes.length < HEADER_SIZE) return { service: null, wait: true, note: `${bytes.length} bytes, less than a GS header` };
  const size = (bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!;
  const type = bytes[4]!;
  const service = OPENS_WITH[type];
  if (service && size >= HEADER_SIZE) {
    // A message still arriving is not a message that failed: wait for the rest rather
    // than fall through to IRC, which is where everything unrecognised ends up.
    if (size > bytes.length)
      return { service: null, wait: true, note: `a ${typeName(type)} of ${size} bytes, ${bytes.length} here so far` };
    return { service, wait: false, note: `a ${typeName(type)} — the ${service.toLowerCase()}` };
  }

  // A header that adds up but names a u-lobby service nobody opens with is the one case worth
  // refusing outright. Attaching it to a session by guesswork would put a real message
  // into the wrong conversation, and the log would say nothing about it.
  //
  // An IRC frame cannot land here by accident: its first three bytes are `00`, the u16
  // length's high half and its low half, so the size they read as is at least 256 times
  // the length, against a buffer only two bytes longer than it.
  if (size >= HEADER_SIZE && size <= bytes.length) {
    return { service: null, wait: false, note: `a GS message of ${typeName(type)}, which opens no u-lobby service here` };
  }

  // 3. Everything else.
  return { service: 'IRC', wait: false, note: 'not a GET and not a GS header — chat' };
}

/** The two UDP u-lobby services. A datagram is one or the other; there is no waiting for more. */
export type Window = 'CDKey' | 'NAT';

/** What the CD-key framing costs before its body: a type byte and a big-endian u32. */
const CDKEY_HEADER = 5;

/**
 * Which window a datagram is for.
 *
 * The CD-key framing carries its body's length, so it can be recognised by arithmetic:
 * five bytes of header plus the length it declares is the datagram that arrived. The
 * mirror is everything else, and it has to be tried LAST — it answers any datagram under
 * twelve bytes with the same bytes back, as a keep-alive, so given first refusal it would
 * swallow anything short that was meant for the other window.
 *
 * The capture also shows the CD-key type byte as `d3`, but the byte is not what decides
 * here: `cdkey-service.ts` reads the request out of the body and has never looked at it,
 * and our own recorded requests carry a different one. The length is the test that holds.
 */
export function classifyDatagram(packet: Buffer): { window: Window; note: string } {
  if (packet.length > CDKEY_HEADER && packet.readUInt32BE(1) + CDKEY_HEADER === packet.length) {
    return { window: 'CDKey', note: `a CD-key message of ${packet.length - CDKEY_HEADER} bytes, type ${packet[0]}` };
  }
  return { window: 'NAT', note: packet.length < 12 ? 'short — the mirror keep-alive' : 'the NAT mirror' };
}

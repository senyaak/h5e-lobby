// Which desk a connection is, read off the first thing it says.
//
// Ubisoft's lobby is several services and the client dials each one separately, but the
// NUMBERS are ours: every address the client uses comes from the ini we serve or from a
// reply we write, and nothing on either side compares one with another. So the desks can
// share a port, and what tells them apart is the first message — which exists, always,
// because the client speaks first on every one of them (SLICE §2.3).
//
// The order below is the whole of it, and it is an order, not a set of independent tests:
//
//   1. `GET ` is the ini being fetched. Nothing else here begins with a word.
//   2. A GS header that adds up — a size that is at least a header and no longer than
//      what arrived — and whose type is one a desk opens with. That names the desk.
//   3. Anything else is IRC, which is what is left. It fails the GS test twice over: its
//      u16 frame length read as a 24-bit size is far larger than the bytes that arrived,
//      and the byte where a type would be is a byte of ciphertext.
//
// The `wait` verdict is the reason this is a function and not an expression: a first read
// can be short, and a decision taken on half a header would be a decision taken on noise.
//
// Exports:
//   Desk                     the names — the same strings the log and the desks map use
//   classifyDesk(bytes)      what this connection is, or that it is too early to say

import { HEADER_SIZE, MessageType } from './gs-message.ts';

/** The desks a TCP connection can turn out to be. `HTTP` is the server list, fetched once. */
export type Desk = 'HTTP' | 'Router' | 'Proxy' | 'Lobby' | 'IRC';

export interface DeskVerdict {
  /** The desk, or null when there is nothing to name yet or nothing that fits. */
  desk: Desk | null;
  /** True when more bytes could still settle it, so the caller must keep the buffer. */
  wait: boolean;
  /** What was decided and why — this goes in the log, because "which desk" is the diagnostic. */
  note: string;
}

/**
 * The message each desk's first one is. Measured on the three-player run: the router is
 * opened with a key exchange, the proxy with a login or a login-wait-module, the lobby
 * with its own login. A type outside this list is not guessed at.
 */
const OPENS_WITH: Record<number, Desk> = {
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

export function classifyDesk(bytes: Buffer): DeskVerdict {
  if (bytes.length === 0) return { desk: null, wait: true, note: 'nothing said yet' };

  // 1. The ini. A short read that is still a prefix of `GET ` is not yet a no.
  const seen = Math.min(bytes.length, GET.length);
  if (bytes.subarray(0, seen).equals(GET.subarray(0, seen))) {
    if (bytes.length < GET.length) return { desk: null, wait: true, note: 'may be a GET, waiting' };
    return { desk: 'HTTP', wait: false, note: 'a GET — the server list' };
  }

  // 2. The GS desks. Half a header decides nothing.
  if (bytes.length < HEADER_SIZE) return { desk: null, wait: true, note: `${bytes.length} bytes, less than a GS header` };
  const size = (bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!;
  const type = bytes[4]!;
  const desk = OPENS_WITH[type];
  if (desk && size >= HEADER_SIZE) {
    // A message still arriving is not a message that failed: wait for the rest rather
    // than fall through to IRC, which is where everything unrecognised ends up.
    if (size > bytes.length)
      return { desk: null, wait: true, note: `a ${typeName(type)} of ${size} bytes, ${bytes.length} here so far` };
    return { desk, wait: false, note: `a ${typeName(type)} — the ${desk.toLowerCase()}` };
  }

  // A header that adds up but names a desk nobody opens with is the one case worth
  // refusing outright. Attaching it to a session by guesswork would put a real message
  // into the wrong conversation, and the log would say nothing about it.
  //
  // An IRC frame cannot land here by accident: its first three bytes are `00`, the u16
  // length's high half and its low half, so the size they read as is at least 256 times
  // the length, against a buffer only two bytes longer than it.
  if (size >= HEADER_SIZE && size <= bytes.length) {
    return { desk: null, wait: false, note: `a GS message of ${typeName(type)}, which opens no desk here` };
  }

  // 3. Everything else.
  return { desk: 'IRC', wait: false, note: 'not a GET and not a GS header — chat' };
}

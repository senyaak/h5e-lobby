// What the services say to the core, and it back to them.
//
// One WebSocket per service, JSON text frames, one object per frame. It is deliberately
// not the game's protocol: nothing here is decided by what the client wants to hear, so
// it is allowed to be readable, and a browser can speak it without a translator.
//
// Two shapes only:
//   a message with an `id` expects exactly one `reply` carrying the same id;
//   a message without one is told and not asked, and anything the core wants to say on
//   its own arrives the same way.
//
// The token is checked on the first frame. It is a seatbelt, not a lock: the core listens
// on loopback and is reached from outside through the services in front of it.
//
// Exports:
//   ChatMessage, PresenceEntry, ChannelInfo   what travels
//   ToCore, FromCore                          the two directions
//   encode(message), decode(bytes)            the frame

export const CORE_PROTOCOL = 1;

/** Where a line was typed. The game and the browser draw each other's differently. */
export type Origin = 'game' | 'web' | 'server';

export interface ChatMessage {
  /** Ascending, assigned by the core; a client asks for "everything after n". */
  id: number;
  /** The IRC channel name, which is what both sides already agree on: `#LobbyGrp1.2`. */
  channel: string;
  nick: string;
  text: string;
  /** Epoch milliseconds. The game's own chat carries no time; ours does. */
  at: number;
  origin: Origin;
}

export interface PresenceEntry {
  nick: string;
  channel: string;
  origin: Origin;
}

export interface ChannelInfo {
  /** `#LobbyGrp1.2` — the key everything else uses. */
  key: string;
  /** The lobby id the game knows it by. */
  id: number;
  /** What a person calls it: Casual, Ranked, 1v1. */
  name: string;
}

export type ToCore =
  | { kind: 'hello'; service: string; token: string }
  /**
   * `sender` is the connection the line came in on, echoed back in the broadcast so the
   * service can skip it: the game draws its own message locally and would show it twice.
   */
  | { kind: 'chat.post'; channel: string; nick: string; text: string; origin: Origin; sender?: string }
  | { kind: 'chat.history'; id: number; channel: string; limit?: number }
  /** The whole of one service's view, sent whenever it changes. Simpler than deltas. */
  | { kind: 'presence.replace'; origin: Origin; entries: PresenceEntry[] }
  | { kind: 'channels'; id: number }
  /**
   * "Is this the password for this account?" — the browser's login, asked for it by the
   * web service. It never creates: an account is made by the first login in the game and
   * nowhere else (services/core/rules/accounts.ts).
   *
   * The password crosses loopback in this frame, in the clear, the same way it crosses
   * the web service's own HTTP. Nothing logs it — the core logs a message's kind and the
   * verdict, never its body — and the day this hop is not loopback is the day it needs
   * more than that.
   */
  | { kind: 'auth.verify'; id: number; name: string; password: string }
  | { kind: 'agent.register'; id: number; token: string; nick: string; room: string }
  | { kind: 'agent.identify'; id: number; token: string };

export type FromCore =
  | { kind: 'welcome'; protocol: number; channels: ChannelInfo[] }
  | { kind: 'chat.message'; message: ChatMessage; sender?: string }
  | { kind: 'presence'; entries: PresenceEntry[] }
  | {
      kind: 'reply';
      id: number;
      ok: boolean;
      error?: string;
      messages?: ChatMessage[];
      channels?: ChannelInfo[];
      agent?: { nick: string; room: string };
      /** On a successful `auth.verify`: the account's own spelling of its name. */
      account?: { name: string };
    };

export function encode(message: ToCore | FromCore): string {
  return JSON.stringify(message);
}

/**
 * A frame back into a message, or null.
 *
 * Null rather than a throw: this is fed by whatever connected, and a service that dies of
 * somebody else's malformed frame is a service that can be stopped by a port scan.
 */
export function decode<T extends ToCore | FromCore>(bytes: Buffer | string): T | null {
  try {
    const value = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8')) as T;
    return value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

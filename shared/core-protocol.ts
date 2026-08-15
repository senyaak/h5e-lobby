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
// NOTHING AUTHENTICATES ON THIS HOP, and that is the honest state of it. There was a
// shared token until 15.08.2026, defaulting to a value written in this repository — a lock
// whose key everybody has is not one, and pretending otherwise is worse than saying so.
// What actually keeps the core to ourselves is that it listens on loopback and refuses to
// listen anywhere else (`startCore` throws), so reaching it means already being on the
// host. The day the host has other people's processes on it, the answer is a unix socket
// in a directory only the service user can enter — checked by the operating system rather
// than by us, and impossible to forget to generate.
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

/**
 * A game somebody is hosting, as much of it as anyone outside the u-lobby needs.
 *
 * The relay's one question is "which room is this agent in", and this is what answers it.
 * Nothing here is the game's own room record — no settings blob, no addresses, no map:
 * the core is not being asked to understand a game, only to say who is playing it with
 * whom.
 */
export interface RoomInfo {
  id: number;
  name: string;
  /** Who is hosting. He is in `members` too. */
  master: string;
  members: string[];
  /** How many the host opened it for, so `members.length` of this reads as "2 of 3". */
  maxPlayers: number;
  /**
   * The game's own version string, as the host's client stated it when it made the room.
   *
   * Here because it is the one thing that decides whether somebody can join at all: the
   * client refuses a game whose version is not one it knows, and a person looking at a
   * list wants to see that before he clicks rather than after.
   */
  gameVersion: string;
  /**
   * Where each player's game is, as the host's own description of the room says.
   *
   * The relay needs it to know which agent a datagram is FOR: an agent knows
   * only the address its game dialled, so somebody has to hold "that address is
   * this player", and the game itself says so in the room description
   * (`roomEndpoints` in services/u-lobby/lobby.ts).
   *
   * Empty when the description has not been read — two players still work, by
   * the relay handing a datagram to the only other agent in the room.
   */
  endpoints: PeerEndpoint[];
}

export interface PeerEndpoint {
  nick: string;
  /** Dotted IPv4, as the game will dial it. */
  address: string;
  port: number;
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
  /** Who is connecting, for the log. It decides nothing — see the note at the top. */
  | { kind: 'hello'; service: string }
  /**
   * `sender` is the connection the line came in on, echoed back in the broadcast so the
   * service can skip it: the game draws its own message locally and would show it twice.
   */
  | { kind: 'chat.post'; channel: string; nick: string; text: string; origin: Origin; sender?: string }
  | { kind: 'chat.history'; id: number; channel: string; limit?: number }
  /** The whole of one service's view, sent whenever it changes. Simpler than deltas. */
  | { kind: 'presence.replace'; origin: Origin; entries: PresenceEntry[] }
  /**
   * The same, for rooms: the u-lobby's whole list, whenever it is not what was sent last.
   *
   * A list rather than "player X joined room Y" because rooms appear, fill, empty and
   * vanish on the client's own messages, and a missed delta would leave the core telling
   * the relay about a game that finished. What cannot go stale is a picture that is
   * replaced whole.
   */
  | { kind: 'rooms.replace'; rooms: RoomInfo[] }
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
  /**
   * The relay's one question, asked once per connection: WHO is at this endpoint?
   *
   * **There is no secret and nothing is issued.** An agent says where its game is —
   * the address and port the game itself plays on, which it takes from the socket it
   * already has its hands on — and the core looks that up in the room list the u-lobby
   * sends it. The lobby is what says who may be let in; the connection carries no claim
   * of its own beyond an address the lobby either knows or does not.
   *
   * There used to be a long-lived secret here, hashed in the core's database and issued
   * by hand. Сеня cut it on 14.08.2026 for the reason that ends the argument: nobody
   * outside the three copies on his desk could ever have obtained one.
   *
   * An endpoint in no room is refused — there is nothing for him to be relayed to yet.
   */
  | { kind: 'agent.identify'; id: number; address: string; port: number };

export type FromCore =
  | { kind: 'welcome'; protocol: number; channels: ChannelInfo[] }
  | { kind: 'chat.message'; message: ChatMessage; sender?: string }
  | { kind: 'presence'; entries: PresenceEntry[] }
  /**
   * The games being hosted, everywhere, as one list — the same shape and the same rule as
   * presence: replaced whole, sent when it differs, never a delta.
   *
   * **This carries `endpoints`, which is where each player's game is.** It goes to
   * services, all of which are on the loopback with the core; whoever forwards any of this
   * to a person is the one that has to take that field out first. The web service does.
   */
  | { kind: 'rooms'; rooms: RoomInfo[] }
  | {
      kind: 'reply';
      id: number;
      ok: boolean;
      error?: string;
      messages?: ChatMessage[];
      channels?: ChannelInfo[];
      /**
       * On `agent.identify`: who he is, which room, and where everyone in that
       * room is playing — the last so the relay can route by endpoint rather
       * than shouting into the room.
       */
      agent?: { nick: string; room: string; roster: PeerEndpoint[] };
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

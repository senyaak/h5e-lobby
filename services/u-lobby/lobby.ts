// The lobby: the lists a player picks from before there is a game at all.
//
// GS calls everything a GROUP. A lobby is a top-level group (Casual, Ranked,
// 1v1 — ours to define), a room is a group inside it, and one player in a room is
// its master. The client asks about them with LOBBY_MSG messages, each carrying a
// subtype: log in, give me the lobby list, take me to the lobby server.
//
// A lobby is described by fourteen fields in a fixed order, and the client reads
// them positionally, so the order below is the format. Two of them carry meaning
// worth knowing: `config` is a mask of LSM_* flags that tells the client what to
// ask for on joining, and `eventId` is the game mode — 0 plain, 1 rated, 2 duel —
// which is how a "Ranked" lobby is rated rather than merely named so.
//
// Exports:
//   LobbyMsg              the subtypes we answer
//   GroupType, Lsm        what a group is, and what it asks for
//   lobbyEntry(lobby)     one lobby as the client reads it
//
// The three lobbies themselves are NOT here: the core publishes the same list to the
// browser, so it lives in shared/channels.ts where neither service owns it.

import type { Lobby } from '../../shared/channels.ts';
import type { RoomFact } from '../../shared/core-protocol.ts';
import { type GSValue } from './gs-data.ts';
import { findField, looksLikeFields, readFields, writeFields, type Field } from './structure.ts';
import { mirrorPort } from './nat-service.ts';

/**
 * LOBBY_MSG subtypes — the whole table, not only what we answer today.
 *
 * The ones past SET_PLAYER_INFO are the game's own sequence, and having the
 * numbers here is what makes reading a log possible: an unimplemented subtype can
 * be named instead of guessed at.
 */
export const LobbyMsg = {
  JOIN_SERVER: 3,
  INFO_REFRESH: 6,
  GROUP_LEAVE: 8,
  GROUP_INFO_GET: 9,
  PLAYER_KICK: 10,
  CREATE_ROOM: 12,
  PARENT_GROUP_ID: 14,
  START_GAME: 15,
  START_MATCH: 17,
  LOBBY_DISCONNECTION: 18,
  LOGIN: 21,
  JOIN_LOBBY: 23,
  JOIN_ROOM: 24,
  MASTER_NEW: 27,
  SUBMIT_MATCH: 30,
  GROUP_CONFIG_UPDATE_RES: 31,
  UPDATE_PING: 32,
  GAME_READY: 33,
  GAME_CONNECTED: 34,
  /** The end of a game nobody was rated for — which, in this build, is every game. */
  GAME_FINISH: 35,
  UPDATE_GAME_INFO: 41,
  SET_PLAYER_INFO: 42,
  /** "I have started the match" — the answer both players give to MATCH_STARTED. */
  PLAYER_MATCH_STARTED: 44,
  MATCH_FINISH: 45,
  GET_ALT_GROUP_INFO: 46,
  MEMBER_JOIN: 50,
  MEMBER_LEAVE: 51,
  GROUP_INFO: 53,
  NEW_GROUP: 54,
  GROUP_REMOVE: 55,
  GAME_STARTED: 56,
  GROUP_CONFIG_UPDATE: 57,
  MASTER_CHANGED: 59,
  KICK_OUT: 61,
  MATCH_STARTED: 62,
  MATCH_READY: 65,
  PLAYER_INFO_UPDATE: 66,
  PLAYER_UPDATE_STATUS: 69,
  /** "I have finished the match" — said once, right after the results go out. */
  PLAYER_MATCH_FINISHED: 70,
  FINAL_MATCH_RESULTS: 71,
  PLAYER_GROUP_GET: 106,
  CHANGE_REQUESTED_LOBBIES: 109,
  MEMBER_LIST: 151,
} as const;

export const GroupType = { LOBBY: 0, ROOM_UBI_P2P: 7 } as const;

/** Lobby Service Mask — what the client should ask for once it is in. */
export const Lsm = {
  PRIVATE: 0x1,
  NEEDMASTER: 0x2,
  ETERNAL: 0x4,
  ACTIVE: 0x8,
  OPEN: 0x10,
  STARTABLE: 0x20,
  GROUPINFO: 0x40,
  GROUPMEMBERS: 0x80,
  CHILDGROUPINFO: 0x100,
  /** All three "tell me about it" bits, which is 448 — the number the client asks with. */
  ALLINFO: 0x1c0,
} as const;

/**
 * Which fields a GROUP_CONFIG_UPDATE_RES carries, and in this order.
 *
 * The flags are the payload's shape: a field is present only if its bit is set, so
 * a reader that ignores one of them reads every field after it out of place.
 */
export const RoomUpdate = {
  OPEN: 0x2,
  SCORE_SUBMISSION: 0x4,
  MAX_PLAYERS: 0x8,
  MAX_VISITORS: 0x10,
  PASSWORD: 0x20,
  GROUP_INFO: 0x40,
  DEDICATED_SERVER: 0x200,
  /** All three together mean one extra field of dedicated-server flags comes first. */
  DS_FLAGS: 0x2 | 0x4 | 0x200,
  ALT_GROUP_INFO: 0x400,
} as const;

/**
 * How a member is doing, in the status field of a member record.
 *
 * **NONE is not a spare value, it is the only one the channel's player panel
 * accepts.** `NUI::NLobbyPlayers::CPlayersController::OnMemberJoined` (0x9108f0)
 * opens with `if (member[+4] != 0) return;` — a member whose status is anything
 * else is dropped without a word, which is why the panel stayed empty while the
 * game log happily announced every arrival. The other values describe a player
 * who is already inside a game, and the panel means to leave those out.
 */
export const PlayerStatus = {
  NONE: 0,
  SILENT: 1,
  GAMECONNECTED: 2,
  GAMEREADY: 4,
  MATCHREADY: 8,
  MATCHPLAYING: 16,
} as const;

/**
 * The port the game itself plays on, as opposed to the ports this server listens on.
 *
 * Not a setting of ours: it is where the client's own NAT pings come from, visible in
 * every log as `UDP NATServer:40010 <- 127.0.0.1:8888`, and it is what a player's
 * self-description carries. Named here because two places now say it — his blob and
 * the announcement that the game has started.
 */
export const GAME_PORT = 8888;

/**
 * A game somebody is hosting.
 *
 * Almost all of it comes straight from the client's CREATE_ROOM: the name it
 * composed ("Сервер — Senyaak", in the player's own language), the game title,
 * the room type (7, peer-to-peer), how many may play and watch, and `info` — a
 * blob of the game's own settings with the map path inside it
 * (`/Maps/Multiplayer/…/map.xdb`, `autosave_enabled`, the goal). We do not need to
 * understand that blob to run a lobby: it is the host's description of the game,
 * and it goes back out to everyone who lists the room.
 */
export interface Room {
  id: number;
  parentId: number;
  name: string;
  gameTitle: string;
  type: number;
  maxPlayers: number;
  maxVisitors: number;
  password: string;
  info: Uint8Array;
  /** The second, empty blob the client sends beside the first one. */
  altInfo: Uint8Array;
  /** Both come from the create request: the version fields it will match against. */
  gameVersion: string;
  gsVersion: string;
  /** The game mode, taken from the channel the room was made in. */
  eventId: number;
  /** Where the host is, as the room advertises him. */
  address: string;
  altAddress: string;
  master: string;
  members: string[];
}

/**
 * Who is in which channel, and what they said about themselves.
 *
 * A channel's player list is not decoration: "Profile" reads *"look at the results of
 * the SELECTED players"*, and "Join" needs a selected game — so with nothing listed
 * both buttons are dead, which is exactly how they looked. The client asks for the
 * list by mask (384: members and child groups) and we answered "nobody", the player
 * himself included.
 *
 * A player is in one channel at a time, so entering one leaves the last.
 */
export class Presence {
  private readonly lobbyOf_ = new Map<string, number>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly addresses = new Map<string, string>();

  enter(name: string, lobbyId: number): void {
    if (name) this.lobbyOf_.set(name, lobbyId);
  }

  /** Where a player says he lives, from his lobby-server login. */
  livesAt(name: string, address: string): void {
    if (name && address) this.addresses.set(name, address);
  }

  address(name: string): string {
    return this.addresses.get(name) ?? '127.0.0.1';
  }

  leave(name: string): void {
    this.lobbyOf_.delete(name);
  }

  /** Which channel a player is in, or null when he is in none. */
  lobbyOf(name: string): number | null {
    return this.lobbyOf_.get(name) ?? null;
  }

  inLobby(lobbyId: number): string[] {
    return [...this.lobbyOf_.entries()].filter(([, id]) => id === lobbyId).map(([name]) => name);
  }

  /**
   * What a player said about himself in SET_PLAYER_INFO.
   *
   * Kept per player rather than per connection, because the OTHER players' records
   * need it too — that is the thing a second client turns from tidiness into a
   * requirement.
   */
  remember(name: string, info: Uint8Array): void {
    if (name && info.length) this.blobs.set(name, info);
  }

  info(name: string): Uint8Array | undefined {
    return this.blobs.get(name);
  }
}

/**
 * The matches that have been started, so a result is judged once and only once.
 *
 * **Both players submit the same table**, a second or two apart — measured, three times —
 * so a ladder written straight from the message would count every game twice, once per
 * player. And whether a game is rated is known at START_MATCH (from the channel its room
 * is in) but not at SUBMIT_MATCH, by which time the room may already be gone.
 *
 * The id is the one we hand out in `MATCH_STARTED` and the client quotes back.
 */
export class Matches {
  private readonly started = new Map<string, { rated: boolean; settled: boolean }>();

  start(matchId: string, rated: boolean): void {
    this.started.set(matchId, { rated, settled: false });
  }

  rated(matchId: string): boolean {
    return this.started.get(matchId)?.rated ?? false;
  }

  /** True for the FIRST result of a match, false for every one after it. */
  settle(matchId: string): boolean {
    const match = this.started.get(matchId);
    if (!match || match.settled) return false;
    match.settled = true;
    return true;
  }
}

/** The rooms that exist, per lobby. Ours to keep; nothing else knows them. */
export class Rooms {
  private readonly rooms = new Map<number, Room>();
  private nextId = 100;

  create(room: Omit<Room, 'id'>): Room {
    const created: Room = { ...room, id: this.nextId++ };
    this.rooms.set(created.id, created);
    return created;
  }

  get(id: number): Room | undefined {
    return this.rooms.get(id);
  }

  inLobby(lobbyId: number): Room[] {
    return [...this.rooms.values()].filter((room) => room.parentId === lobbyId);
  }

  named(parentId: number, name: string): Room | undefined {
    return [...this.rooms.values()].find((room) => room.parentId === parentId && room.name === name);
  }

  hostedBy(master: string): Room[] {
    return master ? [...this.rooms.values()].filter((room) => room.master === master) : [];
  }

  /** The rooms a player is inside — which is how a message that names none is placed. */
  containing(name: string): Room[] {
    return name ? [...this.rooms.values()].filter((room) => room.members.includes(name)) : [];
  }

  /** Every open room. The u-lobby tells the core about these, so the relay can be asked. */
  all(): Room[] {
    return [...this.rooms.values()];
  }

  remove(id: number): void {
    this.rooms.delete(id);
  }
}

/**
 * A room, in the twenty fields the client reads as a RoomInfo.
 *
 * **A room is not a lobby with different contents.** A lobby is fourteen fields
 * (see `lobbyEntry`); a room carries six more — visitors, the two version strings,
 * and the host's two addresses — and the client tells them apart by that. Sending a
 * room in the lobby shape is what made it log our new game as `LobbyRcv_NewLobby`
 * and then refuse to enter it: "join room succeeded" followed immediately by "join
 * room failed, no such room in internal list".
 *
 * `allowed_games` and `games` are empty for a room: the game it belongs to is
 * already settled by the channel it is in.
 */
/**
 * A diagnostic, off unless `--probe-room-fields` is on the command line.
 *
 * The client packs our twenty fields into a record whose layout is ours to work out,
 * and it REFUSES to let anybody join a game whose version field is not one it knows
 * (0x10000…0x10032, or 0x20000/0x20001 — 0x8768B0 and 0xDE2660). Ours reads 0x30001,
 * which is (field 4 << 16) | field 3 — our channel id and our "1" — so at least those
 * two are not where we thought they were.
 *
 * One field at a time is one launch at a time. With this on, every number we are not
 * sure of goes out as its own recognisable value (8003 for field 3, 8004 for field 4,
 * and so on), and the probe's dump of the record then says where each of them landed —
 * the whole map in a single run.
 *
 * **Only in what OTHER players are shown.** The first run of this went out on every
 * copy of the room, the host's own included, and his client then could not enter the
 * game it had just made: "Игра не существует, возможно сервер прекратил игру. Код
 * ошибки 0.5.0" — 5 being the client's own number for "no such game". So the numbering
 * is passed in by the CHANNEL push and nowhere else: the host's room stays honest, he
 * creates and enters as usual, and the map is measured on the other screen.
 */
export const probeRoomFields = { on: false };

/**
 * Where the other player is — replaced, for one launch, with an address that is ours.
 *
 * The duel of 14.08.2026 was captured on the loopback adapter and settled what the peers
 * dial: `192.168.178.27:8888 <-> 192.168.178.27:8889`, UDP, one socket each, 451 packets
 * in 186 seconds. Not `127.0.0.1` — the machine's **LAN** address, the one the client
 * declares about itself in LOBBYSERVERLOGIN. The NAT service had mirrored `127.0.0.1` back
 * to both of them and neither dialled it.
 *
 * That address reaches the other client by two roads and the capture cannot tell them
 * apart, because on one machine they carry the same string: the member record's fields
 * 2 and 3, which the SERVER fills from what he declared, and his own player-info blob,
 * which we forward byte for byte and which carries a LAN address of its own (tag 4).
 * Which of the two is dialled decides how much work the relay is — the first we already
 * own, the second needs surgery on his document.
 *
 * So: with this on, every player is registered in `Presence` at an address out of the
 * pool below instead of his real one, and a listener on those addresses says which road
 * was taken. Nothing else changes; the blob still goes out as he wrote it.
 *
 * **Only in what OTHER players are shown.** `RouterSession.addressOf` answers a player's
 * own record from `this.localAddress`, which stays true, and everyone else's from
 * `Presence` — so the host still knows where he himself lives. This is the same line the
 * room-field probe had to learn the hard way.
 *
 * Nothing forwards on the probe addresses, so the game will NOT connect while this is on.
 * That is the point: the question of this launch is where the call is placed, not whether
 * it is answered.
 */
export const probePeerAddress = {
  on: false,
  /** Handed out in the order players log in — the whole 127/8 is loopback on Windows. */
  pool: ['127.0.0.9', '127.0.0.10', '127.0.0.11', '127.0.0.12'],
  given: new Map<string, string>(),
  for(name: string): string {
    const already = this.given.get(name);
    if (already) return already;
    const next = this.pool[this.given.size % this.pool.length]!;
    this.given.set(name, next);
    return next;
  },
  /**
   * Which probe address stands in for a copy of the game, by the port it plays on:
   * 8888 the first install, 8889 the second, 8890 the third.
   */
  forPort(port: number): string | null {
    const at = port - 8888;
    return at >= 0 && at < this.pool.length ? this.pool[at]! : null;
  },
  /** What the last call to `probeEndpoints` did, for the launch's log to state. */
  lastPatch: '',
};

/**
 * The players' endpoints inside the host's description of the game, pointed at us.
 *
 * The first probe (announcing players at addresses of ours in the member record)
 * changed nothing: the clients dialled the real LAN address anyway and played a full
 * duel. So the address is not carried by any field the server fills in — and the
 * capture's hex says where it is instead. Inside the 658-byte description the host
 * sends, each player has a record of this shape:
 *
 * ```
 * 02 10 "Senyaak2"                       the name
 * 03 24  02 20 <16>                      a sockaddr: port 40010, the NAT-mirrored
 *                                        address, written back to front
 * 04 2c  02 04 <port>  03 20 <16>        the GAME port and the LAN address
 * 05 08 <4>                              the rating
 * ```
 *
 * and `04 2c 02 04 pp pp 03 20` is the shape searched for here: tag 4 of a player
 * record is exactly 22 bytes, holding a two-byte port under tag 2 and sixteen bytes
 * under tag 3 of which the first four are the address. That is specific enough to find
 * without walking the document — the same argument `stampRoomIds` makes for its pair.
 *
 * Only the four address bytes are written, in place, so the document keeps its length
 * and every other byte the host wrote. The port is read, not changed: the probe listens
 * on the ports the copies already use.
 */
/**
 * Every player's game endpoint, read out of the host's description of the room.
 *
 * This is the same record `probeEndpoints` rewrites, read instead of written:
 * per player, his name and then the address the OTHERS will dial him at.
 *
 *   02 10 "Senyaak2"                 the name
 *   03 24 02 20 <16 bytes>           the NAT-mirrored address, port 40010
 *   04 2c 02 04 <port> 03 20 <16>    the GAME port, then the address
 *   05 08 <4 bytes>                  the rating
 *
 * Why anyone wants it: the relay carries datagrams between agents and has to
 * know which agent a datagram is FOR. The agent knows only the address its game
 * dialled, so somebody has to hold "this address is that player", and this is
 * where the game itself says so.
 *
 * FOUND BY ITS SHAPE, not by walking the document as fields — which was tried
 * first and does not survive real bytes: the description holds parts this does
 * not understand, a field walk stops at the first of them, and on a captured
 * two-player room it lost the second player. `probeEndpoints` below has been
 * finding the same record by its bytes for as long as it has existed, against
 * live clients, so this reads it the same way and each hit carries the same
 * guard: tag 3 with sixteen bytes right behind the port, or it is a
 * coincidence somewhere else in the document.
 */
export function roomEndpoints(info: Uint8Array): Array<{ nick: string; address: string; port: number }> {
  const buf = Buffer.from(info);
  const found: Array<{ nick: string; address: string; port: number }> = [];
  const shape = Buffer.from([0x04, 0x2c, 0x02, 0x04]);
  const seen = new Set<string>();

  let at = 0;
  for (;;) {
    at = buf.indexOf(shape, at);
    if (at < 0) break;
    const port = buf.readUInt16LE(at + 4);
    // The same guard `probeEndpoints` writes under: tag 3 with sixteen bytes, or
    // this is a coincidence somewhere else in the document.
    if (buf[at + 6] !== 0x03 || buf[at + 7] !== 0x20 || at + 12 > buf.length) {
      at += shape.length;
      continue;
    }
    const address = [...buf.subarray(at + 8, at + 12)].join('.');

    // The name, backwards from here: a `02 <len>` whose text ends exactly where
    // this player's record begins. Exactly, not nearly — that is what makes it a
    // reading rather than a guess, and a record whose name does not line up is
    // reported without one instead of with somebody else's.
    let nick = '';
    const sockaddr = at - 20; /* 03 24 02 20 + sixteen bytes */
    for (let back = 2; back <= 64 && sockaddr - back >= 0; back += 1) {
      const p = sockaddr - back - 2;
      if (p < 0 || buf[p] !== 0x02) continue;
      const size = buf[p + 1]! >>> 1;
      if ((buf[p + 1]! & 1) !== 0 || p + 2 + size !== sockaddr) continue;
      const text = buf.subarray(p + 2, p + 2 + size).toString('latin1');
      if (/^[ -~ -ÿ]+$/.test(text)) nick = text;
      break;
    }

    const key = `${nick}@${address}:${String(port)}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ nick, address, port });
    }
    at += shape.length;
  }
  return found;
}

/** What a person can be told about the map, out of the host's own description. */
export interface RoomMap {
  /** What to put on a screen: the map's folder, or its template when it was generated. */
  name: string;
  /** True when the host had the game make the map rather than choosing one. */
  generated: boolean;
  /** The path as it stands in the description — the whole of what the wire actually says. */
  path: string;
}

/**
 * The map a room is played on, as far as the wire can say.
 *
 * **The description does not carry the map's NAME.** It carries its path — tag 15,
 * `/Maps/Multiplayer/Rules Test/map.xdb#xpointer(/AdvMapDesc)` — and the client resolves a
 * display name out of the `.xdb` file on its own disk. That is visible in the game itself:
 * a room whose map the other player does not have shows an EMPTY Map column on his screen
 * while a map he does have shows its name. So the folder is what there is, and the folder
 * is a fair name for it.
 *
 * A generated map has no folder worth reading — `/Maps/RMG/154B0BEB-E9FD-…/` — so what is
 * shown instead is the TEMPLATE, `/RMG/Templates/S1P2Z2M1.xdb`, which is in the same
 * document and which players read as a matter of course: S1 is the size, P2 the players,
 * Z2 the zones, M1 the monsters. It says more than the word "random" does.
 *
 * Found by its shape, for the reason `roomEndpoints` is: a field walk over this document
 * stops at the first part it does not understand, and this one is full of them. Here that
 * is easier than there — a path is plain text and `/Maps/` is not a byte sequence that
 * turns up by accident.
 */
export function roomMap(info: Uint8Array): RoomMap | null {
  const buf = Buffer.from(info);
  const at = buf.indexOf('/Maps/', 0, 'utf8');
  if (at < 0) return null;
  // To `.xdb` and no further: what follows is `#xpointer(…)`, which is the client telling
  // itself which part of the file to read and says nothing to anybody else.
  const end = buf.indexOf('.xdb', at, 'utf8');
  if (end < 0) return null;
  const path = buf.subarray(at, end + 4).toString('utf8');
  const generated = path.startsWith('/Maps/RMG/');
  const folder = path.split('/').at(-2) ?? '';

  if (!generated) return { name: folder, generated, path };

  // The template, from the same document. Its absence is not a failure: the recipe is
  // written into the description as the game is made, and a room caught before that
  // happened has the RMG path and not yet the template.
  const templateAt = buf.indexOf('/RMG/Templates/', 0, 'utf8');
  const templateEnd = templateAt < 0 ? -1 : buf.indexOf('.xdb', templateAt, 'utf8');
  const template = templateEnd < 0 ? '' : buf.subarray(templateAt + 15, templateEnd).toString('utf8');
  return { name: template || 'random', generated, path };
}

/**
 * The room screen's switches — five of them, and THE VALUE IS THE TAG.
 *
 * Tag 41 holds five sub-objects, `[41][2]` to `[41][6]`, each four bytes and each of those
 * two EMPTY fields: the first one's tag is the setting's value and the second is always
 * `[0]`. Nothing is stored in a payload, which is why reading payloads never found them.
 *
 * Two of the five are named, both read off a live room screen on 16.08.2026 and both
 * confirmed by the host saying what he had set:
 *
 *   `[41][4]`  how many slots hold a COMPUTER player
 *   `[41][5]`  how many slots are CLOSED
 *
 * They add up, which is what makes them more than a correlation: one human, two computers
 * and one closed slot on a four-slot map is `1 + 2 + 1 = 4`, and every dump taken while
 * that screen was worked obeys it. `[41][2]` follows the slot count in both rooms seen so
 * far — 3 then 4 — and `[41][3]` and `[41][6]` have no name at all. NETWORK_STATE §8 has
 * the table and the procedure for naming the rest.
 */
export function roomSwitches(info: Uint8Array): number[] {
  try {
    const document = findField(readFields(Buffer.from(info)), 1);
    const block = document ? findField(readFields(document), 41) : null;
    if (!block) return [];
    return readFields(block).map((one) => readFields(one.value)[0]?.tag ?? 0);
  } catch {
    return [];
  }
}

/** How many slots the host has filled with computer players. See `roomSwitches`. */
export function roomComputers(info: Uint8Array): number {
  return roomSwitches(info)[2] ?? 0;
}

/** How many slots the host has closed, so nobody can take them. See `roomSwitches`. */
export function roomClosed(info: Uint8Array): number {
  return roomSwitches(info)[3] ?? 0;
}

/** A field's payload as text, if it reads as text at all. */
function asText(value: Buffer): string {
  const text = value.toString('utf8').replace(/\0+$/, '');
  return /^[^ --]*$/.test(text) ? text : '';
}

/**
 * What the description says about the game, for somebody who wants to know before joining.
 *
 * **Only the fields that have been identified**, which is a short list: the map's two
 * paths, the victory goal (tag 32) and the named rule records (tag 27, `autosave_enabled`
 * and its kind). The document holds some forty more fields and what they mean is not known
 * — see NETWORK_STATE — so they are not shown as anything. A panel of `[24] = 00` teaches
 * nobody anything and invites reading meaning into a byte.
 *
 * Tolerant twice over. The field walk is in a `try`, because this document is exactly the
 * one that does not always divide into fields to its end, and a map path read by shape is
 * worth having even when the walk gives up. And nothing here reaches for a player record:
 * those hold addresses, and this goes to a browser.
 */
export function roomFacts(info: Uint8Array): RoomFact[] {
  const facts: RoomFact[] = [];
  const map = roomMap(info);
  if (map) {
    facts.push({ name: 'map', value: map.path });
    if (map.generated && map.name !== 'random') facts.push({ name: 'template', value: map.name });
  }

  let inner: Field[] = [];
  try {
    const document = findField(readFields(Buffer.from(info)), 1);
    if (!document) return facts;
    inner = readFields(document);
  } catch {
    return facts;
  }

  for (const field of inner) {
    if (field.tag === 32) {
      const goal = asText(field.value);
      if (goal) facts.push({ name: 'goal', value: goal });
      continue;
    }
    // A rule the host set, as a name and whatever it was set to: `[1]` is the name and
    // `[2]` holds the value twice, once as a float and once as the text of it.
    if (field.tag !== 27) continue;
    try {
      const rule = readFields(field.value);
      const name = asText(findField(rule, 1) ?? Buffer.alloc(0));
      const held = findField(rule, 2);
      const value = held ? asText(findField(readFields(held), 3) ?? Buffer.alloc(0)) : '';
      if (name) facts.push({ name, value });
    } catch {
      // A rule record that does not read is one rule missing from a panel, not a reason
      // to lose the ones that did.
    }
  }
  return facts;
}

export function probeEndpoints(info: Uint8Array): Uint8Array {
  const out = Buffer.from(info);
  const shape = Buffer.from([0x04, 0x2c, 0x02, 0x04]);
  const done: string[] = [];
  let at = 0;
  for (;;) {
    at = out.indexOf(shape, at);
    if (at < 0) break;
    const port = out.readUInt16LE(at + 4);
    // The two bytes after the port must be tag 3 with sixteen bytes, or this is a
    // coincidence in some other field and writing into it would corrupt the document.
    if (out[at + 6] !== 0x03 || out[at + 7] !== 0x20) {
      at += shape.length;
      continue;
    }
    const address = probePeerAddress.forPort(port);
    if (address) {
      for (const [i, octet] of address.split('.').map(Number).entries()) out[at + 8 + i] = octet;
      done.push(`${String(port)}→${address}`);
    }
    at += shape.length;
  }
  probePeerAddress.lastPatch = done.length ? done.join(', ') : 'NOTHING MATCHED';
  return out;
}

export function roomEntry(room: Room, probe = false): GSValue[] {
  const numbered = (field: number, real: string): string =>
    probe && probeRoomFields.on ? String(8000 + field) : real;
  return [
    String(room.type),
    room.name,
    String(room.id),
    numbered(3, '1'),
    numbered(4, String(room.parentId)),
    numbered(5, String(Lsm.ALLINFO | (room.password ? Lsm.PRIVATE : 0))),
    numbered(6, '1'),
    room.master,
    '',
    '',
    infoOut(room),
    numbered(11, String(room.eventId)),
    String(room.maxPlayers),
    String(room.members.length),
    numbered(14, String(room.maxVisitors)),
    numbered(15, '0'),
    room.gameVersion,
    room.gsVersion,
    room.address,
    room.altAddress,
  ];
}

/** The host's description as it goes OUT — probed on the way, never in what we store. */
function infoOut(room: Room): Uint8Array {
  return probePeerAddress.on ? probeEndpoints(room.info) : room.info;
}

/**
 * "The game has begun" — the push both players are waiting on, in the five fields
 * its parser insists on.
 *
 * 0x423910 reads them by index AND by kind, and a field of the wrong kind is not a
 * field read wrong: the parser returns false and the whole message is dropped without
 * a word, which is indistinguishable from never having sent it.
 *
 *   0 a number   1 a blob   2 a number read as a **short**   3, 4 strings
 *
 * With the ordinary 38 envelope around it, field 0 is the subtype itself — that is how
 * the client's own matcher (0x4286F0) finds the message, and it is the shape every
 * answer in this file already uses.
 *
 * What the last three MEAN is not established. Their shapes — two strings and a
 * sixteen-bit number — fit "two addresses and a port", so the host's are what goes in
 * them; neither handler in the chain reads them (`CStateWaitGameStarted::ProcessGameStarted`
 * 0xE12C40 and `CStateWaitingForPlayers::ProcessGameStarted` 0xE1CCD0 both ignore the
 * message entirely), so nothing here is load-bearing beyond being readable. The blob is
 * the host's own description of the game, which is the only blob in this room that means
 * anything.
 */
export function gameStartedEntry(room: Room, port = GAME_PORT): GSValue[] {
  return [String(LobbyMsg.GAME_STARTED), infoOut(room), String(port), room.address, room.altAddress];
}

/**
 * "The match is running" — pushed after START_MATCH, and it is what makes a game rated.
 *
 * Two numbers (0x423150), and the second one is the **match id**: the client keeps it and
 * sends it back at the top of its results table. We give it the room's id, and the table
 * that arrived at the end of the rated game of 13.08.2026 opened with exactly that number.
 *
 * This was removed once, as an unproven guess, on the strength of a DUEL in which
 * START_MATCH never arrived. The next game — an ordinary map in the Ranked channel —
 * sent START_MATCH, both clients answered this push with subtype 44
 * (`PlayerMatchStarted`), and eight minutes later they submitted their results. So the
 * guess was right, and the duel it was disproved by was simply a different kind of game —
 * the first case of a series, proving the wrong thing about the rest of it.
 */
export function matchStartedEntry(room: Room): GSValue[] {
  return [String(LobbyMsg.MATCH_STARTED), String(room.id)];
}

/**
 * One member of a group, in eight fields — the eight the client reads.
 *
 * The parser is generated code at 0x424b60 and it asks for the fields by index,
 * each with a typed getter, then hands them to the factory at 0xdf1e70 which
 * builds `NUbi::SLobbyRcv_MemberJoined`. So the shape below is not a guess:
 *
 *   0 name (string)   1 flag (bool)   2, 3 address (string)   4 player_info (blob)
 *   5 the groups joined (list)        6 a number, −1 when absent   7 the status
 *
 * Field 7 is the one that decides whether the player is ever seen: it becomes
 * `member[+4]`, and the channel's player panel skips any member whose is not 0
 * (PlayerStatus). Field 6 is the only one the client defaults for itself (0xffff).
 */
export function memberEntry(
  name: string,
  groupId: number,
  address: string,
  status: number = PlayerStatus.NONE,
  own?: Uint8Array,
): GSValue[] {
  // `own` is the blob the player sent us about himself, and it is the ONLY blob
  // worth sending. The client branches on its length (0xDFCDEB): with bytes there it
  // parses them, and with none it falls back to the name field of this very record.
  // A blob we compose ourselves loses that fallback — it parsed ours into nothing and
  // announced "member joined game (Name=,ExtIP=0.0.0.0:0)" over and over. So: his
  // own words, or silence.
  const info = own && own.length ? own : new Uint8Array(0);
  return [name, '0', address, address, info, [String(groupId)], '-1', String(status)];
}

/**
 * A player-info blob, in the client's own shape — copied from one it sent, not
 * derived from what its reader seems to allow.
 *
 * The reader (0xdfea70) fetches tag 2 as the name into the player object's +8, tags 3
 * and 4 as nested objects into +0x14 and +0x24, and tag 5 as **four bytes into +0x38**.
 * Both ends of that matter to the channel's player panel, because
 * `CPlayersController::OnMemberJoined` (0x9108f0) copies +8 into the row's name and
 * `[member+0x38]` into the row's RATING — the two things Сеня saw missing.
 *
 * A document with tag 2 at the top LOOKED legal, since every read is guarded by "is
 * this tag here", and the client drew a player with no name at all. Its own 73-byte
 * blob says why: everything lives one level down, under tag 1.
 *
 * ```
 * [4] 04 00 00 00                  a version, or a kind
 * [1] {
 *   [2] "Senyaak"                  the name
 *   [3] { [2] 16 bytes }           a sockaddr_in: family 2, port 40010, the mirrored
 *                                  address as the NAT service reported it
 *   [4] { [2] port, [3] 16 bytes } the game port (8888) and the LAN address
 *   [5] dc 05 00 00                1500 — the RATING, straight out of the ladder row
 * }
 * ```
 *
 * A real player still sends his own and that is the one to pass on. This is for the
 * players we invent, and for them the rating is the point: without tag 5 the panel
 * shows "…" beside the name.
 */
export function playerInfo(name: string, rating: number, address = '127.0.0.1', gamePort = GAME_PORT): Uint8Array {
  const octets = address.split('.').map(Number);
  // The client writes the mirrored address in the order the NAT answer arrived in —
  // its own log calls 127.0.0.1 "1.0.0.127" — and the LAN one in the natural order.
  // Two orders in one document is not a mistake to fix; it is what it does.
  const mirrored = Buffer.from([...octets].reverse());
  const local = Buffer.from(octets);

  const sockaddr = Buffer.alloc(16);
  sockaddr.writeUInt16LE(2, 0); // AF_INET
  sockaddr.writeUInt16BE(mirrorPort(), 2); // the NAT mirror's own port, as he reports it
  mirrored.copy(sockaddr, 4);

  const lan = Buffer.alloc(16);
  local.copy(lan, 0);

  const port = Buffer.alloc(2);
  port.writeUInt16LE(gamePort, 0);

  const ratingBytes = Buffer.alloc(4);
  ratingBytes.writeInt32LE(Math.trunc(rating), 0);

  return writeFields([
    { tag: 4, value: Buffer.from([4, 0, 0, 0]) },
    {
      tag: 1,
      value: writeFields([
        { tag: 2, value: Buffer.from(name, 'utf8') },
        { tag: 3, value: writeFields([{ tag: 2, value: sockaddr }]) },
        { tag: 4, value: writeFields([{ tag: 2, value: port }, { tag: 3, value: lan }]) },
        { tag: 5, value: ratingBytes },
      ]),
    },
  ]);
}

/**
 * His own blob, with the rating brought up to date — and nothing else touched.
 *
 * The rating drawn beside a name in the channel comes from tag 5 of the player's own
 * player-info document (0xdfea70 reads it into `+0x38`, and `OnMemberJoined` 0x9108f0
 * copies that into the row). **The client composes that document once, when it enters,
 * and never sends it again** — so after a rated game the panel kept showing what he was
 * worth before it, and only leaving the channel and coming back fixed it: that made the
 * client ask the ladder, compose a fresh blob and send it.
 *
 * The rating is the one thing in there that is OURS — we compute it — so it is the one
 * thing written over. Everything else is his: his name, his addresses, his port. If the
 * document is not in the shape we know (tag 1 with a tag 5 inside), it goes back exactly
 * as it came rather than being rebuilt from a guess.
 */
export function withRating(info: Uint8Array, rating: number): Uint8Array {
  try {
    const outer = readFields(Buffer.from(info));
    const inner = outer.find((field) => field.tag === 1);
    if (!inner) return info;
    const fields = readFields(inner.value);
    if (!fields.some((field) => field.tag === 5)) return info;
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(Math.trunc(rating), 0);
    const updated = fields.map((field) => (field.tag === 5 ? { tag: 5, value: bytes } : field));
    return writeFields(outer.map((field) => (field.tag === 1 ? { tag: 1, value: writeFields(updated) } : field)));
  } catch {
    // A document we cannot read is still his, and passing it on unchanged is what this
    // server did before rating existed at all.
    return info;
  }
}

/**
 * The host's own description of the game, with the room's identity written into it.
 *
 * The client sends this blob with **-1 in both id fields**, because when it composed
 * it there was no room yet; the ids are the server's to fill in. It is a
 * `CStructureSaver` document (structure.ts) — tag byte, length, payload — and the
 * two we owe it are tag 2 (the group) and tag 3 (the lobby server), each four bytes
 * little-endian, so each is written with the length byte 8 = 4 << 1.
 *
 * Everything else is passed through untouched: the map, the rules, the goal are the
 * host's business, not ours.
 */
export function stampRoomIds(info: Uint8Array, roomId: number, lobbyServerId = 1): Uint8Array {
  const out = Buffer.from(info);
  // The two fields are adjacent and both still -1, so the pair is searched for as
  // one shape rather than each id on its own: `02 08 ff ff ff ff 03 08 ff ff ff ff`.
  // A lone `02 08` could be anything in a blob this size; this cannot.
  const unset = Buffer.from([0x02, 0x08, 0xff, 0xff, 0xff, 0xff, 0x03, 0x08, 0xff, 0xff, 0xff, 0xff]);
  const at = out.indexOf(unset);
  if (at < 0) throw new Error(`stampRoomIds: no unset id pair in a ${info.length}-byte room info`);
  out.writeInt32LE(roomId, at + 2);
  out.writeInt32LE(lobbyServerId, at + 8);
  return out;
}

/**
 * One lobby, in the fourteen fields the client reads by position:
 * type, name, id, lobby server id, parent, config, level, master, allowed games,
 * games, info blob, event id, max members, members.
 *
 * `game` fills the two game fields with the id the client logged in with
 * (`HEROES_…`). Whether it has to be there is not settled: the reference
 * implementation leaves both empty, and the first channel screen we reached was
 * empty too — a client that filters the list by "is this lobby for my game" would
 * explain that, so this is the cheaper thing to try before reading the filter out
 * of the exe.
 */
export function lobbyEntry(lobby: Lobby, game = '', members = lobby.members): GSValue[] {
  return [
    String(GroupType.LOBBY),
    lobby.name,
    String(lobby.id),
    '1',
    '0',
    '0',
    '1',
    '',
    game,
    game,
    new Uint8Array(0),
    String(lobby.mode),
    String(lobby.maxMembers),
    // How many are in there now — the number beside the channel on the list screen.
    String(members),
  ];
}

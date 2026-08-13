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
//   DEFAULT_LOBBIES       the three we offer
//   lobbyEntry(lobby)     one lobby as the client reads it

import { type GSValue } from './gs-data.ts';
import { writeFields } from './structure.ts';

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
  UPDATE_GAME_INFO: 41,
  SET_PLAYER_INFO: 42,
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

/** Game modes, as the client counts them. */
export const GameMode = { STANDARD: 0, RATED: 1, DUEL: 2 } as const;

export interface Lobby {
  id: number;
  name: string;
  mode: number;
  maxMembers: number;
  members: number;
}

/** What we offer on the lobby screen. Ours to choose; the client only lists them. */
export const DEFAULT_LOBBIES: Lobby[] = [
  { id: 1, name: 'Casual', mode: GameMode.STANDARD, maxMembers: 8, members: 0 },
  { id: 2, name: 'Ranked', mode: GameMode.RATED, maxMembers: 8, members: 0 },
  { id: 3, name: '1v1', mode: GameMode.DUEL, maxMembers: 8, members: 0 },
];

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
  private readonly lobbyOf = new Map<string, number>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly addresses = new Map<string, string>();

  enter(name: string, lobbyId: number): void {
    if (name) this.lobbyOf.set(name, lobbyId);
  }

  /** Where a player says he lives, from his lobby-server login. */
  livesAt(name: string, address: string): void {
    if (name && address) this.addresses.set(name, address);
  }

  address(name: string): string {
    return this.addresses.get(name) ?? '127.0.0.1';
  }

  leave(name: string): void {
    this.lobbyOf.delete(name);
  }

  inLobby(lobbyId: number): string[] {
    return [...this.lobbyOf.entries()].filter(([, id]) => id === lobbyId).map(([name]) => name);
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
export function roomEntry(room: Room): GSValue[] {
  return [
    String(room.type),
    room.name,
    String(room.id),
    '1',
    String(room.parentId),
    String(Lsm.ALLINFO | (room.password ? Lsm.PRIVATE : 0)),
    '1',
    room.master,
    '',
    '',
    room.info,
    String(room.eventId),
    String(room.maxPlayers),
    String(room.members.length),
    String(room.maxVisitors),
    '0',
    room.gameVersion,
    room.gsVersion,
    room.address,
    room.altAddress,
  ];
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
export function playerInfo(name: string, rating: number, address = '127.0.0.1', gamePort = 8888): Uint8Array {
  const octets = address.split('.').map(Number);
  // The client writes the mirrored address in the order the NAT answer arrived in —
  // its own log calls 127.0.0.1 "1.0.0.127" — and the LAN one in the natural order.
  // Two orders in one document is not a mistake to fix; it is what it does.
  const mirrored = Buffer.from([...octets].reverse());
  const local = Buffer.from(octets);

  const sockaddr = Buffer.alloc(16);
  sockaddr.writeUInt16LE(2, 0); // AF_INET
  sockaddr.writeUInt16BE(40010, 2); // the NAT mirror's own port, as he reports it
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

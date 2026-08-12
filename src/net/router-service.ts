// The router — the TCP door every online session comes through.
//
// It is the GS front desk: key exchange, then a login, then a hand-off to the
// next service. Nothing about a game happens here; what happens is that the
// client stops being anonymous and gets told where to go. The order, as the
// client drives it:
//
//   KEY_EXCHANGE "1"   here is my RSA public key   -> here is ours
//   KEY_EXCHANGE "2"   here is a Blowfish key      -> and here is ours
//   LOGIN              here is a username          -> GSSUCCESS
//   JOINWAITMODULE     where do I go now           -> an address and a port
//   STILLALIVE         keep-alive                     (no answer)
//
// Accounts are ours to define: the client shows a name and a password, and what
// they mean is a decision on this side. For now every name is accepted, which is
// the smallest thing that lets the session continue — `docs/NETWORK.md` says
// what registration will look like when there is somewhere to keep it.
//
// Messages arrive over a TCP stream and can be bundled, so a session buffers and
// walks whole messages by their size field.
//
// Exports:
//   RouterService     new(waitModule) -> session(); session.receive(buf) -> Buffer[]

import { hostU32String } from './address.ts';
import { Ladder, ladderRow } from './ladder.ts';
import {
  DEFAULT_LOBBIES,
  GroupType,
  LobbyMsg,
  Lsm,
  PlayerStatus,
  RoomUpdate,
  Rooms,
  lobbyEntry,
  memberEntry,
  roomEntry,
  stampRoomIds,
  type Room,
} from './lobby.ts';
import { HEADER_SIZE as GS_HEADER_SIZE, MessageType, build, parse, reply, type GSMessage } from './gs-message.ts';
import { decodeBody, type GSValue } from './gs-data.ts';
import { Blowfish } from './blowfish.ts';
import { decryptWith, generateKeyPair, parsePublicKey, publicKeyBlob, encryptTo, type RsaKeyPair, type RsaPublicKey } from './pkc.ts';
import { randomBytes } from 'node:crypto';

/** Where the client is sent after it logs in. */
export interface Endpoint {
  address: string;
  port: number;
}

/**
 * Which desk this connection is.
 *
 * The same protocol serves four of them — the router, its wait module, the proxy
 * a module lives behind, and the proxy's own wait module — and the client opens a
 * fresh connection, with a fresh key exchange, for each. Only a few answers
 * differ, and every difference below is one the client insisted on.
 */
export type Role = 'router' | 'proxy' | 'lobby';

export interface RouterEvent {
  note: string;
  replies: Buffer[];
}

/** The id we hand out for a proxy module; the client echoes it back to release it. */
const PROXY_ID = '1';

/**
 * The ladder query's request number, 0x501.
 *
 * The exe pushes it beside the literal "ladderquery" in one call to the request
 * builder (0x42BC92), and there is no other number of its kind: 0x500 and
 * 0x502…0x510 appear nowhere. One request, one answer to write.
 */
const LADDER_QUERY = 1281;

/**
 * Where a player's address and port come from, when the time comes.
 *
 * Not from us: the blob inside a member record is the player's own, sent in
 * SET_PLAYER_INFO, and we pass it along untouched. Composing one ourselves put an
 * unreadable member in the room (the parser is at 0xDFE850 if its layout is ever
 * needed). What we do know unaided is the port his NAT pings come from — 8888,
 * visible in the log as `UDP NATServer:40010 <- 127.0.0.1:8888` — and that is the
 * fallback to reach for when two peers first fail to find each other.
 */

/** A one-byte body value, which is how GS names the message being answered. */
function messageId(type: number): GSValue {
  return new Uint8Array([type & 0xff]);
}

/** A little-endian u32 body value — how a port travels. */
function u32(value: number): GSValue {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return new Uint8Array(out);
}

export class RouterSession {
  private buffer = Buffer.alloc(0);
  private keys: RsaKeyPair | null = null;
  private clientKey: RsaPublicKey | null = null;
  /** The session key the client sent us, and its cipher. */
  clientBlowfishKey: Buffer | null = null;
  private clientCipher: Blowfish | null = null;
  /** The one we generated and sent back. */
  serverBlowfishKey: Buffer | null = null;
  private serverCipher: Blowfish | null = null;
  /** Which of the two turned out to open the client's bodies. */
  encryptedWith: string | null = null;
  username = '';
  /** The game the client logged into the lobby with, e.g. `HEROES_…`. */
  gameId = '';
  /**
   * The address the client says it has, from its lobby-server login: its own LAN
   * address and netmask. This is the raw material for introducing two peers —
   * the lobby is what tells one player where the other is.
   */
  localAddress = '';
  localNetmask = '';
  /**
   * What the player last told us about himself in SET_PLAYER_INFO.
   *
   * His own record beats the one we build for him: it is where he says he can be
   * reached, and it goes out to everybody else in the room as he wrote it.
   */
  playerInfo: Uint8Array | null = null;

  private readonly role: Role;
  private readonly waitModule: Endpoint;
  private readonly proxy: Endpoint;
  private readonly lobbyServer: Endpoint;
  /** Shared with every other connection: a room one player hosts, others join. */
  private readonly rooms: Rooms;
  /** Also shared: the ratings, which outlive every connection. */
  private readonly ladder: Ladder;

  constructor(role: Role, waitModule: Endpoint, proxy: Endpoint, lobbyServer: Endpoint, rooms: Rooms, ladder: Ladder) {
    this.role = role;
    this.waitModule = waitModule;
    this.proxy = proxy;
    this.lobbyServer = lobbyServer;
    this.rooms = rooms;
    this.ladder = ladder;
  }

  /**
   * The connection is gone.
   *
   * A game whose host has left is not a game, and a lobby that keeps it hands the
   * next player a name that is already taken — which is exactly what the client
   * said when it refused to create one: "a game with this name already exists",
   * about a host who had closed the game minutes before.
   */
  close(): string | null {
    const gone = this.rooms.hostedBy(this.username);
    if (!gone.length) return null;
    for (const room of gone) this.rooms.remove(room.id);
    return `${this.username} left — dropped ${gone.map((room) => `"${room.name}"`).join(', ')}`;
  }

  /** Feed bytes from the socket; get back what to send, and a line for the log. */
  receive(chunk: Buffer): RouterEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: RouterEvent[] = [];
    for (;;) {
      // The size field is read first and the bytes are taken off the buffer
      // BEFORE anything can go wrong with them. A message we cannot understand
      // must not be left at the front of the stream: that stalls the connection
      // for good, which is exactly what happened on 12.08.2026 to the first
      // encrypted login we saw.
      if (this.buffer.length < GS_HEADER_SIZE) break;
      const size = (this.buffer[0]! << 16) | (this.buffer[1]! << 8) | this.buffer[2]!;
      if (size < GS_HEADER_SIZE) {
        this.buffer = Buffer.alloc(0);
        events.push({ note: `a message claiming ${size} bytes cannot be one — stream dropped`, replies: [] });
        break;
      }
      if (this.buffer.length < size) break;
      const bytes = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      try {
        const message = parse(bytes, this.decryptBody);
        events.push(message ? this.handle(message) : { note: `${size} bytes did not parse`, replies: [] });
      } catch (err) {
        events.push({ note: `${size} bytes could not be read: ${(err as Error).message}`, replies: [] });
      }
    }
    return events;
  }

  /**
   * Open an encrypted body.
   *
   * Which of the two session keys the client encrypts with is a thing to be
   * measured, not assumed, so both are tried and the one that yields a body we
   * can decode is remembered and reported. A wrong key gives noise, and noise
   * does not decode as a list — that is what makes the trial safe.
   */
  private readonly decryptBody = (body: Buffer): Buffer => {
    const candidates: Array<[string, Blowfish | null]> = [
      ['the key we sent', this.serverCipher],
      ['the key the client sent', this.clientCipher],
    ];
    for (const [name, cipher] of candidates) {
      if (!cipher) continue;
      try {
        const plain = cipher.decrypt(body);
        decodeBody(plain);
        this.encryptedWith = name;
        return plain;
      } catch {
        // Wrong key, or not this one. Try the other.
      }
    }
    throw new Error('neither session key opens this body');
  };

  /**
   * The channels, as child groups of the one group the client is in.
   *
   * The flag asks the client to come back for their children — the rooms —
   * which is how a channel with games in it gets a game list.
   */
  /**
   * The room's members, as records the client can read.
   *
   * Only this connection's own player info is known here, so it is used for him and
   * reconstructed for everybody else. With two players in a room each connection has
   * the other's — that is the next thing this has to grow.
   */
  private membersOf(room: Room): GSValue[] {
    return room.members.map((name) =>
      memberEntry(
        name,
        room.id,
        room.address,
        PlayerStatus.GAMECONNECTED,
        name === this.username ? (this.playerInfo ?? undefined) : undefined,
      ),
    );
  }

  private lobbyList(message: GSMessage): Buffer {
    const lobbies = DEFAULT_LOBBIES.map((lobby) => lobbyEntry(lobby, this.gameId));
    return build(reply(message, [String(LobbyMsg.GROUP_INFO), ['1', String(Lsm.CHILDGROUPINFO), ['0'], lobbies]]));
  }

  private handle(message: GSMessage): RouterEvent {
    switch (message.type) {
      case MessageType.KEY_EXCHANGE:
        return this.keyExchange(message);
      case MessageType.LOGIN: {
        const name = message.body?.[0];
        this.username = typeof name === 'string' ? name : '';
        const body: GSValue[] = this.role === 'proxy' ? [messageId(MessageType.LOGIN), []] : [messageId(MessageType.LOGIN)];
        return {
          note: `LOGIN as "${this.username}" on the ${this.role}${this.encryptedWith ? `, body opened with ${this.encryptedWith}` : ''}`,
          replies: [build(reply(message, body, MessageType.GSSUCCESS))],
        };
      }
      case MessageType.JOINWAITMODULE: {
        // A decimal u32 in HOST order. Both other forms were tried and watched:
        // dotted sent the client to 0.0.0.127, and inet_addr's number sent it to
        // 1.0.0.127. See src/net/address.ts.
        const where = hostU32String(this.waitModule.address);
        // The proxy's own hand-off carries the user and spells the port out;
        // the router's carries four raw bytes. Both come from the client.
        const inner: GSValue[] =
          this.role === 'proxy'
            ? [this.username, where, String(this.waitModule.port)]
            : [where, u32(this.waitModule.port)];
        return {
          note: `JOINWAITMODULE on the ${this.role} — sent to ${this.waitModule.address}:${this.waitModule.port} (as ${where})`,
          replies: [build(reply(message, [messageId(MessageType.JOINWAITMODULE), inner], MessageType.GSSUCCESS))],
        };
      }
      // Once the client is told where to go it opens a SECOND connection — the
      // "wait module" — and speaks the same protocol on it, key exchange and all.
      // The same desk answers both; only the address it was given differs.
      case MessageType.LOGINWAITMODULE: {
        const name = message.body?.[0];
        if (typeof name === 'string' && name) this.username = name;
        const body: GSValue[] =
          this.role === 'proxy' ? [messageId(MessageType.LOGINWAITMODULE), []] : [messageId(MessageType.LOGINWAITMODULE)];
        return {
          note: `LOGINWAITMODULE as "${this.username}" on the ${this.role} — accepted`,
          replies: [build(reply(message, body, MessageType.GSSUCCESS))],
        };
      }
      case MessageType.LOGINFRIENDS:
        return {
          note: 'LOGINFRIENDS — accepted',
          replies: [build(reply(message, [messageId(MessageType.LOGINFRIENDS)], MessageType.GSSUCCESS))],
        };
      case MessageType.PLAYERINFO: {
        // Seven fields; only the first two are known to be the nickname and the
        // real name, and nothing so far has needed the rest.
        const player: GSValue[] = [this.username, this.username, '', '', '', '', ''];
        return {
          note: `PLAYERINFO for "${this.username}"`,
          replies: [build(reply(message, [messageId(MessageType.PLAYERINFO), player], MessageType.GSSUCCESS))],
        };
      }
      // "Where does module X live?" The client asks for `persistantdata` first
      // (its own spelling) and `ladderquery` when it wants a rating — both are
      // served by one proxy, which is where our stats and ladder will go.
      case MessageType.PROXY_HANDLER: {
        const subtype = message.body?.[0];
        if (Array.isArray(subtype)) return { note: 'PROXY_HANDLER notification — nothing to answer', replies: [] };
        const inner = message.body?.[1];
        const module = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '';
        if (subtype === '1') {
          if (module !== 'persistantdata' && module !== 'ladderquery') {
            return { note: `PROXY_HANDLER for unknown module "${module}" — nothing sent`, replies: [] };
          }
          const where = [[PROXY_ID, hostU32String(this.proxy.address), String(this.proxy.port)]];
          return {
            note: `PROXY_HANDLER — "${module}" is at ${this.proxy.address}:${this.proxy.port}`,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [module, '0', '0', where]]])),
            ],
          };
        }
        if (subtype === '2') {
          const moduleId = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '0';
          return {
            note: `PROXY_HANDLER — module ${moduleId} released`,
            replies: [build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [moduleId]]]))],
          };
        }
        // The ladder query — 0x501, and the only request number of its kind in the
        // exe. It arrives on the proxy's own wait module right after the player
        // enters a channel, and while it goes unanswered he waits out 30 seconds and
        // the client writes "Failed to get Ladder row for myself, setting N/A".
        //
        // The body nests: [ "1281", requestId, [ count, [ "1", game, "1", "0",
        // [ count, [ user, "1" ] ], [ [], [], [] ] ] ] ] — the user in there is the
        // pivot the client asked about (`LadderQuery_RequestPivotUser`), and the three
        // empty lists are where named keys would go if it wanted only some of them.
        //
        // The reply's first field is read as a BYTE and compared against 0x26 — 38,
        // GSSUCCESS (`cmp byte ptr [esi+0Ch],26h` at 0xE0BC78). The row layout is our
        // best reading, and the client says which way it went in one line:
        // "LadderQuery_StartResultEntryEnumeration(…) succeeded" or "ladder query
        // request failed,reason=…".
        if (subtype === String(LADDER_QUERY)) {
          // Three fields at the top, not two: the number, the id, and the query — so
          // the query is body[2] and `inner` (body[1]) is the id itself.
          const requestId = typeof message.body?.[1] === 'string' ? message.body[1] : '1';
          const container = message.body?.[2];
          const query = Array.isArray(container) ? container[1] : undefined;
          const pivotList = Array.isArray(query) ? query[4] : undefined;
          const pivotEntry = Array.isArray(pivotList) ? pivotList[1] : undefined;
          const pivot = Array.isArray(pivotEntry) && typeof pivotEntry[0] === 'string' ? pivotEntry[0] : this.username;
          const stats = this.ladder.row(pivot);
          // The shape of the answer, one variant per run, because the client says
          // nothing at all when it does not recognise one — no reply line, no reason:
          //
          //   ["38", ["1281", [requestId, "", [row]]]]        -> silence
          //   ["38", ["1281", requestId, ["1", row]]]         -> this one
          //
          // The second follows the rule the ONE working exchange of this type obeys:
          // the reply echoes the whole request inside a single list and appends the
          // answer. And a count in front of the items is how the client's own bodies
          // are built — the query itself arrived as ["1", <the one query>].
          return {
            note: `LADDER query ${requestId} about "${pivot}" — rating ${stats['RATING']}, ${stats['GAMES_PLAYED']} game(s)`,
            replies: [
              build(
                reply(message, [
                  String(MessageType.GSSUCCESS),
                  [String(LADDER_QUERY), requestId, ['1', ladderRow(pivot, stats)]],
                ]),
              ),
            ],
          };
        }
        return { note: `PROXY_HANDLER subtype ${String(subtype)} is not implemented`, replies: [] };
      }
      // The lobby server's own hello. The client introduces itself by name and
      // tells us where it lives on its network — which is the material a lobby
      // needs later, when it has to point one player at another.
      case MessageType.LOBBYSERVERLOGIN: {
        const name = message.body?.[0];
        const serverId = message.body?.[1];
        if (typeof name === 'string' && name) this.username = name;
        if (typeof message.body?.[2] === 'string') this.localAddress = message.body[2];
        if (typeof message.body?.[3] === 'string') this.localNetmask = message.body[3];
        return {
          note: `LOBBYSERVERLOGIN "${this.username}" on server ${String(serverId)}, from ${this.localAddress}/${this.localNetmask}`,
          replies: [
            build(
              reply(
                message,
                [String(MessageType.LOBBYSERVERLOGIN), [typeof serverId === 'string' ? serverId : '1']],
                MessageType.GSSUCCESS,
              ),
            ),
          ],
        };
      }
      // The lobby, as far as the wait module is concerned: log in, hand over the
      // list of lobbies, and say where the lobby server itself lives.
      case MessageType.LOBBY_MSG: {
        const subtype = message.body?.[0];
        const inner = message.body?.[1];
        if (subtype === String(LobbyMsg.LOGIN)) {
          this.gameId = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '';
          // The channel list is PUSHED, not asked for. Measured: after this login
          // was answered the client said nothing more and drew an empty channel
          // screen — and its receive side is full of handlers for arriving groups
          // (`ProcessNewLobby`, "new lobby \"…\"", `ProcessLobbyInfo`). So the
          // success goes out with the lobbies right behind it.
          return {
            note: `lobby LOGIN for game "${this.gameId}" — accepted, ${DEFAULT_LOBBIES.length} channels pushed`,
            replies: [build(reply(message, [String(MessageType.GSSUCCESS), [subtype]])), this.lobbyList(message)],
          };
        }
        if (subtype === String(LobbyMsg.CHANGE_REQUESTED_LOBBIES)) {
          return {
            note: `lobby list — ${DEFAULT_LOBBIES.map((l) => l.name).join(', ')}`,
            replies: [this.lobbyList(message)],
          };
        }
        // Entering a channel. The client wants to know it is in, and then what is
        // inside — the rooms. There are none yet, so what follows is an honest
        // empty channel rather than nothing at all.
        if (subtype === String(LobbyMsg.JOIN_LOBBY)) {
          const fields = Array.isArray(inner) ? inner : [];
          const groupId = typeof fields[0] === 'string' ? fields[0] : '1';
          // The channel is entered with its own mask — 384 here, members and child
          // groups but not the channel's own info — and it is echoed for the same
          // reason a room's is: the mask says what the rest of the message contains.
          const asked = Number(typeof fields[3] === 'string' ? fields[3] : '') || Lsm.CHILDGROUPINFO;
          const lobby = DEFAULT_LOBBIES.find((l) => String(l.id) === groupId) ?? DEFAULT_LOBBIES[0]!;
          const rooms = this.rooms.inLobby(lobby.id).map(roomEntry);
          return {
            note: `JOIN_LOBBY ${groupId} ("${lobby.name}") — in, ${rooms.length} game(s) listed, mask ${asked}`,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [groupId]]])),
              build(
                reply(message, [
                  String(LobbyMsg.GROUP_INFO),
                  [groupId, String(asked), lobbyEntry(lobby, this.gameId), rooms, []],
                ]),
              ),
            ],
          };
        }
        // Hosting a game. Everything about it comes from the client: the name it
        // composed, the map and rules in one blob, how many may join. We give it
        // an id and put it in the channel it was created in.
        if (subtype === String(LobbyMsg.CREATE_ROOM)) {
          const fields = Array.isArray(inner) ? inner : [];
          const text = (at: number): string => (typeof fields[at] === 'string' ? (fields[at] as string) : '');
          // The client refuses a game whose name is already in its list — "a game
          // with this name already exists" — and the name it offers is generated
          // from the player's own, so pressing create twice collides with itself.
          // A host recreating his own game replaces it; nothing else is touched.
          const parentId = Number(text(0)) || 1;
          const existing = this.rooms.named(parentId, text(1));
          if (existing && existing.master === this.username) this.rooms.remove(existing.id);
          const blob = fields[6] instanceof Uint8Array ? fields[6] : new Uint8Array(0);
          const room = this.rooms.create({
            parentId,
            name: text(1),
            gameTitle: text(2),
            type: Number(text(3)) || GroupType.ROOM_UBI_P2P,
            maxPlayers: Number(text(4)) || 2,
            maxVisitors: Number(text(5)) || 0,
            password: text(7),
            info: blob,
            gameVersion: text(8),
            gsVersion: text(9),
            altInfo: fields[10] instanceof Uint8Array ? (fields[10] as Uint8Array) : new Uint8Array(0),
            // The mode is the channel's, not the host's: a game made in "Ranked" is
            // rated because of where it is.
            eventId: DEFAULT_LOBBIES.find((l) => l.id === parentId)?.mode ?? 0,
            address: this.localAddress || '127.0.0.1',
            altAddress: this.localAddress || '127.0.0.1',
            master: this.username,
            members: [this.username],
          });
          // The host composed his description of the game before the room existed, so
          // both id fields inside it say -1. Writing them is the server's job, and
          // the client reads them back to recognise the room it just made.
          room.info = stampRoomIds(blob, room.id);
          return {
            note: `CREATE_ROOM "${room.name}" in channel ${room.parentId} — id ${room.id}, up to ${room.maxPlayers} players`,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(room.id), room.name, '1']]])),
              // And the room itself, so the channel it lives in shows it.
              build(reply(message, [String(LobbyMsg.NEW_GROUP), [roomEntry(room)]])),
            ],
          };
        }
        // Entering a room. The reply only says "yes"; what actually puts the room in
        // the client's own list is the GROUP_INFO, and it has to come back with **the
        // mask the client asked with** — field 2 of the request, 448, all three "tell
        // me about it" bits.
        //
        // **The room info goes FIRST and the "yes" second**, which is not a style
        // choice. The client dispatches in arrival order: given the reply first it
        // runs `ProcessJoinRoomReply` while its own list is still empty, says "join
        // room succeeded" and then "join room failed, no such room in internal list",
        // and only afterwards does `ProcessRoomInfo` insert the room — measured, in
        // that order, in the game's own log.
        if (subtype === String(LobbyMsg.JOIN_ROOM)) {
          const fields = Array.isArray(inner) ? inner : [];
          const roomId = Number(typeof fields[0] === 'string' ? fields[0] : '0');
          const asked = Number(typeof fields[2] === 'string' ? fields[2] : '') || Lsm.ALLINFO;
          const room = this.rooms.get(roomId);
          if (!room) return { note: `JOIN_ROOM ${roomId} — no such room`, replies: [] };
          if (!room.members.includes(this.username)) room.members.push(this.username);
          const members = this.membersOf(room);
          return {
            note: `JOIN_ROOM ${roomId} ("${room.name}") — in, ${room.members.length} of ${room.maxPlayers}, mask ${asked}`,
            replies: [
              build(
                reply(message, [String(LobbyMsg.GROUP_INFO), [String(roomId), String(asked), roomEntry(room), [], members]]),
              ),
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(roomId)]]])),
            ],
          };
        }
        // The player's own record: name, address, and a blob he composes himself.
        // He waits for a reply to this ("set OWN player info sent, waiting reply"),
        // so silence here is another 30 seconds. The blob is kept and used in his
        // member record from then on, which is better than the one we synthesise —
        // it is his own account of where he can be reached.
        if (subtype === String(LobbyMsg.SET_PLAYER_INFO)) {
          const fields = Array.isArray(inner) ? inner : [];
          const blob = fields.find((field): field is Uint8Array => field instanceof Uint8Array);
          if (blob) this.playerInfo = blob;
          const said = fields.map((field) => (field instanceof Uint8Array ? `<${field.length} bytes>` : JSON.stringify(field)));
          return {
            // The reply's shape is the one every other lobby answer has — result,
            // subtype, the first field back. Not yet confirmed by the client's own
            // log line for it; `LobbyRcv_SetPlayerInfoReply` will say.
            note: `SET_PLAYER_INFO — ${said.join(', ')}`,
            replies: [
              build(
                reply(message, [
                  String(MessageType.GSSUCCESS),
                  [subtype, [typeof fields[0] === 'string' ? fields[0] : '0']],
                ]),
              ),
            ],
          };
        }
        // The host changing his game's settings from inside the room: the flags say
        // which fields follow, in this order. Answered, and then the room is sent
        // back out so everybody in it sees the new map or the new player count.
        if (subtype === String(LobbyMsg.GROUP_CONFIG_UPDATE_RES)) {
          const fields = Array.isArray(inner) ? inner : [];
          const roomId = Number(typeof fields[0] === 'string' ? fields[0] : '0');
          const flags = Number(typeof fields[1] === 'string' ? fields[1] : '0');
          const room = this.rooms.get(roomId);
          if (!room) return { note: `GROUP_CONFIG_UPDATE_RES ${roomId} — no such room`, replies: [] };
          const changed: string[] = [];
          let at = 2;
          const next = (): GSValue | undefined => fields[at++];
          // Dedicated-server flags come first when all three of them are set; this
          // game never hosts that way, but the field still has to be stepped over.
          if ((flags & RoomUpdate.DS_FLAGS) === RoomUpdate.DS_FLAGS) next();
          if (flags & RoomUpdate.MAX_PLAYERS) {
            const value = Number(next());
            if (value) {
              room.maxPlayers = value;
              changed.push(`up to ${value} players`);
            }
          }
          if (flags & RoomUpdate.MAX_VISITORS) {
            room.maxVisitors = Number(next()) || 0;
            changed.push(`${room.maxVisitors} visitors`);
          }
          if (flags & RoomUpdate.PASSWORD) {
            const value = next();
            room.password = typeof value === 'string' ? value : '';
            changed.push(room.password ? 'a password' : 'no password');
          }
          if (flags & RoomUpdate.GROUP_INFO) {
            const value = next();
            // Sent from inside the room, the blob knows the ids already — unlike the
            // one that came with CREATE_ROOM. It is kept exactly as sent.
            if (value instanceof Uint8Array) {
              room.info = value;
              changed.push(`${value.length} bytes of settings`);
            }
          }
          if (flags & RoomUpdate.ALT_GROUP_INFO) {
            const value = next();
            if (value instanceof Uint8Array) room.altInfo = value;
          }
          return {
            note: `GROUP_CONFIG_UPDATE_RES ${roomId} — ${changed.length ? changed.join(', ') : `nothing we read (flags ${flags})`}`,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(roomId)]]])),
              // The room back out, **without its members**. The settings changed, the
              // membership did not — and a member list here is read as somebody
              // arriving, which the client answers with another settings update, which
              // we answer with another member list. That loop spammed "somebody joined"
              // several times a second until the room was closed.
              build(
                reply(message, [
                  String(LobbyMsg.GROUP_INFO),
                  [String(roomId), String(Lsm.GROUPINFO | Lsm.CHILDGROUPINFO), roomEntry(room), [], []],
                ]),
              ),
            ],
          };
        }
        // He tells us he is connected to his own game. Nothing to answer.
        if (subtype === String(LobbyMsg.GAME_CONNECTED)) {
          const groupId = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '?';
          return { note: `GAME_CONNECTED for ${groupId} — noted`, replies: [] };
        }
        // Leaving a group. A host who leaves takes his game with him, which is the
        // other half of why a name could stay taken by nobody.
        if (subtype === String(LobbyMsg.GROUP_LEAVE)) {
          const groupId = Number(Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '0');
          const room = this.rooms.get(groupId);
          let note = `GROUP_LEAVE ${groupId}`;
          if (room) {
            room.members = room.members.filter((name) => name !== this.username);
            if (room.master === this.username) {
              this.rooms.remove(room.id);
              note = `GROUP_LEAVE ${groupId} — the host left, "${room.name}" is gone`;
            } else {
              note = `GROUP_LEAVE ${groupId} — ${this.username} left "${room.name}"`;
            }
          } else {
            // The id is a LOBBY, and this is the message a host actually sends when
            // he abandons a game he has just made. Measured 12.08.2026: create room
            // 100, join it, then `GROUP_LEAVE 1` — the channel — and never a leave
            // for the room. The room stayed behind, the channel listed it, and the
            // client then refused to create another with "a game with this name
            // already exists" without sending us anything at all. A host outside
            // the channel is a host outside his own game.
            const gone = this.rooms.hostedBy(this.username).filter((r) => r.parentId === groupId);
            for (const r of gone) this.rooms.remove(r.id);
            if (gone.length) {
              note = `GROUP_LEAVE ${groupId} — the host left the channel, ${gone
                .map((r) => `"${r.name}"`)
                .join(', ')} gone`;
            }
          }
          return {
            note,
            replies: [build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(groupId)]]]))],
          };
        }
        if (subtype === String(LobbyMsg.GROUP_INFO_GET)) {
          const groupId = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '1';
          return {
            note: `GROUP_INFO_GET for ${groupId}`,
            replies: [build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [groupId, '0']]]))],
          };
        }
        if (subtype === String(LobbyMsg.JOIN_SERVER)) {
          const serverId = Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0] : '1';
          const where = hostU32String(this.lobbyServer.address);
          return {
            note: `lobby server ${serverId} — sent to ${this.lobbyServer.address}:${this.lobbyServer.port}`,
            replies: [
              build(
                reply(message, [
                  String(MessageType.GSSUCCESS),
                  [subtype, [serverId, where, String(this.lobbyServer.port)]],
                ]),
              ),
            ],
          };
        }
        return { note: `lobby message subtype ${String(subtype)} is not implemented`, replies: [] };
      }
      case MessageType.STILLALIVE:
        return { note: 'STILLALIVE', replies: [] };
      default:
        return { note: `no handler for message type ${message.type} — nothing sent`, replies: [] };
    }
  }

  private keyExchange(message: GSMessage): RouterEvent {
    const step = message.body?.[0];
    const payload = message.body?.[1];
    const blob = Array.isArray(payload) ? payload[2] : undefined;

    if (step === '1') {
      if (!(blob instanceof Uint8Array)) return { note: 'KEY_EXCHANGE 1 without a key blob — ignored', replies: [] };
      this.clientKey = parsePublicKey(blob);
      this.keys = generateKeyPair();
      const ours = publicKeyBlob(this.keys.publicKey);
      return {
        note: `KEY_EXCHANGE 1 — client key ${this.clientKey.bits} bits, exponent ${this.clientKey.exponent}; ours sent`,
        replies: [build(reply(message, ['1', ['1', String(ours.length), new Uint8Array(ours)]]))],
      };
    }

    if (step === '2') {
      if (!(blob instanceof Uint8Array) || !this.keys || !this.clientKey) {
        return { note: 'KEY_EXCHANGE 2 out of order — ignored', replies: [] };
      }
      this.clientBlowfishKey = decryptWith(this.keys.privateKey, blob);
      this.clientCipher = new Blowfish(this.clientBlowfishKey);
      this.serverBlowfishKey = randomBytes(16);
      this.serverCipher = new Blowfish(this.serverBlowfishKey);
      const encrypted = encryptTo(this.clientKey, this.serverBlowfishKey);
      return {
        note: `KEY_EXCHANGE 2 — client session key ${this.clientBlowfishKey.length} bytes; ours sent`,
        replies: [build(reply(message, ['2', ['1', String(encrypted.length), new Uint8Array(encrypted)]]))],
      };
    }

    return { note: `KEY_EXCHANGE step ${String(step)} is not implemented`, replies: [] };
  }
}

export class RouterService {
  private readonly waitModule: Endpoint;
  private readonly proxy: Endpoint;
  private readonly proxyWaitModule: Endpoint;
  private readonly lobbyServer: Endpoint;
  private readonly rooms = new Rooms();
  /** Shared by every desk, because a rating belongs to the player, not the socket. */
  readonly ladder: Ladder;

  constructor(waitModule: Endpoint, proxy: Endpoint, proxyWaitModule: Endpoint, lobbyServer: Endpoint, ladderFile = 'data/ladder.json') {
    this.waitModule = waitModule;
    this.proxy = proxy;
    this.proxyWaitModule = proxyWaitModule;
    this.lobbyServer = lobbyServer;
    this.ladder = new Ladder(ladderFile);
  }

  /** A connection on one of the four desks. */
  session(role: Role = 'router'): RouterSession {
    const waitModule = role === 'proxy' ? this.proxyWaitModule : this.waitModule;
    return new RouterSession(role, waitModule, this.proxy, this.lobbyServer, this.rooms, this.ladder);
  }
}

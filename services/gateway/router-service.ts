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
//   STILLALIVE         keep-alive, every 31s        -> the same six bytes back
//
// Accounts are ours to define: the client shows a name and a password, and what
// they mean is a decision on this side. The first login of a name CREATES it, with
// the password that came with it, and every login after that is checked against it —
// `services/core/rules/accounts.ts`, kept in the one database (`services/core/rules/database.ts`).
//
// Messages arrive over a TCP stream and can be bundled, so a session buffers and
// walks whole messages by their size field.
//
// Exports:
//   RouterService     new(waitModule) -> session(); session.receive(buf) -> Buffer[]

import { hostU32String } from './address.ts';
import { Accounts, type LoginVerdict } from '../core/rules/accounts.ts';
import { openDatabase } from '../core/rules/database.ts';
import { Friends, type FriendState } from '../core/rules/friends.ts';
import { Ladder, STARTING_RATING, settleMatch } from '../core/rules/ladder.ts';
import { GET_DATA, PersistentStore, SET_DATA, recordKeyOf } from '../core/rules/profiles.ts';
import { friendUpdate, ladderPayload, matchResult } from './rules-wire.ts';
import { DEFAULT_LOBBIES, GameMode } from '../../shared/channels.ts';
import {
  GroupType,
  LobbyMsg,
  Lsm,
  Matches,
  PlayerStatus,
  Presence,
  RoomUpdate,
  Rooms,
  gameStartedEntry,
  lobbyEntry,
  matchStartedEntry,
  memberEntry,
  playerInfo,
  probePeerAddress,
  roomEntry,
  withRating,
  stampRoomIds,
  type Room,
} from './lobby.ts';
import { HEADER_SIZE as GS_HEADER_SIZE, MessageType, Property, build, moduleFailureBody, moduleReplyBody, parse, reply, type GSMessage } from './gs-message.ts';
import { decodeBody, type GSValue } from './gs-data.ts';
import { writeFields } from './structure.ts';
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
 * SET_PLAYER_INFO, and we pass it along untouched. Its format is known now
 * (`playerInfo`, and the reader at 0xdfea70), but his own words are still the
 * ones to forward. What we know unaided is the port his NAT pings come from —
 * 8888, visible in the log as `UDP NATServer:40010 <- 127.0.0.1:8888` — and that
 * is the fallback to reach for when two peers first fail to find each other.
 */

/** A one-byte body value, which is how GS names the message being answered. */
function messageId(type: number): GSValue {
  return new Uint8Array([type & 0xff]);
}

/**
 * A body as one line of log — what arrived, not merely which subtype it was.
 *
 * Every unanswered subtype is work that is left, and each one has to be read off a
 * log before it can be written. START_GAME arrived as thirteen encrypted bytes and
 * the note said only "subtype 15 is not implemented": the fields it carries — the
 * room id among them — were on the wire, decrypted, in hand, and thrown away. A
 * launch of the game is expensive; printing what we already parsed is free.
 */
function said(value: GSValue | undefined): string {
  if (value === undefined) return '-';
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return `[${value.map(said).join(' ')}]`;
  return JSON.stringify(value);
}

/**
 * A message to send somebody who did not ask for one.
 *
 * Everything here is built with `reply`, which takes its parties and its priority from
 * the request being answered — and a push has no request. The nibbles are not a choice:
 * every lobby message the client sends carries sender 4, receiver 1, and every answer
 * goes back 1 to 4, so this is what its own traffic looks like with the request taken
 * out of it. `reply` swaps them, hence 4 and 1 here.
 */
const UNASKED: GSMessage = {
  size: 0,
  property: Property.GS,
  priority: 0,
  type: MessageType.LOBBY_MSG,
  sender: 4,
  receiver: 1,
  body: null,
};

/**
 * The guest: a second player who is always there, and the only way to exercise half
 * of this server without a second copy of the game.
 *
 * Everything a lone host can do, he does — but the things that need somebody ELSE are
 * exactly the ones still unproven: a profile read about another player, adding a name
 * to the friends list, a ladder row that is not one's own. So one player is seated by
 * the server itself. He is not a ghost (`--ghosts` seats three of those to see what
 * the panel draws of a player with no data): he has a name, a player-info blob, a
 * ladder row with games in it, and he sits in the Ranked channel.
 *
 * What he cannot do is answer. He never joins a room and nothing starts a game against
 * him — that still needs the second client, and nothing here pretends otherwise.
 */
export const GUEST = 'Guest';

/**
 * And he sits in ONE channel: Ranked.
 *
 * He used to follow whoever entered a channel into it, which reads well until two
 * players are in two channels — `Presence` keeps one channel per name, so "follow"
 * means "leave the other one", and a guest who teleports is worse than a guest who
 * is somewhere. Ranked is where a rating means anything, which is what he is for.
 */
export const GUEST_LOBBY = 2;

/**
 * His ladder row, once, with numbers that could not be a default.
 *
 * A row of zeroes proves nothing when the question is "did the client read the row at
 * all" — 6 wins out of 10 is visible on the screen and unmistakably ours.
 */
function seatGuest(ladder: Ladder, presence: Presence): void {
  ladder.seed(GUEST, {
    RATING: 1560,
    GAMES_PLAYED: 10,
    WINS: 6,
    LOSSES: 4,
    MAX_WINS_STREAK: 3,
    CUR_WINS_STREAK: 1,
    W_HEAVEN: 4,
    L_HEAVEN: 2,
    W_ORCS: 2,
    L_ORCS: 2,
    AVERAGE_HERO_LEVEL: 12,
  });
  presence.remember(GUEST, playerInfo(GUEST, ladder.row(GUEST)['RATING'] ?? 0));
  presence.enter(GUEST, GUEST_LOBBY);
}

/**
 * The record handed to a player who has none — which, so far, is every player.
 *
 * A document of the shape everything the game serialises begins with: a four-byte kind
 * under tag 4, and an empty container under tag 1. What the profile's own tags are is
 * unknown — this exists to break the loop where the client will not write a profile
 * because reading one failed. It was `--seed-profile`, an experiment, until the run of
 * 13.08.2026 showed the loop from the other side: a refusal is a profile screen that
 * does not open, and no client has ever offered a record of its own to refuse with.
 */
const SEED_PROFILE = writeFields([
  { tag: 4, value: Buffer.from([4, 0, 0, 0]) },
  { tag: 1, value: Buffer.alloc(0) },
]);

/**
 * A refusal's reason, as the friends parser reads one: four bytes, no more and no
 * fewer. 0x442620 compares the blob's length with what the caller asked for and says
 * no if they differ, so a shorter reason is the same as no reason at all.
 */
function reasonCode(code: number): GSValue {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(code >>> 0, 0);
  return new Uint8Array(out);
}

/**
 * The reasons themselves, in the client's own numbering — read off
 * NUbi::NLAN::SContext::CanEnterGame (0xdeebe0), where the client refuses a LAN game
 * on the server's behalf and so has to name the reasons the way the server does.
 * Only the ones seen there are named; the rest are numbers nobody has read yet.
 */
const WRONG_PASSWORD = 9;

/**
 * How a message body goes into the log: whole, with blobs as hex.
 *
 * A login is the one message whose fields nobody has ever listed — the name is field 0
 * and the rest have never been printed. Printing the lot costs a line and settles which
 * field the password is, instead of another launch. **A password is not written down**:
 * it is the field this exists to identify, so every string after the name goes in as
 * its length. Nobody can read a secret out of "8 characters"; and the day the field is
 * known, this can print the name of it and nothing else.
 */
function bodyForLog(key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.length} bytes: ${Buffer.from(value).toString('hex')}>`;
  if (key === '0' || typeof value !== 'string') return value;
  return `<a string of ${value.length}>`;
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
  /** And the matches under way, so a result counts once however many report it. */
  private readonly matches: Matches;
  /** And who is in which channel, which is what a player list is made of. */
  private readonly presence: Presence;
  /** And the players' profiles, which are the server's to keep. */
  private readonly profiles: PersistentStore;
  /** And who has whom on his friends list. */
  private readonly friends: Friends;
  /** And the accounts, which is what a login is checked against. */
  private readonly accounts: Accounts;
  /** The other open connections, by desk — see `RouterService.desks`. */
  private readonly desks: Map<string, (bytes: Buffer) => void>;
  /**
   * Every session this server has open, this one among them.
   *
   * The desks map holds one connection per DESK NAME, which was enough while there was
   * one player: with two, his Lobby socket and the other player's are the same name and
   * the second one replaced the first. What a second player needs is not a better map
   * but the sessions themselves — who is on the other end of each, and which channel he
   * is looking at.
   */
  private readonly peers: Set<RouterSession>;
  /**
   * How to write on THIS connection, filled in by whatever owns the socket.
   *
   * Null in a test that only feeds `receive` and reads what comes back, which is most of
   * them — so a push to a session with no writer is simply not sent, rather than an
   * error nobody could have prevented.
   */
  send: ((bytes: Buffer) => void) | null = null;
  /** Seat synthetic players in every channel — a diagnostic, off unless asked for. */
  readonly ghosts: boolean;

  constructor(
    role: Role,
    waitModule: Endpoint,
    proxy: Endpoint,
    lobbyServer: Endpoint,
    rooms: Rooms,
    ladder: Ladder,
    matches: Matches,
    presence: Presence,
    profiles: PersistentStore,
    friends: Friends,
    accounts: Accounts,
    desks: Map<string, (bytes: Buffer) => void>,
    peers: Set<RouterSession>,
    ghosts = false,
  ) {
    this.desks = desks;
    this.peers = peers;
    this.profiles = profiles;
    this.friends = friends;
    this.accounts = accounts;
    this.ghosts = ghosts;
    this.role = role;
    this.waitModule = waitModule;
    this.proxy = proxy;
    this.lobbyServer = lobbyServer;
    this.rooms = rooms;
    this.ladder = ladder;
    this.matches = matches;
    this.presence = presence;
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
    // Where he was, before he stops being anywhere: the people still standing there
    // have to be told, and after `leave` there is nothing left to say who they are.
    const wasIn = this.presence.lobbyOf(this.username);
    this.presence.leave(this.username);
    const gone = this.rooms.hostedBy(this.username);
    for (const room of gone) this.rooms.remove(room.id);
    this.peers.delete(this);
    const told = wasIn === null ? 0 : this.tellChannel(wasIn);
    if (!gone.length) return told ? `${this.username} left — ${told} player(s) told` : null;
    return (
      `${this.username} left — dropped ${gone.map((room) => `"${room.name}"`).join(', ')}` +
      (told ? `, ${told} player(s) told` : '')
    );
  }

  /**
   * Everybody else looking at this channel — the connections that draw it.
   *
   * The lobby desk and no other: a player has four connections open and only one of
   * them is the one his channel screen listens on.
   */
  private othersIn(lobbyId: number): RouterSession[] {
    return [...this.peers].filter(
      (peer) =>
        peer !== this &&
        peer.role === 'lobby' &&
        peer.send !== null &&
        peer.username !== '' &&
        this.presence.lobbyOf(peer.username) === lobbyId,
    );
  }

  /**
   * Tell everybody else in a channel what it looks like now. Returns how many were told.
   *
   * ONE message for every kind of change — somebody arrived, somebody left, a game was
   * opened or closed — because GROUP_INFO is the message that already fills both halves
   * of that screen: it carries the member list AND the child groups, and the client has
   * been drawing channels from it since the first day. `MEMBER_JOIN` (50) and
   * `NEW_GROUP` (54) are the narrower announcements and one of them, sent our way, drew
   * no reaction at all — so the shape that is known to work is the one that gets used
   * for all four, and nothing here is a new guess.
   *
   * Each peer's own message is built from ITS session, so the channel entry carries the
   * game id that peer logged in with rather than ours.
   */
  private tellChannel(lobbyId: number): number {
    const others = this.othersIn(lobbyId);
    for (const peer of others) peer.send?.(peer.channelInfo(UNASKED, lobbyId));
    return others.length;
  }

  /**
   * And the same for the people INSIDE a game: the room, with who is in it now.
   *
   * A room's GROUP_INFO is the message the joiner already gets, and the host needs the
   * same one — nothing else tells him a second player has arrived, and a host looking at
   * an empty room will not start anything. The mask is the one the client asks a room
   * with, 448.
   *
   * **With the members and only when they changed.** A room info carrying a member list
   * is read as somebody arriving, and when that was sent after a mere settings update the
   * client answered with another settings update, which we answered with another member
   * list, several times a second until the room was closed. So this is called where
   * somebody actually joined or left, and GROUP_CONFIG_UPDATE_RES still answers with the
   * room and an empty list.
   */
  /** The other people sitting in a room, on the one connection each of them listens on. */
  private othersInRoom(room: Room): RouterSession[] {
    return [...this.peers].filter(
      (peer) =>
        peer !== this &&
        peer.role === 'lobby' &&
        peer.send !== null &&
        peer.username !== '' &&
        room.members.includes(peer.username),
    );
  }

  /**
   * One message, as it is, to everybody else in a room. Returns how many were told.
   *
   * Unlike `tellRoom` the bytes do not depend on who receives them, so they are built
   * once — and unlike it, this says whatever it is given rather than the room.
   */
  private tellRoomThat(room: Room, body: GSValue[]): number {
    const others = this.othersInRoom(room);
    const bytes = build(reply(UNASKED, body));
    for (const peer of others) peer.send?.(bytes);
    return others.length;
  }

  private tellRoom(room: Room): number {
    const others = this.othersInRoom(room);
    for (const peer of others) {
      peer.send?.(
        build(
          reply(UNASKED, [
            String(LobbyMsg.GROUP_INFO),
            [String(room.id), String(Lsm.ALLINFO), roomEntry(room), [], peer.membersOf(room)],
          ]),
        ),
      );
    }
    return others.length;
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
      memberEntry(name, room.id, this.addressOf(name), PlayerStatus.GAMECONNECTED, this.infoOf(name)),
    );
  }

  /**
   * Where a MODULE's answer goes — and it is not the socket it was asked on.
   *
   * Measured, by the probe inside the game rather than by reading: the client's module
   * queue is fed by the ROUTER's own router (0x41b150, which runs for that transport
   * only), and a reply sent down the proxy's wait module is never queued at all. The
   * run that showed it sent the ladder's refusal twice, once on each connection, and
   * exactly ONE copy was queued; the profile answer, sent only on the proxy's wait
   * module, was never seen by the probe — not queued, not keyed, not scanned.
   *
   * The requests come in on the proxy's wait module all the same. That asymmetry is
   * the protocol's, not ours.
   */
  private answerModule(bytes: Buffer): { replies: Buffer[]; where: string } {
    // HIS router connection, not whichever one happens to be open. The desks map holds
    // one socket per desk name, so with two players the second one's RouterLauncher
    // replaced the first's — and this answer, which is a profile or a rating, would have
    // gone to the wrong player's screen. The sessions know whose they are; ask them.
    const his = [...this.peers].find(
      (peer) => peer.role === 'router' && peer.send !== null && peer.username === this.username && peer !== this,
    );
    if (his) {
      his.send?.(bytes);
      return { replies: [], where: `on ${this.username}'s router connection` };
    }
    // 'Router' and not 'RouterLauncher': the wait module now shares the router's own
    // port, so there is one desk of that name (SLICE §2.3, services/gateway/main.ts).
    const onRouter = this.desks.get('Router');
    if (!onRouter) return { replies: [bytes], where: 'here, with no router connection open' };
    onRouter(bytes);
    return { replies: [], where: 'on the router connection' };
  }

  /**
   * Which room a message about starting a game is about.
   *
   * The bodies of the start chain have never been read — the run that reached them
   * logged the subtype and threw the fields away, which is what `said` is now for — so
   * the id is not taken from a field by position. Any field that names a room HE IS IN
   * is that room; failing that, the one room he is in, because a player is in one game
   * at a time and a start he did not send from a room is not a start.
   */
  private roomInPlay(fields: readonly GSValue[]): Room | undefined {
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      const room = this.rooms.get(Number(field));
      if (room && room.members.includes(this.username)) return room;
    }
    return this.rooms.containing(this.username)[0];
  }

  /** "Yes" in the shape 0x420B60 accepts: 38, the subtype, and a number under it. */
  private lobbyYes(message: GSMessage, subtype: string, room: Room | undefined): Buffer {
    return build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(room?.id ?? 0)]]]));
  }

  /**
   * His self-description, with the rating we hold written into it.
   *
   * The client composes that document once, on entering, and never sends another — so
   * after a rated game the channel's panel showed the rating he had BEFORE it, until he
   * left the channel and came back. Ours is the newer number, and it is the only field
   * of his document we own.
   */
  private infoOf(name: string): Uint8Array | undefined {
    const own = this.presence.info(name);
    if (!own) return own;
    return withRating(own, this.ladder.row(name)['RATING'] ?? STARTING_RATING);
  }

  /** Where to say a player is: what he told us, or this machine. */
  private addressOf(name: string): string {
    return name === this.username && this.localAddress ? this.localAddress : this.presence.address(name);
  }

  /**
   * The three channels, with **how many are actually in each**.
   *
   * It said 0 for every channel however many players were standing in them, because
   * `DEFAULT_LOBBIES` is a description of the channels and its `members` is a field
   * nobody had ever filled in. The number the screen shows is the last field of a
   * channel entry, and the only place that knows it is `Presence` — the same list the
   * player panel is drawn from, so the two cannot disagree.
   */
  /**
   * A channel, whole: who is in it and what games are open there.
   *
   * The same message answers three questions — "I have joined", "tell me again" and
   * "somebody's record changed" — and it is one function because the three had already
   * started to drift apart. The mask says what the rest of the message contains and it
   * is echoed as it was asked; 384 (members and child groups) is what the client uses
   * for a channel.
   */
  private channelInfo(
    message: GSMessage,
    lobbyId: number,
    mask: number = Lsm.GROUPMEMBERS | Lsm.CHILDGROUPINFO,
    extra: readonly GSValue[][] = [],
  ): Buffer {
    const lobby = DEFAULT_LOBBIES.find((l) => l.id === lobbyId) ?? DEFAULT_LOBBIES[0]!;
    const members = [
      ...this.presence
        .inLobby(lobby.id)
        .map((name) => memberEntry(name, lobby.id, this.addressOf(name), PlayerStatus.NONE, this.infoOf(name))),
      ...extra,
    ];
    // The games in the channel — and the ONE place the room-field diagnostic numbers
    // anything, because this is what other players are shown and the host's own copy of
    // his room must stay honest or he cannot enter it himself.
    const rooms = this.rooms.inLobby(lobby.id).map((room) => roomEntry(room, true));
    return build(
      reply(message, [
        String(LobbyMsg.GROUP_INFO),
        [String(lobby.id), String(mask), lobbyEntry(lobby, this.gameId, members.length), rooms, members],
      ]),
    );
  }

  private lobbyList(message: GSMessage): Buffer {
    const lobbies = DEFAULT_LOBBIES.map((lobby) =>
      lobbyEntry(lobby, this.gameId, this.presence.inLobby(lobby.id).length),
    );
    return build(reply(message, [String(LobbyMsg.GROUP_INFO), ['1', String(Lsm.CHILDGROUPINFO), ['0'], lobbies]]));
  }

  /**
   * What we can say about a friend besides his name.
   *
   * All of it is known already — `Presence` says where he is and the ladder says what
   * he is rated — and none of it is asked for: a friends list is exactly the fact that
   * somebody else is here, and this is where that fact comes from.
   */
  private stateOf(friend: string): FriendState {
    const lobbyId = this.presence.lobbyOf(friend);
    const lobby = DEFAULT_LOBBIES.find((l) => l.id === lobbyId);
    return {
      online: lobbyId !== null,
      place: lobby?.name ?? '',
      groupId: lobbyId ?? 0,
      rating: this.ladder.row(friend)['RATING'] ?? 0,
    };
  }

  /** His whole list, one message each, in the order he added them. */
  private friendList(message: GSMessage): Buffer[] {
    return this.friends
      .of(this.username)
      .map((friend) => build(reply(message, friendUpdate(friend, this.stateOf(friend)), MessageType.UPDATEFRIEND)));
  }

  private handle(message: GSMessage): RouterEvent {
    switch (message.type) {
      case MessageType.KEY_EXCHANGE:
        return this.keyExchange(message);
      // The login, and since 13.08.2026 it means something: the first time a name is
      // seen the account is created with the password that came with it, and every
      // login after that has to match. That is the whole of "registration" — the
      // client has no screen for it, and needs none.
      //
      // WHICH FIELD IS THE PASSWORD is read off the wire rather than assumed: the body
      // is logged whole below, and every string after the name is a candidate. Until a
      // capture says otherwise the credential is field 1, and a name arriving with no
      // second string logs in with an empty password — which is what a client that
      // sends none would do, and what the first sessions of this server did.
      //
      // Only the ROUTER carries the credentials. The proxy's login is the same message
      // with the same name and it is not a second authentication; treating it as one
      // would lock out a player whose second connection carries no password.
      case MessageType.LOGIN: {
        const name = message.body?.[0];
        this.username = typeof name === 'string' ? name : '';
        const password = typeof message.body?.[1] === 'string' ? message.body[1] : '';
        const body: GSValue[] = this.role === 'proxy' ? [messageId(MessageType.LOGIN), []] : [messageId(MessageType.LOGIN)];
        const said = `the body was ${JSON.stringify(message.body, bodyForLog)}`;
        if (this.role !== 'router' || !this.username) {
          return {
            note: `LOGIN as "${this.username}" on the ${this.role} — not the credential desk, ${said}`,
            replies: [build(reply(message, body, MessageType.GSSUCCESS))],
          };
        }
        const verdict: LoginVerdict = this.accounts.login(this.username, password);
        if (verdict === 'wrong-password') {
          // The client knows this path — "router login failed,reason=" — but it only
          // knows it in ONE shape, and the first refusal we sent was not it: a wrong
          // password left the screen sitting there with nothing said, and the game's own
          // log showed CStateWaitLoginRouterResult entered and then left again without
          // ProcessLoginRouterResult ever running. The reply was dropped BEFORE the
          // handler, in the parser, and the parser says what it wants (13.08.2026):
          //
          //   the router queue's drainer (0x41b620) hands key 102 to 0x42ac00, which
          //   asks 0x428fd0 to open the reply: the type must be 38 or 39 (0x428fe9),
          //   field 0 must be a ONE-byte blob whose value is 102 again, and for a 39 —
          //   and only for a 39 — field 1 must be a LIST whose own field 0 is a
          //   FOUR-byte blob (0x429053). That blob is the reason.
          //
          // A string there is refused by 0x442620 exactly as a blob of the wrong length
          // would be, and the whole reply is then thrown away without a word. Which is
          // what "ничего не происходит" was.
          //
          // 9 is the client's own number for this: NUbi::NLAN::SContext::CanEnterGame
          // (0xdeebe0) is the client playing server for a LAN game, and it refuses with
          // 1 for a version mismatch, 2 for a checksum, 5 for no such game and 9 right
          // after logging "wrong password".
          return {
            note: `LOGIN as "${this.username}" REFUSED — wrong password, reason ${WRONG_PASSWORD}, ${said}`,
            replies: [
              build(reply(message, [messageId(MessageType.LOGIN), [reasonCode(WRONG_PASSWORD)]], MessageType.GSFAIL)),
            ],
          };
        }
        return {
          note:
            `LOGIN as "${this.username}" — ${verdict === 'created' ? 'NEW ACCOUNT created' : 'password matched'}` +
            `${this.encryptedWith ? `, body opened with ${this.encryptedWith}` : ''}, ${said}`,
          replies: [build(reply(message, body, MessageType.GSSUCCESS))],
        };
      }
      case MessageType.JOINWAITMODULE: {
        // A decimal u32 in HOST order. Both other forms were tried and watched:
        // dotted sent the client to 0.0.0.127, and inet_addr's number sent it to
        // 1.0.0.127. See services/gateway/address.ts.
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
      // Logging in to the friends service is also the moment his list arrives: the
      // client has no message for "send me my friends" — `FriendsSend_Login`,
      // `_AddFriend` and `_DelFriend` are the whole of what it can say — so a list
      // that is never pushed is a list that is never shown.
      case MessageType.LOGINFRIENDS: {
        const list = this.friendList(message);
        return {
          note: `LOGINFRIENDS as "${this.username}" — accepted, ${list.length} friend(s) pushed`,
          replies: [build(reply(message, [messageId(MessageType.LOGINFRIENDS)], MessageType.GSSUCCESS)), ...list],
        };
      }
      // Right-clicking a name in the channel is "add to friend", and the game sends it
      // here: `FriendsSend_AddFriend(Senyaak,,0)` in its log, `[name, "", <4 zero
      // bytes>]` on the wire. Unanswered it does nothing at all, which is what Сеня saw
      // when he tried it on himself.
      //
      // The answer is read in two places and BOTH were found by walking the dispatch
      // rather than guessing (13.08.2026):
      //
      //   the routing key is the one byte in body field 0, read as a one-byte blob
      //   (0x428934) — 75 is what sends this down the friends queue's own drainer
      //   (0x41b840), whose table hands 75 to the parser at 0x429a20;
      //   0x428fd0 then insists the type is 38 or 39 and that field 0 says 75 again;
      //   0x4292d0 takes body field 1 as a **STRING** (0x4426c0 refuses any other
      //   kind) and copies it out as the friend's name.
      //
      // A list there — which is what we sent until now — is exactly the silent refusal
      // the probe saw: matched, consumed, and dropped in the getter. The earlier reading
      // of 0x425340 was a different parser altogether: it belongs to key 51 in another
      // drainer's table, and nothing we send is ever keyed 51.
      //
      // A refusal is 39 with a list under the key, holding a FOUR-byte reason (0x429053).
      case MessageType.ADDFRIEND: {
        const friend = typeof message.body?.[0] === 'string' ? message.body[0] : '';
        if (!friend) {
          return {
            note: `ADDFRIEND with no name from "${this.username}" — refused`,
            replies: [
              build(reply(message, [messageId(MessageType.ADDFRIEND), [reasonCode(1)]], MessageType.GSFAIL)),
            ],
          };
        }
        // A player is not his own friend. The client offers "add to friends" on his own
        // name in the channel — it asks nobody whether that makes sense — and we said
        // yes, so his list had himself on it. The refusal path already exists and this
        // is what it is for; names are matched the way accounts are, without case.
        if (friend.toLowerCase() === this.username.toLowerCase()) {
          return {
            note: `ADDFRIEND "${friend}" for "${this.username}" — refused, a player is not his own friend`,
            replies: [build(reply(message, [messageId(MessageType.ADDFRIEND), [reasonCode(1)]], MessageType.GSFAIL))],
          };
        }
        const added = this.friends.add(this.username, friend);
        return {
          note:
            `ADDFRIEND "${friend}" for "${this.username}" — ${added ? 'added' : 'already there'}, ` +
            `${this.friends.of(this.username).length} friend(s) now`,
          // The yes, and then the friend himself. The reply carries a name and nothing
          // else, so a list that only ever gets these is a list of names with nothing
          // beside them; 74 is where "he is online, in Ranked, rated 1560" can go, and
          // sending it now is what makes the new row look like the ones from login.
          replies: [
            build(reply(message, [messageId(MessageType.ADDFRIEND), friend], MessageType.GSSUCCESS)),
            build(reply(message, friendUpdate(friend, this.stateOf(friend)), MessageType.UPDATEFRIEND)),
          ],
        };
      }
      // And the other half of the right-click. The message is 76 and its reply is 75's
      // exactly — 0x429370 is 0x4292d0 with the key changed: the 38/39 envelope, the
      // key repeated in field 0, and the name as a STRING in field 1. Whether the ask
      // itself carries the name where the add does has not been seen on the wire, so
      // the body goes into the log whole the first time one arrives.
      case MessageType.DELFRIEND: {
        const friend = typeof message.body?.[0] === 'string' ? message.body[0] : '';
        if (!friend) {
          return {
            note: `DELFRIEND with no name from "${this.username}" — refused, the body was ${JSON.stringify(message.body, bodyForLog)}`,
            replies: [build(reply(message, [messageId(MessageType.DELFRIEND), [reasonCode(1)]], MessageType.GSFAIL))],
          };
        }
        // A name that is not on the list is answered with a yes as well: the client
        // offers "remove" for the rows it is already showing, so the two can only
        // disagree if our list is behind — and the honest end of that is to agree.
        const removed = this.friends.remove(this.username, friend);
        return {
          note:
            `DELFRIEND "${friend}" for "${this.username}" — ${removed ? 'removed' : 'was not there'}, ` +
            `${this.friends.of(this.username).length} friend(s) now`,
          replies: [build(reply(message, [messageId(MessageType.DELFRIEND), friend], MessageType.GSSUCCESS))],
        };
      }
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
        // **Answered with a real row since 13.08.2026.** What made that possible is
        // 0x432c80, the parser the payload goes through once the envelope is accepted:
        // a tag that must read as 1, two numbers, a list of column names and a list of
        // rows with exactly one cell per column. `ladderPayload` is that shape and the
        // comment on it names every step that refuses in silence.
        //
        // The refusal we used to send is still a path the client knows — "Failed to get
        // Ladder row for myself, setting N/A, set OWN player info sent" — and it is what
        // it falls back to if this row is wrong. Its own log says which happened:
        // `LadderQuery_StartResultEntryEnumeration(…) succeeded` against "ladder query
        // request failed,reason=63/64".
        if (subtype === String(LADDER_QUERY)) {
          // Three fields at the top, not two: the number, the id, and the query — so
          // the query is body[2] and `inner` (body[1]) is the id itself.
          const requestId = typeof message.body?.[1] === 'string' ? message.body[1] : '1';
          const container = message.body?.[2];
          const query = Array.isArray(container) ? container[1] : undefined;
          const pivotList = Array.isArray(query) ? query[4] : undefined;
          const pivotEntry = Array.isArray(pivotList) ? pivotList[1] : undefined;
          const pivot = Array.isArray(pivotEntry) && typeof pivotEntry[0] === 'string' ? pivotEntry[0] : this.username;
          // TWO ids travel with a ladder query and they are not the same number. The
          // module's, `body[1]`, counts 1, 3, 5, 7 across a session (the profile takes
          // the even ones) and is what the reply is matched by. The ladder's own, the
          // first field of the query, counts 1, 2, 3, 4 — and it is what the GAME
          // compares: the reader resolves the module id correctly out of its pending
          // map and then overwrites the answer with this one (0x42c987) before the
          // game ever sees it. Sent as anything else, every query after the first is
          // dropped with "not waiting reply with RequestId=1".
          const ladderId = Array.isArray(query) && typeof query[0] === 'string' ? query[0] : '1';
          const stats = this.ladder.row(pivot);
          const sent = this.answerModule(
            build(reply(message, moduleReplyBody(LADDER_QUERY, ladderPayload(ladderId, [stats]), requestId))),
          );
          return {
            note:
              `LADDER query ${requestId} (the ladder's own id ${ladderId}) about "${pivot}" — one row ` +
              `(rating ${stats['RATING']}, ${stats['GAMES_PLAYED']} game(s)), answered ${sent.where}`,
            replies: sent.replies,
          };
        }
        // The player's profile, kept for him on the persistantdata module. He asks for
        // it on entering a channel and the screen behind "Profile" waits for the
        // answer; unanswered, the client sits in
        // CStateWaitWithReturn<CStateOutOfRoom, CStateWaitPSGetDataReplyBase> for
        // fifteen seconds and then offers to create one.
        //
        // We are a store, not a reader: what a profile means is the client's business,
        // so the bytes it writes are the bytes it gets back. The innermost list, read
        // off 0x42aec0 and 0x42b400 — and the field KINDS matter, because the getters
        // refuse the wrong one:
        //
        //   [0]  the record, as a BLOB whose length must equal [1] exactly (0x442620)
        //   [1]  that length, as a decimal string read with atoi (0x4435c0)
        //   [2]  another number, unidentified; 0 until something says otherwise
        //
        // With [1] zero the client never even looks at [0] — it allocates nothing and
        // takes the record as absent, which is the honest answer for a player who has
        // never saved one.
        if (subtype === String(GET_DATA) || subtype === String(SET_DATA)) {
          // The id it asked with, which has to come back inside the answer: index 2 of
          // the list under the number is looked up among the requests still pending.
          const requestId = typeof message.body?.[1] === 'string' ? message.body[1] : '1';
          const args = Array.isArray(message.body?.[2]) ? message.body[2] : [];
          const key = recordKeyOf(args, this.username);
          const where = `${key.user}'s ${key.section} profile in ${key.game}`;
          const notes: string[] = [];
          if (subtype === String(SET_DATA)) {
            // The write's arguments, read off the builder at 0x42b1e0 rather than
            // inferred: [game, n, user, n, "PUBLIC", record, length]. The record is a
            // BLOB (0x442a20 takes a pointer and a length) and field 6 is that same
            // length repeated. A string is accepted too, because a profile has no NUL
            // in it and an early capture could have been read either way.
            const written = args[5];
            const bytes = typeof written === 'string' ? Buffer.from(written, 'utf8') : Buffer.from((written as Uint8Array) ?? []);
            this.profiles.set(key, bytes);
            // The bytes go in the log as HEX, not as a count. Nobody has ever seen a
            // profile record: it is the client's own composition, we cannot invent one,
            // and the first one to arrive is the only description of the format there
            // will ever be. A line saying "saved 214 bytes" would throw that away.
            notes.push(
              `saved ${bytes.length} byte(s), sent as a ${typeof written === 'string' ? 'string' : 'blob'}` +
                `\n    the record, which nothing else records: ${bytes.toString('hex')}`,
            );
            // A write is answered with an EMPTY payload, and that is not laziness: its
            // reply reader (0x42b2e0) asks for a list at index 1 and a number at index 2
            // and never looks inside the list. Handing back the record instead — which
            // is what this did while the write had never been seen — passes by accident
            // and says something the client did not ask about.
            const sent = this.answerModule(build(reply(message, moduleReplyBody(SET_DATA, [], requestId))));
            return {
              note: `PROFILE write — ${where}, ${notes.join(', ')}, answered ${sent.where}`,
              replies: sent.replies,
            };
          }
          // A record that was never written is answered with a MINIMAL ONE. Answering
          // with nothing is a lie the client half-believes — it reads the reply ("the
          // profile length read said 1"), makes no profile of it and puts up "Не удалось
          // создать профиль" — and refusing outright is honest and is also the screen
          // staying shut, which is what двойной клик по игроку did until 13.08.2026.
          //
          // The reasoning: nobody has ever seen a profile record, we cannot invent one,
          // and the only thing that can produce a real one is the client — which will
          // not write one while its own read fails. So the refusal is a closed loop, and
          // the way out is to answer the read with something the reader survives, get to
          // the screen that saves, and let the client hand us the format. Every write is
          // hex-dumped above for exactly that reason.
          //
          // The bytes are the skeleton every document the game writes begins with —
          // `CStructureSaver`, tag 4 holding a four-byte kind, then an empty container
          // under tag 1 (`structure.ts`, and the player-info blob it was read from). It
          // is a GUESS about the profile's own tags, and the game's log is the verdict:
          // "PS get data succeeded" and then whatever the profile screen does with it.
          //
          // The first write from any client replaces it with the real thing, and that
          // write is still the only description of the format there will ever be.
          // And it is CREATED, not conjured for each read: the row goes into the same
          // table his account and his rating live in, so from his first look he has a
          // profile that persists, and the write that follows updates it like any other.
          // What is in it is the one thing we cannot supply — a record is the client's
          // own document and we are its storage — so ours is the skeleton and his first
          // save replaces it whole.
          const stored = this.profiles.get(key);
          const seeded = stored ? null : SEED_PROFILE;
          if (seeded) this.profiles.set(key, seeded);
          notes.push(
            stored
              ? `handing back ${stored.length} byte(s)`
              : `nothing stored — CREATED one of ${seeded!.length} byte(s): ${seeded!.toString('hex')}`,
          );
          const record = stored ?? seeded;
          const answer = record
            ? moduleReplyBody(subtype, [new Uint8Array(record), String(record.length), '0'], requestId)
            : moduleFailureBody(subtype, 'no such record', requestId);
          const sent = this.answerModule(build(reply(message, answer)));
          return {
            note: `PROFILE read — ${where}, ${notes.join(', ')}, answered ${sent.where}`,
            replies: sent.replies,
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
        // Where everyone ELSE will be told he lives. His own record still comes from
        // `this.localAddress` (addressOf), so the probe never lies to a player about
        // himself — see probePeerAddress.
        const livesAt = probePeerAddress.on ? probePeerAddress.for(this.username) : this.localAddress;
        this.presence.livesAt(this.username, livesAt);
        return {
          note:
            `LOBBYSERVERLOGIN "${this.username}" on server ${String(serverId)}, from ${this.localAddress}/${this.localNetmask}` +
            (probePeerAddress.on ? ` — others will be told ${livesAt}` : ''),
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
          // The channel is entered with its own mask — 384, members and child groups
          // but not the channel's own info — and it is echoed for the same reason a
          // room's is: the mask says what the rest of the message contains. It is
          // field **2**: the body is [id, password, mask], measured off the wire. Read
          // from field 3 it fell back to 256, and a member list announced as "no
          // members" is a member list the client does not draw.
          const asked = Number(typeof fields[2] === 'string' ? fields[2] : '') || Lsm.GROUPMEMBERS | Lsm.CHILDGROUPINFO;
          const lobby = DEFAULT_LOBBIES.find((l) => String(l.id) === groupId) ?? DEFAULT_LOBBIES[0]!;
          this.presence.enter(this.username, lobby.id);
          // And the people already standing there hear about it. Nothing else would
          // tell them: every other message in this file answers whoever asked, and the
          // client asks for the channel again only when it re-enters CStateOutOfRoom —
          // so a player who arrived after them stayed invisible until they went into a
          // game and came back out.
          const heard = this.tellChannel(lobby.id);
          // The people in the channel, himself among them, come from `channelInfo`.
          // Left empty, the client's player list is empty too, and "Profile" — "look at
          // the results of the selected players" — has nothing to act on and stays grey.
          //
          // A run with `--ghosts` seats synthetic players in the channel, one with a
          // blob and one without. That experiment has already said what it had to say:
          // the list is fed by GROUP_INFO, the client does not hide itself, and a
          // member with no blob keeps the name in his record. It stays because a
          // channel with four names in it tells us more at a glance than one with one.
          const ghosts = this.ghosts
            ? [
                memberEntry('GhostList', lobby.id, '127.0.0.1', PlayerStatus.NONE, undefined),
                memberEntry('GhostBlob', lobby.id, '127.0.0.1', PlayerStatus.NONE, playerInfo('GhostBlob', 1234)),
              ]
            : [];
          const announced = this.ghosts
            ? [
                build(
                  reply(message, [
                    String(LobbyMsg.MEMBER_JOIN),
                    [
                      memberEntry('GhostJoin', lobby.id, '127.0.0.1', PlayerStatus.NONE, playerInfo('GhostJoin', 1234)),
                    ],
                  ]),
                ),
              ]
            : [];
          return {
            note:
              `JOIN_LOBBY ${groupId} ("${lobby.name}") — in, ${this.rooms.inLobby(lobby.id).length} game(s) and ` +
              `${this.presence.inLobby(lobby.id).length + ghosts.length} player(s) listed, mask ${asked}` +
              (heard ? `, ${heard} already there told` : '') +
              (this.ghosts ? ' + GhostJoin pushed as MEMBER_JOIN' : ''),
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [groupId]]])),
              this.channelInfo(message, lobby.id, asked, ghosts),
              ...announced,
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
          // And it appears on the screens of everybody standing in that channel. The
          // host gets his NEW_GROUP below; for the others the channel comes back whole,
          // because that message carries the games as well as the players.
          const saw = this.tellChannel(room.parentId);
          return {
            note:
              `CREATE_ROOM "${room.name}" in channel ${room.parentId} — id ${room.id}, ` +
              `up to ${room.maxPlayers} players` + (saw ? `, ${saw} player(s) shown it` : ''),
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
          // A game that is gone must be SAID to be gone. Answering nothing left the
          // client in CStateWaitJoinRoomReply for good — which is what happened when
          // the host left his own game and then clicked it in his still-stale list.
          // The reason goes after the id, and 39 is GSFAIL where 38 is success.
          if (!room) {
            return {
              note: `JOIN_ROOM ${roomId} — no such game, refused`,
              replies: [
                build(
                  reply(message, [String(MessageType.GSFAIL), [subtype, [String(roomId), 'that game is gone']]]),
                ),
                // And take it off his list, in case that is where he found it.
                build(reply(message, [String(LobbyMsg.GROUP_REMOVE), [String(roomId), '1']])),
              ],
            };
          }
          const wasIn = room.members.includes(this.username);
          if (!wasIn) room.members.push(this.username);
          const members = this.membersOf(room);
          // The host, and anybody else already sitting in there. Without this his room
          // still says he is alone in it, and a host alone in his room starts nothing.
          const inside = wasIn ? 0 : this.tellRoom(room);
          // And the channel, because the game's "2 of 2" is drawn from the same record
          // in the list everybody else is looking at.
          const outside = this.tellChannel(room.parentId);
          return {
            note:
              `JOIN_ROOM ${roomId} ("${room.name}") — in, ${room.members.length} of ${room.maxPlayers}, mask ${asked}` +
              (inside ? `, ${inside} in the room told` : '') +
              (outside ? `, ${outside} in the channel told` : ''),
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
          if (blob) {
            this.playerInfo = blob;
            // Kept per player, not per connection: the other players' records need it.
            this.presence.remember(this.username, blob);
          }
          const said = fields.map((field) => (field instanceof Uint8Array ? `<${field.length} bytes>` : JSON.stringify(field)));
          // AND THE CHANNEL IS TOLD AGAIN, because this blob is where his rating is.
          //
          // The order is the client's and it cannot be helped: the member list goes out
          // when he enters the channel, a second before his ladder row arrives, and only
          // then does he compose the blob that carries the rating (tag 5 -> +0x38 -> the
          // panel's column). So the record the panel drew him from had no rating in it,
          // and his own row said "…" until something made the client ask again.
          //
          // Sending the channel's group info here closes that: the panel keys its rows
          // by NAME and replaces what it finds (0x90fc80 -> 0x911b90), so the same list
          // arriving again refreshes rather than doubles. It does not loop the way
          // answering a settings update with a member list did — an arrival does not
          // make the client send its player info a second time.
          const inChannel = this.presence.lobbyOf(this.username);
          const refreshed = inChannel === null ? [] : [this.channelInfo(message, inChannel)];
          return {
            // The reply's shape is the one every other lobby answer has — result,
            // subtype, the first field back. Not yet confirmed by the client's own
            // log line for it; `LobbyRcv_SetPlayerInfoReply` will say.
            note: `SET_PLAYER_INFO — ${said.join(', ')}${inChannel === null ? '' : `, channel ${inChannel} told again so his rating is drawn`}`,
            replies: [
              build(
                reply(message, [
                  String(MessageType.GSSUCCESS),
                  [subtype, [typeof fields[0] === 'string' ? fields[0] : '0']],
                ]),
              ),
              ...refreshed,
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
          // What the room looked like before he touched it, so that the people watching
          // are told when it CHANGES and not merely when he says something. The host
          // sends these three to five times a second and most of them carry the same
          // bytes back; forwarding every one rebuilt the other player's screen
          // continuously — his log filled with "new room" and "member joined … ignoring"
          // several times a second, and joining a game that is being redrawn under you
          // is what "еле подключилось" was.
          const before = Buffer.from(room.info);
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
          // AND EVERYBODY ELSE IN THE CHANNEL GETS THE NEW ONE, when it is new. The host
          // makes his room with one description and replaces it a fraction of a second
          // later with a bigger one — 522 bytes at CREATE_ROOM, 590 the moment he is
          // inside it, 660 once somebody joins — and until now we kept the second and
          // forwarded the first. That description is what the other client builds its own
          // record of the game out of, so his copy was the half-finished one, and that is
          // what Join was greyed out over.
          //
          // Only to the OTHERS: the host is the one sending these, and answering him with
          // a room he did not ask about is what made him send another update, which we
          // answered with another room — several a second until the game was closed.
          const different = !before.equals(Buffer.from(room.info));
          const told = different ? this.tellChannel(room.parentId) : 0;
          return {
            note:
              `GROUP_CONFIG_UPDATE_RES ${roomId} — ${changed.length ? changed.join(', ') : `nothing we read (flags ${flags})`}` +
              (told ? `, ${told} player(s) told` : different ? '' : ', the same settings as before — nobody told'),
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
        // STARTING THE GAME, which is a chain of four exchanges and not one message.
        // Read out of the client's own handlers (0xE12620, 0xE12A70, 0xE12C40, 0xE1CCD0):
        //
        //   host  -> START_GAME 15    we say yes    -> he sends GAME_READY himself
        //   host  -> GAME_READY 33    we say yes    -> and then he WAITS
        //   both  <- GAME_STARTED 56  we push it    -> both answer GAME_CONNECTED,
        //                                              and the host sends START_MATCH
        //   host  -> START_MATCH 17   we say yes    -> "start match succeeded"
        //
        // **GAME_STARTED comes after GAME_READY, not between the first two.** The chain
        // written down in NETWORK_STATE.md was the order the RTTI names are listed in;
        // the handlers run in this one, and the handlers are what runs.
        //
        // It goes to EVERYBODY in the room, the sender included: the host waits for it in
        // CStateWaitGameStarted, and the guest — who sends nothing at all during a start,
        // as the last run shows — leaves his "please wait" on this message and on nothing
        // else. `CStateWaitingForPlayers::ProcessGameStarted` (0xE1CCD0) does not read the
        // message at all: its arrival IS the content.
        //
        // The three "yes"es are the ordinary envelope — 38, the subtype, a list under it —
        // because START_GAME, CREATE_ROOM and JOIN_ROOM are all parsed by the same
        // 0x420B60. What that parser drops in silence is worth naming: `body[1][1]` must
        // BE a list and its first field must read as a number (0x4435C0), even though the
        // handler that receives it then ignores it. A refusal would be 39 with the reason
        // first and a second number after it — not written, because nothing here refuses.
        if (subtype === String(LobbyMsg.START_GAME)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          return {
            note: `START_GAME — ${room ? `"${room.name}" (${room.id})` : 'no room of his'}, yes`,
            replies: [this.lobbyYes(message, subtype, room)],
          };
        }
        // He is ready, and this is the last thing he sends before he waits. So the answer
        // is followed at once by the announcement everybody in the room is waiting for.
        if (subtype === String(LobbyMsg.GAME_READY)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          if (!room) {
            return { note: 'GAME_READY — he is in no room of ours, yes anyway', replies: [this.lobbyYes(message, subtype, room)] };
          }
          const announcement: GSValue[] = [String(MessageType.GSSUCCESS), gameStartedEntry(room)];
          const told = this.tellRoomThat(room, announcement);
          // And the description of the game that is about to be played goes into the log
          // in full, because this is the last moment it is still the host's final word on
          // it — the room is dropped when he leaves, and the raw bytes in the log above
          // are ciphertext. It is what says WHICH game this was: the map's path lives in
          // this document, and a duel and a map differ somewhere inside it and nowhere
          // else we can see. `node tools/dump-struct.ts --hex <bytes>` reads it back.
          const settings = Buffer.from(room.info).toString('hex');
          return {
            note:
              `GAME_READY — "${room.name}" (${room.id}) starts, announced to him and ${told} other(s)` +
              // Silence on the probe must not be readable as "the game ignored our
              // address" when it could just as well be "the shape was never found".
              (probePeerAddress.on ? `\n             probe rewrote the endpoints: ${probePeerAddress.lastPatch}` : '') +
              '\n' +
              `             the game as its host described it, ${room.info.length} bytes, for dump-struct --hex:\n` +
              `             ${settings}`,
            replies: [this.lobbyYes(message, subtype, room), build(reply(message, announcement))],
          };
        }
        // And the match itself, which is where a game becomes RATED. The host sends this
        // when the room is a rated one; the answer, and then MATCH_STARTED to everybody,
        // which carries the **match id** the client will quote back with its results.
        //
        // Measured 13.08.2026, on an ordinary map in the Ranked channel: both clients
        // answered the push with subtype 44 (`PlayerMatchStarted`) within 200ms, played,
        // and submitted a results table opening with that same id. A duel the day before
        // never sent START_MATCH at all — which is why this push was briefly removed as
        // an unprovable guess, on the evidence of the one game that could not show it.
        if (subtype === String(LobbyMsg.START_MATCH)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          if (!room) {
            return { note: 'START_MATCH — he is in no room of ours, yes anyway', replies: [this.lobbyYes(message, subtype, room)] };
          }
          const running: GSValue[] = [String(MessageType.GSSUCCESS), matchStartedEntry(room)];
          const told = this.tellRoomThat(room, running);
          // Whether this game counts is decided HERE, while the room still exists and
          // still knows which channel it was made in. By the time the results arrive the
          // host may have left and taken the room with him.
          const rated = room.eventId === GameMode.RATED;
          this.matches.start(String(room.id), rated);
          return {
            note:
              `START_MATCH — "${room.name}" (${room.id}) is running${rated ? ' and RATED' : ', unrated'}, ` +
              `${told} other(s) told`,
            replies: [this.lobbyYes(message, subtype, room), build(reply(message, running))],
          };
        }
        // "I have finished the match" — the other half of the pair, sent right after the
        // results and immediately followed by GROUP_LEAVE, so nothing waits on it either.
        if (subtype === String(LobbyMsg.PLAYER_MATCH_FINISHED)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          return {
            note: `PLAYER_MATCH_FINISHED — ${this.username} is out of ${room ? `"${room.name}" (${room.id})` : 'a room we do not have'}, nothing to answer`,
            replies: [],
          };
        }
        // "I have started the match" — both players say it as soon as MATCH_STARTED
        // reaches them, and then they play for eight minutes without another word, so
        // nothing is waiting on an answer here. Named rather than answered.
        if (subtype === String(LobbyMsg.PLAYER_MATCH_STARTED)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          return {
            note: `PLAYER_MATCH_STARTED — ${this.username} is in ${room ? `"${room.name}" (${room.id})` : 'a room we do not have'}, nothing to answer`,
            replies: [],
          };
        }
        // THE RESULTS OF A RATED GAME, and the screen that hangs without an answer:
        // "Пожалуйста, подождите пока результаты игры не отправятся на ubi.com".
        //
        // Both players send the whole table, once, at the end. Two things are owed back,
        // and the client waits in a separate state for each:
        //
        //   SubmitMatchResultReply   the ordinary 38 envelope, with the MATCH ID under it
        //   FINAL_MATCH_RESULTS 71   a push, and it must NOT be wrapped in 38 (below)
        //
        // The match id is the one we invented: `MATCH_STARTED` carried it, the client
        // stored it (`ctx+0x258`, written in ProcessMatchStarted 0xE1D2B0) and quotes it
        // at the head of this table. It is taken from the REQUEST rather than from the
        // room, because by now the room may be gone and the client compares against what
        // it was told — a mismatch leaves it waiting for ever (0xE1340F), which is a
        // hang, not an error.
        //
        // The table itself is logged whole. The stat ids in it are not named anywhere in
        // the lobby library — the game builds those pairs — so the log is the only record
        // of what a played game looks like, and it is what any rating of ours will be
        // computed from once the columns are known.
        if (subtype === String(LobbyMsg.SUBMIT_MATCH)) {
          const fields = Array.isArray(inner) ? inner : [];
          const matchId = typeof fields[0] === 'string' ? fields[0] : '0';
          // [matchId, 0, row, row, …] — a row is [name, highestStatId, howMany, mask, [values]]
          const rows = fields.slice(2).filter((field): field is GSValue[] => Array.isArray(field));
          const played = rows.map((row) => (typeof row[0] === 'string' ? row[0] : '?'));
          // The rows we send back are read by nobody: 0x426380 parses them — a name of at
          // most 32 characters and a list of numbers — and the handler (0xE135C0) looks
          // only at the type byte and the id. The new ratings do not travel here; the
          // client goes and asks the ladder. So each player gets his rating as it stands,
          // which is honest and parses.
          // AND THE LADDER IS WRITTEN, once. Both players submit the same table a second
          // or two apart, so the first of them settles the match and the second finds it
          // settled; and only a game started in the rated channel counts, which is our
          // rule rather than the protocol's — the client asks for one ladder and never
          // says which channel it is about.
          let settled = '';
          if (this.matches.rated(matchId) && this.matches.settle(matchId)) {
            const results = rows.map((row) => matchResult(row)).filter((result) => result !== null);
            settled = `, ${settleMatch(this.ladder, results)}`;
            // And the people standing in the channel are handed the list again, because
            // the number beside a name has just changed and nothing else would say so.
            const inChannel = this.presence.lobbyOf(this.username);
            const told = inChannel === null ? 0 : this.tellChannel(inChannel);
            if (told) settled += `, ${told} in the channel told`;
          }
          // The ratings that go back out are read AFTER that, so the winner sees his new
          // one — though the client does not read them here anyway and asks the ladder
          // itself a moment later.
          const standings: GSValue[] = played.map((name) => [name, [String(this.ladder.row(name)['RATING'] ?? 0)]]);
          return {
            note:
              `SUBMIT_MATCH ${matchId} — results from ${this.username} for ${played.join(' vs ')}, ` +
              `answered and the final results pushed back${settled}\n` +
              `             the table as it arrived: ${said(inner)}`,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [matchId]]])),
              // **Bare, not wrapped.** The client's matcher accepts either shape, but the
              // parser for 71 reads `body[1][0]` as the MATCH ID — in a 38 envelope that
              // slot is the echoed subtype, so the id would arrive as 71 and never match.
              // GROUP_REMOVE is already sent bare for the same reason.
              build(
                reply(message, [
                  String(LobbyMsg.FINAL_MATCH_RESULTS),
                  [matchId, String(MessageType.GSSUCCESS), standings],
                ]),
              ),
            ],
          };
        }
        // And the last word of a rated game: the client sends it once every player has
        // stopped playing, and waits for a plain yes (0xE13AE0 checks the type byte and
        // nothing else).
        if (subtype === String(LobbyMsg.MATCH_FINISH)) {
          const fields = Array.isArray(inner) ? inner : [];
          const matchId = typeof fields[0] === 'string' ? fields[0] : '0';
          return {
            note: `MATCH_FINISH ${matchId} — ${this.username} is done, yes`,
            replies: [build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [matchId]]]))],
          };
        }
        // The game is over. Both players say so — `CStatePlaying::ProcessGameFinish`
        // (0xE1CFE0) takes the unrated branch for everybody, since the rated one hangs
        // off the same unreachable flag — and **neither waits for an answer**: there is
        // no `LobbyRcv_GameFinish` and no CStateWait for it, and the sender goes straight
        // into CStateWaitingForPlayers. In the duel both GROUP_LEAVEs arrived in the same
        // millisecond as this, which is what that looks like from here.
        //
        // So this is not a message to answer, it is the one place the server is told a
        // game ended — and the only one it will ever get, because in this build the
        // client never reports a result. Whatever this lobby ever does with played games
        // starts here.
        if (subtype === String(LobbyMsg.GAME_FINISH)) {
          const room = this.roomInPlay(Array.isArray(inner) ? inner : []);
          return {
            note: `GAME_FINISH — ${room ? `"${room.name}" (${room.id})` : 'a room we do not have'} is over for ${this.username}, nothing to answer`,
            replies: [],
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
          // Rooms that stopped existing, so the player can be told rather than left to
          // find out by clicking one.
          const removed: number[] = [];
          if (room) {
            room.members = room.members.filter((name) => name !== this.username);
            if (room.master === this.username) {
              this.rooms.remove(room.id);
              removed.push(room.id);
              note = `GROUP_LEAVE ${groupId} — the host left, "${room.name}" is gone`;
            } else {
              // The room lives on, so the people still in it get it back with one name
              // fewer — the same message they got when he arrived.
              const still = this.tellRoom(room);
              note =
                `GROUP_LEAVE ${groupId} — ${this.username} left "${room.name}"` +
                (still ? `, ${still} still in it told` : '');
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
            for (const r of gone) {
              this.rooms.remove(r.id);
              removed.push(r.id);
            }
            if (gone.length) {
              note = `GROUP_LEAVE ${groupId} — the host left the channel, ${gone
                .map((r) => `"${r.name}"`)
                .join(', ')} gone`;
            }
            // And he is out of that channel's player list.
            this.presence.leave(this.username);
          }
          // The same news for everybody else standing there: a player fewer, or a game
          // fewer. Without it his name and his game sit on their screens until they
          // leave the channel themselves.
          const left = this.tellChannel(room ? room.parentId : groupId);
          if (left) note += `, ${left} player(s) told`;
          return {
            note: removed.length ? `${note} (told it is gone)` : note,
            replies: [
              build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [String(groupId)]]])),
              ...removed.map((id) => build(reply(message, [String(LobbyMsg.GROUP_REMOVE), [String(id), '1']]))),
            ],
          };
        }
        // "Tell me about this group again" — and it is asked EVERY time the client
        // returns to CStateOutOfRoom, which is the refresh this server had been
        // answering with a bare "yes".
        //
        // That is why the player's own rating stayed "…". The channel's member list
        // goes out at JOIN_LOBBY, a second before the ladder resolves; only then does
        // he compose his player-info blob and send it, and the rating the panel shows
        // is inside that blob — `OnMemberJoined` (0x9108f0) copies `[member+0x38]` into
        // the row, and 0xdfea70 puts tag 5 of the blob there. So the panel's first and
        // only picture of him was made before he had said what his rating was.
        //
        // Answering with the group in full is safe against the duplicate rows one would
        // expect from re-announcing everybody: the panel keeps its rows in a map keyed
        // by the NAME (0x90fc80 looks the name up at 0x911b90 and REPLACES what it
        // finds), so the same list arriving twice refreshes rather than doubles.
        //
        // The body is [group, mask] — mask at index 1, not 2 as JOIN_LOBBY has it,
        // read off the wire: `"9" ["2","384"]`.
        if (subtype === String(LobbyMsg.GROUP_INFO_GET)) {
          const fields = Array.isArray(inner) ? inner : [];
          const groupId = typeof fields[0] === 'string' ? fields[0] : '1';
          const asked = Number(typeof fields[1] === 'string' ? fields[1] : '') || Lsm.GROUPMEMBERS | Lsm.CHILDGROUPINFO;
          const lobby = DEFAULT_LOBBIES.find((l) => String(l.id) === groupId);
          const room = this.rooms.get(Number(groupId));
          const ack = build(reply(message, [String(MessageType.GSSUCCESS), [subtype, [groupId, '0']]]));
          if (lobby) {
            const here = this.presence.inLobby(lobby.id).length;
            return {
              note: `GROUP_INFO_GET for ${groupId} ("${lobby.name}") — ${here} player(s), ${this.rooms.inLobby(lobby.id).length} game(s), mask ${asked}`,
              replies: [ack, this.channelInfo(message, lobby.id, asked)],
            };
          }
          if (room) {
            const members = this.membersOf(room);
            return {
              note: `GROUP_INFO_GET for ${groupId} ("${room.name}") — ${members.length} player(s), mask ${asked}`,
              replies: [
                ack,
                build(
                  reply(message, [String(LobbyMsg.GROUP_INFO), [groupId, String(asked), roomEntry(room), [], members]]),
                ),
              ],
            };
          }
          return { note: `GROUP_INFO_GET for ${groupId} — no such group here`, replies: [ack] };
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
        return {
          note: `lobby message subtype ${String(subtype)} is not implemented — it said ${said(inner)}`,
          replies: [],
        };
      }
      // The keep-alive, and it is ANSWERED since 13.08.2026 — with the same bare
      // header it arrived as, parties the other way round.
      //
      // Why: a session that sits in a channel doing nothing dies at almost exactly two
      // minutes. Two of them in one run, 122 and 121 seconds after the connection was
      // made, both ending in "ProcessLoginDisconnection: disconnected from router" with
      // the client closing every socket. Nothing else in this protocol goes unanswered,
      // and this is the only message the client sends that never got a word back: it
      // arrives every 31 seconds as six bytes with no body at all (`00 00 06 00 3a 41`)
      // and it is the client asking whether anybody is there.
      //
      // It had never been noticed because it takes two idle minutes to happen, and until
      // the guest started talking nobody sat in a channel that long — the longest session
      // before it was 118 seconds. That is also why the chat was the first suspect; the
      // bot did not cause this, it only kept the client in the channel long enough.
      //
      // Answer everything (see the top of this file). It costs six bytes.
      case MessageType.STILLALIVE:
        return {
          note: 'STILLALIVE — answered',
          replies: [
            build({
              property: Property.GS,
              priority: message.priority,
              type: MessageType.STILLALIVE,
              sender: message.receiver,
              receiver: message.sender,
              body: null,
            }),
          ],
        };
      default:
        return {
          note: `no handler for message type ${message.type} — nothing sent, it said ${said(message.body ?? undefined)}`,
          replies: [],
        };
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
  private readonly matches = new Matches();
  /**
   * Who is in which game, for anyone outside this file who has to know.
   *
   * Read-only on purpose: rooms are made and unmade by the client's own messages, and
   * the one other reader — the loop that tells the core, so the relay can be asked "which
   * room is this agent in" — has no business changing one.
   */
  get openRooms(): readonly Room[] {
    return this.rooms.all();
  }
  /** Shared by every desk, because a rating belongs to the player, not the socket. */
  readonly ladder: Ladder;
  /** Likewise: who is in which channel is the same fact on every connection. */
  readonly presence = new Presence();
  /** And a profile belongs to the player too, outliving every session. */
  readonly profiles: PersistentStore;
  /** Friendships, likewise: added once, still there next launch. */
  readonly friends: Friends;
  /** Who a name belongs to. Every desk shares one set of accounts. */
  readonly accounts: Accounts;
  /** The database under all of them, for anything that wants to look for itself. */
  readonly database: import('node:sqlite').DatabaseSync;
  /** What the old JSON files brought with them, once, for the log to say. */
  readonly imported: string[];
  /** Passed to every session: seat synthetic players, to see what the client draws. */
  ghosts = false;
  /**
   * How to reach a connection that is not the one being answered.
   *
   * Every reply so far goes back down the socket the request arrived on, which is all
   * a lone player ever needed. Two things need more: telling the people already in a
   * channel that somebody has joined, and — right now — answering a module request on
   * the module's own connection instead of the one it was asked on. The server fills
   * this in as sockets open; `null` means that desk has nobody on it.
   */
  readonly desks = new Map<string, (bytes: Buffer) => void>();
  /**
   * Every open session, which is what a second player made necessary.
   *
   * One entry per CONNECTION, four to a player, and each knows whose it is and how to
   * write on itself — so "everybody else in this channel" and "this player's own router
   * connection" are both questions that can be answered. A session takes itself out on
   * `close`.
   */
  readonly sessions = new Set<RouterSession>();

  constructor(
    waitModule: Endpoint,
    proxy: Endpoint,
    proxyWaitModule: Endpoint,
    lobbyServer: Endpoint,
    databaseFile = 'data/lobby.db',
  ) {
    this.waitModule = waitModule;
    this.proxy = proxy;
    this.proxyWaitModule = proxyWaitModule;
    this.lobbyServer = lobbyServer;
    const opened = openDatabase(databaseFile);
    this.database = opened.db;
    this.imported = opened.imported;
    this.accounts = new Accounts(this.database);
    this.ladder = new Ladder(this.database);
    this.profiles = new PersistentStore(this.database);
    this.friends = new Friends(this.database);
    seatGuest(this.ladder, this.presence);
  }

  /** A connection on one of the four desks. */
  session(role: Role = 'router'): RouterSession {
    const waitModule = role === 'proxy' ? this.proxyWaitModule : this.waitModule;
    const session = new RouterSession(
      role,
      waitModule,
      this.proxy,
      this.lobbyServer,
      this.rooms,
      this.ladder,
      this.matches,
      this.presence,
      this.profiles,
      this.friends,
      this.accounts,
      this.desks,
      this.sessions,
      this.ghosts,
    );
    this.sessions.add(session);
    return session;
  }
}

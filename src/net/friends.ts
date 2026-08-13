// Who has whom on his friends list, and how a friend goes out on the wire.
//
// The client says three things here and no more — `FriendsSend_Login`,
// `FriendsSend_AddFriend`, `FriendsSend_DelFriend` (0xe0f5c1, 0xe1905a, 0xe19263),
// all of them on the router's wait module. There is no "send me my list" among them,
// which settles what the server has to do: **the list is pushed, not asked for.**
// The message for it is 74, `FriendsRcv_UpdateFriend`, one per friend — and the game
// has a panel to draw them in, `FriendListView` (0x910367), the players panel's other
// half.
//
// The four the client can receive are the whole family: 78 login result, 75 added,
// 76 removed, 74 updated (the friends queue's own drainer, 0x41b840, and the listener
// vtable at 0xfe4c30 whose slots +0, +4, +8 and +0x34 are those four in that order).
//
// One row per friendship, in the same database as everything else a player leaves
// behind — and with the time it was made, because "in the order he added them" is the
// order a list is drawn in and it should not depend on how the rows come back.
//
// Exports:
//   Friends       the store: of(user), add(user, friend), remove(user, friend)
//   friendUpdate  one friend as message 74's body
//   FriendState   what we say about him beside his name

import type { DatabaseSync } from 'node:sqlite';
import type { GSValue } from './gs-data.ts';

/**
 * What is said about a friend beside his name.
 *
 * Every one of these is ours to decide only in the sense that nothing has read back
 * what the client does with them — the shapes are exact (see `friendUpdate`), the
 * meanings are the plausible reading of a friends row and are marked as such.
 */
export interface FriendState {
  /** Whether he is logged in at all — the one thing a friends list exists to say. */
  online: boolean;
  /** Where he is, in words: the channel he sits in, empty when he is nowhere. */
  place: string;
  /** And the same as a number: the channel's id, 0 for a friend who is in none. */
  groupId: number;
  /** His rating, because it is what the panel draws beside a name everywhere else. */
  rating: number;
}

/** A four-byte little-endian number, which is how the reader below takes one. */
function u32(value: number): GSValue {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return new Uint8Array(out);
}

/**
 * One friend, as message 74 — the body its parser takes, field by field.
 *
 * 74 is a PUSH and not a reply, and the difference is in the parser: 0x428f40 hands
 * the body to 0x428d90, which matches the message and then insists `[eax+4] == 0x4A`
 * — the message's own type byte, where a reply would carry the 38/39 envelope with
 * the key repeated inside it. So this goes out unasked, with type 74, and the client
 * takes it.
 *
 * The six fields, and the getter that reads each (a getter refuses the wrong KIND
 * outright and the whole message is then dropped without a word — the same silence
 * that hid the ladder for a day):
 *
 *   0  string    0x4426c0   the friend's name
 *   1  4 bytes   0x442620
 *   2  string    0x4426c0
 *   3  4 bytes   0x442620
 *   4  4 bytes   0x442620
 *   5  string    0x443400   the only optional one: when it is missing the client
 *                           copies a 132-byte default of its own in its place
 *
 * WHAT they mean is not read anywhere — no reading of the exe says which number is a
 * status and which string is a place. So they are filled in the way a friends row
 * plausibly wants, with no two numbers alike, and the client itself will say: it
 * prints all six into the game's log (0xdf45e0) before packing them into a struct,
 * so one launch shows what arrived, and the panel shows which of them it draws.
 */
export function friendUpdate(name: string, state: FriendState): GSValue[] {
  return [name, u32(state.online ? 1 : 0), state.place, u32(state.groupId), u32(state.rating), ''];
}

export class Friends {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Whom this user calls a friend, in the order he added them. */
  of(user: string): readonly string[] {
    const rows = this.db
      .prepare('SELECT friend FROM friends WHERE user = ? ORDER BY added_at, friend')
      .all(user) as { friend: string }[];
    return rows.map((row) => row.friend);
  }

  /** True when the friendship is new; adding the same name twice changes nothing. */
  add(user: string, friend: string): boolean {
    if (!user || !friend) return false;
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user = ?').get(user) as { n: number };
    this.db
      .prepare('INSERT OR IGNORE INTO friends (user, friend, added_at) VALUES (?, ?, ?)')
      .run(user, friend, Date.now());
    const after = this.db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user = ?').get(user) as { n: number };
    return after.n > before.n;
  }

  remove(user: string, friend: string): boolean {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user = ?').get(user) as { n: number };
    this.db.prepare('DELETE FROM friends WHERE user = ? AND friend = ?').run(user, friend);
    const after = this.db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user = ?').get(user) as { n: number };
    return after.n < before.n;
  }
}

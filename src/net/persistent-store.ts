// The persistent-storage desk — where the game keeps a player's profile.
//
// `persistantdata` is one of the modules the client asks the router for, and it
// speaks the module request/reply protocol: request 0x401 reads a record, 0x402
// writes one. Both name the record the same way — the game, a number, the user,
// another number, and a section, which is always "PUBLIC" in this game.
//
// **We do not read what is in a profile.** The client writes bytes and later asks
// for them back; what they mean is its business. That is the whole design: keep the
// bytes under their key and hand them over unchanged. It is also why a profile can
// be supported without understanding a single field of it.
//
// A record travels as a BLOB with its length beside it: the reader (0x442620)
// refuses anything but a blob and refuses one whose length is not the number in the
// next field. So bytes are what is kept here, in a BLOB column — nothing encodes or
// decodes them on the way in or out, which is the only way to be sure a profile with
// any byte in it survives the round trip.
//
// The two numbers in the key are carried but not used to look anything up: both
// were 0 in every request seen, and inventing a meaning for them would be a guess.
//
// Exports:
//   GET_DATA, SET_DATA      the two request numbers
//   PersistentStore         get(key) / set(key, bytes), kept in the database

import type { DatabaseSync } from 'node:sqlite';

/** Read a record: `[game, n, user, n, section]`. */
export const GET_DATA = 1025;
/** Write one: the same, then the record and a number. */
export const SET_DATA = 1026;

export interface RecordKey {
  game: string;
  user: string;
  section: string;
}


export class PersistentStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** What is stored under a key, or null when nothing was ever written there. */
  get(key: RecordKey): Buffer | null {
    const row = this.db
      .prepare('SELECT record FROM profiles WHERE game = ? AND user = ? AND section = ?')
      .get(key.game, key.user, key.section) as { record: Uint8Array } | undefined;
    return row ? Buffer.from(row.record) : null;
  }

  set(key: RecordKey, record: Buffer): void {
    this.db
      .prepare(
        'INSERT INTO profiles (game, user, section, record) VALUES (?, ?, ?, ?)' +
          ' ON CONFLICT (game, user, section) DO UPDATE SET record = excluded.record',
      )
      .run(key.game, key.user, key.section, record);
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
  }
}

/**
 * The key a request names, read out of its argument list.
 *
 * Both requests start the same way, so both are read the same way; SET_DATA then
 * carries the record at index 5.
 */
export function recordKeyOf(args: readonly unknown[], fallbackUser: string): RecordKey {
  return {
    game: typeof args[0] === 'string' ? args[0] : '',
    user: typeof args[2] === 'string' && args[2] ? args[2] : fallbackUser,
    section: typeof args[4] === 'string' ? args[4] : 'PUBLIC',
  };
}

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
// next field. So bytes are what is kept here — base64 in the file, so that a profile
// with any byte in it survives a round trip through JSON.
//
// The two numbers in the key are carried but not used to look anything up: both
// were 0 in every request seen, and inventing a meaning for them would be a guess.
//
// Exports:
//   GET_DATA, SET_DATA      the two request numbers
//   PersistentStore         get(key) / set(key, bytes), persisted as JSON

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read a record: `[game, n, user, n, section]`. */
export const GET_DATA = 1025;
/** Write one: the same, then the record and a number. */
export const SET_DATA = 1026;

export interface RecordKey {
  game: string;
  user: string;
  section: string;
}

/** What joins the parts of a key. Chosen to be visible: it lands in the file. */
const SEPARATOR = ' | ';

/** One record's identity as a single string, for the file and the map. */
function keyOf({ game, user, section }: RecordKey): string {
  return [game, user, section].join(SEPARATOR);
}

export class PersistentStore {
  private records = new Map<string, Buffer>();
  private readonly file: string;

  constructor(file = 'data/profiles.json') {
    this.file = file;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
      this.records = new Map(Object.entries(saved).map(([key, data]) => [key, Buffer.from(data, 'base64')]));
    } catch {
      // No file yet, or one we cannot read: an empty store is the honest state, and
      // the first write replaces it.
    }
  }

  /** What is stored under a key, or null when nothing was ever written there. */
  get(key: RecordKey): Buffer | null {
    return this.records.get(keyOf(key)) ?? null;
  }

  set(key: RecordKey, record: Buffer): void {
    this.records.set(keyOf(key), Buffer.from(record));
    this.save();
  }

  get size(): number {
    return this.records.size;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const out: Record<string, string> = {};
    for (const [key, record] of this.records) out[key] = record.toString('base64');
    writeFileSync(this.file, `${JSON.stringify(out, null, 2)}\n`);
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

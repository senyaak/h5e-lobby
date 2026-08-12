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
// The two numbers in the key are carried but not used to look anything up: both
// were 0 in every request seen, and inventing a meaning for them would be a guess.
//
// A record is a STRING, not a blob: the client appends it with the string appender
// (0x442a20 asks for kind 1) and reads it back with a string getter (0x4435c0
// insists on kind 1, where 2 would be a blob). A GS string is NUL-terminated on the
// wire, so a profile cannot contain a zero byte — but it can contain bytes that are
// not valid UTF-8, and `set` says so rather than storing mojibake silently.
//
// Exports:
//   GET_DATA, SET_DATA      the two request numbers
//   PersistentStore         get(key) / set(key, text), persisted as JSON

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read a record: `[game, n, user, n, section]`. */
export const GET_DATA = 1025;
/** Write one: the same, then the bytes and a number. */
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
  private readonly records = new Map<string, string>();
  private readonly file: string;

  constructor(file = 'data/profiles.json') {
    this.file = file;
    try {
      this.records = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>));
    } catch {
      // No file yet, or one we cannot read: an empty store is the honest state, and
      // the first write replaces it.
    }
  }

  /** What is stored under a key, or null when nothing was ever written there. */
  get(key: RecordKey): string | null {
    return this.records.get(keyOf(key)) ?? null;
  }

  /**
   * Keep a record. The return value is a note for the log: normally null, and a
   * complaint when the text arrived with bytes that are not valid UTF-8, because
   * then what we hand back later will not be what was written.
   */
  set(key: RecordKey, text: string): string | null {
    this.records.set(keyOf(key), text);
    this.save();
    return text.includes('�') ? 'the record has bytes that are not UTF-8; it will not round-trip' : null;
  }

  get size(): number {
    return this.records.size;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`);
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

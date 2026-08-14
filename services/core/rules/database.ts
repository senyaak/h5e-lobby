// One database for everything a player leaves behind: his account, his profile,
// his rating, his friends.
//
// WHY SQLITE, AND WHY THIS ONE. Three JSON files rewritten whole on every change
// was fine while nothing depended on them and one player existed. Accounts change
// that: a password is a thing you must not lose to a half-written file, two clients
// will write at once, and "read it all, change one field, write it all back" is the
// shape that loses the other client's write. `node:sqlite` is in Node itself since
// 22.5 and needs no build step, no `node_modules`, no compiler — which is the rule
// this project keeps everywhere else (see the README): no native dependencies.
//
// The schema is small enough to read in one screen, and it is created on open, so
// there is no migration step to run and no way to start with the wrong one.
//
// THE OLD FILES ARE IMPORTED ONCE. `data/ladder.json`, `data/profiles.json` and
// `data/friends.json` are read on first open if they exist and the tables are empty,
// then LEFT ALONE — not deleted, not rewritten. A rating that took a session to earn
// should not vanish because the storage changed underneath it, and a file nobody
// deletes is a file somebody can still read.
//
// Exports:
//   openDatabase(path)   the database, schema applied and legacy files imported

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    name       TEXT PRIMARY KEY COLLATE NOCASE,
    salt       BLOB NOT NULL,
    hash       BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL,
    logins     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS profiles (
    game    TEXT NOT NULL,
    user    TEXT NOT NULL COLLATE NOCASE,
    section TEXT NOT NULL,
    record  BLOB NOT NULL,
    PRIMARY KEY (game, user, section)
  );

  CREATE TABLE IF NOT EXISTS ladder (
    user   TEXT PRIMARY KEY COLLATE NOCASE,
    rating INTEGER NOT NULL,
    stats  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friends (
    user   TEXT NOT NULL COLLATE NOCASE,
    friend TEXT NOT NULL COLLATE NOCASE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user, friend)
  );

  CREATE TABLE IF NOT EXISTS chat (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    nick    TEXT NOT NULL,
    text    TEXT NOT NULL,
    said_at INTEGER NOT NULL,
    origin  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS chat_by_channel ON chat (channel, id);
`;

/**
 * The whole ladder row is kept as JSON in one column, with the rating beside it.
 *
 * Forty-six columns would be forty-six migrations the first time the client turns out
 * to want a forty-seventh; the rating is the only one anything sorts or compares by,
 * so it is the only one that earns a column of its own.
 */
export interface LadderRowRecord {
  user: string;
  rating: number;
  stats: Record<string, number>;
}

function tableIsEmpty(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n === 0;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Bring across whatever the JSON stores hold, once, and only into empty tables.
 *
 * There are no accounts to import: nobody had a password until now, so the first
 * login of each name creates one. That is the same thing that happens to a new
 * player, which is why it needs no special case.
 */
function importLegacy(db: DatabaseSync, dataDir: string): string[] {
  const done: string[] = [];
  const now = Date.now();

  const ladder = readJson<Record<string, Record<string, number>>>(join(dataDir, 'ladder.json'));
  if (ladder && tableIsEmpty(db, 'ladder')) {
    const insert = db.prepare('INSERT OR IGNORE INTO ladder (user, rating, stats) VALUES (?, ?, ?)');
    for (const [user, stats] of Object.entries(ladder)) insert.run(user, stats['RATING'] ?? 0, JSON.stringify(stats));
    done.push(`${Object.keys(ladder).length} ladder row(s)`);
  }

  const profiles = readJson<Record<string, string>>(join(dataDir, 'profiles.json'));
  if (profiles && tableIsEmpty(db, 'profiles')) {
    const insert = db.prepare('INSERT OR IGNORE INTO profiles (game, user, section, record) VALUES (?, ?, ?, ?)');
    for (const [key, base64] of Object.entries(profiles)) {
      // The old key was the three parts joined with " | ", which is why the separator
      // was chosen to be visible in the first place.
      const [game = '', user = '', section = 'PUBLIC'] = key.split(' | ');
      insert.run(game, user, section, Buffer.from(base64, 'base64'));
    }
    done.push(`${Object.keys(profiles).length} profile(s)`);
  }

  const friends = readJson<Record<string, string[]>>(join(dataDir, 'friends.json'));
  if (friends && tableIsEmpty(db, 'friends')) {
    const insert = db.prepare('INSERT OR IGNORE INTO friends (user, friend, added_at) VALUES (?, ?, ?)');
    let count = 0;
    for (const [user, list] of Object.entries(friends)) {
      for (const friend of list) {
        insert.run(user, friend, now);
        count++;
      }
    }
    done.push(`${count} friendship(s)`);
  }

  return done;
}

export interface OpenedDatabase {
  db: DatabaseSync;
  /** What was brought across from the JSON files, for the log to say out loud. */
  imported: string[];
}

/**
 * Open (or create) the database at `path`, apply the schema, import the old files.
 *
 * `:memory:` is a database that lives as long as the process, which is what the tests
 * want: no file to delete first, no state carried from last week's run.
 */
export function openDatabase(path = 'data/lobby.db'): OpenedDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // A lobby is a handful of writes a minute from a handful of sockets; WAL is for the
  // day two clients write at once, and it costs nothing today.
  db.exec('PRAGMA journal_mode = WAL');
  // That day arrived: the core and the game gateway are two processes now, and they hold
  // this same file open (docs/ARCHITECTURE.md, "Where the seam actually runs"). WAL lets
  // them, but a writer still has to wait its turn, and without this a write that collides
  // fails instantly with SQLITE_BUSY instead of taking the millisecond it needs.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const imported = path === ':memory:' ? [] : importLegacy(db, dirname(path));
  return { db, imported };
}

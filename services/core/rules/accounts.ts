// Accounts: who a name belongs to, and whether the password matches.
//
// The client has no registration screen — `UI/MPRegister` is a progress window — but
// it does have the two errors a server needs to say ("name taken", "wrong password"),
// and the wire has NEWUSERREQUEST. Сеня chose the simplest thing that needs no client
// change: **the first login of a name creates the account**, with the password given
// then. Every login after that has to match it.
//
// HOW A PASSWORD IS KEPT. `scrypt`, from `node:crypto`, with sixteen random bytes of
// salt per user and a 64-byte hash; the comparison is `timingSafeEqual`. Nothing here
// is clever, and that is the point: the password is not ours, it is the player's, and
// the one thing this server must not do is keep a copy of it.
//
// The client sends it in a body opened with a key we generated (GS_ENCRYPT), so it
// does not travel in the clear over the wire — but that key exchange is the game's,
// not a secret we chose, so the storage has to stand on its own anyway.
//
// WHAT THE PARAMETERS COST. N=16384, r=8, p=1 is the node default and takes a few
// milliseconds here, which is nothing against a login that happens once per session,
// and enough that a stolen database is not a list of passwords.
//
// WHERE AN ACCOUNT CAN BE MADE: in the game, and nowhere else. `verify` below is the
// door the browser uses, and it refuses a name it has never seen instead of creating it.
// One way in means one place where a password is first set, and it is the one the player
// has to reach anyway — a registration form on the web would be a second door to the same
// accounts, needing everything a public sign-up needs, for nothing gained.
//
// Exports:
//   Accounts   login(name, password) -> the verdict; verify(...) for the web; forget(name)

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SALT_BYTES = 16;
const HASH_BYTES = 64;

/**
 * What happened when a name and a password arrived.
 *
 * `created` and `welcome-back` both mean "let him in"; they are two answers rather
 * than one because the log should say which, and because a first login is the moment
 * to seed anything a new player needs.
 */
export type LoginVerdict = 'created' | 'welcome-back' | 'wrong-password';

/**
 * The same question asked from outside the game, where nothing may be created.
 *
 * `no-such-account` is a different answer from `wrong-password` on purpose: the page has
 * to be able to say "log in once in the game first", which is advice and not a leak —
 * the game itself already tells anyone who asks whether a name is taken, by creating it
 * or refusing it.
 */
export type VerifyVerdict = 'ok' | 'wrong-password' | 'no-such-account';

function hashOf(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, HASH_BYTES);
}

export interface AccountRow {
  name: string;
  createdAt: number;
  seenAt: number;
  logins: number;
}

export class Accounts {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Let a name in, creating it the first time it is seen.
   *
   * An empty password is accepted and stored like any other, because refusing it is a
   * policy this server has no way to explain to the client — its login failure carries
   * a number, not a sentence.
   */
  login(name: string, password: string): LoginVerdict {
    const now = Date.now();
    const row = this.db.prepare('SELECT salt, hash FROM users WHERE name = ?').get(name) as
      | { salt: Uint8Array; hash: Uint8Array }
      | undefined;
    if (!row) {
      const salt = randomBytes(SALT_BYTES);
      this.db
        .prepare('INSERT INTO users (name, salt, hash, created_at, seen_at, logins) VALUES (?, ?, ?, ?, ?, 1)')
        .run(name, salt, hashOf(password, salt), now, now);
      return 'created';
    }
    const expected = Buffer.from(row.hash);
    const actual = hashOf(password, Buffer.from(row.salt));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'wrong-password';
    this.db.prepare('UPDATE users SET seen_at = ?, logins = logins + 1 WHERE name = ?').run(now, name);
    return 'welcome-back';
  }

  /**
   * Check a name and a password, and create nothing.
   *
   * The canonical spelling comes back with the verdict: the table is NOCASE, so a player
   * who types `senyaak` in the browser is the same account as `Senyaak` in the game and
   * must be drawn under the one name, or the chat has two people in it.
   */
  verify(name: string, password: string): { verdict: VerifyVerdict; name: string } {
    const row = this.db.prepare('SELECT name, salt, hash FROM users WHERE name = ?').get(name) as
      | { name: string; salt: Uint8Array; hash: Uint8Array }
      | undefined;
    if (!row) return { verdict: 'no-such-account', name };
    const expected = Buffer.from(row.hash);
    const actual = hashOf(password, Buffer.from(row.salt));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { verdict: 'wrong-password', name: row.name };
    }
    // Seen, but not a login: `logins` counts the game's, and a browser tab left open
    // overnight should not read as somebody who plays a great deal.
    this.db.prepare('UPDATE users SET seen_at = ? WHERE name = ?').run(Date.now(), row.name);
    return { verdict: 'ok', name: row.name };
  }

  /** Whether a name exists at all — for a log line, and for tests. */
  has(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM users WHERE name = ?').get(name) !== undefined;
  }

  get(name: string): AccountRow | null {
    const row = this.db
      .prepare('SELECT name, created_at AS createdAt, seen_at AS seenAt, logins FROM users WHERE name = ?')
      .get(name) as AccountRow | undefined;
    return row ?? null;
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /**
   * Delete an account and everything under it.
   *
   * Here because a server that can create an account and not remove one is a server
   * whose test data is forever. Deleting is never refused; what it takes with it is
   * said plainly instead: the profile, the ladder row and the friendships all go. There is
   * nothing of his agent to delete — an agent is an endpoint in a live room, not a row.
   */
  forget(name: string): void {
    this.db.prepare('DELETE FROM users WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM profiles WHERE user = ?').run(name);
    this.db.prepare('DELETE FROM ladder WHERE user = ?').run(name);
    this.db.prepare('DELETE FROM friends WHERE user = ? OR friend = ?').run(name, name);
  }
}

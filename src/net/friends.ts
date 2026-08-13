// Who has whom on his friends list.
//
// The client asks for exactly two things here — log in to the friends service, and
// "add this name" from the right-click in a channel — and both are answered on the
// router. What a friendship *does* is still nothing: the client keeps its own list
// for the session, and pushing changes to it (message 76 is a removal, 79…81 and 88…91
// are the rest of the family) is not written yet. Keeping the list anyway is what
// makes it a server rather than an echo: added once, a friend is still there next
// launch, and that is the difference the next session will want.
//
// One row per friendship, in the same database as everything else a player leaves
// behind — and with the time it was made, because "in the order he added them" is the
// order a list is drawn in and it should not depend on how the rows come back.
//
// Exports:
//   Friends   the store: of(user), add(user, friend), remove(user, friend)

import type { DatabaseSync } from 'node:sqlite';

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

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
// The file is the same shape as the ladder's and the profiles': one JSON object,
// rewritten whole. Nothing here is big enough to deserve more.
//
// Exports:
//   Friends   the store: of(user), add(user, friend), remove(user, friend)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Friends {
  private readonly file: string;
  private readonly lists = new Map<string, string[]>();

  constructor(file: string) {
    this.file = file;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
      for (const [user, friends] of Object.entries(stored)) this.lists.set(user, [...friends]);
    } catch {
      // Nobody has added anybody yet, which is where every server starts.
    }
  }

  /** Whom this user calls a friend, in the order he added them. */
  of(user: string): readonly string[] {
    return this.lists.get(user) ?? [];
  }

  /** True when the friendship is new; adding the same name twice changes nothing. */
  add(user: string, friend: string): boolean {
    if (!user || !friend) return false;
    const list = this.lists.get(user) ?? [];
    if (list.includes(friend)) return false;
    this.lists.set(user, [...list, friend]);
    this.save();
    return true;
  }

  remove(user: string, friend: string): boolean {
    const list = this.lists.get(user);
    if (!list?.includes(friend)) return false;
    this.lists.set(
      user,
      list.filter((name) => name !== friend),
    );
    this.save();
    return true;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.lists), null, 2)}\n`);
  }
}

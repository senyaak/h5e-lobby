// The agents: one per installed copy of the game, and which player each one is.
//
// An agent is not a session and not an account. It is the piece of the native extension
// that carries a player's game traffic (docs/ARCHITECTURE.md), and it proves who it is
// with a long-lived secret issued once — by the launcher eventually, by
// `tools/issue-agent.ts` today. The secret is put in the extension's config on that
// machine; the game itself never sees it and never passes it on.
//
// WHAT IS STORED IS A HASH, not the secret. The lookup is by the secret the agent
// presents, so hashing costs nothing here — sha256 of a 32-byte random string needs no
// salt or stretching, because there is no weak password to protect, only a long random
// one — and a copy of the database stops being a list of live credentials.
//
// WHICH ROOM an agent is in is deliberately NOT here. That changes every time somebody
// joins a game, it belongs to the gateway, and it reaches the core as `rooms.replace`.
// This table answers only "whose agent is this", which is the half that never changes.
//
// Exports:
//   Agents   issue(name) -> the secret, resolve(secret) -> the name, forget(name)

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface AgentRow {
  name: string;
  issuedAt: number;
}

export class Agents {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * A new secret for this player, replacing whatever he had.
   *
   * One agent per player, because one player plays on one machine at a time and a second
   * issue is what you do when a copy is reinstalled or a secret leaks. Re-issuing is
   * therefore also how an agent is revoked.
   */
  issue(name: string): string {
    const secret = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO agents (name, token_hash, issued_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, issued_at = excluded.issued_at')
      .run(name, hashOf(secret), Date.now());
    return secret;
  }

  /** Whose agent this is, or empty for a secret nobody was given. */
  resolve(secret: string): string {
    if (!secret) return '';
    const row = this.db.prepare('SELECT name FROM agents WHERE token_hash = ?').get(hashOf(secret)) as
      | { name: string }
      | undefined;
    return row?.name ?? '';
  }

  get(name: string): AgentRow | null {
    const row = this.db.prepare('SELECT name, issued_at AS issuedAt FROM agents WHERE name = ?').get(name) as
      | AgentRow
      | undefined;
    return row ?? null;
  }

  /** Take an agent away. The next connection with that secret is a stranger. */
  forget(name: string): void {
    this.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
  }
}

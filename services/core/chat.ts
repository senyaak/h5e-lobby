// Chat, and the first state the core keeps that the game never asked for.
//
// The game's own chat is IRC and it is live only: a line exists while it is in flight and
// then it is gone. That is fine for two people already sitting in a channel and useless
// for the thing the web lobby is FOR — a message written while nobody is playing has to
// still be there when somebody opens the browser an hour later. So every line goes to the
// database on its way through, whoever typed it and wherever it came from.
//
// The text stored is the bare sentence, not the game's presentation wrapper
// (`nick%colour%size%0%0%font%text`, see services/u-lobby/irc.ts). The wrapper is how one client
// draws a line; it is not what was said, and a browser must not have to strip it.
//
// Exports:
//   ChatStore   post(line) -> the stored message, history(channel, limit)

import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, Origin } from '../../shared/core-protocol.ts';

interface Row {
  id: number;
  channel: string;
  nick: string;
  text: string;
  said_at: number;
  origin: string;
}

function asMessage(row: Row): ChatMessage {
  return { id: row.id, channel: row.channel, nick: row.nick, text: row.text, at: row.said_at, origin: row.origin as Origin };
}

/** Long enough to scroll back through, short enough that a JOIN does not send a novel. */
export const HISTORY_DEFAULT = 50;

export class ChatStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Store a line and hand back what it became, id and time included. */
  post(line: { channel: string; nick: string; text: string; origin: Origin; at?: number }): ChatMessage {
    const at = line.at ?? Date.now();
    const result = this.db
      .prepare('INSERT INTO chat (channel, nick, text, said_at, origin) VALUES (?, ?, ?, ?, ?)')
      .run(line.channel, line.nick, line.text, at, line.origin);
    return {
      id: Number(result.lastInsertRowid),
      channel: line.channel,
      nick: line.nick,
      text: line.text,
      at,
      origin: line.origin,
    };
  }

  /** The last `limit` lines of a channel, oldest first — the order they are read in. */
  history(channel: string, limit = HISTORY_DEFAULT): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM chat WHERE channel = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(channel, Math.max(1, Math.min(limit, 500))) as unknown as Row[];
    return rows.map(asMessage);
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chat').get() as unknown as { n: number };
    return row.n;
  }
}

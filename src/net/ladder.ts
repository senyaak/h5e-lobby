// The ladder: the one part of this server with no prior art at all.
//
// The client asks for it by name and knows exactly which numbers it wants — the 46
// keys below are read out of the exe at 0xFE5CC0, in the exe's own order — but
// nothing on the other side of that request has ever existed in the open. So the
// storage, the starting rating and the arithmetic are ours to choose, and they are
// chosen here rather than scattered through the wire code.
//
// What is measured and what is guessed:
//   measured  the key names, their order, that the client asks for one row pivoted
//             on a player (LadderQuery_RequestPivotUser), and — since 13.08.2026 —
//             the whole layout of the answer, read out of the parser at 0x432c80
//   guessed   what the two numbers at the head of the table mean, and what the second
//             string of a column descriptor is for; both are marked below
//
// Exports:
//   LADDER_KEYS         every stat the client names, in the exe's order
//   Ladder              the store: row(name), record(name, patch), top(n)
//   ladderPayload(...)  the whole result table, as the reply carries it

import type { DatabaseSync } from 'node:sqlite';
import { type GSValue } from './gs-data.ts';

/** The eight factions, in the order the exe lists them. */
export const FACTIONS = [
  'HEAVEN',
  'PRESERVE',
  'ACADEMY',
  'DUNGEON',
  'NECROMANCY',
  'INFERNO',
  'DWARVES',
  'ORCS',
] as const;

/**
 * Every key the client names, in the order they sit in the exe (0xFE5CC0…0xFE5F1C).
 *
 * `W_` and `L_` are wins and losses with that faction. `H_` and `G_` are NOT known —
 * they are in the same table and the same order, and naming them from their letters
 * would be a guess, so they are carried and reported as they are.
 */
export const LADDER_KEYS: readonly string[] = [
  'RATING',
  'GAMES_PLAYED',
  'WINS',
  'LOSSES',
  'MAX_WINS_STREAK',
  'MAX_LOSSES_STREAK',
  'CUR_WINS_STREAK',
  'CUR_LOSSES_STREAK',
  'TOT_TIME_PLAYED',
  'TOT_HEROES_HIRED',
  'TOT_HEROES_LOST',
  'TOT_HEROES_DEFEATED',
  ...FACTIONS.map((race) => `W_${race}`),
  ...FACTIONS.map((race) => `L_${race}`),
  ...FACTIONS.map((race) => `H_${race}`),
  ...FACTIONS.map((race) => `G_${race}`),
  'AVERAGE_HERO_LEVEL',
  'DISCONNECTIONS',
];

/**
 * What a player starts with.
 *
 * 1500 is ours to pick — the client displays whatever it is told, and a first game
 * against an unrated stranger has to start somewhere. Everything else starts at zero
 * because nothing has happened yet.
 */
export const STARTING_RATING = 1500;

export type LadderStats = Record<string, number>;

/**
 * Which cell of a submitted results row is what.
 *
 * The stat id is the POSITION in the row's list of values — the client's own log prints
 * them in order, 0…21 — and the meanings below were read off three rated matches against
 * the end-of-game screens of both players (docs/LADDER.md). They are the game's numbering
 * and have nothing to do with `LADDER_KEYS`.
 *
 * `WON` is the one that matters and the one that was hardest to be sure of: in the first
 * two matches it followed the player who HOSTED, and only a third game — deliberately lost
 * by the host — separated "who won" from "which seat".
 */
export const Stat = {
  WON: 0,
  FACTION: 1,
  /** Heroes lost, or battles lost: the screen shows both, and both were 2. */
  HEROES_LOST: 14,
  /** Towns captured, or heroes killed: the screen shows both, and both were 1. */
  HEROES_DEFEATED: 15,
  SECONDS: 17,
} as const;

/** The K of the Elo update. 32 is the usual choice for a young, small pool. */
export const ELO_K = 32;

/**
 * The two new ratings after a game, rounded.
 *
 * Plain Elo, which is a choice rather than a reading: the client displays whatever number
 * it is told and the protocol has no opinion. What the protocol DOES give is the winner
 * (`Stat.WON`), which is all Elo needs.
 */
export function elo(winner: number, loser: number, k = ELO_K): { winner: number; loser: number } {
  const expected = 1 / (1 + 10 ** ((loser - winner) / 400));
  const change = Math.round(k * (1 - expected));
  return { winner: winner + change, loser: loser - change };
}

/** One player's line of a submitted table, as the ladder cares about it. */
export interface MatchResult {
  name: string;
  won: boolean;
  faction: number;
  seconds: number;
  heroesLost: number;
  heroesDefeated: number;
}

/**
 * Read a submitted results row into the fields above.
 *
 * A row is `[name, highestStatId, howMany, mask, [values…]]`. The mask is which stat ids
 * are present and the values are in id order; every match so far has sent ids 0…21 whole,
 * so the values are indexed directly and a missing cell reads as zero.
 */
export function matchResult(row: readonly GSValue[]): MatchResult | null {
  const name = typeof row[0] === 'string' ? row[0] : '';
  const values = Array.isArray(row[4]) ? row[4] : [];
  if (!name || !values.length) return null;
  const at = (id: number): number => Number(typeof values[id] === 'string' ? values[id] : 0) || 0;
  return {
    name,
    won: at(Stat.WON) !== 0,
    faction: at(Stat.FACTION),
    seconds: at(Stat.SECONDS),
    heroesLost: at(Stat.HEROES_LOST),
    heroesDefeated: at(Stat.HEROES_DEFEATED),
  };
}

/**
 * Write a finished rated game into the ladder, for both players at once.
 *
 * Everything here feeds a screen the player can actually look at — the profile draws
 * games, wins, losses, both streaks, hours played, average game length, heroes hired,
 * lost and defeated, and a per-faction table — so the keys are filled in the shape those
 * rows expect rather than as we please.
 *
 * `H_` and `G_` are the two per-faction columns nobody has named. Games and seconds are
 * the only per-faction quantities we have, so they go in one each: whichever way round
 * they land, the profile's two "used" columns will say which is which, and that is
 * cheaper than another reading of the exe.
 */
export function settleMatch(ladder: Ladder, results: readonly MatchResult[]): string {
  const winner = results.find((result) => result.won);
  const loser = results.find((result) => !result.won);
  if (!winner || !loser || results.length !== 2) return 'not a two-player result — the ladder is left alone';

  const before = { winner: ladder.row(winner.name)['RATING'] ?? STARTING_RATING, loser: ladder.row(loser.name)['RATING'] ?? STARTING_RATING };
  const after = elo(before.winner, before.loser);

  for (const [result, rating, won] of [
    [winner, after.winner, true],
    [loser, after.loser, false],
  ] as const) {
    const row = ladder.row(result.name);
    const faction = FACTIONS[result.faction] ?? FACTIONS[0]!;
    const streak = (won ? row['CUR_WINS_STREAK'] : row['CUR_LOSSES_STREAK']) ?? 0;
    ladder.record(result.name, {
      RATING: rating,
      GAMES_PLAYED: (row['GAMES_PLAYED'] ?? 0) + 1,
      WINS: (row['WINS'] ?? 0) + (won ? 1 : 0),
      LOSSES: (row['LOSSES'] ?? 0) + (won ? 0 : 1),
      CUR_WINS_STREAK: won ? streak + 1 : 0,
      CUR_LOSSES_STREAK: won ? 0 : streak + 1,
      MAX_WINS_STREAK: Math.max(row['MAX_WINS_STREAK'] ?? 0, won ? streak + 1 : 0),
      MAX_LOSSES_STREAK: Math.max(row['MAX_LOSSES_STREAK'] ?? 0, won ? 0 : streak + 1),
      TOT_TIME_PLAYED: (row['TOT_TIME_PLAYED'] ?? 0) + result.seconds,
      TOT_HEROES_LOST: (row['TOT_HEROES_LOST'] ?? 0) + result.heroesLost,
      TOT_HEROES_DEFEATED: (row['TOT_HEROES_DEFEATED'] ?? 0) + result.heroesDefeated,
      [`${won ? 'W' : 'L'}_${faction}`]: (row[`${won ? 'W' : 'L'}_${faction}`] ?? 0) + 1,
      [`G_${faction}`]: (row[`G_${faction}`] ?? 0) + 1,
      [`H_${faction}`]: (row[`H_${faction}`] ?? 0) + result.seconds,
    });
  }

  return (
    `${winner.name} beat ${loser.name} in ${winner.seconds}s — ` +
    `${before.winner} -> ${after.winner} and ${before.loser} -> ${after.loser}`
  );
}

/** A row of zeroes, rated. What a player has before anything has happened. */
function freshRow(): LadderStats {
  const stats: LadderStats = {};
  for (const key of LADDER_KEYS) stats[key] = 0;
  stats['RATING'] = STARTING_RATING;
  return stats;
}

export class Ladder {
  private readonly db: DatabaseSync;
  /**
   * Rows the SERVER invents, which are code rather than history and never go to disk.
   *
   * The guest is the only one so far. Writing him out would put a player nobody
   * created into the database of every test that builds a service, and he would then
   * outlive the flag that seats him.
   */
  private readonly seeded = new Map<string, LadderStats>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** A player's row, created at the starting rating the first time he is asked for. */
  row(name: string): LadderStats {
    const stored = this.db.prepare('SELECT stats FROM ladder WHERE user = ?').get(name) as
      | { stats: string }
      | undefined;
    if (stored) return { ...freshRow(), ...(JSON.parse(stored.stats) as LadderStats) };
    const seeded = this.seeded.get(name);
    if (seeded) return seeded;
    return freshRow();
  }

  /** A row for a player the server invents — in memory, and only if he has none. */
  seed(name: string, stats: LadderStats): void {
    if (this.seeded.has(name)) return;
    this.seeded.set(name, { ...freshRow(), ...stats });
  }

  /** Change some of a player's numbers and keep them. */
  record(name: string, patch: LadderStats): LadderStats {
    const row = { ...this.row(name), ...patch };
    this.db
      .prepare(
        'INSERT INTO ladder (user, rating, stats) VALUES (?, ?, ?)' +
          ' ON CONFLICT (user) DO UPDATE SET rating = excluded.rating, stats = excluded.stats',
      )
      .run(name, row['RATING'] ?? 0, JSON.stringify(row));
    this.seeded.delete(name);
    return row;
  }

  /** The best `count` players by rating, best first — for a ladder screen later. */
  top(count: number): { name: string; stats: LadderStats }[] {
    const rows = this.db
      .prepare('SELECT user, stats FROM ladder ORDER BY rating DESC LIMIT ?')
      .all(count) as { user: string; stats: string }[];
    return rows.map((row) => ({ name: row.user, stats: JSON.parse(row.stats) as LadderStats }));
  }

  /** How many players are on the ladder at all. */
  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM ladder').get() as { n: number }).n;
  }
}

/**
 * The result table, in the shape the client's own parser takes it apart in.
 *
 * Read at 0x432c80, which is the whole of what a successful ladder answer has to be.
 * Every step of it refuses in silence, so each one is worth naming:
 *
 *   payload[0]  a decimal string that must read as **1** (0x443740 is atoi on a
 *               string field); anything else and the parser returns 7, which the
 *               caller turns into "failed, reason 63"
 *   payload[1]  the table, a list of four:
 *     [0]       **the request's own id**, and getting this wrong cost a day. It is
 *               kept at result+8, and the reader (0x42c7f0) — having already resolved
 *               the right id out of its pending map — OVERWRITES it with this one at
 *               0x42c987 before handing it to the game. The game compares it with what
 *               it is waiting for and drops the reply as "not waiting reply with
 *               RequestId=N" when they differ. So it is not ours to choose: it is the
 *               number the query carried, `body[2][1][0]`, which counts 1, 2, 3 …
 *               across a session while the module's own id counts 1, 3, 5, 7
 *     [1]       another number, kept at result+0xC. The client prints both in
 *               `StartResultEntryEnumeration(id,N)`; 0 works and nothing has needed
 *               more — the one guess left in this file
 *     [2]       the COLUMNS: a list of pairs of strings, each at most 32 characters.
 *               Element 0 is the column's name and it is pushed onto the result's own
 *               ordered vector; element 1 goes into a second map and nothing we have
 *               read ever looks at it — "1" is ours, and a guess
 *     [3]       the ROWS: a list of lists of strings, at most 128 characters each
 *
 * The rule that makes or breaks it: 0x432b10 compares a row's cell count with the
 * column count and returns error 3 if they differ — so every row is exactly as long
 * as the column list, no shortcuts for absent stats. Each row becomes a map from
 * column name to cell, and `LadderQuery_GetCurrentEntryField` runs the cell through
 * `strtol` and insists the WHOLE cell was consumed (0x431f20). So every value here is
 * a plain decimal number: no names, no empty cells, no units.
 *
 * The verdict is one line in the game's log — `LadderQueryRcv_RequestReply: (38,…)`
 * and `LadderQuery_StartResultEntryEnumeration(…) succeeded` against "ladder query
 * request failed,reason=…", where 63 is a bad tag and 64 a table the parser gave up on.
 */
export function ladderPayload(
  requestId: string,
  rows: readonly LadderStats[],
  keys: readonly string[] = LADDER_KEYS,
): GSValue[] {
  return [
    '1',
    [
      requestId,
      '0',
      keys.map((key) => [key, '1']),
      rows.map((row) => keys.map((key) => String(Math.trunc(row[key] ?? 0)))),
    ],
  ];
}

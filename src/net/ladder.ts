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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

export class Ladder {
  private readonly file: string;
  private readonly players = new Map<string, LadderStats>();

  constructor(file: string) {
    this.file = file;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, LadderStats>;
      for (const [name, stats] of Object.entries(stored)) this.players.set(name, stats);
    } catch {
      // No ladder yet is the normal state of a new server, not an error.
    }
  }

  /** A player's row, created at the starting rating the first time he is asked for. */
  row(name: string): LadderStats {
    const known = this.players.get(name);
    if (known) return known;
    const fresh: LadderStats = {};
    for (const key of LADDER_KEYS) fresh[key] = 0;
    fresh['RATING'] = STARTING_RATING;
    this.players.set(name, fresh);
    return fresh;
  }

  /**
   * A row for a player the SERVER invents, put in without touching the file.
   *
   * The guest's numbers are code, not history: writing them out would mean every test
   * that builds a service leaves a row behind in whatever ladder file it defaulted to.
   * A player who really exists gets his row through `record`.
   */
  seed(name: string, stats: LadderStats): void {
    if (this.players.has(name)) return;
    this.players.set(name, { ...this.row(name), ...stats });
  }

  /** Change some of a player's numbers and write the file. */
  record(name: string, patch: LadderStats): LadderStats {
    const row = { ...this.row(name), ...patch };
    this.players.set(name, row);
    this.save();
    return row;
  }

  /** The best `count` players by rating, best first — for a ladder screen later. */
  top(count: number): { name: string; stats: LadderStats }[] {
    return [...this.players.entries()]
      .map(([name, stats]) => ({ name, stats }))
      .sort((a, b) => (b.stats['RATING'] ?? 0) - (a.stats['RATING'] ?? 0))
      .slice(0, count);
  }

  /** How many players are on the ladder at all. */
  get size(): number {
    return this.players.size;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.players), null, 2)}\n`);
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
 *     [0], [1]  two numbers (0x4435c0, atoi). They are kept as fields of the result
 *               (+8 and +0xC); +8 is what the game reads back as a count. Ours are
 *               the number of rows and 0 — **the meaning is a guess**, and the only
 *               one left in this file
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
  rows: readonly LadderStats[],
  keys: readonly string[] = LADDER_KEYS,
): GSValue[] {
  return [
    '1',
    [
      String(rows.length),
      '0',
      keys.map((key) => [key, '1']),
      rows.map((row) => keys.map((key) => String(Math.trunc(row[key] ?? 0)))),
    ],
  ];
}

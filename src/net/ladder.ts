// The ladder: the one part of this server with no prior art at all.
//
// The client asks for it by name and knows exactly which numbers it wants — the 46
// keys below are read out of the exe at 0xFE5CC0, in the exe's own order — but
// nothing on the other side of that request has ever existed in the open. So the
// storage, the starting rating and the arithmetic are ours to choose, and they are
// chosen here rather than scattered through the wire code.
//
// What is measured and what is guessed:
//   measured  the key names, their order, and that the client asks for one row
//             pivoted on a player (LadderQuery_RequestPivotUser)
//   guessed   how a row is laid out in the reply — `ladderRow` marks it, and the
//             client's own log line is the oracle: `LadderQueryRcv_RequestReply`
//             prints "succeeded" or "ladder query request failed,reason=…"
//
// Exports:
//   LADDER_KEYS         every stat the client names, in the exe's order
//   Ladder              the store: row(name), record(name, patch), top(n)
//   ladderRow(...)      one row as the reply carries it

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
 * One row as the reply carries it: the player, then his numbers as named pairs.
 *
 * **This layout is the guess in the whole file.** What is known is that the client
 * enumerates entries (`LadderQuery_StartResultEntryEnumeration`) and then asks each
 * one for a field BY NAME (`LadderQuery_GetCurrentEntryField`), which is why the keys
 * travel with the values instead of being implied by position. If the client reads it
 * as something else, its log says so in one line — see the file header.
 */
export function ladderRow(name: string, stats: LadderStats, keys: readonly string[] = LADDER_KEYS): GSValue[] {
  return [name, keys.map((key) => [key, String(stats[key] ?? 0)])];
}

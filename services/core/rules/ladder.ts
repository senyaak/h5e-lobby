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
  /**
   * The average hero level, in the SAME 16.16 fixed point the ladder key wants.
   *
   * It arrived as 65536 from everybody and 98304 from one player, which is 1.0 and 1.5 —
   * and `AVERAGE_HERO_LEVEL` is the one key the profile divides by 65536 (0x93F4C0). Two
   * fixed-point numbers meeting like that is not a coincidence, but it is still a reading
   * of two values: the profile line will confirm it, since it has been empty until now.
   */
  AVERAGE_HERO_LEVEL: 16,
  SECONDS: 17,
} as const;

/** The K of the Elo update. 32 is the usual choice for a young, small pool. */
export const ELO_K = 32;

/**
 * Experience and rating are two different things, and the client has one field for them.
 *
 * `RATING` is what the profile turns into a rank, by dividing by 100 and looking the level
 * up in eleven bands whose top begins at 40000 (docs/LADDER.md). That is a scale for
 * POINTS PER GAME, not for a competitive rating: Elo's ±16 a game would leave everybody a
 * peasant for life. So `RATING` carries experience — more for winning, something for
 * turning up — and it is what the player sees, as his rank and beside his name.
 *
 * The competitive number is kept too, under a key of our own that is **not** one of the 46
 * the client asks for, so it never leaves this server. Nothing reads it yet; it is what a
 * future "play someone your own strength" would be built on, and it costs one column in a
 * row we already write.
 */
export const XP_FOR_A_WIN = 100;
export const XP_FOR_A_LOSS = 25;

/** Our own column, invisible to the client: `ladderPayload` only sends `LADDER_KEYS`. */
export const ELO = 'ELO';

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
  // **Never below zero.** The client turns the rating into a level by dividing by 100
  // (0x93CD4B) and looks that level up in a table of eleven ranks; a level under zero
  // matches no row, and the screen then draws an EMPTY rank with no icon (0x93D451,
  // against a zeroed record). A rating of exactly 0 is fine — level 0, rank one, an
  // empty progress bar — so the floor is 0 rather than anything cleverer.
  return { winner: winner + change, loser: Math.max(0, loser - change) };
}

/** One player's line of a submitted table, as the ladder cares about it. */
export interface MatchResult {
  name: string;
  won: boolean;
  faction: number;
  seconds: number;
  heroesLost: number;
  heroesDefeated: number;
  /** Already 16.16 fixed point, which is what the ladder key wants — passed through. */
  averageHeroLevel: number;
}

/**
 * Write a finished rated game into the ladder, for both players at once.
 *
 * Everything here feeds a screen the player can actually look at — the profile draws
 * games, wins, losses, both streaks, hours played, average game length, heroes hired,
 * lost and defeated, and a per-faction table — so the keys are filled in the shape those
 * rows expect rather than as we please.
 *
 * `G_` is "armies used", drawn as a percentage of that player's own total — so only the
 * proportion between factions matters, and one per game says "this much of my play was
 * with this faction". It is not decoration: the alignment needle and "favourite faction"
 * are computed from it alone (0x93C611, 0x93D5E5), and with it empty the needle sits dead
 * centre and the favourite is always Haven.
 *
 * **`H_` is left alone.** Its sum is what the profile calls "heroes hired", and we do not
 * know how many heroes anybody hired — the results table has no such number. Filled with
 * a stand-in it reported nonsense: seconds went in there once, and the profile duly said
 * "Нанято героев: 337". An empty line is honest; a wrong one is not.
 */
export function settleMatch(ladder: Ladder, results: readonly MatchResult[]): string {
  const winner = results.find((result) => result.won);
  const loser = results.find((result) => !result.won);
  if (!winner || !loser || results.length !== 2) return 'not a two-player result — the ladder is left alone';

  // Two numbers, kept apart. The hidden one is a rating in the competitive sense; the
  // visible one is experience, and it only ever goes up.
  const strength = {
    winner: ladder.row(winner.name)[ELO] ?? STARTING_RATING,
    loser: ladder.row(loser.name)[ELO] ?? STARTING_RATING,
  };
  const rated = elo(strength.winner, strength.loser);

  for (const [result, gained, elo_, won] of [
    [winner, XP_FOR_A_WIN, rated.winner, true],
    [loser, XP_FOR_A_LOSS, rated.loser, false],
  ] as const) {
    const row = ladder.row(result.name);
    const faction = FACTIONS[result.faction] ?? FACTIONS[0]!;
    const streak = (won ? row['CUR_WINS_STREAK'] : row['CUR_LOSSES_STREAK']) ?? 0;
    ladder.record(result.name, {
      RATING: (row['RATING'] ?? STARTING_RATING) + gained,
      [ELO]: elo_,
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
      // The average of the averages, weighted by games — which is as close as a running
      // total gets without keeping every game's number.
      AVERAGE_HERO_LEVEL: Math.round(
        (((row['AVERAGE_HERO_LEVEL'] ?? 0) * (row['GAMES_PLAYED'] ?? 0)) + result.averageHeroLevel) /
          ((row['GAMES_PLAYED'] ?? 0) + 1),
      ),
    });
  }

  return (
    `${winner.name} beat ${loser.name} in ${winner.seconds}s — ` +
    `+${XP_FOR_A_WIN} and +${XP_FOR_A_LOSS} experience, ` +
    `strength ${strength.winner} -> ${rated.winner} and ${strength.loser} -> ${rated.loser}`
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

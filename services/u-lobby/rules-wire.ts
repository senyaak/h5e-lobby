// Where the core's rules meet the client's wire.
//
// A ladder row, a results table and a friend are the core's business; the shapes below are
// the client's, down to which field must be a string and which a four-byte blob. Keeping
// them here is what lets services/core/rules/ hold no protocol at all — the rule the
// architecture claims and, until this file existed, quietly broke by importing GSValue.
//
// Exports:
//   matchResult(row)                  a submitted results row, read
//   ladderPayload(id, rows, keys)     a ladder table, as the client parses one
//   friendUpdate(name, state)         one friend, as message 74's body

import { LADDER_KEYS, Stat, type LadderStats, type MatchResult } from '../core/rules/ladder.ts';
import type { FriendState } from '../core/rules/friends.ts';
import { type GSValue } from './gs-data.ts';

/** A four-byte little-endian number, which is how the reader below takes one. */
function u32(value: number): GSValue {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return new Uint8Array(out);
}

/**
 * Read a submitted results row into a `MatchResult`.
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
    averageHeroLevel: at(Stat.AVERAGE_HERO_LEVEL),
  };
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

/**
 * One friend, as message 74 — the body its parser takes, field by field.
 *
 * 74 is a PUSH and not a reply, and the difference is in the parser: 0x428f40 hands
 * the body to 0x428d90, which matches the message and then insists `[eax+4] == 0x4A`
 * — the message's own type byte, where a reply would carry the 38/39 envelope with
 * the key repeated inside it. So this goes out unasked, with type 74, and the client
 * takes it.
 *
 * The six fields, and the getter that reads each (a getter refuses the wrong KIND
 * outright and the whole message is then dropped without a word — the same silence
 * that hid the ladder for a day):
 *
 *   0  string    0x4426c0   the friend's name
 *   1  4 bytes   0x442620
 *   2  string    0x4426c0
 *   3  4 bytes   0x442620
 *   4  4 bytes   0x442620
 *   5  string    0x443400   the only optional one: when it is missing the client
 *                           copies a 132-byte default of its own in its place
 *
 * WHAT they mean is not read anywhere — no reading of the exe says which number is a
 * status and which string is a place. So they are filled in the way a friends row
 * plausibly wants, with no two numbers alike, and the client itself will say: it
 * prints all six into the game's log (0xdf45e0) before packing them into a struct,
 * so one launch shows what arrived, and the panel shows which of them it draws.
 */
export function friendUpdate(name: string, state: FriendState): GSValue[] {
  return [name, u32(state.online ? 1 : 0), state.place, u32(state.groupId), u32(state.rating), ''];
}

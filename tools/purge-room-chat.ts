// Delete the chat that was kept for rooms, which was never anybody's to read.
//
// WHY THIS EXISTS. A room is a chat channel too and its name is built from the room id —
// and room ids start again at 100 on every restart of the u-lobby. So `#LobbyGrp1.100` is
// not the name of a game, it is the name of a SLOT: "the first room made this run".
// Everything kept under it was handed to whoever got that slot next, and a player opening
// a fresh game was shown a wall of conversation from games that had ended days before.
//
// The u-lobby no longer keeps or replays a room's chat (`isLobbyChannel`). This clears out
// what was kept before it stopped. Nothing reads those rows any more, so it is tidying and
// not a repair — the reason to run it is that a database full of dead rows invites somebody
// to write something that reads them.
//
// WHAT IT WILL NOT TOUCH. Only the `chat` table, and only rows whose channel is not one of
// the lobbies the core publishes. Accounts, profiles, the ladder and friendships are not
// mentioned in this file. The lobbies' own history is kept in full, including whatever the
// guest bot has been saying: that is a lobby's chat and a lobby keeps everything.
//
// Usage:
//   node tools/purge-room-chat.ts            # say what would go, change nothing
//   node tools/purge-room-chat.ts --delete   # do it
//
// Take a copy of data/lobby.db first if the machine matters. This does not take one for
// you, because a backup written by the thing doing the deleting is a backup nobody checked.

import { DatabaseSync } from 'node:sqlite';
import { config } from '../shared/config.ts';
import { gameChannels } from '../shared/channels.ts';

const settings = config();
const doIt = process.argv.includes('--delete');
const keep = gameChannels().map((one) => one.key);
const marks = keep.map(() => '?').join(',');

const db = new DatabaseSync(settings.database);
db.exec('PRAGMA busy_timeout = 5000');

const count = (where: string, ...args: string[]): number =>
  (db.prepare(`SELECT count(*) AS c FROM chat WHERE ${where}`).get(...args) as { c: number }).c;

const staying = count(`channel IN (${marks})`, ...keep);
const going = count(`channel NOT IN (${marks})`, ...keep);

console.log(`database: ${settings.database}`);
console.log(`lobbies kept: ${keep.join('  ')}`);
console.log(`  staying: ${String(staying)} row(s)`);
console.log(`  going:   ${String(going)} row(s)`);

const rows = db
  .prepare(`SELECT channel, count(*) AS c FROM chat WHERE channel NOT IN (${marks}) GROUP BY channel ORDER BY c DESC`)
  .all(...keep) as { channel: string; c: number }[];
for (const row of rows) console.log(`    ${row.channel}  ${String(row.c)}`);

if (!doIt) {
  console.log(going ? '\nnothing done — pass --delete to do it' : '\nnothing to do');
  process.exit(0);
}

const removed = db.prepare(`DELETE FROM chat WHERE channel NOT IN (${marks})`).run(...keep);
console.log(`\ndeleted ${String(removed.changes)} row(s)`);
console.log(`chat now: ${String(count('1 = 1'))} row(s)`);

// Said out loud, because a purge that quietly took something else would look exactly like
// a purge that did not.
for (const table of ['users', 'profiles', 'ladder', 'friends']) {
  const left = (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  console.log(`  ${table.padEnd(9)} ${String(left)} row(s), untouched`);
}

// A one-time repair of the chat history the codepage bug left behind.
//
// Until 15.08.2026 the u-lobby read the game's chat as windows-1251. The game speaks
// UTF-8, so every Cyrillic line typed in the game was stored as mojibake — `вошёл в игру`
// went in as `РІРѕС€РµР»`. Nobody saw it, because writing it back out under the same wrong
// codepage produced the original bytes again; only the browser lobby, which reads the
// database directly, ever showed the damage. With the u-lobby fixed the two errors no
// longer cancel, so what is stored has to be made true.
//
// WHICH ROWS. Not "the ones from the game" — origin is not proof, and a row repaired twice
// is a row destroyed. The test is the damage's own signature: mojibake is text whose
// windows-1251 bytes are themselves valid UTF-8, which is exactly how it came to exist.
// A correctly stored Russian line fails that test (`дратуте` -> `e4 f0 e0 …`, valid UTF-8
// nowhere), and so does anything in ASCII. A row that cannot prove it is broken is left
// alone.
//
// Usage:
//   node tools/repair-chat-encoding.ts             # say what would change, touch nothing
//   node tools/repair-chat-encoding.ts --apply     # and do it

import { DatabaseSync } from 'node:sqlite';

const apply = process.argv.includes('--apply');
const file = process.argv.find((arg) => arg.endsWith('.db')) ?? 'data/lobby.db';

/** Character -> its windows-1251 byte, for the 256 the page has. */
const FROM_BYTE = new TextDecoder('windows-1251').decode(Uint8Array.from({ length: 256 }, (_, i) => i));
const TO_BYTE = new Map([...FROM_BYTE].map((char, byte) => [char, byte]));

/**
 * The text this row would have held if it had been read as UTF-8 — or null if it was
 * never mojibake to begin with.
 */
function repaired(text: string): string | null {
  if (![...text].some((char) => char.charCodeAt(0) > 126)) return null; // ASCII: untouched either way
  const bytes = Buffer.alloc(text.length);
  let at = 0;
  for (const char of text) {
    const byte = TO_BYTE.get(char);
    if (byte === undefined) return null; // not something 1251 could have produced
    bytes[at++] = byte;
  }
  const utf8 = bytes.subarray(0, at).toString('utf8');
  // The decode has to be lossless, or these bytes were not UTF-8 and this row is fine.
  if (!Buffer.from(utf8, 'utf8').equals(bytes.subarray(0, at))) return null;
  return utf8 === text ? null : utf8;
}

const db = new DatabaseSync(file);
const rows = db.prepare('select id, channel, origin, nick, text from chat order by id').all() as Array<{
  id: number;
  channel: string;
  origin: string;
  nick: string;
  text: string;
}>;

const update = db.prepare('update chat set text = ?, nick = ? where id = ?');
let changed = 0;
for (const row of rows) {
  const text = repaired(row.text);
  const nick = repaired(row.nick);
  if (!text && !nick) continue;
  changed++;
  console.log(`#${row.id} ${row.channel} (${row.origin})`);
  if (nick) console.log(`   nick: ${row.nick}  ->  ${nick}`);
  if (text) console.log(`   text: ${row.text}  ->  ${text}`);
  if (apply) update.run(text ?? row.text, nick ?? row.nick, row.id);
}

console.log(
  `\n${changed} of ${rows.length} row(s) ${apply ? 'repaired' : 'would be repaired'}` +
    (apply ? '' : ' — re-run with --apply'),
);
db.close();

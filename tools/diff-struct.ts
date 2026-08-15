// Two room descriptions, side by side, so a setting can be found by changing it.
//
// WHY THIS EXISTS. The host's description of his game is a CStructureSaver document of
// some fifty fields, and four of them have ever been identified: the two ids, the map path
// and the player records. The rest are a byte or four each with no name — and one of them
// is the difficulty, one is the turn time, one is whether ghost mode is on.
//
// Reading them out of the client is one way. Changing one and looking is the cheaper one:
// host a room, dump it, change exactly one setting, dump it again, and whatever moved is
// that setting. The u-lobby prints the whole document as hex every time the host changes
// anything (`GROUP_CONFIG_UPDATE_RES … for diff-struct:`), so both halves come out of the
// log without starting a game.
//
// What it will not do is tell you which of two changes was which. One setting at a time,
// or the answer is a list rather than a name.
//
// Usage:
//   node tools/diff-struct.ts before.hex after.hex
//   node tools/diff-struct.ts <hex> <hex>          # straight off the log line
//
// Either argument may be a file or the hex itself. Comment lines (`#`) and whitespace are
// ignored, so a log line pasted whole is fine.

import { existsSync, readFileSync } from 'node:fs';
import { readFields, looksLikeFields, type Field } from '../services/u-lobby/structure.ts';

function bytesOf(argument: string): Buffer {
  const text = existsSync(argument) ? readFileSync(argument, 'utf8') : argument;
  const hex = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('')
    .replace(/[^0-9a-f]/gi, '');
  return Buffer.from(hex, 'hex');
}

/** A field's payload in the shortest form that is still honest. */
function show(value: Buffer): string {
  if (value.length === 0) return '(empty)';
  const printable = [...value].every((b) => b === 0 || (b >= 0x20 && b < 0x7f));
  if (printable && value.length > 3) return JSON.stringify(value.toString('utf8').replace(/\0/g, ''));
  // Four bytes are almost always a number in this document, and a number read as one is
  // the whole point of a diff: 0 -> 1 says more than 00000000 -> 01000000 does.
  if (value.length === 4) return `${String(value.readUInt32LE(0))}  (${value.toString('hex')})`;
  const hex = value.toString('hex');
  return hex.length > 80 ? `${hex.slice(0, 80)}…` : hex;
}

/**
 * Every field, flattened, each under the path of tags that reaches it.
 *
 * Flattened because that is what makes two documents comparable: the settings live inside
 * `[1]`, some of them inside a record inside that, and a reader that only compared the top
 * level would report "[1] changed, 538 bytes" and nothing else.
 *
 * A payload is descended into only when it is fields edge to edge. That heuristic reads
 * some leaves as documents — a UTF-16 name comes apart into nonsense tags — but a
 * false split is symmetric, so it shows up identically on both sides and diffs away.
 */
function flatten(buf: Buffer, path: string, into: Map<string, Buffer>): void {
  let fields: Field[];
  try {
    fields = readFields(buf);
  } catch {
    return;
  }
  const seen = new Map<number, number>();
  for (const field of fields) {
    // A tag repeats freely in this format, so the path carries which one this is.
    const nth = (seen.get(field.tag) ?? 0) + 1;
    seen.set(field.tag, nth);
    const here = `${path}[${String(field.tag)}${nth > 1 ? `#${String(nth)}` : ''}]`;
    into.set(here, field.value);
    if (field.value.length >= 2 && looksLikeFields(field.value)) flatten(field.value, here, into);
  }
}

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.error('usage: node tools/diff-struct.ts <before> <after>   (files or hex)');
  process.exit(2);
}

const before = bytesOf(first);
const after = bytesOf(second);
console.log(`before: ${String(before.length)} bytes`);
console.log(`after:  ${String(after.length)} bytes\n`);

const left = new Map<string, Buffer>();
const right = new Map<string, Buffer>();
flatten(before, '', left);
flatten(after, '', right);

const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
const changed = paths.filter((path) => {
  const was = left.get(path);
  const now = right.get(path);
  return !(was && now && was.equals(now));
});

// A field that changed BECAUSE something inside it did is not news — it is the same news
// with more bytes. Reporting `[1]` alongside `[1][24]` buries the answer under the
// document that contains it, so a field is dropped when a deeper one also moved.
const deepest = changed.filter((path) => !changed.some((other) => other !== path && other.startsWith(path)));

let moved = 0;
for (const path of deepest) {
  const was = left.get(path);
  const now = right.get(path);
  moved += 1;
  if (!was) console.log(`+ ${path}\n    ${show(now!)}`);
  else if (!now) console.log(`- ${path}\n    ${show(was)}`);
  else console.log(`~ ${path}\n    was ${show(was)}\n    now ${show(now)}`);
}

console.log(
  moved === 0
    ? '\nnothing moved — the same document twice, or the change is not in this document'
    : `\n${String(moved)} field(s) moved. If you changed one setting, the one you are looking for is here;\n` +
      'if more than one moved, the player records and the checksum move on their own — see NETWORK_STATE.',
);

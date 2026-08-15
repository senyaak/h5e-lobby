// What is inside a blob the game wrote — a CStructureSaver document, printed as
// a tree (services/u-lobby/structure.ts).
//
// Exploratory: it prints, it asserts nothing. Give it a captured message and it
// dumps the GS list with every blob inside it decoded, or give it raw hex and it
// dumps just that:
//
//   node tools/dump-struct.ts tools/fixtures/net/create-room.hex
//   node tools/dump-struct.ts --hex 0208ffffffff

import { readFileSync } from 'node:fs';
import { parse } from '../services/u-lobby/gs-message.ts';
import type { GSValue } from '../services/u-lobby/gs-data.ts';
import { looksLikeFields, readFields } from '../services/u-lobby/structure.ts';

function hexOf(path: string): Buffer {
  return Buffer.from(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('#'))
      .join('')
      .replace(/[^0-9a-f]/gi, ''),
    'hex',
  );
}

/** A payload as text when it is printable, as hex when it is not. */
function show(value: Buffer): string {
  const printable = value.length > 0 && [...value].every((b) => b === 0 || b === 9 || b === 10 || (b >= 0x20 && b < 0x7f));
  const text = printable ? JSON.stringify(value.toString('utf8').replace(/\0/g, '\\0')) : value.toString('hex');
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function dump(buf: Buffer, indent = ''): void {
  let fields;
  try {
    fields = readFields(buf);
  } catch (err) {
    console.log(`${indent}!! ${(err as Error).message}`);
    console.log(`${indent}   ${buf.toString('hex')}`);
    return;
  }
  for (const { tag, value } of fields) {
    const nested = looksLikeFields(value);
    console.log(`${indent}[${tag}] ${value.length} ${nested ? '{' : show(value)}`);
    if (nested) {
      dump(value, `${indent}  `);
      console.log(`${indent}}`);
    }
  }
}

const [, , first, ...rest] = process.argv;
if (!first) {
  console.log('usage: node tools/dump-struct.ts <capture.hex> | --hex <bytes>');
  process.exit(1);
}

if (first === '--hex') {
  dump(Buffer.from(rest.join('').replace(/[^0-9a-f]/gi, ''), 'hex'));
  process.exit(0);
}

const message = parse(hexOf(first));
if (!message) {
  console.log('not a whole GS message; treating the file as raw bytes');
  dump(hexOf(first));
  process.exit(0);
}
console.log(`type ${message.type}, ${message.sender} -> ${message.receiver}, ${message.size} bytes`);

function walk(list: GSValue[], path: string): void {
  list.forEach((value, i) => {
    const at = `${path}${i}`;
    if (typeof value === 'string') console.log(`${at}: "${value}"`);
    else if (Array.isArray(value)) walk(value, `${at}.`);
    else {
      console.log(`${at}: blob of ${value.length} bytes`);
      if (value.length) dump(Buffer.from(value), '    ');
    }
  });
}
walk(message.body ?? [], '');

// The log, which for this project is the instrument and not the exhaust.
//
// Every service writes two files: `<service>-session-<stamp>.log` keeps the run for good,
// and `<service>-latest.log` is the run happening now — a name that can be tailed without
// looking up a timestamp first, which matters because these are usually started by
// somebody else's hand.
//
// THE U-LOBBY ALSO KEEPS WRITING `logs/latest.log`. That is the file Сеня tails, and the
// last time a log quietly moved, the obvious place kept yesterday's file and every run
// after that looked like a server that had stopped writing. So the old name stays, and
// the new one is beside it.
//
// Nothing here truncates. A dump of an unknown protocol with the middle cut out is worth
// nothing at all.
//
// Exports:
//   openLog(service, options)   -> log(line), hexDump(buffer), paths
//   hexDump(buffer, indent)     bytes as hex and text, 16 to a line

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/** Hex and text, 16 bytes to a line, however long the buffer is. */
export function hexDump(buf: Buffer, indent = '    '): string {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const hex = [...slice]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47);
    const text = [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    out.push(`${indent}${i.toString(16).padStart(4, '0')}  ${hex}  ${text}`);
  }
  return out.join('\n');
}

export interface Log {
  (line: string): void;
  /** Where this run is being written, so the service can say it out loud. */
  readonly session: string;
  readonly latest: string;
}

export interface LogOptions {
  /** Write `logs/latest.log` as well — the u-lobby does, see the header. */
  alsoPlainLatest?: boolean;
}

export function openLog(service: string, options: LogOptions = {}): Log {
  const dir = config().logDir;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionPath = join(dir, `${service}-session-${stamp}.log`);
  const latestPath = join(dir, `${service}-latest.log`);
  const files = [createWriteStream(sessionPath), createWriteStream(latestPath)];
  if (options.alsoPlainLatest) files.push(createWriteStream(join(dir, 'latest.log')));

  const log = ((line: string): void => {
    const at = new Date().toISOString().slice(11, 23);
    const text = `${at}  ${line}`;
    console.log(text);
    for (const file of files) file.write(`${text}\n`);
  }) as { (line: string): void; session: string; latest: string };
  log.session = sessionPath;
  log.latest = latestPath;
  return log as Log;
}

// All four services at once, for a machine that has no systemd — which is to say, for
// this one.
//
//   node tools/fleet.ts [gateway flags…]
//
// On the Linux host the units in deploy/systemd do this properly: one unit per service,
// restarted on failure, started in the order their dependencies want. Here it is one
// parent that spawns four children, prefixes their output so a single console reads like
// four logs, and takes them all down together. Anything after the command line goes to
// the gateway, which is the only one with flags worth typing (--ghosts, --quiet-bot…).
//
// Each service still writes its own file in logs/ — this only makes them visible at once.

import { spawn, type ChildProcess } from 'node:child_process';
import { repoRoot } from '../shared/config.ts';

interface Unit {
  name: string;
  script: string;
  /** Colour for the prefix. Nothing depends on it; four logs in one console do. */
  colour: string;
  args?: string[];
}

const gatewayFlags = process.argv.slice(2);

const FLEET: Unit[] = [
  { name: 'core   ', script: 'services/core/main.ts', colour: '\u001b[33m' },
  { name: 'gateway', script: 'services/gateway/main.ts', colour: '\u001b[36m', args: gatewayFlags },
  { name: 'web    ', script: 'services/web/main.ts', colour: '\u001b[32m' },
  { name: 'relay  ', script: 'services/relay/main.ts', colour: '\u001b[35m' },
];

const RESET = '\u001b[0m';
const running = new Map<string, ChildProcess>();
let stopping = false;

function start(unit: Unit): void {
  const child = spawn(process.execPath, [unit.script, ...(unit.args ?? [])], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(unit.name, child);

  const prefix = (stream: NodeJS.ReadableStream, toErr: boolean): void => {
    let rest = '';
    stream.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const out = `${unit.colour}${unit.name}${RESET} │ ${line}`;
        if (toErr) console.error(out);
        else console.log(out);
      }
    });
  };
  prefix(child.stdout!, false);
  prefix(child.stderr!, true);

  child.on('exit', (code, signal) => {
    running.delete(unit.name);
    console.log(`${unit.colour}${unit.name}${RESET} │ exited (${signal ?? code})`);
    // One service dying is not a reason to keep the other three pretending. systemd would
    // restart it; here the whole thing goes down, because the run is somebody watching.
    if (!stopping) stopAll();
  });
}

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const child of running.values()) child.kill();
  setTimeout(() => process.exit(1), 1000).unref();
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// The core first, so the other three connect on their first attempt rather than their
// second. Nothing breaks if they do not — they all reconnect — but a clean start is worth
// half a second.
start(FLEET[0]!);
setTimeout(() => {
  for (const unit of FLEET.slice(1)) start(unit);
}, 500);

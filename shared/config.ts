// One place that says where everything listens, read the same way by all four services.
//
// Environment first, file second (docs/ARCHITECTURE.md): a container is fed variables and
// a laptop is fed a file, and neither has to know about the other. Nothing that matters is
// compiled in — the defaults below are only what makes `npm start` work on a machine where
// nothing has been set up yet, which is this machine.
//
// The file is `config.json` beside the repository root, or wherever `H5E_CONFIG` points.
// A key missing from both is the default; a key in both is the environment's.
//
// Exports:
//   config()        the settings, read once
//   repoRoot        the directory the services resolve their relative paths against

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  /**
   * The address the game is told to connect to. Advertised only — it goes into the
   * `[Servers]` ini and into the endpoints a room hands out, and no socket is ever bound
   * to it. On a host reached from outside this is the public address.
   */
  host: string;
  /**
   * What the gateway, the web and the relay bind. Every interface by default, because a
   * second machine has to be able to reach them. The core is not on this list: it binds
   * loopback and nothing else (services/core/server.ts).
   */
  bind: string;
  /**
   * The gateway's one TCP port: the server list (`http_proxy` points here) and, since
   * SLICE §2.3, every desk the game dials — they are told apart by what a connection
   * says first, not by the number it said it on.
   */
  httpPort: number;
  /** The core's internal API — loopback only, never exposed. */
  corePort: number;
  /** How the other services reach the core. */
  coreUrl: string;
  /** The browser lobby. */
  webPort: number;
  /** Where agents connect to have their datagrams carried. */
  relayPort: number;
  /**
   * Where a game's DESK traffic arrives when it comes through a tunnel rather than
   * straight at `httpPort`.
   *
   * A tunnel of the cloudflared family carries HTTP and WebSocket and nothing else, and
   * everything the game dials after its one HTTP request is raw TCP and UDP
   * (SLICE_over_the_internet.md §1). So the desk half gets carried the same way the peer
   * half already is: the game's own copy of the mod holds those sockets locally and this
   * is where it hands them over.
   */
  desksPort: number;
  /** The one database. The core owns it; see docs/ARCHITECTURE.md for the seam. */
  database: string;
  /** Where every service writes its log. */
  logDir: string;
}

const DEFAULTS: Config = {
  host: '127.0.0.1',
  bind: '0.0.0.0',
  httpPort: 8080,
  corePort: 40100,
  coreUrl: 'ws://127.0.0.1:40100/core',
  webPort: 8081,
  relayPort: 40200,
  desksPort: 40300,
  database: 'data/lobby.db',
  logDir: 'logs',
};

/** Which environment variable carries which setting. */
const FROM_ENV: Record<keyof Config, string> = {
  host: 'H5E_HOST',
  bind: 'H5E_BIND',
  httpPort: 'H5E_HTTP_PORT',
  corePort: 'H5E_CORE_PORT',
  coreUrl: 'H5E_CORE_URL',
  webPort: 'H5E_WEB_PORT',
  relayPort: 'H5E_RELAY_PORT',
  desksPort: 'H5E_DESKS_PORT',
  database: 'H5E_DATABASE',
  logDir: 'H5E_LOG_DIR',
};

function fromFile(): Partial<Config> {
  const path = process.env['H5E_CONFIG'] ?? join(repoRoot, 'config.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  } catch (error) {
    // A file that is not there is the normal case and says nothing. A file that is there
    // and unreadable is a mistake worth hearing about, because the alternative is a
    // service quietly listening on the wrong port.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`config: ${path} is there but unreadable — ${(error as Error).message}`);
    }
    return {};
  }
}

let cached: Config | null = null;

/** Paths in the config are relative to the repository, so a unit file needs no absolute one. */
function resolve(path: string): string {
  return isAbsolute(path) ? path : join(repoRoot, path);
}

export function config(): Config {
  if (cached) return cached;
  const file = fromFile();
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const [key, variable] of Object.entries(FROM_ENV)) {
    const fromEnv = process.env[variable];
    const value = fromEnv ?? (file as Record<string, unknown>)[key] ?? DEFAULTS[key as keyof Config];
    out[key] = typeof DEFAULTS[key as keyof Config] === 'number' ? Number(value) : String(value);
  }
  const settings = out as unknown as Config;
  settings.database = resolve(settings.database);
  settings.logDir = resolve(settings.logDir);
  // `coreUrl` defaults to wherever the core was told to listen, so moving the port is one
  // variable rather than two that can disagree. The address is not a choice: the core is
  // loopback and the three that call it are on the same host.
  if (!process.env['H5E_CORE_URL'] && file.coreUrl === undefined) {
    settings.coreUrl = `ws://127.0.0.1:${settings.corePort}/core`;
  }
  cached = settings;
  return settings;
}

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
  /** The address the game is told to connect to, and what the services bind. */
  host: string;
  /** Where the game asks for its server list (`http_proxy` points here). */
  httpPort: number;
  /** The core's internal API — loopback only, never exposed. */
  corePort: number;
  /** How the other services reach the core. */
  coreUrl: string;
  /** The shared secret they present. Loopback makes it a seatbelt, not a lock. */
  coreToken: string;
  /** The browser lobby. */
  webPort: number;
  /** Where agents connect to have their datagrams carried. */
  relayPort: number;
  /** The one database. The core owns it; see docs/ARCHITECTURE.md for the seam. */
  database: string;
  /** Where every service writes its log. */
  logDir: string;
}

const DEFAULTS: Config = {
  host: '127.0.0.1',
  httpPort: 8080,
  corePort: 40100,
  coreUrl: 'ws://127.0.0.1:40100/core',
  coreToken: 'local-development',
  webPort: 8081,
  relayPort: 40200,
  database: 'data/lobby.db',
  logDir: 'logs',
};

/** Which environment variable carries which setting. */
const FROM_ENV: Record<keyof Config, string> = {
  host: 'H5E_HOST',
  httpPort: 'H5E_HTTP_PORT',
  corePort: 'H5E_CORE_PORT',
  coreUrl: 'H5E_CORE_URL',
  coreToken: 'H5E_CORE_TOKEN',
  webPort: 'H5E_WEB_PORT',
  relayPort: 'H5E_RELAY_PORT',
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
  // variable rather than two that can disagree.
  if (!process.env['H5E_CORE_URL'] && file.coreUrl === undefined) {
    settings.coreUrl = `ws://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.corePort}/core`;
  }
  cached = settings;
  return settings;
}

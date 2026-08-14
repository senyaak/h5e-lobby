// The web lobby, as a process.
//
//   node services/web.ts
//
// A page and a WebSocket, and nothing else — the service that must never reach the
// database (docs/ARCHITECTURE.md). It is the one of the four that a person points a
// browser at, so it is also the one that will eventually stand behind the tunnel.

import { config } from '../src/config.ts';
import { openLog } from '../src/log.ts';
import { startWeb } from '../src/web/web-service.ts';

const settings = config();
const log = openLog('web');

const running = await startWeb({
  host: settings.host,
  port: settings.webPort,
  coreUrl: settings.coreUrl,
  coreToken: settings.coreToken,
  log,
});

log(`web on http://${settings.host}:${running.port()} — the same chat the game is in`);
log(`core at ${settings.coreUrl}`);
log(`logging to ${log.session}`);

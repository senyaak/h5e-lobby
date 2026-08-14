// The relay, as a process.
//
//   node services/relay/main.ts
//
// Nothing plays through it yet: the agent that would dial it is the next step
// (docs/ARCHITECTURE.md, "What to build first", step 2), and until it exists this listens
// and carries nothing. It is a service now rather than then because its whole design is
// about what it does NOT depend on, and that is only true if it is separate from the
// start.

import { config } from '../../shared/config.ts';
import { openLog } from '../../shared/log.ts';
import { startRelay } from './relay-service.ts';

const settings = config();
const log = openLog('relay');

const running = await startRelay({
  bind: settings.bind,
  port: settings.relayPort,
  coreUrl: settings.coreUrl,
  coreToken: settings.coreToken,
  log,
});

log(
  `relay on ${settings.bind}:${running.port()} — agents dial ws://${settings.host}:${running.port()}/agent ` +
    `(or the tunnel's wss://…/agent), identify once, against ${settings.coreUrl}`,
);
log(`logging to ${log.session}`);

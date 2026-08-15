// The desk tunnel, as a process.
//
//   node services/desks/main.ts
//
// The fifth service, and the one the game's own copy of the mod dials when it is playing
// from off this network. It carries the desks; the relay carries the peers; neither knows
// the other exists. See services/desks/desk-tunnel.ts for why they are two things.
//
// Nothing plays through it until the mod's lobby half exists — like the relay before its
// agent, it is a service from the start because its whole point is what it does NOT share.

import { config } from '../../shared/config.ts';
import { openLog } from '../../shared/log.ts';
import { startDeskTunnel } from './desk-tunnel.ts';

const settings = config();
const log = openLog('desks');

const running = await startDeskTunnel({
  bind: settings.bind,
  port: settings.desksPort,
  // The loopback and not `settings.host`: the desks are on this host with us, and the
  // gateway's own promise is that the advertised address is bound to nothing.
  deskHost: '127.0.0.1',
  deskPort: settings.httpPort,
  log,
});

log(
  `desks on ${settings.bind}:${String(running.port())} — the mod dials ws://${settings.host}:${String(running.port())}/desks ` +
    `(or the tunnel's wss://…/desks), and every stream lands on 127.0.0.1:${String(settings.httpPort)}`,
);
log(`logging to ${log.session}`);

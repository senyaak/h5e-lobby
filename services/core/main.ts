// The core, as a process.
//
//   node services/core/main.ts
//
// It owns the database and answers the other three over one WebSocket on loopback. It
// speaks nothing of the game's protocol and never will: that is the u-lobby's job, and
// keeping it out of here is what lets the web reach any of this at all.
//
// Restarting it is meant to be dull. The u-lobby reconnects, the web reconnects, and a
// game already in progress does not notice — nothing in a running match passes through
// here (docs/ARCHITECTURE.md, "Why the relay is not in the middle").

import { config } from '../../shared/config.ts';
import { openLog } from '../../shared/log.ts';
import { startCore } from './server.ts';
import { gameChannels } from '../../shared/channels.ts';
import { openDatabase } from './rules/database.ts';

const settings = config();
const log = openLog('core');

const { db, imported } = openDatabase(settings.database);
if (imported.length) log(`brought across from the old JSON files: ${imported.join(', ')}`);

// The channels are the game's lobbies seen from the other side: the game knows them by
// number, the browser by name, and the key both end up using is the IRC channel, because
// that is the one name that already exists on the wire. The list is in shared/ so that
// this service does not have to import the game's protocol to know it.
const channels = gameChannels();

const running = await startCore({
  // Not `settings.bind`, and not a variable of its own: the core is the one service that
  // is never reached from another machine, and `startCore` refuses anything else.
  bind: '127.0.0.1',
  port: settings.corePort,
  db,
  channels,
  log,
});

log(`core on 127.0.0.1:${running.port()} — ws at /core, health at /health, loopback only`);
log(`database ${settings.database}, ${running.core.chat.size} chat line(s) kept`);
log(`channels: ${channels.map((c) => `${c.name} ${c.key}`).join(', ')}`);
log(`logging to ${log.session}`);

// The core, as a process.
//
//   node services/core.ts
//
// It owns the database and answers the other three over one WebSocket on loopback. It
// speaks nothing of the game's protocol and never will: that is the gateway's job, and
// keeping it out of here is what lets the web reach any of this at all.
//
// Restarting it is meant to be dull. The gateway reconnects, the web reconnects, and a
// game already in progress does not notice — nothing in a running match passes through
// here (docs/ARCHITECTURE.md, "Why the relay is not in the middle").

import { config } from '../src/config.ts';
import { openLog } from '../src/log.ts';
import { startCore } from '../src/core/core-server.ts';
import type { ChannelInfo } from '../src/core/protocol.ts';
import { openDatabase } from '../src/net/database.ts';
import { DEFAULT_LOBBIES } from '../src/net/lobby.ts';
import { lobbyChannel } from '../src/net/irc.ts';

const settings = config();
const log = openLog('core');

const { db, imported } = openDatabase(settings.database);
if (imported.length) log(`brought across from the old JSON files: ${imported.join(', ')}`);

/**
 * The channels, which are the game's lobbies seen from the other side.
 *
 * The game knows them by number and the browser by name; the key both of them end up
 * using is the IRC channel, because that is the one name that already exists on the wire.
 */
const channels: ChannelInfo[] = DEFAULT_LOBBIES.map((lobby) => ({
  key: lobbyChannel(lobby.id),
  id: lobby.id,
  name: lobby.name,
}));

const running = await startCore({
  host: settings.host,
  port: settings.corePort,
  db,
  token: settings.coreToken,
  channels,
  log,
});

log(`core on ${settings.host}:${running.port()} — ws at /core, health at /health`);
log(`database ${settings.database}, ${running.core.chat.size} chat line(s) kept`);
log(`channels: ${channels.map((c) => `${c.name} ${c.key}`).join(', ')}`);
log(`logging to ${log.session}`);

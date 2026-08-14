// Give a player's copy of the game an agent secret.
//
//   node tools/issue-agent.ts Senyaak
//
// Prints one line to put in that installation's extension config. The launcher will do
// this eventually, by logging in as the player; until there is a launcher this is how a
// copy of the game is enrolled, and it is deliberately a separate command rather than
// something the game can ask for — the game never sees this secret and never sends it.
//
// Re-issuing replaces the last secret, which is also how one is revoked.

import { config } from '../shared/config.ts';
import { CoreClient } from '../shared/core-client.ts';

const name = process.argv[2];
if (!name) {
  console.error('usage: node tools/issue-agent.ts <player name>');
  process.exit(2);
}

const settings = config();
const core = new CoreClient({ url: settings.coreUrl, token: settings.coreToken, service: 'issue-agent' });
core.start();

try {
  const secret = await core.issueAgent(name);
  // The two lines as the agent reads them. `relay` and `secret` are the words
  // `relay_read_config` in the editor's `native/net/relay.c` looks for, and the file is
  // the one its Network tab writes — so what is printed here can be pasted whole. It used
  // to print `net_agent_secret`, which nothing has ever read.
  console.log(`\nagent secret for ${name} — for that copy's bin/homm5-editor-net.txt, not the game:\n`);
  console.log(`  relay ws://${settings.host}:${settings.relayPort}/agent`);
  console.log(`  secret ${secret}\n`);
  console.log('Behind a tunnel the first line is that hostname instead, with no query string:');
  console.log('  relay wss://relay.example.com/agent\n');
  console.log('The editor writes this file from its Network tab; that is the way to do it.');
  console.log('Anything issued for this name before now has stopped working.\n');
} catch (error) {
  console.error(`could not reach the core at ${settings.coreUrl}: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  core.stop();
}

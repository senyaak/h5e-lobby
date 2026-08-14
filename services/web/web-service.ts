// The browser lobby: one page, and the WebSocket behind it.
//
// The point is not a second client — a browser cannot play Heroes. The point is that
// finding an opponent should not require the game to be running. So this is a participant
// in the same chat and the same presence list the game sees, and nothing more than that.
//
// It never touches the database. Everything it shows comes from the core, and everything
// it is told goes to the core; if the core is away, the page says so and shows nothing
// invented. That constraint is the whole reason the split is worth having, so it is
// enforced by there being no database code in this folder at all.
//
// The browser speaks its own small protocol, not the core's: a browser must not hold the
// core's token, and what a page needs is narrower than what a service may ask.
//
// Exports:
//   startWeb(options)   the http server, listening, with close()

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreClient } from '../../shared/core-client.ts';
import type { ChannelInfo, ChatMessage, PresenceEntry } from '../../shared/core-protocol.ts';
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

/** What a page sends us. */
type FromBrowser =
  | { kind: 'hello'; nick: string; channel?: string }
  | { kind: 'channel'; channel: string }
  | { kind: 'say'; text: string };

/** And what it is sent. */
type ToBrowser =
  | { kind: 'welcome'; nick: string; channels: ChannelInfo[]; core: boolean }
  | { kind: 'history'; channel: string; messages: ChatMessage[] }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'presence'; entries: PresenceEntry[] }
  | { kind: 'core'; connected: boolean };

interface Browser {
  peer: WebSocketPeer;
  nick: string;
  channel: string;
}

export interface WebOptions {
  host: string;
  port: number;
  coreUrl: string;
  coreToken: string;
  log?: (line: string) => void;
}

export interface RunningWeb {
  server: Server;
  /** Where it actually listens, which the tests need when they ask for port 0. */
  port(): number;
  close(): Promise<void>;
}

/** Beside this file, not somewhere under the repository root: moving the folder should
 *  not be able to turn the page into a 500, which is exactly what it did once. */
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'index.html');

export function startWeb(options: WebOptions): Promise<RunningWeb> {
  const log = options.log ?? ((): void => {});
  const browsers = new Set<Browser>();
  let channels: ChannelInfo[] = [];

  const core = new CoreClient({ url: options.coreUrl, token: options.coreToken, service: 'web', log });

  const send = (browser: Browser, message: ToBrowser): void => browser.peer.sendText(JSON.stringify(message));
  const tellEveryone = (message: ToBrowser, where?: string): void => {
    for (const browser of browsers) if (!where || browser.channel === where) send(browser, message);
  };

  /** Who is in the browser right now, as the core wants to hear it. */
  const pushPresence = (): void => {
    const entries: PresenceEntry[] = [...browsers]
      .filter((browser) => browser.nick)
      .map((browser) => ({ nick: browser.nick, channel: browser.channel, origin: 'web' as const }));
    core.replacePresence('web', entries);
  };

  core.onConnected = (list) => {
    channels = list;
    tellEveryone({ kind: 'core', connected: true });
    pushPresence();
  };
  core.onChat = (message) => tellEveryone({ kind: 'message', message }, message.channel);
  core.onPresence = (entries) => tellEveryone({ kind: 'presence', entries });
  core.start();

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const body = JSON.stringify({ ok: true, browsers: browsers.size, core: core.connected });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === '/' || request.url?.startsWith('/?')) {
      // Read per request rather than once at start: this page is edited far more often
      // than the service is restarted, and nothing here is hot enough to care.
      let page: Buffer;
      try {
        page = readFileSync(PAGE);
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(`the page is missing: ${(error as Error).message}\n`);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
      response.end(page);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('nothing here\n');
  });

  serveWebSocket(server, (peer) => {
    const browser: Browser = { peer, nick: '', channel: channels[0]?.key ?? '' };
    browsers.add(browser);

    const openHistory = (channel: string): void => {
      if (!core.connected) return;
      core
        .history(channel)
        .then((messages) => send(browser, { kind: 'history', channel, messages }))
        .catch((error: Error) => log(`web  no history for ${channel}: ${error.message}`));
    };

    peer.onMessage((bytes) => {
      let message: FromBrowser;
      try {
        message = JSON.parse(bytes.toString('utf8')) as FromBrowser;
      } catch {
        return;
      }
      switch (message.kind) {
        case 'hello': {
          // A name is whatever the person typed. There is no account behind it yet: the
          // launcher will bring one (docs/ARCHITECTURE.md), and until it does, pretending
          // otherwise would be a login screen that checks nothing.
          browser.nick = String(message.nick).slice(0, 24).replace(/[^\S ]/g, '') || 'somebody';
          if (message.channel) browser.channel = message.channel;
          log(`web  ${browser.nick} is watching ${browser.channel}`);
          send(browser, { kind: 'welcome', nick: browser.nick, channels, core: core.connected });
          openHistory(browser.channel);
          pushPresence();
          return;
        }
        case 'channel': {
          browser.channel = message.channel;
          openHistory(browser.channel);
          pushPresence();
          return;
        }
        case 'say': {
          const text = String(message.text).slice(0, 400).trim();
          if (!text || !browser.nick) return;
          core.post({ channel: browser.channel, nick: browser.nick, text, origin: 'web' });
          return;
        }
        default:
          return;
      }
    });

    peer.onClose(() => {
      browsers.delete(browser);
      pushPresence();
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port, options.host, () => {
      resolve({
        server,
        port: () => (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((done) => {
            core.stop();
            for (const browser of browsers) browser.peer.close();
            server.close(() => done());
          }),
      });
    });
  });
}

// The browser lobby: one page, the WebSocket behind it, and the login in front of it.
//
// The point is not a second client — a browser cannot play Heroes. The point is that
// finding an opponent should not require the game to be running. So this is a participant
// in the same chat and the same presence list the game sees, and nothing more than that.
//
// WHO YOU ARE HERE IS WHO YOU ARE IN THE GAME. The same name and the same password, and
// this service checks neither itself: it asks the core, which asks the accounts the game
// made. There is no sign-up here on purpose — an account is created by its first login in
// the game and nowhere else, so there is exactly one place a password is ever set. A page
// that could create accounts would be a second door to the same players, needing
// everything a public sign-up needs, for nothing gained.
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreClient } from '../../shared/core-client.ts';
import type { ChannelInfo, ChatMessage, PresenceEntry } from '../../shared/core-protocol.ts';
import { serveWebSocket, type WebSocketPeer } from '../../shared/websocket.ts';

/**
 * What a page sends us.
 *
 * No token anywhere: the session is a cookie the page cannot read and the browser attaches
 * by itself, to the login POST and to the WebSocket handshake alike. `hello` therefore says
 * only which channel to open, and who is asking was settled before the socket existed.
 */
type FromBrowser =
  | { kind: 'hello'; channel?: string }
  | { kind: 'channel'; channel: string }
  | { kind: 'say'; text: string };

/** And what it is sent. */
type ToBrowser =
  | { kind: 'welcome'; nick: string; channels: ChannelInfo[]; core: boolean }
  /** No session, or one that has run out: the page shows the login and asks again. */
  | { kind: 'denied' }
  | { kind: 'history'; channel: string; messages: ChatMessage[] }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'presence'; entries: PresenceEntry[] }
  | { kind: 'core'; connected: boolean };

interface Browser {
  peer: WebSocketPeer;
  /** Empty until a session has been shown. Nothing is sent or accepted before that. */
  nick: string;
  /** Which session this socket belongs to, so the sweep can keep it alive. */
  token: string;
  channel: string;
}

export interface WebOptions {
  /** The address to bind — `H5E_BIND`, not the one the game is advertised. */
  bind: string;
  port: number;
  coreUrl: string;
  coreToken: string;
  log?: (line: string) => void;
  /** Both are here so a test can watch a session expire without waiting an hour. */
  sessionIdleMs?: number;
  sessionTouchMs?: number;
}

export interface RunningWeb {
  server: Server;
  /** Where it actually listens, which the tests need when they ask for port 0. */
  port(): number;
  close(): Promise<void>;
}

const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'index.html');

/**
 * How long a session lives after the last sign of the person behind it.
 *
 * An hour, and it is counted from the last USE, not from the login: a tab that is open
 * and connected is kept alive by the sweep below, so the hour only ever runs while nobody
 * is there. Closing the tab starts it.
 *
 * Sessions live in this process and nowhere else, so restarting the web service logs
 * everybody out. That is the honest trade for now: the alternative is another table and
 * another thing to expire, and being asked for a password again after a deploy is not an
 * injury.
 */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * How often a live socket refreshes the session behind it.
 *
 * Done HERE and not in the page on purpose: a background tab's timers are throttled by
 * the browser, sometimes to nothing, and a session that expires while its own connection
 * is open and carrying chat would be a bug the person cannot even see coming. The socket
 * is the evidence; the page only has to keep its cookie's clock in step, which is what
 * `POST /session` is for.
 */
const SESSION_TOUCH_MS = 60_000;

/** The cookie the session lives in. The page never sees it — that is the point. */
const COOKIE = 'h5e_session';

/** One cookie out of a `Cookie:` header, without a parser for a format this simple. */
function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}

/**
 * How the session cookie is set.
 *
 * `HttpOnly` so no script can read it, ours or anyone else's — that is the whole reason
 * this is a cookie and not a token in localStorage. `SameSite=Lax` so another site cannot
 * make the browser spend it, on a form post or on a WebSocket handshake. `Secure` only
 * when the request actually arrived over TLS: set unconditionally it would be dropped on
 * `http://127.0.0.1`, which is where all of this is developed.
 */
function sessionCookie(token: string, secure: boolean, seconds: number): string {
  const bits = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${seconds}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Whether the request reached us over TLS — directly, or through a tunnel that says so. */
function overTls(request: IncomingMessage): boolean {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  return forwarded === 'https' || 'encrypted' in request.socket;
}

/** A wrong password costs the next one: five misses from an address and it waits. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

/** Nothing a login needs is bigger than this, and a body that is, is not a login. */
const MAX_BODY = 4096;

export function startWeb(options: WebOptions): Promise<RunningWeb> {
  const log = options.log ?? ((): void => {});
  const idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
  const touchMs = options.sessionTouchMs ?? SESSION_TOUCH_MS;
  const browsers = new Set<Browser>();
  const sessions = new Map<string, { name: string; usedAt: number }>();
  const failures = new Map<string, number[]>();
  let channels: ChannelInfo[] = [];

  const core = new CoreClient({ url: options.coreUrl, token: options.coreToken, service: 'web', log });

  const send = (browser: Browser, message: ToBrowser): void => browser.peer.sendText(JSON.stringify(message));
  const tellEveryone = (message: ToBrowser, where?: string): void => {
    for (const browser of browsers) if (browser.nick && (!where || browser.channel === where)) send(browser, message);
  };

  /** Who is in the browser right now, as the core wants to hear it. */
  const pushPresence = (): void => {
    const entries: PresenceEntry[] = [...browsers]
      .filter((browser) => browser.nick)
      .map((browser) => ({ nick: browser.nick, channel: browser.channel, origin: 'web' as const }));
    core.replacePresence('web', entries);
  };

  /** A session, if the token names a live one; using it keeps it alive. */
  const sessionOf = (token: string): string => {
    const session = sessions.get(token);
    if (!session) return '';
    if (Date.now() - session.usedAt > idleMs) {
      sessions.delete(token);
      return '';
    }
    session.usedAt = Date.now();
    return session.name;
  };

  /**
   * Once a minute: every session with a socket behind it is still in use, and every
   * session with nothing behind it for an hour is gone.
   *
   * The second half matters as much as the first — without it an abandoned session sits
   * in the map until somebody happens to present it, and "expired" would mean "expired
   * when asked" rather than "expired".
   */
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const browser of browsers) {
      const session = browser.token ? sessions.get(browser.token) : undefined;
      if (session) session.usedAt = now;
    }
    for (const [token, session] of sessions) {
      if (now - session.usedAt > idleMs) {
        sessions.delete(token);
        log(`web  ${session.name}'s session expired`);
      }
    }
  }, touchMs);
  // Nothing here should hold the process open by itself.
  sweep.unref?.();

  const tooManyFailures = (from: string): boolean => {
    const recent = (failures.get(from) ?? []).filter((at) => Date.now() - at < FAILURE_WINDOW_MS);
    failures.set(from, recent);
    return recent.length >= MAX_FAILURES;
  };

  core.onConnected = (list) => {
    channels = list;
    tellEveryone({ kind: 'core', connected: true });
    pushPresence();
  };
  core.onChat = (message) => tellEveryone({ kind: 'message', message }, message.channel);
  core.onPresence = (entries) => tellEveryone({ kind: 'presence', entries });
  core.start();

  function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > MAX_BODY) {
          request.destroy();
          reject(new Error('body too large'));
        }
      });
      request.on('end', () => resolve(body));
      request.on('error', reject);
    });
  }

  function answer(response: ServerResponse, status: number, value: unknown, cookie?: string): void {
    const body = JSON.stringify(value);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };
    if (cookie) headers['Set-Cookie'] = cookie;
    response.writeHead(status, headers);
    response.end(body);
  }

  /**
   * The login.
   *
   * The password is in the request body and goes straight into the core's question; it is
   * never written to the log, never kept, and never put in a URL — which is the whole
   * reason this is a POST with a body rather than the query string it would be easier to
   * test with.
   *
   * What comes back is a cookie, not a token in the body: the page has no use for the
   * session's value, and what a page cannot read cannot be stolen out of it.
   */
  async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const from = request.socket.remoteAddress ?? '?';
    if (tooManyFailures(from)) {
      log(`web  ${from} is guessing — refused without asking the core`);
      answer(response, 429, { ok: false, reason: 'too-many-tries' });
      return;
    }
    let asked: { name?: unknown; password?: unknown };
    try {
      asked = JSON.parse(await readBody(request)) as { name?: unknown; password?: unknown };
    } catch {
      answer(response, 400, { ok: false, reason: 'bad-request' });
      return;
    }
    const name = String(asked.name ?? '').trim();
    const password = String(asked.password ?? '');
    if (!name) {
      answer(response, 400, { ok: false, reason: 'bad-request' });
      return;
    }
    // No "is the core connected?" before asking: the client waits a moment for its own
    // connection and only then gives up, which is what makes a login during a core
    // restart — or in the first second of this service's life — wait rather than fail.
    let verdict: { ok: boolean; name: string; reason?: string };
    try {
      verdict = await core.verifyAccount(name, password);
    } catch (error) {
      log(`web  could not ask the core about ${name}: ${(error as Error).message}`);
      answer(response, 503, { ok: false, reason: 'core-away' });
      return;
    }
    if (!verdict.ok) {
      failures.set(from, [...(failures.get(from) ?? []), Date.now()]);
      log(`web  ${name} was refused: ${verdict.reason}`);
      answer(response, 401, { ok: false, reason: verdict.reason });
      return;
    }
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, { name: verdict.name, usedAt: Date.now() });
    log(`web  ${verdict.name} logged in`);
    answer(
      response,
      200,
      { ok: true, name: verdict.name },
      sessionCookie(token, overTls(request), Math.floor(idleMs / 1000)),
    );
  }

  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/login') {
      void login(request, response).catch((error: Error) => {
        log(`web  login failed to answer: ${error.message}`);
        answer(response, 500, { ok: false, reason: 'server' });
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/logout') {
      // Whichever session the cookie names — the page cannot name one itself, and that is
      // the point of it: nothing here takes a session id from a body it was handed.
      const token = cookieValue(request.headers.cookie, COOKIE);
      if (token) {
        const gone = sessions.get(token);
        sessions.delete(token);
        if (gone) log(`web  ${gone.name} logged out`);
      }
      answer(response, 200, { ok: true }, sessionCookie('', overTls(request), 0));
      return;
    }
    if (request.method === 'POST' && request.url === '/session') {
      // The page's minute tick. The server already keeps a socket's session warm; this is
      // the browser's half of it — the cookie carries an expiry of its own, and without
      // being handed a fresh one a tab that stays open past the hour would be logged out
      // the moment it was reloaded.
      const name = sessionOf(cookieValue(request.headers.cookie, COOKIE));
      if (!name) {
        answer(response, 401, { ok: false });
        return;
      }
      answer(
        response,
        200,
        { ok: true, name },
        sessionCookie(cookieValue(request.headers.cookie, COOKIE), overTls(request), Math.floor(idleMs / 1000)),
      );
      return;
    }
    if (request.url === '/health') {
      answer(response, 200, { ok: true, browsers: browsers.size, sessions: sessions.size, core: core.connected });
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
    const browser: Browser = { peer, nick: '', token: '', channel: channels[0]?.key ?? '' };
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
      if (message.kind === 'hello') {
        // A name is not something the page gets to choose: it is whichever account the
        // session cookie belongs to, spelled the way the account spells it. The cookie
        // came with the handshake, so it is read from there and not from this frame.
        const token = cookieValue(peer.headers.cookie, COOKIE);
        const nick = sessionOf(token);
        if (!nick) {
          send(browser, { kind: 'denied' });
          return;
        }
        browser.nick = nick;
        browser.token = token;
        if (message.channel) browser.channel = message.channel;
        log(`web  ${browser.nick} is watching ${browser.channel}`);
        send(browser, { kind: 'welcome', nick: browser.nick, channels, core: core.connected });
        openHistory(browser.channel);
        pushPresence();
        return;
      }
      // Everything else needs a session. A socket that never showed one is a socket that
      // can watch nothing and say nothing.
      if (!browser.nick) {
        send(browser, { kind: 'denied' });
        return;
      }
      switch (message.kind) {
        case 'channel': {
          browser.channel = message.channel;
          openHistory(browser.channel);
          pushPresence();
          return;
        }
        case 'say': {
          const text = String(message.text).slice(0, 400).trim();
          if (!text) return;
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
    server.listen(options.port, options.bind, () => {
      resolve({
        server,
        port: () => (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            core.stop();
            for (const browser of browsers) browser.peer.close();
            server.close(() => done());
          }),
      });
    });
  });
}

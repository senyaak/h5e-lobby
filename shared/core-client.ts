// How a service talks to the core.
//
// Node has had a WebSocket client of its own since 22, so this is the one place in the
// repository that does not write its own protocol: the server side is ours because the
// game's datagrams travel through it (shared/websocket.ts), the client side carries JSON
// between our own processes and has nothing to prove.
//
// It reconnects. The core is allowed to restart — that is the point of the split — so a
// gateway that gave up on the first refused connection would turn a five-second core
// restart into a chat that never came back. Lines said while it is away are held, up to a
// bounded number, and go out when it returns; a request that wants an answer fails at
// once instead, because an answer that arrives a minute late is not an answer.
//
// Exports:
//   CoreClient   start(), post(), history(), replacePresence(), identifyAgent()

import type { ChannelInfo, ChatMessage, FromCore, Origin, PresenceEntry, RoomInfo, ToCore } from './core-protocol.ts';
import { decode, encode } from './core-protocol.ts';

export interface CoreClientOptions {
  url: string;
  token: string;
  /** Which service this is, for the core's log. */
  service: string;
  log?: (line: string) => void;
}

/** Held while the core is away. Beyond this the oldest go — a lobby is not a mail spool. */
const BACKLOG_LIMIT = 200;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;

export class CoreClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry = RETRY_MIN_MS;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(reply: FromCore & { kind: 'reply' }): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly backlog: string[] = [];
  private readonly log: (line: string) => void;

  /** Set by whoever owns this client; both are optional and both may be replaced. */
  onChat: (message: ChatMessage, sender?: string) => void = () => {};
  onPresence: (entries: PresenceEntry[]) => void = () => {};
  onConnected: (channels: ChannelInfo[]) => void = () => {};

  private readonly options: CoreClientOptions;

  constructor(options: CoreClientOptions) {
    this.options = options;
    this.log = options.log ?? ((): void => {});
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('core client stopped'));
    }
    this.waiting.clear();
  }

  private open(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.later(`core is not reachable: ${(error as Error).message}`);
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      this.retry = RETRY_MIN_MS;
      socket.send(encode({ kind: 'hello', service: this.options.service, token: this.options.token }));
      // The backlog goes out before anything new, and before the welcome comes back:
      // ordering on the core is the order it receives, and the hello is already ahead.
      for (const held of this.backlog.splice(0)) socket.send(held);
    };

    socket.onmessage = (event: MessageEvent): void => {
      const message = decode<FromCore>(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer));
      if (!message) return;
      switch (message.kind) {
        case 'welcome':
          this.log(`core  connected, protocol ${message.protocol}, ${message.channels.length} channel(s)`);
          this.onConnected(message.channels);
          return;
        case 'chat.message':
          this.onChat(message.message, message.sender);
          return;
        case 'presence':
          this.onPresence(message.entries);
          return;
        case 'reply': {
          const pending = this.waiting.get(message.id);
          if (!pending) return;
          this.waiting.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve(message);
          return;
        }
        default:
          return;
      }
    };

    socket.onclose = (): void => {
      if (this.socket === socket) this.socket = null;
      this.later('core  connection closed');
    };
    // Without a handler an error on the global WebSocket is an unhandled event; the close
    // that follows it is what actually schedules the retry.
    socket.onerror = (): void => {};
  }

  private later(why: string): void {
    if (this.stopped) return;
    this.log(`${why} — trying again in ${this.retry} ms`);
    setTimeout(() => this.open(), this.retry).unref?.();
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
  }

  private tell(message: ToCore): void {
    const text = encode(message);
    if (this.connected) {
      this.socket!.send(text);
      return;
    }
    this.backlog.push(text);
    while (this.backlog.length > BACKLOG_LIMIT) this.backlog.shift();
  }

  /**
   * Wait a moment for the connection, rather than failing the instant it is not there.
   *
   * systemd starts the four services together, so the first thing a relay is asked may
   * arrive before its own link to the core is up — a race of milliseconds that would
   * otherwise refuse a player for no reason. Beyond this the core really is away, and
   * saying so is the right answer.
   */
  private async waitForConnection(ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.connected && !this.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.connected;
  }

  private async ask(build: (id: number) => ToCore): Promise<FromCore & { kind: 'reply' }> {
    if (!this.connected && !(await this.waitForConnection())) throw new Error('core is not connected');
    const id = this.nextId++;
    const answer = new Promise<FromCore & { kind: 'reply' }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('the core did not answer'));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
    });
    this.socket!.send(encode(build(id)));
    return answer;
  }

  post(line: { channel: string; nick: string; text: string; origin: Origin; sender?: string }): void {
    this.tell({ kind: 'chat.post', ...line });
  }

  replacePresence(origin: Origin, entries: PresenceEntry[]): void {
    this.tell({ kind: 'presence.replace', origin, entries });
  }

  /** The gateway's whole room list, sent when it is not what was sent last. */
  replaceRooms(rooms: RoomInfo[]): void {
    this.tell({ kind: 'rooms.replace', rooms });
  }

  async history(channel: string, limit?: number): Promise<ChatMessage[]> {
    const reply = await this.ask((id) => ({ kind: 'chat.history', id, channel, ...(limit ? { limit } : {}) }));
    return reply.messages ?? [];
  }

  async channels(): Promise<ChannelInfo[]> {
    const reply = await this.ask((id) => ({ kind: 'channels', id }));
    return reply.channels ?? [];
  }

  /**
   * A name and a password, checked against the accounts the game made.
   *
   * The reason comes back with the refusal because the page shows it: "no-such-account"
   * is the one that has to read as "log in once in the game first", not as "try again".
   */
  async verifyAccount(name: string, password: string): Promise<{ ok: boolean; name: string; reason?: string }> {
    const reply = await this.ask((id) => ({ kind: 'auth.verify', id, name, password }));
    return reply.ok
      ? { ok: true, name: reply.account?.name ?? name }
      : { ok: false, name, reason: reply.error ?? 'refused' };
  }

  /** A secret for this player's agent, said once. Re-issuing revokes the last one. */
  async issueAgent(name: string): Promise<string> {
    const reply = await this.ask((id) => ({ kind: 'agent.issue', id, name }));
    if (!reply.ok || !reply.secret) throw new Error(reply.error ?? 'the core issued nothing');
    return reply.secret;
  }

  async identifyAgent(token: string): Promise<{ nick: string; room: string } | null> {
    const reply = await this.ask((id) => ({ kind: 'agent.identify', id, token }));
    return reply.ok ? (reply.agent ?? null) : null;
  }
}

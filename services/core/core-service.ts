// The core: accounts, profiles, ladder, friends, presence, chat — and the rules over
// them. It is asked; it asks nobody (docs/ARCHITECTURE.md).
//
// This file is the part that answers. It knows nothing about sockets: it is handed a way
// to write text and gives back something to feed the text that arrives, so the same code
// serves a WebSocket in `services/core/main.ts` and a pair of function calls in the tests.
//
// What it carries today is chat with its history, the presence the services push into it,
// and the agent registry the relay asks. The rest of the rules still live in the gateway's
// process and reach the database directly — the seam is named in docs/ARCHITECTURE.md,
// and moving them across changes this file only by adding to the switch.
//
// Exports:
//   CoreService   connect(send) -> { receive(text), close() }

import type { DatabaseSync } from 'node:sqlite';
import { ChatStore, HISTORY_DEFAULT } from './chat.ts';
import {
  CORE_PROTOCOL,
  decode,
  encode,
  type ChannelInfo,
  type FromCore,
  type PresenceEntry,
  type ToCore,
} from '../../shared/core-protocol.ts';

export interface CoreConnection {
  receive(frame: Buffer | string): void;
  close(): void;
}

export interface CoreOptions {
  db: DatabaseSync;
  token: string;
  channels: ChannelInfo[];
  log?: (line: string) => void;
}

interface Client {
  /** Who said they were connecting — for the log, and nothing is decided by it. */
  service: string;
  authenticated: boolean;
  send(text: string): void;
  /** This connection's share of the presence list, replaced whole when it says so. */
  presence: PresenceEntry[];
}

export class CoreService {
  readonly chat: ChatStore;
  readonly channels: ChannelInfo[];
  private readonly clients = new Set<Client>();
  private readonly agents = new Map<string, { nick: string; room: string }>();
  private readonly token: string;
  private readonly log: (line: string) => void;

  constructor(options: CoreOptions) {
    this.chat = new ChatStore(options.db);
    this.channels = options.channels;
    this.token = options.token;
    this.log = options.log ?? ((): void => {});
  }

  /** Everyone every service has told us about, as one list. */
  presence(): PresenceEntry[] {
    return [...this.clients].flatMap((client) => client.presence);
  }

  get connections(): number {
    return this.clients.size;
  }

  connect(send: (text: string) => void): CoreConnection {
    const client: Client = { service: '?', authenticated: false, send, presence: [] };
    this.clients.add(client);
    return {
      receive: (frame) => this.receive(client, frame),
      close: () => {
        if (!this.clients.delete(client)) return;
        this.log(`core  ${client.service} disconnected`);
        // Whoever it was speaking for is no longer here — say so before anything is
        // drawn stale. A player list that keeps ghosts is worse than an empty one.
        if (client.presence.length) this.tellEveryone({ kind: 'presence', entries: this.presence() });
      },
    };
  }

  private receive(client: Client, frame: Buffer | string): void {
    const message = decode<ToCore>(frame);
    if (!message) {
      this.log('core  a frame that is not one of ours — ignored');
      return;
    }

    if (message.kind === 'hello') {
      if (message.token !== this.token) {
        this.log(`core  ${message.service} presented the wrong token — refused`);
        client.send(encode({ kind: 'reply', id: 0, ok: false, error: 'wrong token' }));
        return;
      }
      client.service = message.service;
      client.authenticated = true;
      this.log(`core  ${client.service} connected`);
      client.send(encode({ kind: 'welcome', protocol: CORE_PROTOCOL, channels: this.channels }));
      client.send(encode({ kind: 'presence', entries: this.presence() }));
      return;
    }

    if (!client.authenticated) {
      this.log('core  a message before hello — ignored');
      return;
    }

    switch (message.kind) {
      case 'chat.post': {
        const text = message.text.trim();
        if (!text) return;
        const stored = this.chat.post({
          channel: message.channel,
          nick: message.nick,
          text,
          origin: message.origin,
        });
        this.log(`chat  ${stored.channel} <${stored.nick}> ${stored.text} (${stored.origin}, #${stored.id})`);
        // Back to everyone, the sender's service included: it is the one that has to put
        // the line in front of the other players sitting on its own connections.
        this.tellEveryone({ kind: 'chat.message', message: stored, ...(message.sender ? { sender: message.sender } : {}) });
        return;
      }
      case 'chat.history': {
        const messages = this.chat.history(message.channel, message.limit ?? HISTORY_DEFAULT);
        client.send(encode({ kind: 'reply', id: message.id, ok: true, messages }));
        return;
      }
      case 'presence.replace': {
        client.presence = message.entries;
        this.tellEveryone({ kind: 'presence', entries: this.presence() });
        return;
      }
      case 'channels': {
        client.send(encode({ kind: 'reply', id: message.id, ok: true, channels: this.channels }));
        return;
      }
      case 'agent.register': {
        this.agents.set(message.token, { nick: message.nick, room: message.room });
        this.log(`core  agent ${message.nick} registered for room ${message.room}`);
        client.send(encode({ kind: 'reply', id: message.id, ok: true }));
        return;
      }
      case 'agent.identify': {
        // The one question the relay ever asks, and it asks it once per connection. An
        // unknown token is refused here rather than anywhere downstream: that refusal is
        // the whole of the relay's admission control.
        const agent = this.agents.get(message.token);
        client.send(
          encode(
            agent
              ? { kind: 'reply', id: message.id, ok: true, agent }
              : { kind: 'reply', id: message.id, ok: false, error: 'no such agent' },
          ),
        );
        return;
      }
      default:
        this.log(`core  nothing answers "${(message as { kind: string }).kind}"`);
        return;
    }
  }

  /** Something the core says on its own, to every service listening. */
  private tellEveryone(message: FromCore): void {
    const text = encode(message);
    for (const client of this.clients) if (client.authenticated) client.send(text);
  }
}

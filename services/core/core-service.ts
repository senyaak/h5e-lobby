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
import { Accounts } from './rules/accounts.ts';
import { Agents } from './rules/agents.ts';
import {
  CORE_PROTOCOL,
  decode,
  encode,
  type ChannelInfo,
  type FromCore,
  type PresenceEntry,
  type RoomInfo,
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
  /** And of the room list — today only the gateway ever fills this in. */
  rooms: RoomInfo[];
}

export class CoreService {
  readonly chat: ChatStore;
  readonly accounts: Accounts;
  readonly agents: Agents;
  readonly channels: ChannelInfo[];
  private readonly clients = new Set<Client>();
  private readonly token: string;
  private readonly log: (line: string) => void;

  constructor(options: CoreOptions) {
    this.chat = new ChatStore(options.db);
    this.accounts = new Accounts(options.db);
    this.agents = new Agents(options.db);
    this.channels = options.channels;
    this.token = options.token;
    this.log = options.log ?? ((): void => {});
  }

  /** Everyone every service has told us about, as one list. */
  presence(): PresenceEntry[] {
    return [...this.clients].flatMap((client) => client.presence);
  }

  /** Every game being hosted, as the gateway last described them. */
  rooms(): RoomInfo[] {
    return [...this.clients].flatMap((client) => client.rooms);
  }

  /** The room a player is in, or null. */
  private roomOf(nick: string): RoomInfo | null {
    return (
      this.rooms().find((one) => one.members.some((member) => member.toLowerCase() === nick.toLowerCase())) ?? null
    );
  }

  get connections(): number {
    return this.clients.size;
  }

  connect(send: (text: string) => void): CoreConnection {
    const client: Client = { service: '?', authenticated: false, send, presence: [], rooms: [] };
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
      case 'rooms.replace': {
        // Nobody is told: the only reader is the relay, and it asks one question about
        // one agent when a connection opens. Pushing a room list at three services that
        // do not draw rooms would be chatter.
        client.rooms = message.rooms;
        this.log(
          `core  ${client.service} has ${message.rooms.length} room(s): ` +
            (message.rooms.map((room) => `${room.id} "${room.name}" [${room.members.join(', ')}]`).join('; ') || '—'),
        );
        return;
      }
      case 'channels': {
        client.send(encode({ kind: 'reply', id: message.id, ok: true, channels: this.channels }));
        return;
      }
      case 'auth.verify': {
        // The browser's login. The account has to exist already — it is made by a first
        // login in the game — so an unknown name is told apart from a wrong password,
        // and the page can say which.
        const { verdict, name } = this.accounts.verify(message.name, message.password);
        this.log(`auth  ${message.name} from ${client.service}: ${verdict}`);
        client.send(
          encode(
            verdict === 'ok'
              ? { kind: 'reply', id: message.id, ok: true, account: { name } }
              : { kind: 'reply', id: message.id, ok: false, error: verdict },
          ),
        );
        return;
      }
      case 'agent.issue': {
        const secret = this.agents.issue(message.name);
        this.log(`core  an agent secret was issued for ${message.name}`);
        client.send(encode({ kind: 'reply', id: message.id, ok: true, secret }));
        return;
      }
      case 'agent.identify': {
        // The one question the relay ever asks, and it asks it once per connection. Both
        // halves are refused here rather than anywhere downstream — that refusal is the
        // whole of the relay's admission control.
        const nick = this.agents.resolve(message.token);
        const room = nick ? this.roomOf(nick) : null;
        if (!nick || !room) {
          this.log(`core  an agent was refused: ${nick ? `${nick} is in no room` : 'no such secret'}`);
          client.send(
            encode({ kind: 'reply', id: message.id, ok: false, error: nick ? 'not in a room' : 'no such agent' }),
          );
          return;
        }
        const where = `room-${room.id}`;
        this.log(
          `core  agent ${nick} is in ${where}, ${room.endpoints.length} endpoint(s) known: ` +
            (room.endpoints.map((one) => `${one.nick}@${one.address}:${one.port}`).join(', ') || '—'),
        );
        client.send(
          encode({ kind: 'reply', id: message.id, ok: true, agent: { nick, room: where, roster: room.endpoints } }),
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

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
  readonly channels: ChannelInfo[];
  private readonly clients = new Set<Client>();
  private readonly log: (line: string) => void;

  constructor(options: CoreOptions) {
    this.chat = new ChatStore(options.db);
    this.accounts = new Accounts(options.db);
    this.channels = options.channels;
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

  /**
   * Who is playing at this address and port, out of the room list — and nothing else.
   *
   * This is the whole of how an agent is recognised. The endpoints come from the host's
   * own description of the room, by way of the gateway, so the answer is only ever yes for
   * somebody the lobby has actually seated in a game.
   *
   * TWO PLAYERS CAN DECLARE THE SAME ADDRESS — two behind one NAT both saying
   * `192.168.1.5` — and then the port is what separates them. Two who match on both are a
   * hole this cannot close from here; the room list is where that has to be fixed, by the
   * gateway handing out an endpoint of its own per player (SLICE_over_the_internet.md §4.2).
   * Until then such a pair is refused rather than guessed at.
   */
  private playerAt(address: string, port: number): { nick: string; room: RoomInfo } | null {
    const found: { nick: string; room: RoomInfo }[] = [];
    for (const room of this.rooms()) {
      for (const one of room.endpoints) {
        if (one.address === address && one.port === port) found.push({ nick: one.nick, room });
      }
    }
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      this.log(`core  ${address}:${port} is ${found.length} players at once — refusing rather than guessing`);
    }
    return null;
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
      // Nothing is checked. Being able to open this socket at all is the whole of the
      // permission, and what limits that is the loopback bind in `startCore` — see the
      // note at the top of `shared/core-protocol.ts` for why a token in the repository was
      // no better than none.
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
      case 'agent.identify': {
        // The one question the relay ever asks, and it asks it once per connection. The
        // refusal here is the whole of the relay's admission control.
        //
        // Nothing is presented but an endpoint, and it is the ROOM LIST that turns it into
        // a player — which is what "the lobby says who may be let in" means in code. An
        // endpoint nobody is playing at belongs to nobody.
        const found = this.playerAt(message.address, message.port);
        if (!found) {
          this.log(`core  an agent was refused: nobody is playing at ${message.address}:${message.port}`);
          client.send(encode({ kind: 'reply', id: message.id, ok: false, error: 'no player at that endpoint' }));
          return;
        }
        const { nick, room } = found;
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

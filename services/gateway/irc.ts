// Chat: real IRC, in a wrapper.
//
// The game opens a TCP connection to the IRC service at startup and speaks
// ordinary IRC on it — NICK, USER, JOIN, PRIVMSG — except that every line is
// wrapped: a big-endian u16 length, then the line Blowfish-encrypted with a key
// that is the same in every copy of the game (below). Several wrapped lines can
// arrive in one read.
//
// Why this matters beyond chat: entering a lobby channel DEPENDS on it. After the
// lobby says "you are in", the client joins an IRC channel and only then asks for
// its NAT address (`NUbi::CStateWaitJoinLobbyReply::ProcessJoinLobbyReply`, which
// logs "IRC join channel succeeded" / "failed" right there). A silent chat server
// stops the channel screen, which is exactly what it did.
//
// What we implement is the minimum an ircd must say for a client to believe it is
// connected: the welcome numerics, an echo of its own JOIN with a member list, and
// PING/PONG. Everything a player types goes to whoever else is in the channel.
//
// Exports:
//   IRC_KEY, frame(line), unframe(buf)     the wrapper
//   IrcService                             new(); connection() -> handle(buf)

import { Blowfish } from './blowfish.ts';

/** Not a secret: it is compiled into the game. */
export const IRC_KEY = new Uint8Array([
  0x06, 0xe2, 0xc8, 0x46, 0x01, 0x90, 0x55, 0x7c, 0x3c, 0xa1, 0xcd, 0xa3, 0xe3, 0xa1, 0x10, 0x6c,
]);

const cipher = new Blowfish(IRC_KEY);

/** One IRC line, wrapped the way the client expects to read it. */
export function frame(line: string): Buffer {
  const body = cipher.encrypt(Buffer.from(`${line}\r\n`, 'latin1'));
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

/**
 * Every whole wrapped line in `buf`, and whatever is left over.
 *
 * A read can carry a bundle, and it can also cut the last line in half — the
 * remainder goes back on the buffer rather than being guessed at.
 */
export function unframe(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let at = 0;
  while (at + 2 <= buf.length) {
    const size = buf.readUInt16BE(at);
    if (size === 0 || at + 2 + size > buf.length) break;
    const text = cipher.decrypt(buf.subarray(at + 2, at + 2 + size)).toString('latin1');
    for (const line of text.split(/\r?\n/)) if (line) lines.push(line);
    at += 2 + size;
  }
  return { lines, rest: buf.subarray(at) };
}

const SERVER = 'homm5.local';

/**
 * The encoding the game's chat is in, which is **UTF-8** — measured, not assumed.
 *
 * IRC here is bytes, and `unframe` reads them as latin1 because that is the only way to
 * get them back unharmed. What those bytes mean was guessed at first: "whatever the
 * client's Windows ANSI codepage is, 1251 on a Russian machine". That was wrong, and the
 * capture of 15.08.2026 says so in one line — a player typed Cyrillic in the game and it
 * arrived as `71 77 64 d0b9 d186 d0b2`, which is `qwd` followed by UTF-8, not 1251.
 *
 * The guess survived for a year because it CANCELS ITSELF when both ends are the game:
 * UTF-8 bytes read as 1251 became mojibake in the database, and mojibake written back as
 * 1251 became the same UTF-8 bytes again, so the game always drew the right letters and
 * only the stored copy was wrong. The browser lobby is what broke the symmetry — it puts
 * real UTF-8 into the history, and 1251 turned that into a byte sequence which is not
 * valid UTF-8 at all (`дратуте` -> `e4 f0 e0 f2 f3 f2 e5`). The client does not draw that;
 * it dies on it, and every player entering that channel died with it.
 *
 * There is no setting for this and no table of codepages any more. Every client that has
 * ever been measured here sends UTF-8, and none has been seen sending anything else; a
 * knob for "a client that speaks something else" would be an assumption of exactly the
 * kind that cost a year, kept alive on the strength of nobody having tested it. If one
 * ever turns up, the evidence will arrive with it — and so will the branch.
 */

/** What the client typed, as text: the bytes off the wire, which are UTF-8. */
export function fromGameText(wire: string): string {
  return Buffer.from(wire, 'latin1').toString('utf8');
}

/**
 * And back: text into the bytes the client draws.
 *
 * Nothing has to be dropped or replaced on the way — a codepage had characters it could
 * not hold and turned them into `?`, and UTF-8 holds every one of them.
 */
export function toGameText(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

export interface IrcEvent {
  note: string;
  /** Lines for this client. */
  replies: Buffer[];
  /** Lines for everyone else in a channel: [channel, line]. */
  broadcast: Array<{ channel: string; line: Buffer }>;
  /**
   * What was said, unwrapped — the channel and the bare sentence.
   *
   * `broadcast` carries the line as bytes for the other clients in this process; this is
   * the same thing as something a person wrote, which is what the core stores and what a
   * browser can show. Present only for a PRIVMSG.
   */
  said?: { channel: string; nick: string; text: string };
  /** The channel this client just joined, which is when its history is owed to it. */
  joined?: string;
}

/**
 * A channel name as it is stored and compared.
 *
 * The client JOINs `:#LobbyGrp1.2` and then PRIVMSGs to `#LobbyGrp1.2` — the colon is
 * IRC's "the rest of the line is one argument" marker and it belongs to the wire, not
 * to the name. Kept as it arrived, the two spellings are two different channels: a
 * message addressed to one reaches nobody sitting in the other, which is precisely
 * what player-to-player chat would have done the first time two clients tried it.
 */
function channelName(raw: string): string {
  return raw.replace(/^:/, '');
}

/**
 * One line of chat, in the wrapper the client puts round its own.
 *
 * Verbatim from a message Сеня typed: `Senyaak%16777215%9%0%0%Arial%123` — the nick,
 * a colour as a decimal RGB, a size, two flags nobody has identified, a font name, and
 * only then the text. The client packs its own presentation into the message body
 * because IRC carries no room for it, and it parses what arrives the same way: a bare
 * sentence is not a chat line to it.
 */
export function chatLine(nick: string, text: string, colour = 0xffffff, size = 9, font = 'Arial'): string {
  return `${nick}%${colour}%${size}%0%0%${font}%${text}`;
}

/**
 * The same thing read back: the nick and the sentence, with the presentation dropped.
 *
 * Six separators, then the text — which may itself contain a `%`, so the split has a
 * limit and the tail is joined back rather than taken as one field. A line that is not in
 * this shape is not something the client produced, and its whole text is the sentence.
 */
export function parseChatLine(raw: string): { nick: string; text: string } {
  const parts = raw.split('%');
  if (parts.length >= 7) return { nick: parts[0]!, text: parts.slice(6).join('%') };
  return { nick: '', text: raw };
}

export class IrcConnection {
  nick = '';
  readonly channels = new Set<string>();
  private buffer = Buffer.alloc(0);
  /**
   * Names that are in every channel without a connection of their own — the guest.
   *
   * He is in the player panel because the lobby says so (GROUP_INFO), and the panel
   * and the chat are two different lists: this is the one the chat draws its names
   * from, and a name that talks but is not in it looks like a ghost.
   */
  residents: readonly string[] = [];

  receive(chunk: Buffer): IrcEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { lines, rest } = unframe(this.buffer);
    this.buffer = Buffer.from(rest);
    return lines.map((line) => this.handle(line));
  }

  private handle(line: string): IrcEvent {
    const [word, ...rest] = line.split(' ');
    const command = (word ?? '').toUpperCase();
    const event: IrcEvent = { note: `IRC <- ${line}`, replies: [], broadcast: [] };

    switch (command) {
      case 'NICK': {
        this.nick = (rest[0] ?? '').replace(/^:/, '');
        // The welcome numerics. A client that does not get 001 waits forever.
        event.replies.push(
          frame(`:${SERVER} 001 ${this.nick} :Welcome to the Heroes lobby, ${this.nick}`),
          frame(`:${SERVER} 002 ${this.nick} :Your host is ${SERVER}`),
          frame(`:${SERVER} 003 ${this.nick} :This server is ours`),
          frame(`:${SERVER} 004 ${this.nick} ${SERVER} homm5-editor o o`),
        );
        event.note = `IRC nick "${this.nick}" — welcomed`;
        break;
      }
      case 'USER':
        // The client sends it right after NICK; the welcome has already gone out.
        event.note = `IRC user ${rest.join(' ')}`;
        break;
      case 'JOIN': {
        const channel = channelName(rest[0] ?? '');
        if (channel) {
          this.channels.add(channel);
          const names = [this.nick, ...this.residents.filter((name) => name !== this.nick)];
          event.replies.push(
            frame(`:${this.nick} JOIN ${channel}`),
            frame(`:${SERVER} 353 ${this.nick} = ${channel} :${names.join(' ')}`),
            frame(`:${SERVER} 366 ${this.nick} ${channel} :End of /NAMES list`),
          );
          event.broadcast.push({ channel, line: frame(`:${this.nick} JOIN ${channel}`) });
          event.joined = channel;
          event.note = `IRC ${this.nick} joined ${channel}`;
        }
        break;
      }
      case 'PART': {
        const channel = channelName(rest[0] ?? '');
        this.channels.delete(channel);
        event.replies.push(frame(`:${this.nick} PART ${channel}`));
        event.broadcast.push({ channel, line: frame(`:${this.nick} PART ${channel}`) });
        event.note = `IRC ${this.nick} left ${channel}`;
        break;
      }
      case 'PING':
        event.replies.push(frame(`:${SERVER} PONG ${SERVER} :${rest.join(' ').replace(/^:/, '')}`));
        event.note = 'IRC ping';
        break;
      case 'PRIVMSG': {
        const target = channelName(rest[0] ?? '');
        const text = rest.slice(1).join(' ');
        const said = frame(`:${this.nick} PRIVMSG ${target} ${text}`);
        if (target.startsWith('#')) {
          event.broadcast.push({ channel: target, line: said });
          const spoken = parseChatLine(text.replace(/^:/, ''));
          event.said = { channel: target, nick: spoken.nick || this.nick, text: spoken.text };
        }
        event.note = `IRC ${this.nick} -> ${target}: ${text.replace(/^:/, '')}`;
        break;
      }
      case 'QUIT':
        event.note = `IRC ${this.nick} quit`;
        break;
      default:
        event.note = `IRC unhandled: ${line}`;
        break;
    }
    return event;
  }
}

export class IrcService {
  private readonly connections = new Set<IrcConnection>();
  /** Names in every channel that have no connection — see `IrcConnection.residents`. */
  residents: readonly string[] = [];

  connection(): IrcConnection {
    const connection = new IrcConnection();
    connection.residents = this.residents;
    this.connections.add(connection);
    return connection;
  }

  drop(connection: IrcConnection): void {
    this.connections.delete(connection);
  }

  /** Everyone else who is in this channel. */
  others(channel: string, except: IrcConnection): IrcConnection[] {
    return [...this.connections].filter((c) => c !== except && c.channels.has(channel));
  }

  /** Everyone in this channel, including whoever is asking. */
  everyone(channel: string): IrcConnection[] {
    return [...this.connections].filter((c) => c.channels.has(channel));
  }

  /** Every channel somebody is sitting in right now. */
  get channels(): string[] {
    return [...new Set([...this.connections].flatMap((c) => [...c.channels]))];
  }

  /**
   * A line said by somebody who has no connection — the guest, and later anything
   * else the server wants to put in the chat.
   *
   * Chat is real IRC, so this is exactly what a client's own message looks like on the
   * wire; the client draws whatever arrives and asks no questions about who sent it.
   * It carries no timestamp, which is why replaying history would look like it was
   * just said (see docs/NETWORK_STATE.md).
   */
  say(nick: string, channel: string, text: string): { line: Buffer; to: IrcConnection[] } {
    return { line: frame(`:${nick} PRIVMSG ${channel} :${text}`), to: this.everyone(channel) };
  }
}

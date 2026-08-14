// What the core is told about who is where, and WHEN it is told.
//
// Two halves travel this way: presence, which the browser draws, and the room list, which
// is what lets the relay admit an agent at all. Both used to go out on a two-second poll.
// Two seconds is a long time to be kept out of a game you are already standing in, so this
// is driven by the events instead — `touch()` from wherever a socket said something.
//
// Three rules, and each one is a bug that was reasoned about rather than met:
//
//   1. WHAT GOES OUT IS THE WHOLE LIST, never "X joined Y". Rooms appear, fill, empty and
//      vanish on the client's own messages; a delta that went missing would leave the core
//      routing a game that has finished.
//   2. IT GOES OUT ONLY WHEN IT DIFFERS from what was last sent, which is what makes
//      `touch()` cheap enough to call from every message.
//   3. A BURST IS ONE PUSH, not thirty. The first `touch()` opens a window; everything
//      that happens inside it is folded into the single push at its end. Login is a dozen
//      messages in a few milliseconds, and the core has no use for eleven of them.
//
// The window is ALWAYS waited out — there is no "send this one immediately because nothing
// came before it". That was the first draft, and Сеня cut it with the argument that
// settles it: nothing can assert "immediately" without asserting a duration, so the fast
// path would be the one part of this nobody could test. A uniform window costs a few
// milliseconds nobody can feel and is checkable by running the timer.
//
// And `reconnected()`, which is the hole none of the above covers: a core that restarts
// has forgotten the list, and nothing on this side changed, so no comparison will ever
// send it again. The memory of what was sent is dropped and the next push is a full one.
//
// Exports:
//   StateFeed   touch(), reconnected(), pushNow()

import type { PresenceEntry, RoomInfo } from '../../shared/core-protocol.ts';

export interface StateFeedOptions {
  /** How long the window stays open, counted from the change that opened it. */
  window: number;
  presence(): PresenceEntry[];
  rooms(): RoomInfo[];
  sendPresence(entries: PresenceEntry[]): void;
  sendRooms(rooms: RoomInfo[]): void;
  /** Injected so a test can run the window out rather than wait for it. */
  schedule?(fn: () => void, ms: number): void;
}

export class StateFeed {
  private readonly options: StateFeedOptions;
  private readonly schedule: (fn: () => void, ms: number) => void;

  private lastPresence = '';
  private lastRooms = '';
  private pending = false;

  constructor(options: StateFeedOptions) {
    this.options = options;
    this.schedule =
      options.schedule ??
      ((fn, ms): void => {
        setTimeout(fn, ms).unref?.();
      });
  }

  /**
   * Something happened on a socket, and the core may need to hear about it.
   *
   * Safe and cheap to call on every message: the window decides when anything is sent and
   * the comparison decides whether. The first call opens the window and the ones after it
   * inside that window do nothing at all — they do not extend it, so a steady stream of
   * messages still produces a push every window rather than none.
   */
  touch(): void {
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.pushNow();
    }, this.options.window);
  }

  /** The core is new and knows nothing; forget what was sent to the old one. */
  reconnected(): void {
    this.lastPresence = '';
    this.lastRooms = '';
    this.pushNow();
  }

  /** Send whichever half moved. Returns the names of the halves that did, for the log. */
  pushNow(): string[] {
    const moved: string[] = [];

    const entries = this.options.presence();
    const presenceShape = JSON.stringify(entries);
    if (presenceShape !== this.lastPresence) {
      this.lastPresence = presenceShape;
      moved.push('presence');
      this.options.sendPresence(entries);
    }

    const rooms = this.options.rooms();
    const roomShape = JSON.stringify(rooms);
    if (roomShape !== this.lastRooms) {
      this.lastRooms = roomShape;
      moved.push('rooms');
      this.options.sendRooms(rooms);
    }

    return moved;
  }
}

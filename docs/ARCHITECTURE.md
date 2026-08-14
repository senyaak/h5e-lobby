# Four services, and why each one is separate

Decided 14.08.2026, after the day that measured the game's peer-to-peer transport end to
end (`NETWORK_STATE.md`, sections "Playing over the internet" onward). Nothing here is
built yet except the pieces named as done. This is the shape to build to.

The goal it serves: two people on different internet connections play Heroes V through our
own server, including behind CGNAT, and can find each other without keeping the game open.

## The services

| | owns | talks to | must NOT |
|---|---|---|---|
| **core** | accounts, profiles, ladder, friends, presence, chat — and the rules over them | nobody; it is asked | speak the game's protocol |
| **game gateway** | the GS desks: router, lobby, NAT, CD-key, IRC; the room settings blob | core | hold state of its own |
| **web** | the browser UI and its API | core | reach the database |
| **relay** | moving game datagrams between agents | core, **once per connection** | need anything at runtime |

Plus the **agent**, which is not a service: it runs on the player's machine, one per
player, and is the only thing that talks to the outside from there.

Today core and the game gateway are **one process** — there is one consumer of the rules,
so there is nothing to split yet. The seam is kept visible instead: `ladder.ts`,
`accounts.ts`, `friends.ts`, `lobby.ts` hold rules and know nothing about the protocol,
and `router-service.ts` holds protocol and no rules. When the web lands there are two
consumers and the split pays for itself.

## Why the relay is not in the middle

Everything else may restart; a game in progress must not notice. So the relay asks the
core exactly one question — "who is this agent, and which room is he in" — when a
connection opens, caches the answer for the life of that connection, and needs nothing
afterwards. Consequences, deliberate:

- core down → **new** relayed connections are refused, **running** games continue;
- a banned player is stopped at his next connection, with no revocation list anywhere;
- a brief grace window re-admits an agent whose identity was confirmed a minute ago, so a
  wifi blip during a core restart does not end a game.

Signed tickets (Ed25519, core signs, relay holds only the public key) were designed and
are **not needed under this arrangement**. They become the answer only if the relay must
work while the core is unreachable — then they slot in without changing anything else.

The relay never learns a destination from its client: an agent says "to my opponent", not
"to this address". It is therefore not a proxy anyone can bounce traffic through, and that
property must survive every future change to it.

## What the agent is, and why it exists

Two facts force it:

- **cloudflared carries HTTP and nothing else.** The game's own desks are raw TCP and UDP
  on six ports. Behind a tunnel they cannot be reached at all, so the game's lobby traffic
  has to travel inside a WebSocket.
- **the game dials a peer directly, over UDP, at an address it is told.** Over the
  internet that address is useless and often unreachable.

So the agent terminates both. The game is pointed at `127.0.0.1` for everything, and the
agent decides what happens next:

```
game ──UDP→ 127.0.0.x ─┬─ agent ──UDP────────→ peer          when a hole punch works
                       └─ agent ──WS─────────→ relay         when it does not
game ──TCP/UDP→ 127.0.0.1 ─ agent ──WS───────→ core          always: login, channel, room
```

The path choice is invisible to the game and to the core: the address written into the
room description is the agent's own loopback stand-in either way, so the agent may even
change its mind mid-game. The core's part is to hand out the materials for the choice —
the peers' public endpoints, which its NAT desk already observes, and the relay's address.

**Identity.** The agent holds a long-lived secret in its config, issued once by the
launcher logging in with the player's account. It never passes through the game. The game
then logs in *inside* that tunnel, which gives the core a free consistency check: a login
under a different name than the tunnel's owner is refused.

Eventually the agent is a DLL loaded by the existing native extension (WinHTTP has
WebSocket support, so no TLS or dependency of our own). For the local pretest it is a Node
process — same protocol, same behaviour, cheap to iterate.

## What is already proven

From `NETWORK_STATE.md`, measured with packet captures on 14.08.2026:

- peers speak UDP directly, at each other's `net_game_port`, one socket each;
- they meet at **`JOIN_ROOM`**, before the game starts — a relay must stand up when the
  room fills, not at match start;
- the address they dial comes from **the host's room-settings blob**, in each player's
  record, and rewriting four bytes there sends both clients wherever we like;
- a full duel and a rated three-player game were carried by a stand-in relay
  (`tools/peer-probe.ts`) with no direct packet between the clients;
- the traffic is tiny: 38 kB per duel, peak 1170 bytes in a second;
- generated maps are never transferred — the recipe travels and each client builds its
  own; hand-made maps are never transferred either, the join is refused instead.

The one thing the pretest still has to add: the blob must be patched **per recipient**.
Three agents on one machine cannot claim the same stand-in address, so what player P is
told about Q depends on P. In production a single map would do; per-recipient is more
general and is needed locally anyway.

## The web lobby

The point is not a second client — a browser cannot play. It is that finding an opponent
should not require the game to be running. Which makes it mostly free, because the core
already owns what it needs: accounts, channels, who is present, and the chat that the
game's IRC desk carries. A browser client is another participant on the same chat and the
same presence list, so both sides see each other.

**Chat history is a requirement, not a nicety** — a message written while nobody is in the
game must still be there when someone opens the browser an hour later. That is the first
piece of state the core keeps that the game never asked for.

The launcher we need anyway — it issues the agent's secret and starts the game — is the
same page in an Electron shell.

## Deployment

One repository, four entry points, all on one host to begin with, started from the root by
**systemd units** (fleet-style: one unit per service, `Requires`/`After` where they
actually depend, restart on failure). Сеня adjusts and tests these on the Linux laptop.

Configuration is environment first, file second: a container is fed variables, a laptop is
fed a file. Nothing that matters is compiled in.

## What to build first

1. **A light core + web, enough to see it work**: the game logs in and chats as it does
   today, a browser page shows the same channel and the same messages, both directions,
   **with history**. This is the milestone that proves the split is real rather than drawn.
2. **The agent and the relay, locally**: three copies of the game, three agents, one
   relay, everything on `127.0.0.1`, no tunnel and no 443. Per-recipient blob patching
   turns the debug `--probe-peer-address` into the real thing.
3. **The tunnel**: cloudflared in front, the agent's URL changes and nothing else does.
4. **Two machines**, then a phone hotspot for a real CGNAT path.

Done already: the WebSocket layer (`src/net/websocket.ts`, ours, no dependency — messages
of any size arrive whole in both directions, verified) and the stand-in relay that carried
real games (`tools/peer-probe.ts`).

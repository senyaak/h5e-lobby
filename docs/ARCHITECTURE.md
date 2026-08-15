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
| **u-lobby** | the GS u-lobby services: router, lobby, NAT, CD-key, IRC; the room settings blob | core | hold state of its own |
| **web** | the browser UI and its API | core | reach the database |
| **relay** | moving game datagrams between agents | core, **once per connection** | need anything at runtime |

Plus the **agent**, which is not a service: it runs on the player's machine, one per
player, and is the only thing that talks to the outside from there.

## Where the seam actually runs (14.08.2026)

The web has landed, so there are four processes, one systemd unit each (`deploy/`), and
`npm start` runs all four locally through `tools/fleet.ts`. They talk to the core over one
WebSocket carrying JSON — `shared/core-protocol.ts` for what it says, `shared/core-client.ts`
for how a service says it.

**A service is a folder, not a file.** Everything only that service uses lives inside it,
which is what makes "the web must not reach the database" something you can see rather
than something written down:

```
services/core/      main.ts server.ts core-service.ts chat.ts
                    rules/{accounts,ladder,friends,profiles,database}.ts
services/u-lobby/   main.ts router-service.ts lobby.ts irc.ts gs-{data,message,xor}.ts
                    srp.ts blowfish{,-tables}.ts nat-service.ts cdkey-service.ts pkc.ts
                    address.ts structure.ts rules-wire.ts
services/web/       main.ts web-service.ts index.html
services/relay/     main.ts relay-service.ts
shared/             config.ts log.ts websocket.ts core-protocol.ts core-client.ts channels.ts
```

Two of those need saying. `shared/channels.ts` holds the three lobbies and the
`#LobbyGrp<server>.<group>` name because the core publishes that list to the browser and
the u-lobby serves it to the game — neither may own it. `services/u-lobby/rules-wire.ts`
holds `ladderPayload`, `matchResult` and `friendUpdate`: they are the client's shapes, so
they sit on the protocol side, and with them gone `services/core/rules/` imports nothing
of the game at all — which is what this document had been claiming while `ladder.ts` still
imported `GSValue`.

What actually moved into the core is **chat, its history, presence and the agent
registry**. The rest of the rules — accounts, ladder, friends, profiles — are still called
straight out of `router-service.ts`, which holds the database open beside the core: those
handlers answer the client synchronously, and a remote call cannot. Two processes on one
SQLite file in WAL mode with `busy_timeout` is what makes that safe, and it is the one
place where the drawing above is ahead of the code.

Moving them across is a contained job — about eighteen call sites, all inside message
handlers — and it needs `RouterSession.receive` to become async. Until somebody wants it,
nothing is paid for it: the seam is still visible, `ladder.ts` / `accounts.ts` /
`friends.ts` / `lobby.ts` hold rules and know nothing about the protocol, and
`router-service.ts` holds protocol and no rules.

**Chat is not fanned out by the core alone.** The u-lobby still delivers a player's line to
the other game clients on its own process, and posts the same line to the core for storing
and for the browser. So two players in one channel keep talking with the core stopped;
what they lose is the history and the browser. The core's echo carries the id of the
u-lobby that sent it, which is how the u-lobby knows not to draw its own line twice.

**The wire is a codepage, not UTF-8.** The game's IRC is one byte per character in the
client's Windows ANSI page (1251 here), so the u-lobby converts at its own edge —
`fromGameText` / `toGameText` in `services/u-lobby/irc.ts`. Read as latin1 and stored, a Russian
sentence becomes `:B>-=81C4L` and is lost; that is what the first live run did.

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

- **cloudflared carries HTTP and nothing else.** The game's own u-lobby services are raw TCP and UDP
  on six ports. Behind a tunnel they cannot be reached at all, so the game's lobby traffic
  has to travel inside a WebSocket.
- **the game dials a peer directly, over UDP, at an address it is told.** Over the
  internet that address is useless and often unreachable.

So the agent terminates both — from inside the process, by taking over the calls the game
already makes:

```
game's own socket calls ─┬─ agent ──UDP────────→ peer          when a hole punch works
                         └─ agent ──WS─────────→ relay         when it does not
game's u-lobby connections ─── agent ──WS─────────→ core          always: login, channel, room
```

The path choice is invisible to the game and to the core, so the agent may change its mind
mid-game. The core's part is to hand out the materials for the choice — the peers' public
endpoints, which its NAT service already observes, and the relay's address.

**Identity: the lobby says who may be let in, and there is nothing to hand out.**

An agent opens with seven bytes saying where its game plays — the address and port it
takes off the socket it already has its hands on. The relay asks the core that one
question, and the core answers it out of the room list the u-lobby sends: somebody is
playing at that endpoint, or nobody is. No secret, no ticket, no file to distribute, and
nothing on disk. A player becomes admissible by joining a game and stops being admissible
when the game ends, which is exactly the lifetime that was wanted.

There WAS a long-lived secret here, hashed in the core's database, issued by
`npm run issue-agent` and written into the extension's config. Сеня cut it on 14.08.2026
and the reason is the one that ends the argument: **nobody outside the three copies on his
u-lobby service could ever have obtained one.** The doc had answered "where does it come from" with a
launcher that does not exist and is not planned.

Two consequences worth having in front of you:

- **A room whose description we cannot read admits nobody.** The endpoints are the
  identity, so a room with none has no admissible players — where the secret would have let
  them in and left the relay with nowhere to aim. `roomEndpoints` reads by shape and is
  tested against captured bytes, which is what makes that acceptable.
- **Two players who declare the same address AND port cannot be told apart**, and are
  refused rather than guessed at. The port separates two behind one NAT; two colliding on
  both is a hole the core cannot close, and the fix belongs in the u-lobby — an endpoint of
  its own per player in the room description (`SLICE_over_the_internet.md` §4.2).

**The agent is C, inside the game** — a module of the existing native extension
(`homm5-editor`, worktree `homm5-editor-net`, `native/net/`), not a process beside it.
Сеня settled that on 14.08.2026, against an earlier line here that had it as a Node
process "for the local pretest, cheap to iterate". It was not cheaper: a process outside
the game has to be *dialled*, so the game would have to be handed a loopback stand-in
address for every peer and the server would have to write those addresses into the room
description — a whole mechanism built to be thrown away, and a second implementation of
the agent's protocol to keep in step with the first.

In the process there is nothing to dial. The extension already detours the game's own
calls (`native/net/ubi-log.c` and the probes beside it); the agent hooks the socket the
game plays on and decides, per datagram, between the peer and the relay. WinHTTP carries
the WebSocket, so there is no TLS and no dependency of ours on that side either.

What the address in the room description becomes, then, is a **key and not a
destination**: the game hands it to a hook that has to recognise which peer it means. The
client already knows the room's players and their records, so the agent may well build
that table itself — in which case the per-recipient patching below is not needed at all.
That is the first thing to find out when the agent is written, not to assume either way.

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

That last measurement was taken with a stand-in relay *outside* the game, which is why it
needed the blob rewritten: something had to be dialled. With the agent inside the process
the question changes shape — the address is a key the hook resolves, and the client
already holds the room's player records, so the table may be built there. **That is open
until the agent's first run**, and the wrong way to settle it is to build the per-recipient
patching first and never find out.

## The web lobby

The point is not a second client — a browser cannot play. It is that finding an opponent
should not require the game to be running. Which makes it mostly free, because the core
already owns what it needs: accounts, channels, who is present, and the chat that the
game's IRC service carries. A browser client is another participant on the same chat and the
same presence list, so both sides see each other.

**Chat history is a requirement, not a nicety** — a message written while nobody is in the
game must still be there when someone opens the browser an hour later. That is the first
piece of state the core keeps that the game never asked for.

### Who you are in the browser (14.08.2026, done)

The same account as in the game, and **there is no sign-up here**. An account is created by
its first login *in the game* and nowhere else, so a password is set in exactly one place;
the page checks nothing itself, it posts the name and password to the web service, which
asks the core, which asks `Accounts.verify` — the one entry that refuses an unknown name
instead of creating it. A second door to the same accounts would need everything a public
sign-up needs and would buy nothing.

Consequences worth knowing:

- **a refusal says which**, `no-such-account` or `wrong-password`, because the page has to
  be able to say "log in once in the game first". That is advice, not a leak: the game
  already tells anyone who asks whether a name exists, by creating it or refusing it;
- **the name shown is the account's own spelling** — the table is `NOCASE`, so `senyaak`
  in the browser and `Senyaak` in the game must not become two people in one chat;
- **the session is a cookie the page cannot read.** A random token per login, kept in the
  web service's memory and sent back as `HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`
  (plus `Secure` when the request arrived over TLS, which behind cloudflared it will).
  `HttpOnly` puts it out of reach of any script, ours included, so there is no copy of it
  anywhere in the page; `SameSite=Lax` stops another site spending it, on a form post or on
  a WebSocket handshake. The cookie travels with the HANDSHAKE, so logging in has to open a
  NEW socket — the one already open was greeted without it. Restarting the web service asks
  everybody for a password again, which is the honest price of not having a session table
  yet;
- **it runs out an hour after the last sign of the person, and a live socket is one.**
  Every minute the service marks the session behind each connected browser as used, and
  deletes any that has had nobody behind it for an hour — expiry that happens on its own
  rather than "when next asked". The refresh is on the SERVER and not in the page because a
  background tab's timers are throttled, sometimes to nothing, and a session must not run
  out under a connection that is open and carrying chat. The page's own minute tick
  (`POST /session`) exists for the other half: the cookie carries an expiry too, and a tab
  open past the hour would otherwise be logged out the moment it was reloaded;
- **five wrong passwords from one address and it stops asking the core**, for a minute,
  the right password included — a throttle that lets the real one through is not one;
- the browser is a chat participant, not a player: it is in the web presence list and in
  the channel, but not in the game's own player panel, which only `GROUP_INFO` fills.

There is no launcher, and this page is not going to become one — see the identity section
above for what that leaves open.

## Deployment

One repository, four entry points, all on one host to begin with, started from the root by
**systemd units** — `deploy/systemd/`, one unit per service plus `h5e.target`, and
`deploy/README.md` for installing them. `Wants=` rather than `Requires=` on the core
everywhere: it is allowed to restart. Сеня adjusts and tests these on the Linux laptop.

Configuration is environment first, file second (`shared/config.ts`,
`deploy/h5e-lobby.env.example`): a container is fed variables, a laptop is fed a file.
Nothing that matters is compiled in.

On a machine without systemd, `npm start` runs `tools/fleet.ts`, which spawns the same four
and prefixes their output. Each service also writes `logs/<service>-latest.log`; the
u-lobby keeps writing `logs/latest.log` as well, because that is the file that gets tailed.

## What to build first

1. ~~**A light core + web, enough to see it work**~~ — **done 14.08.2026.** The game logs in
   and chats as it did; a browser page shows the same channel and the same messages, both
   directions, with history. Checked with the fleet running: a line typed in the browser
   was replayed to a client joining the game's chat port afterwards, and a line said on
   that port appeared in the browser as it was said. `tools/test-services.ts` holds the
   same journey as thirty-odd checks. What is NOT done: a browser player does not appear in
   the game's own player panel — that list is `GROUP_INFO`, which only the lobby fills.
   The browser logs in with the game's account (see above); what it still lacks is a way
   to be seen from inside the game.
2. **The agent and the relay, locally**: three copies of the game, three agents, one
   relay, everything on `127.0.0.1`, no tunnel and no 443. In order:
   - ~~**the lobby's half, which needs no game**~~ — **done 14.08.2026.** The u-lobby
     sends the core its whole room list whenever it changes (`rooms.replace`, on the event
     and not on a clock — `services/u-lobby/state-feed.ts`), and the core answers the
     relay's one question out of that list alone: an agent says where its game plays, and
     somebody is playing there or nobody is. An endpoint in no room is refused, and so is
     one whose game has ended.
   - ~~**the agent**, in C~~ — **done 14.08.2026, and a duel was played through the relay.**
     `homm5-editor-net/native/net/agent.c` and `relay.c`: WinHTTP for the WebSocket, hooks on
     `sendto`/`recvfrom`/`select` (imported from WSOCK32 **by ordinal**), and the datagram
     handed back to the game by answering its own `recvfrom`. Measured, both sides: 667 sent,
     665 carried by the relay, 665 handed back, and exactly **one** datagram arriving directly
     — the first handshake, before the relay was up. So no stand-in addresses and no
     per-recipient patching: that question is closed by there being no address to rewrite.
   - ~~**three copies**~~ — **done 14.08.2026: three of them played.** The first attempt
     lagged and dropped a connection, and two things were wrong on our side: the fleet was
     running a build whose room list carried no endpoints, so the relay sent every datagram
     to everybody in the room; and `roomEndpoints` walked the description as fields, which
     does not survive a real one. Both fixed. Then two runs, and what they prove is not the
     same thing:
     - **three players, a whole game, no complaints** — but on the fleet from before the
       routing, so the relay was still fanning every datagram out to the room. All three
       carried heavy traffic (131369 / 86685 / 137738 out, 135526 / 129785 / 141575 back).
       Worth keeping: the fan-out on its own is not what made the first attempt unplayable.
     - **the addressing, on the fixed fleet** — the room list reached the core with all
       three endpoints (`at 192.168.178.27:8888, :8889, :8890`), the relay logged no
       `named …, which is nobody here`, and the counters came out one-to-one: 17794 carried
       against 17795 handed back, 17801 against 17789. All three were playing; the third
       was put back to the lobby early on (`ProcessGameLeave`, an orderly leave — nothing
       direct arrived, nothing errored, `DISCONNECTIONS=0`), which is why his counter stops
       at 357 while the other two go on. So the precise path has carried three, but the
       long game so far is the one on the old fleet.
   - what is still missing for a real game between strangers: a hole punch (today EVERY peer
     datagram goes through the relay), and the tunnel.
3. **The tunnel**: cloudflared in front, the agent's URL changes and nothing else does.
4. **Two machines**, then a phone hotspot for a real CGNAT path.

Done already: the WebSocket layer (`shared/websocket.ts`, ours, no dependency — messages
of any size arrive whole in both directions, verified) and the stand-in relay that carried
real games (`tools/peer-probe.ts`).

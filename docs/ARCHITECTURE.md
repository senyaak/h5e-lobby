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
services/gateway/   main.ts router-service.ts lobby.ts irc.ts gs-{data,message,xor}.ts
                    srp.ts blowfish{,-tables}.ts nat-service.ts cdkey-service.ts pkc.ts
                    address.ts structure.ts rules-wire.ts
services/web/       main.ts web-service.ts index.html
services/relay/     main.ts relay-service.ts
shared/             config.ts log.ts websocket.ts core-protocol.ts core-client.ts channels.ts
```

Two of those need saying. `shared/channels.ts` holds the three lobbies and the
`#LobbyGrp<server>.<group>` name because the core publishes that list to the browser and
the gateway serves it to the game — neither may own it. `services/gateway/rules-wire.ts`
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

**Chat is not fanned out by the core alone.** The gateway still delivers a player's line to
the other game clients on its own process, and posts the same line to the core for storing
and for the browser. So two players in one channel keep talking with the core stopped;
what they lose is the history and the browser. The core's echo carries the id of the
gateway that sent it, which is how the gateway knows not to draw its own line twice.

**The wire is a codepage, not UTF-8.** The game's IRC is one byte per character in the
client's Windows ANSI page (1251 here), so the gateway converts at its own edge —
`fromGameText` / `toGameText` in `services/gateway/irc.ts`. Read as latin1 and stored, a Russian
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
  web service's memory and sent back as `HttpOnly; SameSite=Lax; Path=/` (plus `Secure`
  when the request arrived over TLS, which behind cloudflared it will). `HttpOnly` puts it
  out of reach of any script, ours included, so there is no copy of it anywhere in the
  page; `SameSite=Lax` stops another site spending it, on a form post or on a WebSocket
  handshake. The cookie travels with the HANDSHAKE, so logging in has to open a NEW socket
  — the one already open was greeted without it. Restarting the web service asks everybody
  for a password again, which is the honest price of not having a session table yet;
- **five wrong passwords from one address and it stops asking the core**, for a minute,
  the right password included — a throttle that lets the real one through is not one;
- the browser is a chat participant, not a player: it is in the web presence list and in
  the channel, but not in the game's own player panel, which only `GROUP_INFO` fills.

The launcher we need anyway — it issues the agent's secret and starts the game — is the
same page in an Electron shell, and it logs in the same way.

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
gateway keeps writing `logs/latest.log` as well, because that is the file that gets tailed.

## What to build first

1. ~~**A light core + web, enough to see it work**~~ — **done 14.08.2026.** The game logs in
   and chats as it did; a browser page shows the same channel and the same messages, both
   directions, with history. Checked with the fleet running: a line typed in the browser
   was replayed to a client joining the game's chat port afterwards, and a line said on
   that port appeared in the browser as it was said. `tools/test-services.ts` holds the
   same journey as thirty-odd checks. What is NOT done: a browser player does not appear in
   the game's own player panel — that list is `GROUP_INFO`, which only the lobby fills — and
   the browser has no account behind its name yet.
2. **The agent and the relay, locally**: three copies of the game, three agents, one
   relay, everything on `127.0.0.1`, no tunnel and no 443. Per-recipient blob patching
   turns the debug `--probe-peer-address` into the real thing.
3. **The tunnel**: cloudflared in front, the agent's URL changes and nothing else does.
4. **Two machines**, then a phone hotspot for a real CGNAT path.

Done already: the WebSocket layer (`shared/websocket.ts`, ours, no dependency — messages
of any size arrive whole in both directions, verified) and the stand-in relay that carried
real games (`tools/peer-probe.ts`).

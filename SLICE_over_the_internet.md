# SLICE — The lobby off this machine, and then onto the internet

> **Status, 14.08.2026:** §2.1, §2.2 and §2.3 done, and §3 done ahead of its turn because
> the tunnel came with the install. The gateway is two sockets now — `8080` TCP and
> `40010` UDP — so the firewall question §2.2 leaves open is two lines, not fifteen. The four services plus a cloudflared
> tunnel run as `senyaak-h5e-*` user units in the `~/Projects/tunnels` fleet
> (`systemctl --user start senyaak-h5e.target`, `deploy/README.md`);
> `https://h5e-lobby.example.com` is the lobby and `wss://relay-h5e.example.com/agent`
> is the relay, both answering `/health` over a real certificate. **Not** done: §2.3, and
> no game has played through any of it yet — the two client-side files (§2.4) still point
> nowhere, §2.5 has not been read off, and stage three is untouched.
>
> What IS built and measured is the local half — four services, three copies of the game,
> every peer datagram carried by our own relay ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
> step 2). This file is the order of work from there, written so it can be picked up on
> the laptop without recovering anything from memory. When a stage is done, mark it here
> and fold the lasting part into `docs/ARCHITECTURE.md` and `deploy/README.md`; when the
> list is empty, retire this file.

Reading first: [deploy/README.md](deploy/README.md) (how the fleet installs),
[shared/config.ts](shared/config.ts) (where every address comes from),
[services/gateway/main.ts:40-106](services/gateway/main.ts) (the server list the game
is handed, and the one host inside it), and — in the editor repo, branch
`net/multiplayer` — `native/net/relay.c` (how the agent dials) and `docs/NETWORK.md`
(how the game is redirected at all).

---

## 1. The fact that decides the shape of everything below

**A tunnel can carry the relay and the browser. It cannot carry the game.**

The game speaks HTTP to us exactly once, and raw TCP and UDP for everything after
that: ten desks, of which `40000/40001/40010/40020/40021` are TCP **and** UDP, `6667`
is the IRC socket, and `40030/40031/40040` are TCP. Cloudflared — and every tunnel of
that family — carries HTTP and WebSocket. There is no port of the game's own transport
it can carry.

The one HTTP request is not an exception either. The redirect is a single environment
variable: `run-net.bat` sets `http_proxy=http://<host>:8080`, and the game's libcurl
7.14 honours it because the game never sets `CURLOPT_PROXY`. That means the value has
to be a *proxy*, reachable over plain TCP; an `https://…` tunnel hostname cannot stand
in for one. The two alternatives named in `docs/NETWORK.md` — a `hosts` entry, or
patching the 43-byte URL literal — both still end at a directly reachable address.

So there are two transports and they get two different answers:

| what | how it gets out |
|---|---|
| relay (`40200`), browser lobby (`8081`) | tunnel, `wss://` and `https://` |
| everything the game itself dials | a routable address: port forwarding, a VPS, or a private network |

How many ports that second row costs is a separate question with a good answer — one,
once §2.3 is done — but it is never zero, and no tunnel of this kind changes that.

The agent already supports its half: `relay.c` accepts `ws://` and `wss://`, takes the
port from the scheme (80 / 443) unless one is given, and passes
`WINHTTP_FLAG_SECURE` when the scheme is secure. Two things about that URL, both
load-bearing: it must carry **no query string**, because the agent appends
`?token=<secret>` itself; and the session is opened `WINHTTP_ACCESS_TYPE_NO_PROXY`, so
the `http_proxy` that redirects the game deliberately does not leak into the agent.

---

## 2. Stage one — the fleet on the laptop, the games on this box, one LAN

No tunnel, nothing public. This is the stage that finds the deployment bugs while
every address is still one you can read off `ip addr`.

### 2.1. Split the one address variable in two — DONE (14.08.2026)

`H5E_HOST` is doing two contradictory jobs. It is **advertised** (it is the host inside
the `[Servers]` ini, and the endpoints the room hands out) and it is also what the core,
the web and the relay **bind** — while the gateway binds every interface. Both defaults
are wrong for a second machine, in opposite directions:

- left at `127.0.0.1`, the relay and the browser are loopback-only, so an agent on
  another box cannot reach them at all;
- set to the LAN address, **the core stops being loopback-only** and starts listening
  where anyone can reach it, with nothing but `H5E_CORE_TOKEN` in front — exactly what
  `shared/config.ts` and `deploy/README.md` promise it never does.

The fix is a variable each, and it is small:

- `H5E_HOST` — **advertised only**. Goes into `serversIni()` and into the endpoints. No
  socket is bound to it.
- `H5E_BIND` — what the gateway, the web and the relay bind. Default `0.0.0.0`.
- The core binds `127.0.0.1` and takes neither. If a reason to move it ever appears it
  gets `H5E_CORE_BIND`, defaulting to loopback — not a share of somebody else's.

Prove it with a check that the core refuses to listen anywhere but loopback, and
sabotage-check it: hand the core a LAN address and the check must go red. A test that
can only confirm is a test that would pass on a typo.

While in there: the gateway logs `start the game with http_proxy=http://127.0.0.1:8080`
no matter what host it was given (`services/gateway/main.ts:94`). It should print the
address it is actually advertising — that line is what gets copied into the bat file.

**How it came out.** `H5E_BIND` (default `0.0.0.0`) is what the gateway, the web and the
relay bind; `H5E_HOST` is advertised and bound to nothing. The core takes neither — it
binds `127.0.0.1` and `startCore` throws on anything else, so no value of `H5E_BIND` can
publish it, and `H5E_CORE_BIND` was not needed after all. `tools/test-services.ts` has
the check and its sabotage half: with the guard commented out, `every interface is
refused` goes red. The gateway's http line now prints the host it advertises, every
listen line names the address it bound, and `--bind` joined `--host` on the command line.

### 2.2. Install — DONE on this machine, as user units (14.08.2026)

Node 24 or newer (the services run TypeScript straight off disk; there is nothing to
build and nothing to install). Units and `h5e.target` from `deploy/systemd/`, env from
`deploy/h5e-lobby.env.example`, and the firewall opened for the ports in §2.3 plus
`8081` and `40200` — but **not** `40100`.

With §2.3 done that is `8080/tcp` and `40010/udp`, and nothing else:

```bash
sudo ufw allow from 192.168.178.0/24 to any port 8080 proto tcp
sudo ufw allow from 192.168.178.0/24 to any port 40010 proto udp
```

Not that way here. `deploy/systemd/` is for a host of its own (`/opt`, a `h5e` user,
root); this machine already has a fleet, so the four went into it as `senyaak-h5e-*`
**user** units in `~/Projects/tunnels/systemd/`, running the working copy at
`~/Projects/h5e-lobby`, with a `senyaak-h5e.target` that starts the five as one command
and `Restart=always` on each — a killed relay was back in seconds without the tunnel
noticing. `deploy/systemd/` stays as it is: it is what a VPS will use (§4.1), and the two
must not drift.

Two corrections to the paragraph above, learnt by doing it:

- **`8081` and `40200` do NOT need opening.** cloudflared dials them from inside the
  host; nothing arrives at them from outside. The only firewall question is the gateway's
  ports — which is exactly why §2.3 is worth doing before anything is opened at all.
- The firewall here is untouched and closed: `ufw` is active with
  `DEFAULT_INPUT_POLICY="DROP"` and **no** user rules, so no desk is reachable from
  another machine yet. A game on this same box is unaffected — its traffic to this box's
  own LAN address goes over `lo`, which ufw lets through.

### 2.3. Nine listening ports become one — DONE (14.08.2026)

**This is lobby-side work and has nothing to do with the agent.** Two separate axes get
confused easily: how many ports the fleet's host must allow (this section — the gateway
only), and how a player's peer traffic gets out (the agent and the relay, done and
measured). Neither waits on the other, and a change here must not turn into a change
there.

The number of DESKS is Ubisoft's — their lobby is split up and the client dials each
part separately. The port NUMBERS are ours: the client learns every one of them from
the ini we serve, from the wait-module reply, from `PROXY_HANDLER` and from the
join-lobby hand-off, all four of which read the endpoints wired at
`services/gateway/main.ts:100-106`. Nothing in the client or in our code compares them
or assumes they differ. So a host that must open one port can have one port.

What is in use, measured on the three-player run (`logs/gateway-latest.log`):

| desk | proto | in that run |
|---|---|---|
| the ini itself (`8080`) | TCP | 3 requests, one per client |
| `Lobby:40040` | TCP | 255 connections |
| `RouterLauncher:40001` | TCP | 103 |
| `IRC:6667` | TCP | 41 |
| `ProxyLauncher:40031` | TCP | 39 |
| `Router:40000` | TCP | 30 |
| `Proxy:40030` | TCP | 18 |
| `NATServer:40010` | UDP | 125 datagrams |
| `CDKeyServer:40020` | UDP | 37 datagrams |

Five more sockets we open saw nothing at all: TCP on `NATServer` and `CDKeyServer`, UDP
on `Router`, `RouterLauncher` and `CDKeyServerLauncher` — `main.ts` binds UDP for every
`tcp+udp` desk whether a handler exists or not, and for three of them none does.

**The client always speaks first.** All eighteen connections in that capture opened with
the client's message; no desk waits to be greeted. IRC is the slowest by far — about
eleven seconds of silence after connecting — but it speaks unprompted in the end. That
is what makes one listener possible at all: there is always something to read before
anything has to be decided.

And what there is to read separates cleanly. The GS desks share a six-byte header whose
**type** byte says which one it is: `219` KEY_EXCHANGE is the router, `102` LOGIN or
`77` LOGINWAITMODULE is the proxy, `210` LOBBYSERVERLOGIN is the lobby. HTTP announces
itself with `GET `. IRC is what is left, and it fails the GS test twice over — its
u16 frame length read as a GS size does not match what arrived, and its second byte is
not a known message type. On the UDP side: CD-key datagrams start `d3` and carry a
big-endian body length that adds up to the datagram's own length; everything else is
the NAT mirror — with one ordering trap, that the mirror echoes **any** datagram under
twelve bytes as a keep-alive, so that fallback has to be tried last.

Two of the merges need no sniffing whatsoever: `Router` and `RouterLauncher` are served
by byte-identical code, and so are `Proxy` and `ProxyLauncher` — the handler picks its
behaviour from the role, and the role comes from the desk, never from the port. Giving
each pair one number is an edit to the desk table plus renaming one lookup key
(`main.ts:320`, `router-service.ts:571`), about ten lines, and six TCP numbers become
four.

Do it in this order, because each step can fail on its own and say why:

1. **Merge the two launcher pairs.** This is also the one real unknown of the whole
   plan: whether the client accepts being handed a wait-module address equal to the
   connection it is already on. Nothing in the code or the notes answers that, and this
   is the cheapest way to ask.
2. **Drop the five dead sockets.** Closing them is how it gets proved they were dead.
3. **Sniff-demux the remaining four TCP desks** onto one listener. The work is that the
   session object is built at connect time today, before any byte has arrived, so it has
   to move behind a classify step that buffers the first message and then replays it.
   Keep the detected role in the log line — "which desk" is the diagnostic this project
   runs on, and losing it would be a real regression. The classifier belongs in its own
   exported function so `tools/test-net.ts` can drive it with the first packets recorded
   in `logs/gateway-latest.log`: a regression test that needs no game.
4. **Merge the two UDP desks** onto one socket, CD-key tested before the short-datagram
   echo.
5. **Fold the ini's HTTP server in** as well. Then `http_proxy=http://<host>:<port>`
   names the same port as everything else.

Altogether: roughly 150 lines of `main.ts` rewritten, one new function of about thirty,
and a scatter of one-line edits — `nat-service.ts:67` and `lobby.ts:669` both spell
`40010` into what they report, and those literals must follow the number. **No protocol
change, and nothing in `router-service.ts`'s message handling moves** — the roles
already exist; only the way a connection is given one changes.

**The game side needs almost nothing for any of this.** Every desk port reaches the
client through the ini, so it takes whatever we say. The agent keeps a list of desk
ports to tell a desk from a player, reads it from the same ini, matches by number alone
and already refuses a duplicate (`native/net/agent.c:88-95`), so nine numbers collapsing
to one leaves it with a one-entry list and nothing to change. Two small things do follow
from that, though: `run-net.bat`'s `http_proxy` names the ini's port by hand, so it
changes if the last step folds HTTP in; and because the agent separates desks from peers
**by port and nothing else**, the number chosen for the desks must not be one a game
also listens on for peers (`8888` upward here).

Worth noticing at the end of it: the browser lobby and the relay are both reached by an
HTTP request too (a WebSocket handshake is a `GET`), so if the last step is taken they
could share the same listener as well, told apart by path. That is what "one port"
could actually mean here — the whole product on one number, plus the same number in UDP.

**How it came out.** All five steps, in that order, one commit each. Fifteen sockets are
two: **`8080` in TCP** — the ini, the router, the proxy, the lobby and chat — and
**`40010` in UDP** for the mirror and the CD-key window. The classifier is
`services/gateway/desk.ts`, driven in `tools/test-net.ts` by the KEY_EXCHANGE the client
really sent, a real wrapped IRC line, the recorded SRP SYN and FIN, and the halves of the
first two; live, a key exchange in one write and in two, a NICK, a CD-key challenge and a
SYN all landed at the right desk.

Four things worth knowing, three of them departures from the plan above:

- **The shared number is the ini's, `8080`, not the router's `40000`.** `http_proxy` is
  written by hand into each copy's `run-net.bat`, every desk address is read out of the
  ini we serve — so keeping the hand-written one means the game side needs **no edit at
  all**, where the other way round wanted three bat files changed.
- **UDP stays on `40010`** rather than moving to `8080` as well. `lobby.ts` writes the
  mirror's port into the room description as the address others are told to dial, so
  making the two literally equal means threading it through `playerInfo` and its callers.
  It buys one firewall line; it is not that step's business. The literal is at least gone:
  both files now read `NAT_PORT` from `nat-service.ts`.
- **`CDKeyServerLauncher` on `40021` went too**, which is the sixth dead socket — the
  table above accounts for five. Its number became the CD-key desk's own, so the ini still
  names a launcher and nothing answers nothing.
- **The CD-key type byte does not decide.** `cdkey-service.ts` reads the request out of
  the body and has never looked at `d3`; our own recorded requests carry a different byte.
  The length that adds up is the test, with the mirror's short-datagram echo tried last.

What is still open is the one real unknown the plan named: whether the client accepts a
wait-module address equal to the connection it is already on. That is answered by a game
logging in, not by us.

**And none of this touches a player's machine.** The peer port each game listens on
(`8888`, `8889`, `8890` here) needs nothing opened and nothing forwarded — its traffic
leaves over the agent's outbound WebSocket. That is what the relay bought, and it is
the reason only the host of the fleet has a firewall question at all.

### 2.4. Point the two client-side files at the laptop

Per game copy, and neither of them is in a repository:

- `<copy>\run-net.bat` — `http_proxy=http://<laptop>:8080`. Hand-written and unmanaged
  today; if it survives this stage as a bat file, at least say so in the editor's
  Network tab, next to the field that writes the other one.
- `<copy>\bin\homm5-editor-net.txt` — `relay ws://<laptop>:40200/agent`, secret
  unchanged. The editor's **Network** tab writes this file; use it rather than an
  editor.

As the fleet stands today, those two lines are:

```
http_proxy=http://192.168.178.23:8080
relay wss://relay-h5e.example.com/agent
```

The first is `H5E_HOST` from `~/.config/h5e-lobby.env` and has to be an address the game
can dial — it changes here and in the bat file together. Its **port** does not change any
more, which is why §2.3 put every desk on the ini's own number: `8080` is now the whole
of what the game dials in TCP. The second is already the internet one, so the relay half
of this stage needs no LAN at all.

### 2.5. How to know the stage worked

Same three readings as the local runs, and they are all in logs we already write:

- the gateway answers the ini over the LAN (`200`, `[Servers]` with the laptop's
  address in it), the game logs in and chat reaches the browser;
- `rooms -> core: … at [Senyaak@<lan>:8888, …]` in `logs/gateway-latest.log` — the
  endpoints are what lets the relay address anybody;
- no `named …, which is nobody here` in `logs/relay-latest.log`, and in each game's log
  `carried out by the relay` against `handed to the game` roughly one to one.

---

## 3. Stage two — TLS for the relay and the browser — DONE (14.08.2026)

Cloudflared in front of `40200` and `8081`; the fleet unchanged behind it. The agent
needs one line changed, `relay wss://relay.<domain>/agent`, and nothing else — that is
the whole point of the URL living in its own file.

Two things worth knowing before it is tried:

- **A real certificate is required.** The agent leaves WinHTTP's security flags at the
  Windows defaults, so a self-signed certificate will be refused and there is no bypass
  to reach for. Cloudflare's own certificate is what makes this free.
- **A quick tunnel renames itself every start.** `trycloudflare.com` hands out a new
  hostname per run, which means editing every game copy's config each time. Use a named
  tunnel on a domain of his own.

What this proves, and it is worth keeping isolated: the relay works across the internet
while the lobby is still on the LAN. If a game breaks at this stage the tunnel is the
only thing that changed.

**As built.** One named tunnel, `h5e`, run by `senyaak-h5e-tunnel.service` from
`~/.cloudflared/h5e.yml`, two ingresses: `https://h5e-lobby.example.com` → `:8081` and
`wss://relay-h5e.example.com/agent` → `:40200`. Both answer `/health` over Cloudflare's
certificate, and a WebSocket handshake to the relay's URL returns `101` — the tunnel
carries the upgrade, which was the one thing worth proving before a game is pointed at
it. The half only a game can do is still open: §2.4, and then a datagram out the far end.

**Why `relay-h5e` and not `relay.h5e-lobby`.** Cloudflare's free certificate covers
`example.com` and `*.example.com`, one level and no deeper. A two-level name would be
served a certificate that does not match it, and the agent leaves WinHTTP's checks at the
Windows defaults — the same reason a self-signed one is no good. Advanced Certificate
Manager buys the second level; a hyphen is free.

---

## 4. Stage three — a genuinely foreign network

A phone hotspot for one copy is enough to make it real: two NATs, no shared subnet.
This is where the remaining design work is, and there are two separate problems.

### 4.1. The desks need an address the game can dial

With §2.3 done this is one TCP port and the same number in UDP, which makes every option
below cheaper — but it is still an address that has to exist. Three ways, and they are
not equivalent:

- **A small VPS running the fleet** — the only one that works for people who are not
  us. It is also where the tunnel stops being needed for the relay.
- **Port forwarding on the router** — cheapest way to *test* stage three, and it proves
  the protocol side without proving anything about strangers.
- **WireGuard or Tailscale between the two machines** — works, and honestly labelled:
  it makes the two boxes one LAN, so it tests the game and not the internet.

### 4.2. Two peers can present the same address, and today that is ambiguous

A room's endpoints are the addresses the clients **declared** at login. Two players
behind different NATs can both declare `192.168.1.5`, and the relay's match by address
then finds two agents — its fallback is to send to everybody in the room, which is the
fan-out we just got rid of.

The fix is one rewrite in the one place that builds the room description: advertise a
**unique stand-in address per player per room** (`10.77.<room>.<slot>` and the like)
instead of what the client declared. The same substitution for every recipient, so
there is no per-recipient patching; the agent needs no change at all, because it carries
whatever address the game dialled and the relay matches the address it was given.

This does not contradict the conclusion from the duel that stand-in addresses are not
needed. That was about *delivery* — the agent answers the game's own `recvfrom`, so
nothing has to be rewritten for a datagram to arrive. This is about *telling two peers
apart*, which only becomes a problem once two of them collide.

One more thing that changes here: the NAT mirror answers with the source address it
sees. On a real public host that is right; behind a tunnel it is not, and there is no
override for it today.

---

## 5. Stage four — the hole punch, and why it is last

Every peer datagram goes through the relay today. A three-player game did that at
something like 150 datagrams a second and nobody noticed, so the punch buys bandwidth
and latency, not correctness. It is worth doing when the relay's traffic actually
hurts — which is a measurement, not a guess, and the counters to make it with are
already in both logs.

---

## 6. What not to do

- **Do not try to put the game's desks behind the tunnel.** Section 1; it is not a
  configuration problem.
- **Do not set `H5E_HOST` to a routable address before §2.1 is split.** That is the
  step that publishes the core.
- **Do not chase a self-signed certificate** for `wss://`. Either a real one or `ws://`
  on the LAN.
- **Do not quietly move `run-net.bat` into the mod's config.** If it moves, it moves
  visibly, with the Network tab that already owns the other file.

## 7. Small things to fix while passing through

- ~~`docs/NETWORK_STATE.md` still tells the reader to run `node tools/net-server.ts`~~ —
  fixed 14.08.2026; it names `services/gateway/main.ts` and the fleet target.
- ~~`deploy/README.md`'s health checks are written against `localhost`~~ — fixed
  14.08.2026; they say "from on the host", with the two public URLs beside them.
- `startCore` now rejects instead of dying when it cannot have its socket. The other
  three still let a `listen` error reach Node uncaught, which is a stack trace where a
  sentence would do — and §2.3 will make one of them bind rather more.

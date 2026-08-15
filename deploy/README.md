# Running the fleet

Five services, one repository, one host. On Linux they are five systemd units; on a
machine without systemd — a Windows one, for instance — `npm start` spawns the same five
and prefixes their output.

| unit | what it is | listens on |
|---|---|---|
| `h5e-core` | accounts, ladder, friends, presence, chat and its history | `40100` (loopback) |
| `h5e-gateway` | the u-lobby the game connects to | `8080`, TCP and UDP: the ini and every u-lobby service in one, the NAT mirror and the CD-key window in the other |
| `h5e-web` | the browser lobby | `8081` |
| `h5e-relay` | game datagrams between agents | `40200` |
| `h5e-u-lobby` | the same u-lobby, for a game that reaches us through a tunnel | `40300` |

Only the gateway, the web, the relay and the u-lobby tunnel are ever reached from outside.
The core is loopback: everything that talks to it is on the same host.

**The gateway and the u-lobby tunnel are two doors into one room.** A game on this network
dials `8080` itself; a game that cannot — because a tunnel carries HTTP and WebSocket and
nothing else — hands its u-lobby sockets to the tunnel, which opens ordinary loopback
connections to `8080` on its behalf. The gateway is not told which door a client came
through and does not change either way.

## Two addresses, and why they are not one

| variable | what it does | default |
|---|---|---|
| `H5E_HOST` | **advertised only** — the host inside the `[Servers]` ini and the endpoints a room hands out. No socket is bound to it, so it must be an address the game can dial. | `127.0.0.1` |
| `H5E_BIND` | what the gateway, the web and the relay **bind** | `0.0.0.0` |

The core takes neither. It binds `127.0.0.1` and `startCore` refuses anything else
(`services/core/server.ts`), and that bind is its whole defence — nothing authenticates on
the hop between the services and the core. That guard is what makes `H5E_BIND` safe to set:
one variable moves the three services that are meant to be reachable, and there is no
value of it that publishes the core. `tools/test-services.ts` checks both halves — the
running core is on loopback, and a core handed `0.0.0.0` or a LAN address is refused.

## Install

```bash
sudo useradd --system --home /opt/h5e-lobby --shell /usr/sbin/nologin h5e
sudo git clone <this repo> /opt/h5e-lobby
sudo chown -R h5e:h5e /opt/h5e-lobby

sudo cp /opt/h5e-lobby/deploy/h5e-lobby.env.example /etc/h5e-lobby.env
sudo editor /etc/h5e-lobby.env          # at least H5E_HOST

sudo cp /opt/h5e-lobby/deploy/systemd/*.service /opt/h5e-lobby/deploy/systemd/h5e.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now h5e.target
```

Node 24 or newer, because the services run their TypeScript straight off disk. There is
nothing to build and nothing to `npm install` — this repository has no dependencies
outside Node itself.

## On this machine: the same five inside senyaak's fleet

The `/opt` install above is for a host of its own. Here the five run as **user** units out
of this same checkout — no root, and `~/Projects/tunnels/fleet` manages them alongside the
MCP servers and their tunnels:

| unit | what it runs |
|---|---|
| `senyaak-h5e-core` | `services/core/main.ts` |
| `senyaak-h5e-gateway` | `services/gateway/main.ts` |
| `senyaak-h5e-web` | `services/web/main.ts` |
| `senyaak-h5e-relay` | `services/relay/main.ts` |
| `senyaak-h5e-u-lobby` | `services/u-lobby/main.ts` |
| `senyaak-h5e-tunnel` | cloudflared: `h5e-lobby.example.com` → `:8081`, `relay-h5e.example.com` → `:40200`, `u-lobby-h5e.example.com` → `:40300` |

```bash
systemctl --user start   senyaak-h5e.target    # the six, one command
systemctl --user restart senyaak-h5e.target    # take them round together
systemctl --user restart senyaak-h5e-gateway   # or just one of them
journalctl --user -u senyaak-h5e-gateway -f
~/Projects/tunnels/fleet                       # 0 = tree + health, local and public
```

`Restart=always` on every one of them, and `loginctl enable-linger` is already on, so
they come back after a crash and after a reboot without anyone logging in.

**The units are files in `deploy/systemd/senyaak/` — in THIS repository**, symlinked into
`~/.config/systemd/user/`. They lived in `~/Projects/tunnels/systemd/` until 15.08.2026 and
that is what moved them: the fleet repository is a generic one, it knows how to run and
tunnel anything and nothing about this game. A unit's ports, its ordering and its
description are facts about the lobby and change when the lobby's code changes — kept over
there they went stale silently, which is exactly what the `desk` → `u-lobby` rename did to
them. `./fleet` never cared where the files are: it finds units by the `senyaak-*` glob
through systemd, and a symlink is a symlink.

`H5E_HOST` and `H5E_BIND` live in `~/.config/h5e-lobby.env`, which is in neither
repository.

Installing them, once:

```bash
ln -sfn "$PWD"/deploy/systemd/senyaak/senyaak-h5e-*.service ~/.config/systemd/user/
ln -sfn "$PWD"/deploy/systemd/senyaak/senyaak-h5e.target    ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now senyaak-h5e.target
```

**The tunnel carries what speaks its language, and the game does not speak it.** cloudflared
speaks HTTP and WebSocket; the game's u-lobby services are raw TCP and UDP, and its one HTTP request
goes through `http_proxy`, which has to be a routable address. So the relay reaches the
internet as `wss://relay-h5e.example.com/agent` while the game still dials `H5E_HOST`
directly — SLICE §1.

`h5e-u-lobby` is the way out of that, and **both halves now exist**: this service, and the
mod's own lobby half (homm5-editor, branch `net/multiplayer`, `native/net/lobby.c`), which
holds the game's u-lobby sockets on its loopback and carries them here. No game has been
through it yet — what is proved is the trip, by `tools/test-u-lobby.ts` against a gateway
it spawns and by `tools/probe-u-lobby.ts` against this deployment. What the tunnel costs
the host for a client that does NOT run the mod is unchanged: one number rather than fifteen
sockets: `8080`, in TCP and UDP, because the u-lobby services are told apart by what a connection
says first (`services/gateway/u-lobby.ts`) and not by the port it arrived on. That one number
is what a firewall has to allow, if there is one — on this machine `ufw` is installed but
`ENABLED=no`, so nothing is filtered.

## Day to day

```bash
systemctl status h5e-core h5e-gateway h5e-web h5e-relay h5e-u-lobby
journalctl -u h5e-gateway -f            # or tail logs/gateway-latest.log
systemctl restart h5e-core              # the others reconnect; a running game does not notice
systemctl restart h5e.target            # all five
```

The health checks, from **on the host** — from anywhere else the first two are the
tunnel's hostnames and the third is nobody's business:

```bash
curl -s localhost:8081/health           # web    — also https://h5e-lobby.example.com/health
curl -s localhost:40200/health          # relay  — also https://relay-h5e.example.com/health
curl -s localhost:40300/health          # u-lobby — also https://u-lobby-h5e.example.com/health
curl -s localhost:40100/health          # core   — loopback, and only ever loopback
```

**`Wants=`, not `Requires=`.** The gateway, the web and the relay all want the core and
none of them requires it: the core is allowed to restart, and a game in progress must not
notice (docs/ARCHITECTURE.md). The gateway with the core away still logs players in, still
hosts games, and still carries chat between two people in the same channel; what it loses
is the history and the browser.

## The one thing to know about the database

`data/lobby.db` is opened by the core AND by the gateway. The core owns it — accounts,
profiles, ladder, friends, chat — but the gateway's game handlers still read and write
those tables directly, because they answer the client synchronously and a remote call
cannot. SQLite in WAL mode, with `busy_timeout`, is what makes that safe today; moving
those calls behind the core's API is what removes the question, and it changes nothing
outside `services/gateway/router-service.ts`.

That is why `ReadWritePaths` gives `data/` to the core and the gateway, and to neither of
the other two.

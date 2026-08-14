# Running the fleet

Four services, one repository, one host. On Linux they are four systemd units; on a
machine without systemd — a Windows one, for instance — `npm start` spawns the same four
and prefixes their output.

| unit | what it is | listens on |
|---|---|---|
| `h5e-core` | accounts, ladder, friends, presence, chat and its history | `40100` (loopback) |
| `h5e-gateway` | the desks the game connects to | `8080` http, `40000/40001`, `40010`, `40020/40021`, `6667`, `40030/40031`, `40040` |
| `h5e-web` | the browser lobby | `8081` |
| `h5e-relay` | game datagrams between agents | `40200` |

Only the gateway, the web and the relay are ever reached from outside. The core is
loopback: everything that talks to it is on the same host.

## Two addresses, and why they are not one

| variable | what it does | default |
|---|---|---|
| `H5E_HOST` | **advertised only** — the host inside the `[Servers]` ini and the endpoints a room hands out. No socket is bound to it, so it must be an address the game can dial. | `127.0.0.1` |
| `H5E_BIND` | what the gateway, the web and the relay **bind** | `0.0.0.0` |

The core takes neither. It binds `127.0.0.1` and `startCore` refuses anything else
(`services/core/server.ts`), because the only thing in front of it is `H5E_CORE_TOKEN`,
and a token is a seatbelt, not a lock. That guard is what makes `H5E_BIND` safe to set:
one variable moves the three services that are meant to be reachable, and there is no
value of it that publishes the core. `tools/test-services.ts` checks both halves — the
running core is on loopback, and a core handed `0.0.0.0` or a LAN address is refused.

## Install

```bash
sudo useradd --system --home /opt/h5e-lobby --shell /usr/sbin/nologin h5e
sudo git clone <this repo> /opt/h5e-lobby
sudo chown -R h5e:h5e /opt/h5e-lobby

sudo cp /opt/h5e-lobby/deploy/h5e-lobby.env.example /etc/h5e-lobby.env
sudo editor /etc/h5e-lobby.env          # at least H5E_HOST and H5E_CORE_TOKEN

sudo cp /opt/h5e-lobby/deploy/systemd/*.service /opt/h5e-lobby/deploy/systemd/h5e.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now h5e.target
```

Node 24 or newer, because the services run their TypeScript straight off disk. There is
nothing to build and nothing to `npm install` — this repository has no dependencies
outside Node itself.

## On this machine: the same four inside senyaak's fleet

The `/opt` install above is for a host of its own. Here the four run as **user** units,
next to the MCP servers and their tunnels in `~/Projects/tunnels` — same repository
checkout, no root, and `./fleet` manages them like everything else:

| unit | what it runs |
|---|---|
| `senyaak-h5e-core` | `services/core/main.ts` |
| `senyaak-h5e-gateway` | `services/gateway/main.ts` |
| `senyaak-h5e-web` | `services/web/main.ts` |
| `senyaak-h5e-relay` | `services/relay/main.ts` |
| `senyaak-h5e-tunnel` | cloudflared: `h5e-lobby.example.com` → `:8081`, `relay-h5e.example.com` → `:40200` |

```bash
systemctl --user start   senyaak-h5e.target    # the five, one command
systemctl --user restart senyaak-h5e.target    # take them round together
systemctl --user restart senyaak-h5e-gateway   # or just one of them
journalctl --user -u senyaak-h5e-gateway -f
~/Projects/tunnels/fleet                       # 0 = tree + health, local and public
```

`Restart=always` on every one of them, and `loginctl enable-linger` is already on, so
they come back after a crash and after a reboot without anyone logging in. The units are
files in `~/Projects/tunnels/systemd/`, symlinked into `~/.config/systemd/user/`;
`H5E_HOST`, `H5E_BIND` and `H5E_CORE_TOKEN` live in `~/.config/h5e-lobby.env`, which is in
neither repository.

**The tunnel carries the lobby and the relay, and cannot carry the game.** cloudflared
speaks HTTP and WebSocket; the game's ten desks are raw TCP and UDP, and its one HTTP
request goes through `http_proxy`, which has to be a routable address. So the relay
reaches the internet as `wss://relay-h5e.example.com/agent` while the game still dials
`H5E_HOST` directly — SLICE §1.

## Day to day

```bash
systemctl status h5e-core h5e-gateway h5e-web h5e-relay
journalctl -u h5e-gateway -f            # or tail logs/gateway-latest.log
systemctl restart h5e-core              # the other three reconnect; a running game does not notice
systemctl restart h5e.target            # all four
```

The health checks, from **on the host** — from anywhere else the first two are the
tunnel's hostnames and the third is nobody's business:

```bash
curl -s localhost:8081/health           # web    — also https://h5e-lobby.example.com/health
curl -s localhost:40200/health          # relay  — also https://relay-h5e.example.com/health
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

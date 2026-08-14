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

## Day to day

```bash
systemctl status h5e-core h5e-gateway h5e-web h5e-relay
journalctl -u h5e-gateway -f            # or tail logs/gateway-latest.log
systemctl restart h5e-core              # the other three reconnect; a running game does not notice
systemctl restart h5e.target            # all four
curl -s localhost:40100/health          # core
curl -s localhost:8081/health           # web
curl -s localhost:40200/health          # relay
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
outside `src/net/router-service.ts`.

That is why `ReadWritePaths` gives `data/` to the core and the gateway, and to neither of
the other two.

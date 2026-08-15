# h5e-lobby

Our own Ubi.com for **Heroes of Might and Magic V: Tribes of the East**.

Ubisoft's Game Service was switched off years ago, and the game's whole online menu
hangs from one HTTP request to a host that no longer answers. This is the other end
of that request: everything the client asks for — the server list, NAT traversal, the
CD-key service, the router and its wait modules, the proxy, the lobby, and chat — plus a
browser lobby sitting in the same chat, because finding an opponent should not require
the game to be running. A player can log in with any name, enter a channel and host a
game.

Nothing here patches the game. The redirect is one environment variable: the game's
libcurl honours `http_proxy` and the exe never overrides it, so a game started with
`http_proxy=http://127.0.0.1:8080` asks us for its server list and we point every
service at this machine.

## Four services

| | what it is | where |
|---|---|---|
| **core** | accounts, ladder, friends, presence, chat and its history | `services/core/main.ts`, loopback `40100` |
| **u-lobby** | the Ubisoft lobby the game itself connects to — and, at `/u-lobby` on the same port, the door a tunnelled game carries its sockets through | `services/u-lobby/main.ts`, `8080` in TCP and UDP |
| **web** | the browser lobby | `services/web/main.ts`, `8081` |
| **relay** | game datagrams between agents | `services/relay/main.ts`, `40200` |

One repository, four entry points, one systemd unit each — `deploy/README.md`. Each service
keeps all of its own code in its own folder, and `shared/` holds only what genuinely
crosses between them:

```
services/core/      main.ts server.ts core-service.ts chat.ts  rules/{accounts,ladder,friends,profiles,database}.ts
services/u-lobby/   main.ts classify.ts tunnel.ts router-service.ts lobby.ts irc.ts gs-*.ts srp.ts blowfish.ts nat-service.ts …
services/web/       main.ts web-service.ts index.html
services/relay/     main.ts relay-service.ts
shared/             config.ts log.ts websocket.ts core-protocol.ts core-client.ts channels.ts
```

The core is the only one that touches the database, except for the game handlers that still
reach it directly — the u-lobby importing `../core/rules/` is that seam, left visible on
purpose and named in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm start                             # all four, output prefixed, logs to logs/<service>-latest.log
npm run u-lobby                       # just the game side (--ghosts, --quiet-bot, --probe-… as before)
npm test                              # 300+ checks: the protocol, and the services against each other
npm run typecheck
node tools/net-decode.ts --file dump.txt   # a hex dump from the log, back into a message
```

There is nothing to install: no dependencies outside Node itself, and Node 24 runs the
TypeScript straight off disk. Then start the game — `bin\H5_Game_H5E.exe` in the copy, and
nothing else: the extension points it here itself — and open <http://127.0.0.1:8081> beside it: the same channels,
the same messages, and what was said while nobody was playing is still there.

**The browser logs in with the game's account** — the same name and the same password.
There is no sign-up on the web: an account is created by its first login *in the game*, so
a password is set in one place only. A name the game has never seen is told exactly that.

## Where everything is written down

- **[docs/NETWORK_STATE.md](docs/NETWORK_STATE.md)** — the state of play: the ports,
  how far the client gets, the facts that each cost a launch to learn, and where the
  next wall is. Read this first.
- **[docs/LADDER.md](docs/LADDER.md)** — the stats end, which has no prior art
  anywhere: the proxy's four handlers, the one ladder request, the 46 keys the
  client names.
- **The game's side** lives in the editor repo (`homm5-editor`, branch
  `net/multiplayer`): `docs/NETWORK.md` for how the exe finds its services,
  `native/net/ubi-log.c` for the detour that makes the client narrate what it is
  doing, `tools/net-probe.ts` for the disassembly. That is the split — the editor
  does things *to* the game, this repo only listens. Comments in `services/u-lobby/`
  that point at `docs/NETWORK.md` mean that one.

A player logs in with any name and the first login CREATES his account, with the
password he typed; everything he leaves behind — that account, his profile, his
rating, his friends — lives in one SQLite database (`data/lobby.db`) through
`node:sqlite`, which is part of Node and keeps this repo free of native dependencies.

Gameplay itself is peer to peer, so this server never carries game traffic: the
lobby only introduces the players to each other.

## Prior art

[michal-kapala/gsconnect](https://github.com/michal-kapala/gsconnect) (MIT) is an
open re-implementation of Ubisoft's Game Service with a Heroes V directory. It is
where the SRP field names, the GS message header and the body shuffle were first
written down, and it is used here as documentation; the code is our own, in
TypeScript, checked against our own captures. The ladder and persistent stats,
which this client does ask for, are in neither and are ours to invent.

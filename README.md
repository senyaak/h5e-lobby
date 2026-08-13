# h5e-lobby

Our own Ubi.com for **Heroes of Might and Magic V: Tribes of the East**.

Ubisoft's Game Service was switched off years ago, and the game's whole online menu
hangs from one HTTP request to a host that no longer answers. This is the other end
of that request: one Node process playing every service the client asks for — the
server list, NAT traversal, the CD-key desk, the router and its wait modules, the
proxy, the lobby, and chat. A player can log in with any name, enter a channel and
host a game.

Nothing here patches the game. The redirect is one environment variable: the game's
libcurl honours `http_proxy` and the exe never overrides it, so a game started with
`http_proxy=http://127.0.0.1:8080` asks us for its server list and we point every
service at this machine.

```bash
npm install
npm start                             # every service, one process, logs to _tmp/net/
npm test                              # 225+ checks against bytes a real client sent
npm run typecheck
node tools/net-decode.ts --file dump.txt   # a hex dump from the log, back into a message
```

Then start the game — `run-net.bat` in the game copy sets the variable and nothing
else.

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
  does things *to* the game, this repo only listens. Comments in `src/net/` that
  point at `docs/NETWORK.md` mean that one.

Gameplay itself is peer to peer, so this server never carries game traffic: the
lobby only introduces the players to each other.

## Prior art

[michal-kapala/gsconnect](https://github.com/michal-kapala/gsconnect) (MIT) is an
open re-implementation of Ubisoft's Game Service with a Heroes V directory. It is
where the SRP field names, the GS message header and the body shuffle were first
written down, and it is used here as documentation; the code is our own, in
TypeScript, checked against our own captures. The ladder and persistent stats,
which this client does ask for, are in neither and are ours to invent.

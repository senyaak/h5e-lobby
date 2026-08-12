# h5e-lobby

Our own Ubi.com for **Heroes of Might and Magic V: Tribes of the East**.

Ubisoft's Game Service was switched off years ago, and the game's whole online
menu hangs from one HTTP request to a host that no longer answers. This repo is
the other end of that request: a single Node process that plays the part of every
service the client asks for — the server list, NAT traversal, the CD-key desk, the
router and its wait modules, the proxy, the lobby, and chat. A player can log in
with any name, enter a channel, and host a game.

Nothing here patches the game. The redirect is one environment variable: the
game's libcurl 7.14 honours `http_proxy`, and the exe never overrides it, so a
game started with `http_proxy=http://127.0.0.1:8080` asks us for its server list
and we point every service at this machine.

## Run it

```bash
npm install
npm start
```

Then start the game with the proxy variable set (`run-net.bat` in the game copy
does exactly this and nothing else):

```bat
set http_proxy=http://127.0.0.1:8080
cd /d "%~dp0bin"
start "" H5_Game_H5E.exe
```

Every byte in and out is written to `logs/session-*.log`, in full. Read that log
before changing anything — it is the only witness there is, since no live Ubisoft
service remains to compare against.

```bash
npm test                              # 155+ checks, driven by bytes a real client sent
npm run typecheck
node tools/decode.ts --file dump.txt  # a hex dump from the log, back into a message
```

## What answers what

```
8080   HTTP        the server list (this is the whole redirect)
40000  Router      key exchange, LOGIN, JOINWAITMODULE
40001  RouterWM    the wait module: LOGINWAITMODULE, PLAYERINFO, PROXY_HANDLER, LOBBY_MSG
40010  NAT   UDP   the address mirror — the game will not start without it
40020  CDKey UDP   challenge / activation / authorisation / validation — all yes
40030  Proxy       persistent data, and where the ladder will live
40031  ProxyWM     the proxy's own wait module
40040  Lobby       LOBBYSERVERLOGIN, channels, rooms
6667   IRC         chat, and a precondition for entering a channel
```

Gameplay itself is peer to peer. The lobby only introduces the players to each
other, so this server never carries game traffic.

## The code

`src/` is layers, bottom up. Each file says in its header what is measured and
what is still a guess, and that distinction is the point — a protocol learned from
one side is mostly evidence, and evidence has to be labelled.

| file | what it is |
|---|---|
| `srp.ts` | the reliable-UDP transport under everything: SYN/FIN/ACK, window, checksum |
| `gs-message.ts` | the six-byte Game Service header (the size is big-endian) |
| `gs-data.ts` | the nested lists of strings and blobs every body is made of |
| `gs-xor.ts` | the shuffle a plain body wears |
| `blowfish.ts` | the cipher an encrypted body wears — ours, because Node has no `bf-*` |
| `pkc.ts` | RSA-512, exponent 3, and the client's 260-byte key blob |
| `address.ts` | an address is a decimal u32, and which byte order depends on the field |
| `nat-service.ts` | the address mirror, and a table of which answers the client accepted |
| `cdkey-service.ts` | every key question answered yes |
| `router-service.ts` | the four GS desks: keys, login, hand-offs, lobby messages |
| `lobby.ts` | channels and rooms — what a lobby *is* here is ours to define |
| `irc.ts` | chat, in a length-prefixed Blowfish wrapper |
| `main.ts` | the composition root: ports, the ini, the log |

## Where the rest lives

- **[docs/STATE.md](docs/STATE.md)** — where this stands: how far the client gets,
  which messages are still unanswered, and the facts that cost a launch each to
  learn. Read this before picking up the work.
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — the wire: how the game finds its
  servers, and what each layer looks like.
- The **game side** — disassembly of `H5_Game_H5E.exe`, the log-mirror DLL that
  makes the client narrate what it is doing, and everything else that changes
  files in the game — lives in the editor repo (`homm5-editor`, branch
  `net/multiplayer`, `docs/NETWORK.md`). That is the split: the editor does things
  to the game, this repo is only a server.

## Prior art

[michal-kapala/gsconnect](https://github.com/michal-kapala/gsconnect) (MIT) is an
open re-implementation of Ubisoft's Game Service, with a Heroes V directory. It is
where the SRP field names, the GS message header and the body shuffle were first
written down, and it is used here as documentation. The code in this repo is our
own, in TypeScript, checked against our own captures. The ladder and persistent
stats — which this client does ask for — exist in neither, and are ours to invent.

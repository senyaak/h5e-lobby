# The wire

What this server has to speak, and how each layer is known. The game-side
evidence — the disassembly of `H5_Game_H5E.exe` that these facts were read out
of, and the commands to reproduce it — lives in the editor repo
(`homm5-editor`, branch `net/multiplayer`, `docs/NETWORK.md`); this file is the
protocol as the server sees it. Where something is a guess it says so.

## One request decides everything

`NUbi::CStateUninitialized::GetServersConfig` downloads
`http://gsconnect.ubisoft.com/gsinit.php?dp=HEROES_29988429c481f219` into
`%TEMP%\ubi_servers.ini` with libcurl, and then reads it back with plain
`GetPrivateProfileStringA` / `GetPrivateProfileIntA`:

```ini
[Servers]
RouterIP0=…            RouterPort0=…      RouterLauncherPort0=…
NATServerIP0=…         NATServerPort0=…
CDKeyServerIP0=…       CDKeyServerPort0=…
IRCIP0=…               IRCPort0=…
```

The key names are built as `%sIP%i` / `%sPort%i` / `%sLauncherPort%i` and the
index counts up until a key is missing — each service is a *list* of servers to
try. **There is no local fallback**: if the download fails, the whole online
session fails, and the temp file is only read after a successful GET.

That format is checked rather than assumed: our ini was read back through the same
Windows API the game uses, and index 1 comes back empty, which is how the client
knows the list ended. Windows' profile reader wants CRLF and a trailing newline.

Two services are **not** in the ini — the proxy and the lobby. The client is told
where those live when it asks for them (`PROXY_HANDLER`, `JOIN_SERVER`), so their
addresses are ours to hand out at runtime.

The redirect itself: libcurl 7.14.0 reads `http_proxy` from the environment and
the exe never sets `CURLOPT_PROXY`, so `http_proxy=http://127.0.0.1:8080` is the
entire mechanism, affecting only that process. A `hosts` entry for
`gsconnect.ubisoft.com` works too; patching the URL literal is possible but
length-bound.

## The services

- **NATServer** — an address mirror over UDP. The client tells it nothing useful
  and wants its own address back. Nothing else can start until it answers.
- **Router** — the entry point. Key exchange, then LOGIN, then a hand-off to a
  *wait module* on another port, which is where lobby messages are tunnelled.
- **CDKeyServer** — activation, authorisation, validation. The client holds no key
  list and does no arithmetic: it asks and displays the answer.
- **Proxy** — a switchboard in front of four named handlers: `clanservice`,
  `remotealgorithm`, `persistantdata`, `ladderquery` (the literals are at
  0xFF87CC…0xFF87F8). It has its own wait module, and the requests that arrive
  there are the subject of [LADDER.md](LADDER.md).
- **Lobby** — channels (GS calls them groups), rooms, players.
- **IRC** — chat, and a precondition for entering a channel: the client joins
  `#LobbyGrp<lobby>.<server>` and only then considers itself in.

Gameplay is peer to peer (`NetDriver`). The lobby hands out peer addresses —
the group fields are `ExtIP=`, `LocIP(s)=`, `szIPAddress=`, `szAltIPAddress=` — so
no game traffic passes through here.

## SRP: the transport under UDP

Twelve bytes, then the payload:

| off | size | field |
|---|---|---|
| 0 | 2 | checksum |
| 2 | 2 | signature |
| 4 | 2 | data size |
| 6 | 2 | flags |
| 8 | 2 | segment |
| 10 | 2 | ack |

Flags carry a marker `0x3040` plus FIN 1, SYN 2, ACK 4, URG 8. A SYN appends an
eight-byte window: tail, sender signature, checksum seed, buffer size. Each
direction announces its own seed and signs later packets from it.

The checksum is the piece a wrong answer dies on silently, so it is pinned to
recorded bytes, not to a description: with the field zeroed, the sum over the
client's captured SYN is `0x8893` — exactly what the client wrote there — and the
sum over a packet as sent folds to 0, which is how a receiver checks one. The test
also flips a byte and demands the check fail, because a checksum that always
passes is not a checksum.

## GS messages

Six bytes, then a body:

| off | size | field |
|---|---|---|
| 0 | 3 | size, **big-endian**, including the header |
| 3 | 1 | property << 6 \| priority |
| 4 | 1 | type |
| 5 | 1 | sender << 4 \| receiver |

A body is a nested list of strings and blobs. Plain bodies (`GS_XORED`) wear an
XOR plus a diagonal-square shuffle; encrypted ones (`GS_ENCRYPT`) wear Blowfish.

**Measured, and not what you would guess:** the client's LOGIN arrives
`GS_ENCRYPT`, encrypted with the key **we** generated and sent it, not the one it
sent us. The router tries both and reports which opened the body, so this stays a
measurement rather than a belief.

**Also measured the hard way:** a message we cannot read must still be taken off
the stream. Leaving it at the front wedged the connection permanently — the first
encrypted login was re-parsed and re-failed until the client gave up. Consume by
the size field first, parse second.

## The ciphers

- **Blowfish** with GS framing: little-endian halves, zero padding, and the real
  length appended as a u16. Ours (`src/blowfish.ts`) because Node exposes no
  `bf-*` cipher — OpenSSL 3 moved it to the legacy provider. Validated against
  the published vector: zero key, zero block → `4597f94e78dd9861`.
- **RSA-512, exponent 3, PKCS#1 v1.5.** A public key on the wire is a 260-byte
  blob: u32 LE bit count, then a 128-byte big-endian modulus and a 128-byte
  big-endian exponent. Our parse/serialise round-trips the real client's key
  byte-identically.
- **IRC** rides GS too: u16 big-endian length, then a Blowfish body on a key
  compiled into the exe (`IRC_KEY` in `src/irc.ts`).

## Addresses, and the trap in them

An address inside a message body is a **decimal u32**, and which byte order it
wants **depends on the field**:

- the wait-module hand-off wants HOST order — `127.0.0.1` is `2130706433`;
- the NAT answer wants `inet_addr` order — `127.0.0.1` is `16777343`.

Both were measured by watching the game's own sockets: a dotted string sent it
dialling `0.0.0.127`, and the wrong number sent it to `1.0.0.127`.

**The client's log prints a network-order address octet-reversed**, so its
`address=1.0.0.127:40010` is how it renders 127.0.0.1 back to you. Reading that as
an error and turning the bytes round broke a step that already worked. Twice. The
run-by-run table is in `src/nat-service.ts`.

## Timeouts

A step nobody answers costs **30 seconds** (the `0x1E` handed to the NAT connect),
after which the client either moves on or starts the whole attempt over. That is
why a wrong answer looks like a hang rather than an error, and why "it worked that
time" usually means a reply landed inside the window. The client's own config vars
`net_ubicom_init_timeout` and `net_multiplayer_init_timeout` are 10, `net_load_timeout` 20.

## Error codes say nothing

The UI's `0.7.0` is not a step number: the failure path in `ProcessInit` builds the
triple `{7,0,0}` for **every** initialisation failure, and the formatter prints its
fields in the order f1.f0.f2. To know which step failed, read the client's own log
— which means the log-mirror DLL in the editor repo, not this one.

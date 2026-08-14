# Our own Ubi.com: where this stands, and what is known

A companion to `docs/NETWORK.md`, which explains how the game finds its servers and
which lives in the editor repo (`homm5-editor`, branch `net/multiplayer`) together with
everything else that touches the game. This one is the state of play: what runs, what the client accepted, what
it refused, and where the next wall is. Written 12.08.2026 so that none of it has
to be recovered from memory.

## How to run it

```bash
npm start                                   # all four services, one terminal, logs to logs/
node services/gateway/main.ts               # the game's desks alone (this was tools/net-server.ts)
node services/gateway/main.ts --ghosts      # plus synthetic players in every channel
```

On this machine they normally run as the fleet instead — `systemctl --user start
senyaak-h5e.target`, see [deploy/README.md](../deploy/README.md).

`--seed-profile` was a flag here and is now simply what happens: a player with no profile
of his own is handed a minimal one, because refusing is a profile screen that stays shut.

`npm start` and `npm test` are the same two things. `--ghosts` is a diagnostic: it seats
players who do not exist, and what the client draws of them is evidence (see the player
list section). **Turn it off before a two-client test** — otherwise the channel holds
strangers who cannot answer.

The **guest** is always there and is not part of that: one player, with a name, a blob and
a ladder row of his own, seated in the Ranked channel. He is what makes a
profile read, a friend to add and a foreign rating testable with one copy of the game.

Then start the game from the copy: `C:\Projects\homm5-game-net\run-net.bat`. That
bat sets `http_proxy=http://127.0.0.1:8080`, which is the whole redirect — the
game's libcurl asks us for its server list instead of `gsconnect.ubisoft.com`.
Nothing in the exe is patched for this.

Two logs matter, and they answer different questions:

| log | says |
|---|---|
| `logs/latest.log` (and `logs/session-*.log`) | every byte in and out of our services, decoded — `latest.log` is always the run happening now |
| `<game copy>/bin/homm5-editor-*.log` | **the game's own narration**, mirrored by our DLL |

The second one is the important one and it exists because of `native/net/ubi-log.c`
**in the editor repo**: one detour on the engine's log append (0xDFB270), lines
stamped with a tick count. Built and installed from there, not from here:
`node tools/build-native.ts --log net/ubi-log`, then
`node tools/install-native.ts --game C:\Projects\homm5-game-net`. Without it we are
blind — five walls in a row were found by reading it, and the two before it cost a
launch each to guess at.

`node tools/net-decode.ts --file <dump>` turns a hex dump from either log back
into a message; `--srp` for a datagram, `--irc` for chat — that one is ours.
`node tools/net-probe.ts <exe> …` is the disassembly side and lives in the editor repo
as well: strings, references, imports, callers, `--func`, `--dword`, `--bytes`.

## The ports, and who answers

```
8080   HTTP        the server list (this is the whole redirect)
40000  Router      key exchange, LOGIN, JOINWAITMODULE
40001  RouterWM    the wait module: LOGINWAITMODULE, PLAYERINFO, PROXY_HANDLER, LOBBY_MSG
40010  NAT   UDP   the address mirror
40020  CDKey UDP   challenge / activation / authorisation / validation — all yes
40030  Proxy       where "persistantdata" and "ladderquery" live
40031  ProxyWM     the proxy's own wait module
40040  Lobby       LOBBYSERVERLOGIN, channels, rooms
6667   IRC         chat, and a precondition for entering a channel
```

The four GS desks (router, its wait module, proxy, proxy's wait module) speak one
protocol with three differences, all in `src/net/router-service.ts`; the lobby is
a fourth role on the same code.

## How far the client gets

Everything below is from the game's own log, not inference:

```
server list        -> ours
NAT init           -> "connected to NAT Service server 127.0.0.1:40010"
CD-key             -> challenge, authorisation, validation: all answered yes
router             -> keys, LOGIN, "iam sent to 40001"
wait module        -> LOGINWAITMODULE, PLAYERINFO, PROXY_HANDLER
proxy chain        -> LOGIN, hand-off, LOGINWAITMODULE on 40031, LOGINFRIENDS
lobby login        -> accepted, three channels pushed
IRC                -> "IRC welcome", "IRC join channel succeeded"
join channel       -> "join lobby succeeded(GroupID=1,LobbySrvID=1)"
NAT address        -> "address request succeeded,address=1.0.0.127:40010"
ladder             -> WORKS (13.08.2026): "(38,0,1)", then
                      "StartResultEntryEnumeration(1,0) succeeded" and all 46 fields,
                      the game printing "RATING=1500" — our number, out of our store
profile            -> answered and READ: "PSRcv_GetDataReply: ubType=39,iReason=0,iID=2",
                      "PS get data failed,reason=0", and back to CStateOutOfRoom at once
player info        -> arrives on its own now, 73 bytes, his and not our invention
player list        -> WORKS (12.08.2026): the panel draws him
friends (add)      -> WORKS (13.08.2026): "FriendsRcv_AddFriend: (38,…,Senyaak)", and a
                      nameless one is refused with our reason: "(39,1,)"
friends (the list) -> WORKS (13.08.2026): pushed as 74s at friends login and on every
                      add, "FriendsRcv_UpdateFriend: (Guest,1,Ranked,2,1560,)"; removal
                      answered; still drawn as OFFLINE, which is open — see below
create game        -> CREATE_ROOM answered, room 100 in the channel
join own room      -> "LobbyRcv_RoomInfo", then CStateInRoom / CStateWaitingForPlayers
settings changes   -> GROUP_CONFIG_UPDATE_RES answered, the room echoed back
leaving a game     -> destroyed here, announced with GROUP_REMOVE, gone from his list
joining a dead one -> refused with GSFAIL and a reason, instead of silence
TWO CLIENTS (13.08.2026, the second install):
  the other player  -> appears in the channel as he arrives, and his game in the list
  ANOTHER'S GAME    -> **JOINED**: "join room succeeded", CStateInRoom /
                       CStateWaitingForPlayers, chat inside the room both ways — three
                       times in one run
  starting it       -> NEVER TRIED YET: no GameStart, no AttemptGameStart in any log
```

So a player logs in, enters a channel with his name in its player list, hosts a game and
**sits in it waiting for players**; games appear and disappear correctly. **The module
request/reply protocol is solved** (13.08.2026): the ladder and the profile are both read
and acted on, and the client now sends its own player-info blob unprompted, which is the
one thing the room's member records were missing.

Since then the three things that were left of that family have been READ rather than
guessed, and the launch of 13.08.2026 confirmed two: **the ladder row and the friends
reply both work**, on the first try, exactly as the parsers said they had to look. What
each turned out to be is in "Reading the client's dispatch" below.

That launch also found the next two, and they share one lesson — *a thing the client
draws comes from where the client puts it, not from where we would have put it*:

- **the rating in the player panel is inside the player-info blob**, tag 5, and nowhere
  else. `OnMemberJoined` copies `[member+0x38]` into the row and 0xdfea70 puts tag 5
  there. The player's own rating stayed "…" because his member record went out at
  JOIN_LOBBY, a second before his ladder row arrived and he composed that blob.
- **an invented blob has to be the client's own document, one level down.** Tag 2 at the
  top level is legal — every read is guarded by "is this tag here" — and it reads as a
  player with no name at all, which is what the guest was. Everything lives under tag 1.

The second client is the thing nothing has exercised — and the **guest** now stands in for
half of what it was needed for.

## Facts worth not re-learning

- **The keep-alive has to be answered, and it takes two idle minutes to find that out.**
  STILLALIVE is six bytes with no body (`00 00 06 00 3a 41`), every 31 seconds, on every
  connection. Unanswered, the client leaves at about 120 seconds —
  "ProcessLoginDisconnection: disconnected from router", every socket closed from its
  side, measured twice in one run at 122 and 121 seconds. Nobody had ever sat still that
  long (the longest session before the guest started talking was 118 seconds), so it
  looked like the chat had done it. The answer is the same six bytes with the parties
  swapped. **Answer everything** was already the rule in this file; this is the message
  that had been quietly exempt.
- **A chat channel is `#LobbyGrp<server>.<group>`** — server FIRST, so channel 2 on lobby
  server 1 is `#LobbyGrp1.2`. And **a chat line carries its own presentation**:
  `nick%colour%size%0%0%font%text`, verbatim `Senyaak%16777215%9%0%0%Arial%123`. A bare
  sentence is not a chat line to this client. Both are `lobbyChannel()` and `chatLine()`
  in `src/net/irc.ts`, and between them they are why the guest's first two minutes of
  talking were silent.
- **The leading colon is not part of a channel's name.** The client JOINs
  `:#LobbyGrp1.2` and then talks to `#LobbyGrp1.2` — in IRC the colon means "the rest of
  the line is one argument". Stored as it arrives, those are two channels, and one
  player's message would reach nobody sitting in "the other one".
- **The login body is `[name, password, game, 1]`.** Field 1 is the password: its length in
  the capture matched the password actually typed, which is what settled it rather than
  another reading. Field 2 is the game id (`HEROES_…`, 23 characters) and
  field 3 is one byte, 01. The proxy's login is `[name, game]` and carries no password
  at all, which is why only the router checks one.

- **The checksum's lone odd byte is SIGNED.** The routine is at 0x4796E0: the seed is
  written into the checksum field, an odd-length segment counts its first byte alone
  and `movsx`-extended, the rest as 16-bit words. During verification that byte IS
  the seed's low byte, and the client picks a random seed per connection — so with
  `>= 0x80` our sum was 256 too high and the datagram was dropped **without a word**.
  Our NAT answer is 43 bytes, odd, so every launch was a coin toss and it landed at a
  different step each time. This is the source of every "it worked, then it didn't"
  in this file's history, and it means the NAT answer table in `src/net/nat-service.ts`
  may have been measuring the seed rather than the subtypes.
- **A room is twenty fields, a channel is fourteen**, and that is how the client tells
  a game from a channel: sent in the channel's shape our room was logged as
  `LobbyRcv_NewLobby` and then refused. The six extra are visitors, both version
  strings, and the host's two addresses.
- **A mask in a reply must be the mask the request carried.** JOIN_ROOM asks with 448
  (all three "tell me about it" bits), JOIN_LOBBY with 384. The mask says what the
  rest of the message contains; answered with a narrower one the client says "join
  room succeeded" and then "join room failed, no such room in internal list".
- **The ids inside the host's settings blob are ours to write.** He composes it before
  the room exists, so both say -1 (`02 08 ff ff ff ff 03 08 ff ff ff ff`); the server
  stamps the room id and the lobby server id in. Everything else passes through.
- **Order matters: the room info goes out BEFORE the acceptance.** The client
  dispatches in arrival order, so given the "yes" first it runs
  `ProcessJoinRoomReply` against a list that is still empty.
- **Silence means a getter said no, and the getters are typed.** Every reply that "was
  ignored" turned out to be found and consumed, then dropped inside a parser because a
  field was the wrong KIND — a list where a number is read, a string where a blob is.
  Nothing in this protocol reports that; the message simply stops. So when a reply gets no
  reaction, the question is never "did it arrive" but "which field is the wrong kind".
- **Measure before the third guess.** Reading the client's code found the right answer
  five times and the wrong one twice, and each wrong reading cost a launch — Сеня's launch.
  The probe (editor repo, `--log net/ubi-module-probe`) settles in one run what two rounds
  of reading could not, and it is cheap now that it exists.
- **A detour's head must end where an instruction ends.** Five bytes is what the jump
  needs, not what the head is: the trampoline is the copied head plus a jump past it, so a
  head cut mid-instruction resumes the original inside one and the game dies at an address
  belonging to nothing. `npm run test-native-anchors` now checks this for every head a
  detour displaces.
- **A member's status field decides whether he is ever seen.** The channel's player panel
  (0x9108f0) returns immediately unless it is 0 — silently, and after the game log has
  already announced the arrival. Every other part of the message can be right and the
  panel still empty. See the player-list section.
- **Never invent a member's player-info blob.** The client branches on its length
  (0xDFCDEB): with bytes there it parses them, with none it falls back to the name
  field of the member record. A blob of our own parsed into nothing — "member joined
  game (Name=,ExtIP=0.0.0.0:0)" — because the name inside it wins over the name beside
  it. Its format is known now (`src/net/structure.ts`), so a blob CAN be composed; his
  own, from SET_PLAYER_INFO, is still the one to forward.
- **A blob written by the game is a `CStructureSaver` document, not a struct**: tag byte,
  then the size doubled in one byte or in four with bit 0 set. Read `structure.ts` before
  reading any blob's bytes by hand.
- **Answer everything.** Silence is never right on this wire: an unanswered request is
  thirty seconds at best (`CStateWait*`) and a permanent dead end at worst — a JOIN_ROOM
  for a game that had been destroyed parked the client in CStateWaitJoinRoomReply for
  good. A refusal is `GSFAIL` (39) where success is 38, with the reason after the id.
- **A mask is read from the field the wire has it in, not the one the log suggests.**
  JOIN_LOBBY carries [id, password, mask] — the mask is field **2**. Read from field 3 it
  silently fell back to 256 and the member list we sent was announced as "no members",
  which the client duly did not draw.
- **A member list is read as an arrival.** Answering a settings update with the room
  AND its members made the client announce a phantom join, which is a change, which is
  another settings update — five a second, with the game's settings blob growing each
  round because each phantom arrival added a player to it.
- **An address in a message body is a decimal u32**, and which order depends on
  the field. The wait-module hand-off wants HOST order (`2130706433`); the NAT
  answer wants `inet_addr` order (`16777343`). Both were measured by watching the
  game's sockets — a dotted string sent it to `0.0.0.127`, the wrong number to
  `1.0.0.127`.
- **The client's log prints a network-order address octet-reversed.** Its
  "address=1.0.0.127:40010" is how it renders 127.0.0.1. Reading that as an error
  and turning the bytes round broke a step that already worked, twice. See the
  table in `src/net/nat-service.ts`.
- **The NAT answer that works is subtypes 1, 2 and 3 together**, `inet_addr`
  order, the mirror's own port, request id echoed. Two subtypes failed; one
  subtype failed; one subtype twice failed. Why three is not understood.
- **A step that is not answered costs 30 seconds** — the `0x1E` handed to the NAT
  connect — and then the client moves on or starts over. That is the lag Сеня
  noticed, and it is why a wrong answer looks like a hang rather than an error.
- **The login arrives GS_ENCRYPT, keyed with the key WE generated**, not the one
  the client sent us.
- **Chat is real IRC in a wrapper** (u16 big-endian length, Blowfish on a key in
  the exe) and entering a channel depends on it: the client joins
  `#LobbyGrp<lobby>.<server>` and only then asks for its address.
- **The client reads our game list and enforces unique names.** Its default game
  name comes from the player's own, so a stale room of his own makes "a game with
  this name already exists". Rooms now die with their host's connection, on
  GROUP_LEAVE, and a host recreating his own game replaces it.
- **Both engine log thresholds are already 0.** Lowering them opens branches the
  engine means to skip and it dies in its own string append. Read, do not write.
- The blob in CREATE_ROOM (555–888 bytes, it grows with the map) is the host's own
  description of the game — map path, rules, goal — and it passes through us with only
  the two ids written into it.
- **`net-probe "<text>"` matches a whole literal, not a substring.** The engine's names
  live inside longer ones (`LobbySend_Login(`, `…LadderQueryRcv_RequestReply: `), so
  asking for the bare name answers "no such string" about strings that are plainly
  there. That false negative nearly got a correct document rewritten into a wrong one.
  When a name is not found, dump the neighbourhood: `--strings <from> <to>`.
- **A log line can be mostly canned.** The RoomInfo line ends with a literal run of
  seventeen commas, so the "empty fields" in it are not evidence of anything.

## Addresses in the exe worth keeping

Ours is `bin/H5_Game_H5E.exe`, image base 0x400000, read with `tools/net-probe.ts` in
the editor repo.

| what | where |
|---|---|
| SRP checksum (the signed odd byte) | 0x4796E0 |
| SRP receive: length check, then connection lookup **by signature** | 0x47CB00 |
| SRP header builder (`or edx,3040h`) / segment send | 0x479740 / 0x47BB20 |
| the ladder request, pushed beside `"ladderquery"` | 0x42BC92 |
| `ProcessGetLadderRow` — asks, then enumerates the reply | 0xE0BBB0 |
| member's blob: the branch on its length, and the parser | 0xDFCDEB / 0xDFE850 |
| the blob's fields: 2 name, 3 and 4 nested objects, 5 four bytes | 0xDFEA70 |
| `CStructureSaver`: the one primitive that defines the bytes / tag scan / RTTI | 0x94EF30 / 0x94F070 / 0x10C4F14 |
| `ProcessMemberJoined` (its own log lines are the oracle) | 0xDFCBE0 |
| the member record: the generated parser, and the factory it feeds | 0x424B60 / 0xDF1E70 |
| **the player panel's `OnMemberJoined`, and its status guard** | 0x9108F0 |
| `NUI::NLobbyPlayers::CPlayersController` — constructor, and its widget names | 0x90FFC0 |
| the player object a blob is parsed into: name +8, ExtIP +0x14, LocIPs +0x24 | formatter 0xDFE2E0 |
| the ladder reply handler (three arguments) and the request map | 0xDF4080 / 0x41DF10 |
| the servers-config fetch, and why an error code names no step | 0xE07A50 / 0xE075B1 |
| **a module reply: the matcher, and the status/number check** | 0x4286F0 / 0x427170 |
| the queue a received message is pushed onto, and the drainer's key | 0x4285E0 / 0x4288D0 |
| the readers a matched reply then goes through: ladder, profile | 0x42C7F0 / 0x42AEC0 + 0x42B400 |
| the friends reply's own parser — **not the one we answer**, see below | 0x425340 |
| the three queue drainers: lobby, **friends**, and the module/router one | 0x41B620 / 0x41B840 / 0x41BAD0 |
| the friends drainer's switch: index bytes, then jump table | 0x41BA34 / 0x41B9EC |
| ADDFRIEND (75): the reply's handler, its parser, and the status helper | 0x429A20 / 0x4292D0 / 0x428FD0 |
| the ladder's payload parser, and the row/column count rule inside it | 0x432C80 / 0x432B10 |
| a ladder field by name: the map find, then `strtol` over the whole cell | 0x42BB90 / 0x431F20 |
| the profile WRITE: request builder, and its reply's reader | 0x42B1E0 / 0x42B2E0 |
| the getters, by kind: list, string, number, blob | 0x442F10 / 0x4435C0 / 0x443680 / 0x442510 |
| a module request is sent and registered here | 0x41DF10 |
| the profile: read request and reply, write request | 0x42B100 + 0x42AEC0 / 0x42B1E0 |
| the ladder reply reader, and the row payload nobody has parsed | 0x42C7F0 / 0x432C80 |

## The player list: one field, and it was never the blob

The channel's player panel was empty, and that is not cosmetic: "Profile" reads *"look at
the results of the selected players"* and "Join" needs a selected game, so an empty list
greys both buttons out.

**The panel drops a member whose status field is not 0.** The code is
`NUI::NLobbyPlayers::CPlayersController::OnMemberJoined` at 0x9108f0, and it opens with

```
9108fb  cmp dword ptr [esi+4],0     ; esi = the member
9108ff  jne 91097a                  ; ...and that is the whole of it: return
```

Everything after that guard allocates an `SPlayerData`, copies the name into it and adds
the row. `member[+4]` comes from the member record's **last field (index 7)** — the one we
were filling with `PlayerStatus.SILENT` (1). So every player was refused at the door,
after the game log had already announced him. Fixed by sending 0 for a player standing in
a channel; the other statuses describe a player already inside a game, which is exactly
what this panel means to leave out.

The chain, so the next surprise of this shape is cheaper to find: the wire record is
parsed by generated code at 0x424b60, which reads the eight fields by index with typed
getters and hands them to the factory at 0xdf1e70; that builds
`NUbi::SLobbyRcv_MemberJoined` (0x64 bytes) with field 6 at +0x44 and field 7 at +0x62;
`ProcessMemberJoined` (0xdfcbe0) copies those two words into the member it passes to the
listeners, at +0 and +4. The record's fields are therefore known, not guessed:

| index | 0 | 1 | 2, 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| | name | flag | address | player_info | groups | number, −1 if absent | **status** |

The earlier `--ghosts` run (synthetic players, each announced a different way) is still
worth keeping, because it ruled out three other explanations before this one was found:

```
member joined lobby (Name=Senyaak,   ExtIP=0.0.0.0:0)  -> member has no data attached
member joined lobby (Name=GhostList, ExtIP=0.0.0.0:0)  -> member has no data attached
member joined lobby (Name=,          ExtIP=0.0.0.0:0)  <- GhostBlob: the name came out EMPTY
GhostJoin                                              <- not one line about it
```

- **The list is fed by the member list inside GROUP_INFO** — all three were accepted as
  joining, so the mechanism was right all along.
- **The client does not hide only itself**: it took GhostList too and drew neither.
- **A blob is not what the list wants.** "No data attached" and "the name came out empty"
  were both drawn identically — that is, not at all — so the blob was never the reason.
- **MEMBER_JOIN (50) as we sent it is ignored**; still unexplained, and it is the message
  a second client's arrival will need.

### The blob, now that it is not on the critical path

Its format IS known now, and it is the game's own serialisation rather than anything
Ubisoft's: `CStructureSaver` (RTTI at 0x10c4f14), the one primitive that defines the bytes
being 0x94ef30. `src/net/structure.ts` reads and writes it, `tools/dump-struct.ts` prints
it, and the client's own 555-byte room settings parse edge to edge as proof.

```
field  = tag:u8  length  payload[size]
length = size<<1 in ONE byte, or (size<<1)|1 as a LITTLE-endian u32
```

No magic, no version, no type byte; a tag is one byte and may repeat, because the reader
scans for the tag it wants (0x94f070) instead of walking a struct. The player_info reader
(0xdfea70) asks for tag 2 as the name, tag 3 as a nested 16-byte object, tag 4 as a
nested {u16, 16 bytes}, tag 5 as four raw bytes — each guarded by "is this tag here", so a
document holding tag 2 alone is legal. That is what `namedPlayerInfo` writes. The room
settings blob is the same format, which is also why the id stamping works: `02 08 ff…` is
tag 2, length 8 = 4 << 1, four bytes of −1.

Two string kinds live in these documents: a narrow one wrapped in its own container (the
map path came out as `[15] { [2] "…/map.xdb#xpointer(/AdvMapDesc)" }`) and raw UTF-16LE
(the room name, 32 bytes for 16 characters). Which is which per field is not settled.

Still open: **the ladder**. The client composes its own blob and sends it in
SET_PLAYER_INFO only once the ladder resolves, either way — "Ladder info acquired, set OWN
player info sent" / "Failed to get Ladder row for myself, setting N/A, set OWN player info
sent". Ours resolves neither way, so it never sends one. That is now a want, not a
blocker.

## Module requests: the shape, read rather than guessed

Two things the client asks for over a **module** — `persistantdata` (the profile) and
`ladderquery` (the rating) — go out as PROXY_HANDLER with `[number, requestId, [args]]`
and then it BLOCKS, scanning what has arrived for something that fits. Four shapes of
ladder answer had been ignored in total silence before this was read; the matcher is at
0x4286f0, and 0x427170 finishes the job:

```
the message type is 204 or 209                 cmp cx,0CCh
body field 0 is 38 or 39                       cmp ax,26h / 27h
body field 1 is a LIST whose field 0 is the request's number
```

Nothing else is looked at — not the request id, not the party nibbles. And inside, the
fields are fetched **by kind**, a getter refusing the wrong kind outright: 0x442f10 takes
a list (kind 3), 0x442510 and 0x442620 take a blob (kind 2), and 0x4435c0 / 0x443680 take
a string (kind 1) and run it through `atoi` — they are NUMBER getters, an int and a short,
not a way to fetch text. So a reply can match and still be dropped without a word, in the
getter.

```
success   ["38", ["<number>", [ … fields … ], "<count>"]]
refusal   ["39", ["<number>", [ "<reason>" ], "0"]]
```

**The list under the number is a THREE**, and that was the wall: both readers fetch its
index 2 as a number before looking at anything else — the ladder at 0x42c8d2, the profile
at 0x42b4c4 — whatever the status said. The probe named it exactly:

```
reading the status for request 1281 … said 1, and the status is 39
the ladder read said 0
```

The status was read; what came after it was one field short. **And a reply that is
consumed but unreadable is worse than no reply at all**: the message is off the queue, so
the client's state machine gets no event and waits out its FULL timeout — about thirty
seconds in `CStateWaitWithReturn<CStateOutOfRoom, CStateWaitPSGetDataReplyBase>`, during
which the lobby is not in the state where a game can be created. That is what "you broke
creating a game" was: not the room code, the profile answer eating the wait.

`moduleReplyBody` / `moduleFailureBody` in `src/net/gs-message.ts` are these two.

- **The profile (0x401 read, 0x402 write).** The innermost list, from 0x42aec0 and
  0x42b400: index **0** is the record as a **BLOB**, index **1** is its length as a
  decimal string, index **2** is another number nobody has identified. The length is read
  first and the client allocates from it, so with 0 there it never looks at the record at
  all — which is the honest answer for a player who has never saved one. We keep the bytes
  under (game, user, section) in `data/profiles.json` and hand them back untouched:
  `src/net/persistent-store.ts`. **What a profile means was never needed.**
- **The ladder was refused on purpose until 0x432c80 was read** (13.08.2026). Index 2 of
  its innermost list is a NUMBER, so the nested row we used to send could never have been
  read; the rest of that list is a table, and its layout is now in `ladderPayload` and in
  "The ladder's real row" above. The refusal remains the client's fallback path —
  "Failed to get Ladder row for myself, setting N/A, set OWN player info sent" — so a row
  it does not like costs nothing but the N/A.

Also read along the way: each module has its own state machine, and both are already past
their logins — "PS login succeeded" is in the game's log, and the ladder service says
"initializing Ladder Query Service...succeeded" (it is local, no exchange). So the
silence was never a login problem.

### Solved, and what each piece turned out to be

Four things had to be right at once, and each was wrong in its own way. In the order the
client reads them:

| what | and what it had to be |
|---|---|
| the connection | the **router's** wait module, not the one the request came in on |
| the envelope | `[status, [number, payload, requestId]]`, type 204 |
| index 2 | the **request id**, looked up among the pending requests (0x42b810) — not a count |
| an absent record | **39**, a refusal. "38 with nothing in it" is a lie and it is believed |

That last one is worth its own line, because it cost a launch and a false alarm about
broken game creation: answered "here it is" with zero bytes, the client read the answer,
made no profile out of it, showed "could not create a profile" — and, being consumed but
useless, the message left the state machine to sit out its whole timeout, during which the
lobby cannot create a game. Refused honestly, the client says "PS get data failed,reason=0"
and returns to `CStateOutOfRoom` **immediately**.

The proof, from the game's own log:

```
LadderQueryRcv_RequestReply: (39,0,1)
Failed to get Ladder row for myself, setting N/A → LobbySend_SetPlayerInfo(,,73)
ProcessSetPlayerInfoReply: set OWN player info succeeded
PSRcv_GetDataReply: ubType=39,iReason=0,iID=2,pData=0,iSize=0
ProcessPSRcv_GetDataReply: PS get data failed,reason=0
Entering state: class NUbi::CStateOutOfRoom
```

### Measured, at last: three of the four stages are RIGHT

A probe inside the game (`native/net/ubi-module-probe.c` in the editor repo, built with
`--log net/ubi-module-probe`) watched the points a reply has to pass. Its answer, for our
ladder refusal:

```
module probe: queued a message of type 204
module probe:   into the queue at 955393712      <- the MODULE queue
module probe: dispatching request …0501          <- keyed 1281, correct
module probe: scanned for request 1281
module probe:   found a message of type 204      <- MATCHED
```

So the envelope, the routing, the queue and the matcher are all right; the reply is found
and consumed. **What is left is the body**, read after the match by 0x427170 and then by
the request's own reader, each of which returns false without a word when a field is not
the kind it wants. The same run shows the friends reply matched too (`scanned for request
75, found a message of type 38`), so that one dies in the same place — its parser.

The queue addresses in that log are worth keeping, because they name the subsystem a
message was classified into: the friends queue and the lobby queue and the module queue
are 24 bytes apart (…640, …688, …712), and a reply in the wrong one is a reply nobody
will look for.

**A module's answer goes on the ROUTER's connection, not the one that asked.** This was
measured the same way and it corrects two earlier readings of mine. The run that settled
it sent the ladder's refusal on both candidate sockets and the probe saw exactly ONE
message queued; the profile answer, sent only on the proxy's wait module, was never seen
at all — not queued, not keyed, not scanned. The requests still arrive on the proxy's wait
module; the asymmetry is the protocol's. `RouterService.answerModule` is where that lives.

Why the earlier "the connection is not the variable" was wrong: the two-refusal experiment
looked negative because the client's log prints a reason only after its READER succeeds,
and the reader fails for a second, independent reason. Two bugs stacked, and only a probe
inside the client could take them apart.

Also measured: the game **closes 40030 within a second** of being handed to 40031, exactly
as it closes 40000 after 40001. So "answer where it asked" only ever had one live socket to
mean — and it was the wrong one.

### The older question, and why it was the wrong one

Every step of the client's path has now been read and it should accept the reply above:
the router (0x41b150) puts a 204 into the module queue at CClient2+0x1b8; the drainer
(0x41bf70) peeks its key — for a 204 carrying a status, that key IS the nested request
number (0x4288d0) — and hands it to 0x426d50, which dispatches on the number's high byte,
0x400 to the profile and 0x500 to the ladder; from there 0x42b590 reads it. Every gate on
that path is satisfied by what we send, and the game's log still shows nothing.

So the remaining unmeasured thing is **which connection the module reads**. Its requests
arrive on the proxy's wait module (40031), but its own login happened on the proxy itself
(40030), and both sockets stay open — and there is a separate pump per transport
(0x41b4d0, kinds 2, 8 and 16). This run answers **the ladder on the proxy** and **the
profile where it was asked**; whichever of the two appears in the game's log names the
rule, and then both follow it. `RouterService.desks` is what makes that possible, and it
is needed anyway for announcing an arrival to the players already in a channel.

## Reading the client's dispatch, instead of guessing at three replies

13.08.2026. Three answers were wrong or missing, and all three were settled in one sitting
by reading how the client routes a message rather than by launching the game at each guess.
The method is worth as much as the answers.

**A reply lands in a QUEUE, and each queue has its own drainer with its own switch.**
0x41b150 sorts a received message into one of them; the drainer takes the first message's
key (0x4288d0) and dispatches:

```
type 204 / 209        the key is the nested request number under the status
type 38 / 39          the key is body field 0, read as a ONE-BYTE BLOB (0x442620)
anything else         the key is the message type itself
```

Each drainer's switch is a byte table plus a jump table, and decoding those two arrays says
exactly which parser sees which key — `_tmp/gs-dispatch.ts` in the editor repo does it. That
is what showed the friends drainer (0x41b840) sending **75 to 0x429a20**, and it is what
showed the parser this document used to name — 0x425340, key **51** — to be a different
message we never send. A reading that was never wrong on its own terms, about the wrong
function.

The complementary listing is "which request does each parser scan for": every parser calls
the matcher at 0x4286f0 with one number, so walking back from each call site gives the whole
map (`_tmp/gs-requests.ts`). Request 75's parser is 0x4292d0, and it says in five
instructions what four launches could not have.

### The friends reply: one field, and it was the kind

```
success   type 38, [ <byte 75>, "<the friend's name>" ]
refusal   type 39, [ <byte 75>, [ <four bytes of reason> ] ]
```

0x4292d0 fetches body field 1 with 0x4426c0, which takes a **string and nothing else**; we
had been sending a list, so the message was matched, consumed and dropped in the getter
— the same silent death as everything else in this protocol. 0x428fd0 checks the rest: type
38 or 39, and field 0 says 75 again as a one-byte blob. A refusal's reason is read with
0x442620 asking for **exactly four bytes**, and that getter refuses a length that differs.

### The friends list is pushed, and 74 is what carries it

**LAUNCHED, and the wire half works** (13.08.2026, evening). The client took every push
and printed it back whole:

```
NUbi::CClient2::FriendsRcv_UpdateFriend: (Guest,1,Ranked,2,1560,)
NUbi::CClient2::FriendsRcv_AddFriend:    (38,279128104,Guest)
NUbi::CClient2::FriendsRcv_DelFriend:    (38,279128104,Guest)
```

Friends appear in the panel and adding and removing both work. Three things that run
showed, and only the first two were ours:

1. **A player could add himself.** The client offers "add to friends" on any name in the
   channel, his own included, and asks nobody whether that means anything. Refused here
   now, in the shape a friends refusal already had.
2. **Double-clicking a friend opened nothing** — it asks for that player's profile, the
   guest had none, and a refusal is the screen not opening (`PS get data failed,reason=0`
   and straight back to `CStateOutOfRoom`). The guest now carries a profile the way he
   carries a ladder row.
3. **A friend the server says is online is drawn as offline, without a rating — and it is
   the game, not us.** Measured, not reasoned (the probe in the editor repo,
   `native/net/ubi-friends-probe.c`): the flag arrives as 1 all the way into the row the
   panel draws — `a row goes into the panel for Guest / rated -1 / online 1 / and a
   friend? 1` — so the word on the screen does not come from it. It comes from that
   **-1**, which 0x910A00 writes into every friend's row with no source and no condition;
   the client keeps only the name and `field 1 == 1` out of the six fields, and the
   friends tab never looks at the channel's member records, where the real rating is
   (`a member row for Guest / rated 1560`, the same panel one tab over).

   **Nothing the server sends can change this.** The one way out is on our side of the
   exe — a detour on 0x910A00 taking the rating from the member record when there is one
   — and that is a change to the game, so it waits to be asked for.

The reading below is what the launch was built on, and it held.

14.08.2026, read and written before any of that. The client can say exactly three
things about friends — `FriendsSend_Login`, `_AddFriend`, `_DelFriend` (0xe0f5c1,
0xe1905a, 0xe19263) — and none of them is "send me my list". So the list is ours to
push, and there is a panel waiting for it: `FriendListView` (0x910367), the other half
of the players panel, with `UI/Lobby/Main/Players/FriendListHeader` and
`FriendListSelect` in the game's own UI data.

What it can *receive* is four messages, and the four are the whole family. The friends
queue's drainer (0x41b840) hands each key to a parser, and each parser calls one slot of
the listener vtable at **0xfe4c30** — whose first three slots and its +0x34 are exactly
the four functions that log `NUbi::CClient2::FriendsRcv_*`:

| key | parser | slot | what the client calls it |
|---|---|---|---|
| 78 | 0x4299b0 | +0 | `FriendsRcv_LoginResult` (0xdf41c0) |
| 75 | 0x429a20 | +4 | `FriendsRcv_AddFriend` (0xdf42e0) |
| 76 | 0x429a80 | +8 | `FriendsRcv_DelFriend` (0xdf4460) |
| **74** | **0x428f40** | **+0x34** | **`FriendsRcv_UpdateFriend` (0xdf45e0)** |

**74 is a push and its parser proves it.** 0x428d90 matches the message and then insists
`[eax+4] == 0x4A` — the message's own type byte — where 75 and 76 go through 0x428fd0 and
demand the 38/39 envelope with the key repeated inside. A reply is answered; a 74 is
simply sent. Its six fields, with the getter that reads each:

```
0  string    0x4426c0   the friend's name
1  4 bytes   0x442620
2  string    0x4426c0
3  4 bytes   0x442620
4  4 bytes   0x442620
5  string    0x443400   optional: missing, the client copies its own 132-byte default
```

**What they mean is not read anywhere**, and nothing in the exe says which number is a
status. So they are filled the way a friends row plausibly wants — online, the channel
in words, the channel as a number, the rating — with no two numbers alike, and the
client will settle it: 0xdf45e0 prints **all six** into the game's log before packing
them into a 0x3C-byte struct, so one launch says what arrived and the panel says which
of them it draws. `friendUpdate` in [src/net/friends.ts](../src/net/friends.ts) is the
one place to change them.

Removal is the add with the key changed: 0x429370 is 0x4292d0 to the instruction, so a
DELFRIEND is answered `38, [ <byte 76>, "<the name>" ]`. Whether the ask carries the name
in field 0 the way the add does has **not** been seen on the wire — a nameless one is
refused and the body goes into the log whole, which is what the first click will settle.

### The ladder's real row

`ladderPayload` in [src/net/ladder.ts](../src/net/ladder.ts) is the shape, and its comment
names every gate. In short, the payload under the request number is

```
[ "1",                                   <- 0x443740, atoi, must be 1, else reason 63
  [ "<rows>", "<0>",                     <- two numbers kept at result+8 and +0xC
    [ ["RATING","1"], … ],               <- columns: pairs of strings, ≤32 chars
    [ ["1500","0", … ], … ] ] ]          <- rows: strings, ≤128 chars
```

Two rules decide it. **A row must have exactly as many cells as there are columns** —
0x432b10 compares the counts and returns error 3 otherwise. And **every cell is a whole
decimal number**: a field is fetched by name and run through `strtol`, and 0x431f20 insists
the whole string was consumed, so "N/A" or a trailing space is a field that does not exist.

### A profile write, before ever seeing one

The request builder is 0x42b1e0, so its arguments are not a guess:
`[game, n, user, n, "PUBLIC", <record as a BLOB>, <that record's length>]`. Field 5 is a
blob and field 6 is its length — the "unidentified number" this document carried.

The reply is thinner than the read's: 0x42b2e0 takes body[1] as a list, its [1] as a list it
never looks inside, and its [2] as the request id. So a write is answered with an **empty**
payload; handing the record back passed by accident and said something nobody asked.

### What a player panel row is made of, and how it is refreshed

Measured after the first run that had a guest in it, because he was drawn with no name
and no rating and the player himself had no rating either.

A row is built in `CPlayersController::OnMemberJoined` (0x9108f0) out of exactly two
things: `[member+8]`, the name, and `[member+0x38]`, the rating. Both come from the
player-info blob when there is one (0xdfea70 reads tag 2 into +8 and tag 5 into +0x38),
and the name falls back to the member record's own field when there is not. **There is no
third source for the rating**: without a blob the column is empty, whatever the ladder
said a moment earlier.

The blob is the client's own document and it nests — the 73 bytes it sends of itself:

```
[4] 04 00 00 00
[1] { [2] "Senyaak"
      [3] { [2] 16 bytes: family 2, port 40010, the mirrored address }
      [4] { [2] port 8888, [3] 16 bytes: 192.168.178.27 }
      [5] dc 05 00 00 }          <- 1500, the RATING, from the row we had just sent him
```

`playerInfo` in `src/net/lobby.ts` writes that shape now. A document with tag 2 at the
top is what the guest had, and the client drew him nameless.

**And the refresh is `GROUP_INFO_GET`.** The client sends it on every return to
`CStateOutOfRoom` (`LobbySend_GetGroupInfo(2,1,384)`, body `[group, mask]` — the mask is
index **1** here, not 2 as in JOIN_LOBBY), and this server used to answer it with a bare
"yes". So the panel's only picture of the player was the one made before he had a rating
to report. Answering it in full is safe: the panel keeps its rows in a map keyed by the
NAME (0x90fc80 looks the name up at 0x911b90 and replaces what it finds), so the same
list arriving again refreshes rather than doubles.

### The profile is a closed loop, and the seed is the way out

What is known, all of it read rather than tried:

| what | where |
|---|---|
| the read request and its reply | 0x42b100 / 0x42aec0 + 0x42b400 |
| the write request — `[game, n, user, n, "PUBLIC", record as a BLOB, its length]` | 0x42b1e0 |
| the write's reply reader: a list at 1 it never opens, a number at 2 | 0x42b2e0 |
| the reply handler, and what it posts to the UI on failure (`{22, 4, reason}`) | 0xe12440 |
| what sends a write, and its own log line "PS set data sent, N bytes" | 0xe1bec0 |
| the screen behind it: `CMPProfileScreen`, its loader and saver actions | 0x93f260 / 0x9139d0 / 0x913a00 |
| the dialogs it puts up — captions in `UI/MPProfile/texts.(WindowRelatedTexts).xdb` | `AcquireProfile`, `AcquireProfileFailed`, `UpdateProfile`, `UpdateProfileFailed` |

And the loop: **a profile record is the client's own composition, so the only way to learn
its format is to catch a write — and the client writes nothing while its read fails.** We
refuse the read honestly, because nothing is stored; the screen says "AcquireProfileFailed"
and stops there. Reading further into the UI does not break this: no branch anywhere makes
a client compose a profile out of a refusal.

So a read with nothing behind it is answered with a MINIMAL RECORD instead — the skeleton every
document the game writes begins with (`04 08 04 00 00 00 01 00`: a four-byte kind under tag
4, an empty container under tag 1). It is a guess about the profile's own tags and it is
labelled one, in the code, in the log line and in this file. What it is for is to get past
the failed read to the screen that saves, because **every write is hex-dumped in the session
log** — one save and the format stops being a guess forever.

The verdict, in the game's own log:

```
PS get data succeeded            <- the seed was read at all
...the profile screen opens, or says what it did not like...
PS set data sent, N bytes        <- and then our log has the bytes
```

If instead the client reads the seed and dies quietly in a parser, that is the same silence
every wrong shape in this protocol produces, and the answer is to go back to refusing.

### A ladder query carries TWO ids, and the reply is judged by the other one

13.08.2026, and it cost a day of reading because the first query of a session hides it.

- **the module's id** — `body[1]`, counting 1, 3, 5, 7 across a session (the profile
  takes the even ones). The reply is MATCHED by it: it goes back at index 2 of the
  three, the client looks it up in its pending map (`lower_bound`, 0x42b810) and gets
  the right entry. This was right all along.
- **the ladder's own id** — the first field of the query itself, `body[2][1][0]`,
  counting 1, 2, 3, 4. The reply is JUDGED by it. After resolving the correct id from
  the map, the reader **overwrites it** (0x42c987) with `[result+8]` — the first number
  of the table we sent — and hands THAT to the game, which compares it with what it is
  waiting for and logs "not waiting reply with RequestId=N — ignoring message".

We were sending the row count there, which is 1, and the first query's ladder id is
also 1: it worked once per session and every later query was dropped, including every
"Profile" on a player, which is a ladder query pivoted on him.

The measurement that settled it printed both of the ladder's maps whole, on every
insert and every lookup — the queue at +0x64 and the pending sends at +0x80, walked
node by node with the map's address on each line. It showed the lookup working
perfectly (`LOOKUP for 3 … landed on key 3, whose value is 2`) three lines before the
game was told 1, which is what pointed at the overwrite. Three earlier readings of the
insert side had each been self-consistent and each wrong about where to look.

### The guest, and what he is not

A player the server seats itself: a name, a player-info blob, a ladder row with games in it,
and he sits in **Ranked** (`GUEST` and `GUEST_LOBBY` in `src/net/router-service.ts`) — one
channel, because a player is in one channel at a time and so is he. He exists
because half of what needed a second client only needs somebody ELSE — a row to read that is
not one's own, a name to right-click, a profile that is not yours. He is not a ghost:
`--ghosts` seats players with nothing behind them to see what the panel draws.

**He cannot answer.** Nothing about starting a game is closer for his being there.

## What to pick up next

Two of the three were confirmed by the run of 13.08.2026 and are in the table at the top
of this file. What that run left:

1. **The two ratings and the guest's name.** Both fixes are written and neither has been
   launched: the guest's blob is the client's own shape now, and `GROUP_INFO_GET` answers
   with the channel in full. The verdict is on screen rather than in the log — a guest with
   a name and 1560 beside it, and the player's own 1500 appearing instead of "…" once he
   returns to the channel screen.
2. **The profile, and the loop it sits in.** See below — it is the one thing left that
   nothing on our side can settle by reading.
3. **Why a friend is drawn as offline** (13.08.2026). The list itself works; what the
   panel says about a friend does not. The probe in the editor repo
   (`--log net/ubi-friends-probe`) prints the flag at three points and the next run
   answers it. Everything else about the six fields is still unread, and only field 1
   survives into the client at all.

And then the wall proper:

**The second player, and it is the whole of the gap.** Everything a lone host can do,
he does; nothing has asked for START_GAME because starting needs somebody to start
against. What the second client sends is the specification, so there is nothing to
design in advance — but there are three things to prepare and one open question.

To prepare:

- **The player-info blob.** Done on our side: `Presence` keeps it per player rather than
  per connection, so a real blob reaches everybody's member records; and the format is
  known, so one can be composed for a player who has not sent his own.
- **Arrivals must be announced to the people already there — DONE, 13.08.2026.** Our
  replies only ever went back to whoever asked, which is why the first player saw
  neither the second one arriving nor the game he opened. The message is **GROUP_INFO,
  the same one that draws that screen already**: it carries the member list AND the
  child groups, so one shape covers all four changes — somebody joined, somebody left, a
  game opened, a game closed. `MEMBER_JOIN` (50) and `NEW_GROUP` (54) are the narrower
  announcements and one of them, sent our way, drew no reaction at all, so they stay
  unused rather than guessed at again.

  What made it possible is not the message but the bookkeeping: `desks` holds one socket
  per DESK NAME, so with two players the second one's Lobby socket replaced the first's
  and nothing could reach him. There is a `sessions` set now, one entry per connection,
  each knowing whose it is and how to write on itself. **The same bug had a second
  head**: a module answer (a profile, a rating) goes out on the router's connection, and
  that was "whichever RouterLauncher is open" — with two players, the wrong screen.
- **The peers' addresses.** The lobby knows each player's own (`LOBBYSERVERLOGIN`
  reports his LAN address and netmask) and the NAT mirror knows how he looks from
  outside; the port his pings come from is 8888. That is the material for introducing
  them, and gameplay itself is peer to peer, so this server never carries it.

The open question was **does one install run twice**, and the answer is **no — and a
second copy of the folder will not do it either**, which is a thing to know before
copying six gigabytes. Read out of the exe, not tried:

- `WinMain` (0x4db860) opens with `CreateMutexA(NULL, TRUE, "NIVAL_H5")` and asks
  `GetLastError`. On 0xB7 (ERROR_ALREADY_EXISTS) it puts up *"You can't run game and
  editor or two instances of any of then at the same time"* and returns from WinMain.
  The name has no `Local\` or `Global\` prefix, so it is one name per logon session —
  a second copy of the folder hits the same mutex, and a second Windows user would not.
- The branch is `jne` at **0x4db8aa**, five bytes after the compare: `75 1D` where
  `EB 1D` would mean "carry on regardless". Our exe is our own build already, so this
  is one byte in the SECOND copy's `bin/H5_Game_H5E.exe` — the first copy keeps the
  guard and so keeps telling us when we have left an instance running.
- The other collision is the game port: `net_game_port` is registered at 0x4cf2b0 with
  a default of 8888 (the float at 0x4cf2b5), and it is where each client's own pings
  come from. Two instances on one machine want two ports, and it is an ordinary
  config variable, so the second copy sets it in its own config rather than in code.

So the second client costs a copy of the game folder, one byte in its exe and one
config line — and, on the evidence above, nothing at all in this server.

**DONE, 13.08.2026.** `C:\Projects\homm5-game-net2`, started by its own `run-net2.bat`.
The byte is not patched by hand: it is a flag of the extension now — `second-instance`
in `bin/homm5-editor-qol.txt`, which takes the branch off before WinMain reads it,
because a DllMain runs before the executable's entry point. Beside it, `run-in-background`
makes the game stop throttling itself to a frame every 40 ms when it is not in front,
which a second client is by definition half the time. The port is a config line as
expected: `own-profile` on in that copy, and `net_game_port = 8889` in its own
`Profiles/global_a2.cfg`. Both are documented in the editor repo's `docs/QOL.md`.

**What two clients showed at once (13.08.2026), and what each cost:**

- *the player list did not refresh* and *a game did not appear* — one fix, above: nobody
  was ever told anything. GROUP_INFO to everybody else in the channel, on four triggers.
- *the host was not told when somebody entered his game* — the same again one level down,
  a room's GROUP_INFO **with its members**, and only where somebody actually joined or
  left. A member list sent after a mere settings update is read as an arrival and starts
  the loop that once spammed "somebody joined" several times a second.
- *profiles worked for the guest only* — because the guest was the only one with a record
  and everybody else was refused. Refusing is honest and it is also a profile screen that
  does not open, so **every player with no record now gets the seed**; `--seed-profile` is
  gone as a flag, it is simply what happens. The first write from any client still
  replaces it, and every write is still hex-dumped.
- *"Игра не существует, возможно сервер прекратил игру. Код ошибки 0.5.0"* — what the
  client puts up when the room it is handed makes no sense to it. **5 is its own number
  for "no such game"** (`CanEnterGame`, 0xdeebe0: 1 version, 2 checksum, 5 no such game,
  9 wrong password), so the code reads `<0>.<reason>.<0>`. It came up when the
  field-mapping diagnostic went out on EVERY copy of a room and the host could no longer
  enter the game he had just made. The diagnostic now numbers fields only in the channel
  push — what other players are shown — and a host's own room stays honest.
- *the game appears but Join stays grey* — **SOLVED, and it was not a field of ours at
  all.** The host creates his room with one settings blob and replaces it within a second
  with a bigger one — **522 bytes at CREATE_ROOM, 590 once he is inside, 660 once somebody
  joins** — and we kept every new one and forwarded none of them. The other player's copy
  of the game was therefore built out of the half-finished first description, and the byte
  the button insists on lives in that description (its class is the game's own, copy ctor
  0x61C550, not the twenty lobby fields — which is why numbering those fields never made
  it appear). Forwarding the room to the channel whenever its settings CHANGE turned the
  button on, and joining then worked three times in a row.

  **Only when they change.** The first version of this forwarded every update, and the
  host sends three to five a second carrying the same bytes: the joiner's screen was
  rebuilt continuously ("new room" and "member joined … ignoring", several a second) and
  that is what "еле подключилось" was. The handler keeps the previous blob and pushes only
  on a difference.

  What was read along the way, and is worth keeping (0x8768B0 decides the button):

  ```
  a game is selected            else grey
  0xDE2660(game) == false       else grey
  game[+0x18] != 0              else grey
  ```

  0xDE2660 reads `[+0x8C]` as a version — `0x10000…0x10032` or `0x20000/0x20001` go on to
  `[+0x18]`, anything else falls back to `[+0x17C]`. The row is drawn by 0x8DD160 out of
  `[+0x34]` (padlock) and `[+0x90]` (STARTED), neither of which was ever set.
  `CGamesView2::AddGame` (0x8DCE50) is the door: it takes the description, checks the same
  `[+0x18]`, and copies it into a 0x1A0-byte `CGameData`.

  **The "ours reads 0x30001 = (field 4 << 16) | field 3" that stood here is wrong.**
  `CGameData+0x8C` comes from the description's `+0x80`, and 0xE06BA0 — the one function
  that turns an arrived room into a description — writes only `+0x00` (id), `+0x04` (lobby
  server), `+0x1C` (name) and `+0x6C` (max players). Everything else, the version and the
  byte the Join button reads included, is loaded **from the settings blob**. Which is the
  same conclusion the button itself gave: forwarding the blob fixed it, numbering the
  twenty fields never did.

**Two clients want two accounts.** The first login of a name creates it, so the second
client logs in as another name and nothing has to be prepared here.

**`eventId` is a caption, and a duel is not a channel.** Field 11 of a channel and of a
room, and it was worth finding out what the client does with it before designing anything
around it:

- **A room's eventId is thrown away.** 0xE06BA0, the one function that turns an arrived
  room into a game description, copies the id, the lobby-server id, the name, the player
  cap and the blob — `+0xAC`, where the parser put eventId, is never read. It does not
  reach `CGameData` at all, so nothing on the games screen can depend on it.
- **A channel's eventId survives, into `lobbyObj+0x1C`**, and has exactly one reader in
  the whole exe: 0x799276, a four-way jump that turns it into a localised string —
  0 `MODE_TRAINING`, 1 `MODE_RATING`, 2 and 3 `MODE_DUEL` — and stores THAT, not the
  number, in the channel row. Anything ≥ 4 leaves the cell empty without complaint. There
  is no filtering, no sorting and no other effect: 0x798BD0 lists every channel it is
  given.
- **It must still be a number and it must still be there.** The field readers (0x41FC80
  for a room, 0x41FE40 for a channel) return false at index 11 if it is missing or not
  numeric, and a record that fails there is dropped in silence — the whole channel, or
  the whole game.
- **A duel comes from a different screen, not from the channel.** `CCreateLobbyInterfaceCommand`
  opens `CLobbyScreen`; `CCreateDMLobbyCommand` (0x876550) opens `CMPDMLobbyScreen` and
  sets `duel_lobby_open`, and a game started there runs `CDuelGame` (0x938590) and the
  peer-to-peer `CCreateDuelCommand` instead of `CMPStart`. Neither path reads eventId.
  So the duel of 13.08.2026 was a duel because the player went in by that door, not
  because the channel said 2 — and **a duel can be hosted in any channel, "Ranked"
  included**.

Which answers "can there be a rated duel room": as far as the client is concerned there
is no such thing as a rated room at all (see the dead flag above), and duel-ness is not a
property of the room we serve. A channel with eventId 1 is honestly captioned
`MODE_RATING` and a duel played in it is a duel — the rating, if it is ever wanted, is
arithmetic of ours over `GAME_FINISH` and nothing the client will help with.

What is still not known is which field of the settings blob makes a game a duel: no
capture of a duel's `CREATE_ROOM` exists. Since 13.08.2026 the blob is written into the
log at GAME_READY, so the next duel and the next map answer that by themselves.

**A GAME WAS PLAYED, 13.08.2026.** Two clients, a room, and a duel from the lobby to the
end — 18:56:36 to 19:00:14 on our own server, no Ubi.com anywhere. The first attempt that
day died on an unanswered `START_GAME`; the four exchanges below were written the same
evening and the next launch went through in 0.44 seconds:

```
18:56:35.972  START_GAME — "Senyaak2" (100), yes
18:56:36.190  GAME_READY — "Senyaak2" (100) starts, announced to him and 1 other(s)
18:56:36.314  GAME_CONNECTED for 100 — noted      the guest
18:56:36.409  GAME_CONNECTED for 100 — noted      the host
19:00:14.328  GAME_FINISH — the duel is over, from both
```

The peers found each other unaided: nothing in this server ever told either client where
the other one was, beyond the addresses that were already in the room and in each player's
own blob.

**It was a DUEL, in the 1v1 channel, and that is the whole of what has been played.** An
ordinary map — Casual or Ranked, two players on a multiplayer map with towns and a turn
order — has never been started once. A duel is a single fight between ready-made heroes:
it loads differently, it is over in minutes, and it may well ask less of the peers than a
map does. So "a game works" means this game; the next thing to find out is whether the
other kind does, and nothing here should be read as saying it already does.

What is NOT done is anything about the result — see `GAME_FINISH` below and
LADDER.md: the ladder still reads 1500 and 0 games for both of them. The probes are still
in the extension (`--log net/ubi-room-probe`, `net/ubi-friends-probe`) and can go once
nothing needs them.

**Starting is a chain of four exchanges, not one message.** 13.08.2026, measured: the
host pressed Start, sent `START_GAME` (subtype 15) — seventeen bytes, the only message
either client sent about starting — and the server dropped it into "not implemented"
and said nothing. Both screens read "please wait", and 31 seconds later the host closed
every socket: `CStateWaitStartGameReply` and its 30-second stall, to the second.

The chain, from the client's own handlers rather than from the order its RTTI names are
listed in — `ProcessStartGameReply` 0xE12620, `ProcessGameReadyReply` 0xE12A70,
`CStateWaitGameStarted::ProcessGameStarted` 0xE12C40, `CStateWaitingForPlayers::ProcessGameStarted`
0xE1CCD0:

```
host  -> START_GAME 15    <- "yes"    then he sends GAME_READY himself
host  -> GAME_READY 33    <- "yes"    then he WAITS
both                      <- GAME_STARTED 56, pushed        both answer GAME_CONNECTED 34,
                                                            and the host sends START_MATCH
host  -> START_MATCH 17   <- "yes"    "start match succeeded"
      ... the game is played, peer to peer ...
host  -> SUBMIT_MATCH 30  <- "yes"    then FINAL_MATCH_RESULTS 71 (LADDER.md)
```

**`GameStarted` comes after `GameReadyReply`, not between the first two** — the earlier
version of this list had it in the RTTI's order, which is not the order anything runs in.
It goes to EVERYBODY in the room, the host included: he waits for it in
`CStateWaitGameStarted`, and the guest — who sends nothing at all during a start — leaves
his "please wait" on this message and on nothing else. `0xE1CCD0` does not read the
message: its arrival IS the content.

Senders, `push <subtype>` right before `call 0x42D970`: 0x421C00 → 15, 0x421990 → 33,
0x421B50 → 34, 0x421480 → 17, 0x421AA0 → 35, 0x421550 → 45, 0x421600 → 44, 0x4216B0 → 70,
0x420A20 → 30. (0x421430 stood here for 17 and is wrong: it is the tail of CREATE_ROOM's
sender and nothing calls it.)

**The three "yes"es are the ordinary envelope.** `START_GAME`, `CREATE_ROOM` and
`JOIN_ROOM` are all parsed by the same 0x420B60, so a reply is `38` / the subtype / a list
under it — nothing new to invent. What that parser drops in silence, which is
indistinguishable from never sending it:

| must be | or else |
|---|---|
| message type 209 | `cmp byte [msg+4], 0D1h` fails |
| `body[0]` a **string** "38"/"39" | the short getter 0x443680 takes kind 1 only |
| `body[1][0]` the subtype, as a string | the queue matcher 0x4286F0 never finds it |
| `body[1][1]` a **list** (0x442F10) | false, and the message is eaten |
| `body[1][1][0]` a string that reads as a number | 0x4435C0 says false — and the handler then ignores the value |

A refusal is `39` with the reason first and a **second** number after it; nothing here
refuses, so it is not written.

**`GAME_STARTED` (56) has five fields and its parser (0x423910) checks their KINDS:**
0 a number — the subtype itself, under the 38 envelope — 1 a blob, 2 a number read as a
**short**, 3 and 4 strings. One kind wrong and the whole push is dropped without a word.
We send the host's own description of the game as the blob, the game port (8888) as the
short, and his address twice. **What the last three mean is not established**: the shapes
fit "two addresses and a port", and neither handler in the chain reads any of them, so
nothing depends on it being right — but nothing proves it either.

**A rated game sends `START_MATCH` (17), and then the whole second half happens.**
Measured 13.08.2026 on an ordinary map in the Ranked channel:

```
START_MATCH 17        -> "yes", and MATCH_STARTED 62 pushed to the room
PlayerMatchStarted 44 <- from BOTH players, 200ms later; nothing waits on it
   ... eight minutes of game ...
SUBMIT_MATCH 30       <- from BOTH, the whole results table
                      -> SubmitMatchResultReply, then FINAL_MATCH_RESULTS 71 (bare!)
MATCH_FINISH 45       <- once every player has stopped
```

The shapes are in [LADDER.md](LADDER.md), including why 71 must not be wrapped.

**THE CHANNEL DECIDES, measured three ways on 13.08.2026:**

| channel | eventId | what was played | `START_MATCH` | how it ended |
|---|---|---|---|---|
| 1v1 | 2 | a duel | no | `GAME_FINISH` 35, no table |
| Ranked | 1 | an ordinary map | **yes** | the whole chain, results submitted |
| Casual | 0 | the same ordinary map | no | `GAME_FINISH` 35, no table |

The last two differ in nothing but the channel they were hosted in, so **a game is rated
because it was made in the rated channel** — the client's own decision, not a rule of ours.
Which also means the gate on `[ctx+0xE8]` (0xE12DC3) is fed from the channel somewhere: the
byte is not written anywhere in NUbi except after a StartMatchReply, and the code between
`GAME_CONNECTED` and the gate reads nothing about the room, so whatever sets it lives
outside that range and has not been found. It does not matter for the server — **answer the
rated chain unconditionally, and decide what to COUNT by the channel**, which is what
`Matches` does.

An earlier version of this section declared the whole rated branch dead code and removed
the `MATCH_STARTED` push as an unprovable guess, on the evidence of the duel. The next game
disproved it.

**`GAME_FINISH` (35) is how a game ends, and it is not answered.** `ProcessGameFinish`
(0xE1CFE0) branches on the same dead flag, so every game takes the unrated door:
`ProcessGameFinishUnrated` (0xE1DEB0) sends 35 with one field, the room id, from BOTH
players. There is no `LobbyRcv_GameFinish`, no `CStateWait` for it, and the sender moves
to `CStateWaitingForPlayers` before any answer could arrive — in the duel each client's
`GROUP_LEAVE` came in the same millisecond as its 35. It is the only word this server gets
that a game was played, which makes it the hook for anything the lobby ever wants to know
about played games. **The client will never report a result** (see LADDER.md): a rating
here is ours to compute or not to have.

The room these four are about is found by **membership**, not by a field: their bodies
have only ever been seen encrypted, so nothing about their layout is assumed. Since this
run every unanswered subtype prints its fields (`said`), so the next log says what they
carry instead of only that they arrived.

**The ladder is answered with a row whose layout is read, not guessed.** `PROXY_HANDLER`
subtype 1281 (0x501) gets a table from `src/net/ladder.ts` — 46 columns, one row, a new
player at 1500, stored in `data/ladder.json`. What is still guessed inside it is only the
pair of numbers at the head of the table and the second string of a column descriptor;
everything else is what 0x432c80 reads. The verdict is one line in the game's log —
`LadderQuery_StartResultEntryEnumeration(…) succeeded` against `ladder query request
failed,reason=…` — so read that before changing anything about it.
[LADDER.md](LADDER.md) has the rest, including the four handler names behind the proxy.

**Chat has no history and cannot get one from the protocol.** It is real IRC: a joiner
gets an echo of his JOIN and a member list, nothing else. Replaying the last N lines
to him is possible — the client draws whatever arrives, and it packs colour and font
into the message text itself — but it is our invention, and replayed lines will look
like they were just said, because the wire carries no timestamps.

## Accounts, and one database under everything

13.08.2026. Three JSON files rewritten whole were fine while nothing depended on them
and one player existed. A password is not that: it must not be lost to a half-written
file, and two clients will write at once. So everything a player leaves behind — his
account, his profile, his rating, his friendships — is in one SQLite database,
`data/lobby.db`, opened with **`node:sqlite`**, which is part of Node itself and needs
no build step and no `node_modules` (this project takes no native dependencies).

The schema is in [src/net/database.ts](../src/net/database.ts) and is applied on open,
so there is no migration to run. The three old files are **imported once**, into empty
tables, and then left alone rather than deleted — a rating that took a session to earn
should not vanish because the storage changed underneath it.

**The first login of a name creates the account**, with the password that came with it;
every login after that has to match. That is the whole of registration, and it needs no
client change: the client has no registration screen, but it does know how to be
refused ("router login failed,reason="). A password is stored as `scrypt` over sixteen
random bytes of salt, compared with `timingSafeEqual`, and it is never written to the
log — the login body goes into the log whole, but every string after the name goes in
as its LENGTH, which is enough to identify the field and useless to anyone reading the
file.

### A refusal has one shape, and a string in it is the same as silence

The first wrong password did nothing at all: the screen sat there, and the game's own
log showed `CStateWaitLoginRouterResult` entered and left again with
`ProcessLoginRouterResult` never running. The refusal was thrown away one step earlier
than the handler — in the parser — and the parser is exact about what it takes:

| where | what it insists on |
|---|---|
| `0x41b620` | the router queue's drainer; key 102 (`LOGIN`) goes to `0x42ac00` |
| `0x428fd0` | type must be **38 or 39**, and field 0 a **one-byte** blob repeating 102 |
| `0x429053` | for a **39 only**: field 1 must be a **list** whose field 0 is a **four-byte** blob — the reason |
| `0x442620` | reads a blob of exactly the asked-for length; anything else is `false`, and `false` means the whole reply is dropped without a word |

So a refusal is `39`, `[<1 byte: 102>, [<4 bytes: reason>]]`. We had sent the reason as
the string `"1"`, which is why nothing happened. This is the same shape the friends
refusal already used — the two were found on different days and only the second one
made it a rule.

Past the parser, `ProcessLoginRouterResult` (0xe0e500) compares the type byte at `+0x0C`
with `0x26` and, when it is not, logs `router login failed,reason=<the dword at +0x10>`
and posts `{0x16, 1, reason}` to the state machine's listener.

**The reason numbers are the client's own.** `NUbi::NLAN::SContext::CanEnterGame`
(0xdeebe0) is the client playing server for a LAN game, so it has to name refusals the
way the server does: `1` version mismatch, `2` checksum mismatch, `5` no such game,
`9` wrong password. We send 9.

Two things to know before the next launch:

- **which field the password is has not been seen yet.** It is taken from field 1, the
  string after the name, and the log now prints the shape of the whole body — so the
  next login says whether that is right. If the client sends no password at all,
  everybody's account is created with an empty one and a name is claimed by whoever
  logs in first; the log will show that too.
- **only the ROUTER checks credentials.** The same LOGIN arrives on the proxy with the
  same name and no password, and treating that as a second authentication would lock a
  player out of his own session.

Accounts were, until then, "any name, any password" — and the reasoning that got here is
worth keeping: the wire has `NEWUSERREQUEST` and the client knows how to say "name
taken" and "wrong password", so creating an account on first login needs no client
change, which Сеня chose over a website or a new screen. Removing the CD-key prompt is
still open: the key sits in the client's `ubi_cdkey` setting, used by the screens at
0x87B790, 0x87C840, 0x87CF50, 0x87D2B0.

## Playing over the internet

**The gameplay is peer to peer and this server never carries it.** So "playing over the
internet" is not a lobby feature at all — it is a question about two NATs, and the plan
Сеня settled on is a **relay**: the game's own packets tunnelled to our server rather than
sent peer to peer, because the traffic turns out to be too small for the cost to matter
and a relay is the one path that works behind CGNAT. Hole punching is an optimisation to
put on top later, not the thing to build first.

Everything below was measured on 14.08.2026, on one machine, with Wireshark's `tshark` on
the Npcap loopback adapter (`\Device\NPF_Loopback`, capture works unelevated). Note that
traffic to the machine's own LAN address goes through the loopback path too, which is how
a "loopback" capture caught peers dialling `192.168.178.27`.

### What the peers actually do — measured

A duel, 186 seconds, captured whole:

- **UDP, straight to each other**, at the machine's LAN address and at each other's
  `net_game_port`: `192.168.178.27:8888 <-> 192.168.178.27:8889`.
- **One socket per client** — the same one that pings the NAT desk. No second connection
  of any kind was opened.
- A **nine-byte handshake** each way carrying a four-byte token (`07 01 00 00 00` + token
  from the first copy, `07 00 00 00 00` + token from the second), then one **273-byte**
  description, then a steady 18-to-28-byte packet about **every 0.9 s** with two 16-bit
  counters that behave like a sequence and an acknowledgement. It is a reliable ordered
  layer of the game's own over UDP — which means a relay can pass datagrams through
  unchanged and understand none of it.
- **16 kB of payload in 186 s**: median 56 bytes a second, peak 950, largest packet 273.

### Where the peer address comes from — measured, and not where it was expected

Three launches, one question each.

1. **Not the NAT mirror.** The NAT desk answered both clients with `127.0.0.1` and neither
   ever dialled it.
2. **Not any field the server fills in.** With `--probe-peer-address` every player was
   announced to the others at an address of ours in the member record (`szIPAddress` /
   `szAltIPAddress`, from `RouterSession.addressOf`) — the log confirms both substitutions
   went out — and the clients found each other at the real LAN address and played a full
   duel regardless. A clean negative: the member record is not read for this.
3. **The host's own description of the game is.** Inside `room.info` — the blob we forward
   and only stamp room ids into — each player has a record:

   ```
   02 10 "Senyaak2"                    the name
   03 24  02 20 <16 bytes>             sockaddr: family 2, port 40010, the NAT-mirrored
                                       address written back to front
   04 2c  02 04 <port>  03 20 <16>     the GAME port, then the LAN address
   05 08 <4 bytes>                     the rating
   ```

   `probeEndpoints` (`src/net/lobby.ts`) searches for `04 2c 02 04 pp pp 03 20` and writes
   four bytes of address in place — the document keeps its length and every other byte the
   host wrote. Both clients then dialled us, in both directions, and **not one packet went
   to the real address**.

**They meet at `JOIN_ROOM`, not at the start of the game.** The dialling began within a
second of the guest entering the room; that run never reached `START_GAME` at all. A relay
has to stand up when the room fills.

**Patch on the way out, never in what we store.** `infoOut` applies it in `roomEntry` and
`gameStartedEntry` only. The host resends his settings three to five times a second and
the join button depends on us telling the difference between a real change and a repeat —
rewriting the stored copy would break that, as it did once before.

### A relay, proven in the small

`tools/peer-probe.ts` stands in for a player: the socket at `pool[i]:PORTS[i]` **is** that
player as far as everyone else is concerned — it receives what is sent to him, and it is
what his own packets appear to come from. A datagram arriving on P's socket from Q's port
is Q talking to P, and goes out again through Q's socket. Two pretend clients verify the
directions before the game is ever started.

A full duel played through it: **1114 packets, 38 kB both ways over 455 seconds, peak 1170
bytes in one second, nothing direct between the clients.** For eight players and a real
server that is still small enough not to think about.

### A generated map is a recipe, not a file

A game on an RMG map was played twice and the map appeared in both installs each time —
187411 bytes against 187366, and 202864 against 202780, differing hashes, seven to
nineteen seconds apart. Nothing of that size crossed anything: with a capture running the
whole session the largest conversation on the machine was 10 kB, and the relay's busiest
five seconds was 3 kB. **Each client builds the map itself, and the gap is how long that
takes.**

The recipe travels in the same blob whose player records we already patch. In the
871-byte description of that game:

```
/Maps/RMG/154B0BEB-E9FD-4033-8086-46709A27A9E9/map.xdb#xpointer(/AdvMapDesc)
04 08 5a e5 7e 6a                     the seed, 1786701146, at offset 570
"154B0BEB-E9FD-4033-8086-46709A27A9E9"
/RMG/Templates/S1P2Z2M1.xdb#xpointer(/RMGTemplate)
```

and the map's own properties agree: `sRMGProps.RMGmap true`, `RMGstartseed 1786701146`,
`RMGguid 154B0BEB-…`, with the template, size, water, monster level and each player's race
under `InitialParams`. A generated map therefore costs a relay nothing at all — which
removes the case the throttling worry was mostly about.

### The database checksum, which is what refuses a custom map

Hosting a map the other player does not have ends with "Контрольная сумма игровой базы
данных клиента не соответствует контрольной сумме игровой базы данных сервера… Код ошибки
0.2.0" — reason 2. Read off the disassembly of `bin/H5_Game_H5E.exe`:

**It is the joining client refusing itself.** `NUbi::SContext::CanEnterGame` at **0xdf02c0**
(the lobby twin of the LAN 0xdeebe0) is reached from
`CStateOutOfRoom::ProcessGameEnter` **0xe1b380**, call site 0xe1b3ed. It compares the
checksum the client computed for itself against `SGameInfo+0xC4` in its own copy of the
host's room record — reason 5 at 0xdf03ba, version 1 at 0xdf0481, password 9 at 0xdf0503,
**checksum compared at 0xdf051a and reason 2 written at 0xdf0597**. No round trip: the
struct it works from carries a live `IStatusListener*`, which cannot have crossed a socket.
Only on the LAN path does the value go on the wire and the HOST check it (0xdeee9d).

**What it is computed over** — entry 0x7dba20:

```
checksum = TablesChecksum() XOR selectedMap->SAdvMapDesc::GetChecksum()
```

`TablesChecksum` (0x7dbd80) is zlib `adler32` seeded with `SRPGStats::GetChecksum()`
(`/GameMechanics/RPGStats.xdb`), folded with the literal `"3.1"`, then the checksums of
exactly **14 reference tables** under `/GameMechanics/RefTables/` — Creatures, Skills,
UndividedSpells, Artifacts, MicroArtifactEffects, CombatAbilities, WarMachines,
TownTypesInfo, ArenaBuildingsStats, CombatArenaTypes, CampaignBonus, CombatLog and the two
GhostMode tables. A resource's own `GetChecksum` (vtable +0x10) is an adler32 over its
parsed field values **recursing through every `NDb::Ref`**, so everything those tables
reach is in scope.

Nothing enumerates a directory, a mount list or an archive's contents. So:

- **Extra maps do not count.** Two players with different collections can play any map
  they both have — only the *selected* map's descriptor is XORed in, and it has to be the
  same build of the same file on both sides.
- **A mod counts only if it overrides one of those tables or something they reference.**
  Retextures, music, UI, new maps: free. Our own `homm5-editor.h5u` is the opposite case —
  it edits exactly this kind of data, so the checksum is in effect a "same version of our
  mod" check, and that is a feature rather than a problem.
- Untraced edge: whether a `.h5m` joins the global VFS at startup. If one contained its own
  copy of a reference-table path it would poison the sum. Not observed, not ruled out.

There is a gate byte at 0x108F91C (initialised to 1) and a per-`SGameInfo` bool at +0x104
that leave the field zero, and a `no_checksum` config key (string 0xfa86d0) — what connects
them was not traced.

**Confirmed against the game, 14.08.2026, not only read.** One hand-made map (`test1`) was
put on both installs and another (`test12`) on the host only, and at the same time an
unrelated hand-made map (`PandoraProbe.h5m`) was deleted from the joiner alone:

- hosting `test1` — joins, **although the joiner is missing PandoraProbe**. An unrelated
  map absent on one side does not refuse anything, which is the claim that mattered and
  the one a reading of the disassembly alone would not have settled.
- hosting `test12` — refused with 0.2.0, and **the channel list shows that room with an
  empty Map column** while `test1`'s row shows its name. The name is resolved locally from
  the path in the settings blob, so a player can be told he lacks the map before he
  clicks — the game already knows.

And the path is in the blob we hold, in plain text:
`/Maps/Multiplayer/test1/map.xdb#xpointer(/AdvMapDesc)` (676 bytes for that room). So this
server can see which map every room needs, which is everything a launcher needs to fetch
one before the player enters.

**A trap for this server.** The host computes the value into `SGameInfo+0xC4` while
composing his room description, so it rides in the settings blob we forward. That blob is
the one he replaces moments after creating the room (522 → 590 → 660 bytes), and forwarding
a stale copy once already broke the join button. A joiner given an early blob would see
checksum 0 against his own non-zero value and refuse locally with 0.2.0 — **on two
byte-identical installs**. If that error ever appears where the content matches, look here
before looking at mods.

### Still open

1. **Getting a hand-made map to the other player.** Not a transport question after all:
   the game never sends one, it refuses the join instead (see the checksum section). So
   distribution is ours to do — the lobby knows which map a room is for, and the launcher
   could fetch it before the player enters. Nothing of this is written. Сеня wants it
   eventually done **inside the game** rather than by a launcher (14.08.2026).
2. **Duel presets, which the game saves and then cannot show.** Saving one writes a
   complete `<game>\DuelPresets\<name>.h5p` — a zip holding `Maps/DuelPresets/<name>/`
   with `preset.xdb` (an `AdvMapHero`: hero, experience, army slots, artifacts),
   `name.txt` and three `HeroIcon_*` textures. Exactly the four pieces a list entry needs.
   The list is built at **0x5c33d0** from two sources merged: the shipped table
   `SUIGameRoot+0x19C` → `UI/MPDMLobby/presets.(DuelPresets).xdb` (24 `<Item>`s), **and a
   VFS scan for `Maps/DuelPresets/*/preset.xdb#xpointer(/AdvMapHero)`** — the same helper
   that finds `Maps/SingleMissions/*/map-tag.xdb` and the RMG templates, so the archive is
   exactly the right shape and the enumeration side should work.

   It is the caller that blocks it. `GetDuelPresets` (0x5c2af0) consults the merged list
   only when its flag is set, and the one caller (0x924be0) sets it **only if a minimum or
   maximum price is non-zero** — otherwise it returns the built-in table and the scan is
   never run. The prices come from `Maps/DuelPresets/dpcoeff.xdb` and the `DuelPresetsPrices`
   table, and **neither exists in this installation**, in any pak or loose. No prices → the
   selector offers no range → both stay 0 → custom presets are unreachable by construction.
   Inference from the disassembly plus the missing files, not confirmed by instrumenting;
   the discriminating test is a log at 0x5c33d0 — never entered means it is this, entered
   and empty means the mount, entered and full means the price filter (0x5c2e4c) or the
   validator (0x5c2ff7, which would leave `" Error in preset %ws: %s"` in the log).

   Two more facts worth keeping. **The game never writes a preset** — the editor does, to
   `DuelPresets\`, and retail scans `DuelPresets/*.h5p` while our build has that pattern
   overwritten with `H5E/*.h5p` (0xf4f7f4), so on our exe the editor writes where the game
   no longer looks. And a preset is validated before it is listed: attributes ≤ 19,
   skills+perks ≤ 18, plus spell and prerequisite checks (0xa64620).

   Сеня wants a preset editor in the game and presets carried to the other player for a
   duel — a later feature, recorded here because the pieces are now known.
3. **An adventure map, and more than two players.** Everything above is a duel between two
   clients. A third install is ready at `C:\Projects\homm5-game-net3` (port 8890,
   `run-net3.bat`) and will say whether the peers form a mesh or a star, and whether
   `NetDriver` keys players by address — if it does, each peer needs a loopback address of
   its own, which the pool already provides.
4. **Whether the game's transport survives real address translation.** It is UDP with its
   own sequencing; nothing here says how it behaves when the port it is answered from is
   not the port it dialled.
5. **What the game does when the dial fails.** Observed only as silent one-a-second
   retries for as long as the probe refused to answer; the timeout and the message the
   player sees were never reached.
6. **The port, when the relay is real.** The address is rewritten and the port is left
   alone, which works because each copy here plays on a port of its own. Two players
   behind one relay both on 8888 need either a distinct address each or the port rewritten
   too — and the port is two bytes in the same record, under tag 2.
7. **A finished game stays on the other players' screens.** Not a transport question, but
   it will be constant online, where connections drop rather than say goodbye. The server
   does its part: on the host's socket closing it removed the room and told the channel
   (`Senyaak2 left — dropped "Сервер — Senyaak", 2 player(s) told`, 14.08.2026). The
   client adds a game row and never takes one away — leaving the channel and coming back
   clears it. So there is a message the client reads as "this game is gone" that we do not
   send, and it has not been looked for.

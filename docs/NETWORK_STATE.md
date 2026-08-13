# Our own Ubi.com: where this stands, and what is known

A companion to `docs/NETWORK.md`, which explains how the game finds its servers and
which lives in the editor repo (`homm5-editor`, branch `net/multiplayer`) together with
everything else that touches the game. This one is the state of play: what runs, what the client accepted, what
it refused, and where the next wall is. Written 12.08.2026 so that none of it has
to be recovered from memory.

## How to run it

```bash
node tools/net-server.ts            # all our services, one process, logs to logs/
node tools/net-server.ts --ghosts   # plus synthetic players in every channel
node tools/net-server.ts --seed-profile   # hand a first-time player a minimal profile
```

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
- **The login body is `[name, password, game, 1]`.** Field 1 is the password — three
  characters in the capture, and Сеня's password is "123", which is what settled it
  rather than another reading. Field 2 is the game id (`HEROES_…`, 23 characters) and
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

### The profile is a closed loop, and `--seed-profile` is the way out

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

So `--seed-profile` answers a first read with a MINIMAL RECORD instead — the skeleton every
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
- *the game appears but Join stays grey* — OPEN. Reading gives two candidates and no way
  to choose: the row is drawn from `[record+0x34]` (a padlock) and `[record+0x90]`
  (STARTED), either of which would explain it; or the button is simply dead because
  nothing is selected, which is what 0x799140 decides by asking the list. The editor repo
  has a probe printing both — `--log net/ubi-room-probe`.

**Two clients want two accounts.** The first login of a name creates it, so the second
client logs in as another name and nothing has to be prepared here.

**Starting is a chain of five, not one message.** From the client's own RTTI:

```
CStateWaitingForPlayers      -- SFLB_AttemptGameStart, once the room is full enough
  -> LobbySend_GameStart     CStateWaitStartGameReply    <- LobbyRcv_StartGameReply
                             CStateWaitGameStarted       <- LobbyRcv_GameStarted
  -> LobbySend_GameReady     CStateWaitGameReadyReply    <- LobbyRcv_GameReadyReply
  -> LobbySend_StartMatch    CStateWaitStartMatchReply   <- LobbyRcv_StartMatchReply
      ... the game is played, peer to peer ...
  -> LobbySend_SubmitMatchResult  CStateWaitSubmitMatchResultReply
                             CStateWaitFinalMatchResults <- LobbyRcv_FinalMatchResults
```

Every `CStateWait*` is its own 30-second stall if unanswered, and `GameStarted` is
a push to the other players rather than a reply to the sender. The first sender is
`NUbi::CStateWaitingForPlayers::ProcessGameStart` (0xE1C9C0), which hands off to the
GS library at 0x4196F0 — that is where the subtype numbers live if the wire does not
show them.

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

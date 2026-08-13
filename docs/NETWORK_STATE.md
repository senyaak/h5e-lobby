# Our own Ubi.com: where this stands, and what is known

A companion to [NETWORK.md](NETWORK.md), which explains how the game finds its
servers. This one is the state of play: what runs, what the client accepted, what
it refused, and where the next wall is. Written 12.08.2026 so that none of it has
to be recovered from memory.

## How to run it

```bash
node tools/net-server.ts            # all our services, one process, logs to _tmp/net/
node tools/net-server.ts --ghosts   # plus synthetic players in every channel
```

`npm start` and `npm test` are the same two things. `--ghosts` is a diagnostic: it seats
players who do not exist, and what the client draws of them is evidence (see the player
list section). **Turn it off before a two-client test** — otherwise the channel holds
strangers who cannot answer.

Then start the game from the copy: `C:\Projects\homm5-game-net\run-net.bat`. That
bat sets `http_proxy=http://127.0.0.1:8080`, which is the whole redirect — the
game's libcurl asks us for its server list instead of `gsconnect.ubisoft.com`.
Nothing in the exe is patched for this.

Two logs matter, and they answer different questions:

| log | says |
|---|---|
| `_tmp/net/session-*.log` | every byte in and out of our services, decoded |
| `<game copy>/bin/homm5-editor-*.log` | **the game's own narration**, mirrored by our DLL |

The second one is the important one and it exists because of
[native/net/ubi-log.c](../native/net/ubi-log.c): one detour on the engine's log
append (0xDFB270), lines stamped with a tick count. Build it with
`node tools/build-native.ts --log net/ubi-log` and install with
`node tools/install-native.ts --game C:\Projects\homm5-game-net`. Without it we are
blind — five walls in a row were found by reading it, and the two before it cost a
launch each to guess at.

`node tools/net-decode.ts --file <dump>` turns a hex dump from either log back
into a message; `--srp` for a datagram, `--irc` for chat.
`node tools/net-probe.ts <exe> …` is the disassembly side: strings, references,
imports, callers, `--func`, `--dword`, `--bytes`.

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
ladder             -> answered, MATCHED, and dropped inside the body reader
profile            -> the same; the store behind it works, the reply's body does not
friends (add)      -> the same again: type 75 answered, matched, dropped in its parser
player list        -> WORKS (12.08.2026): the panel draws him
create game        -> CREATE_ROOM answered, room 100 in the channel
join own room      -> "LobbyRcv_RoomInfo", then CStateInRoom / CStateWaitingForPlayers
settings changes   -> GROUP_CONFIG_UPDATE_RES answered, the room echoed back
leaving a game     -> destroyed here, announced with GROUP_REMOVE, gone from his list
joining a dead one -> refused with GSFAIL and a reason, instead of silence
```

So a player logs in, enters a channel with his name in its player list, hosts a game and
**sits in it waiting for players**; games appear and disappear correctly. Three things —
the ladder, the profile and adding a friend — are answered, matched, and then dropped
inside the client's own body readers; that is now ONE question with three faces, and a
probe says exactly where each dies. The second client is the thing nothing has exercised.

## Facts worth not re-learning

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
| the friends reply's own parser | 0x425340 |
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
- **The ladder is refused on purpose.** Index 2 of its innermost list is read as a NUMBER,
  so the nested row we kept sending could never have been read; what the rest of that list
  holds is parsed at 0x432c80 and still unread. A refusal is fully determined, and the
  client has a path for it: "Failed to get Ladder row for myself, setting N/A, set OWN
  player info sent" — which is also how it finally sends its own player-info blob. The
  rating is kept on our side meanwhile. Reading 0x432c80 turns the refusal into a real row.

Also read along the way: each module has its own state machine, and both are already past
their logins — "PS login succeeded" is in the game's log, and the ladder service says
"initializing Ladder Query Service...succeeded" (it is local, no exchange). So the
silence was never a login problem.

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

Also measured, and it settles a guess that cost two runs: the game **closes 40030 within
a second** of being handed to 40031, exactly as it closes 40000 after 40001. There is
only ever one live socket per desk, and we were always answering on it.

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

## Where the next wall is

**The second player, and it is the whole of the gap.** Everything a lone host can do,
he does; nothing has asked for START_GAME because starting needs somebody to start
against. What the second client sends is the specification, so there is nothing to
design in advance — but there are three things to prepare and one open question.

To prepare:

- **The player-info blob.** Done on our side: `Presence` keeps it per player rather than
  per connection, so a real blob reaches everybody's member records; and the format is
  known, so one can be composed for a player who has not sent his own.
- **Arrivals must be announced to the people already there.** Our replies only ever go
  back to whoever asked. `MEMBER_JOIN` (50) is the message for it, and `NEW_GROUP` (54)
  for a game appearing in a channel somebody else is looking at — but MEMBER_JOIN as we
  sent it drew no reaction at all, so its shape is unknown, and a second client is what
  will show whether the room's own list refreshes without it.
- **The peers' addresses.** The lobby knows each player's own (`LOBBYSERVERLOGIN`
  reports his LAN address and netmask) and the NAT mirror knows how he looks from
  outside; the port his pings come from is 8888. That is the material for introducing
  them, and gameplay itself is peer to peer, so this server never carries it.

The open question: **does one install run twice**, or is a second copy of the game
folder needed? Worth answering before anything else, because it decides how the test
is even set up.

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

**The ladder is answered, and its row layout is the open guess.** `PROXY_HANDLER`
subtype 1281 (0x501) now gets a real row from `src/net/ladder.ts` — 46 keys, a new
player at 1500, stored in `data/ladder.json`. What is measured: the request's shape and
that the reply's first field is read as a byte and compared with 0x26 (38). What is
guessed: how a row is laid out. The verdict is one line in the game's log —
`LadderQuery_StartResultEntryEnumeration(…) succeeded` against `ladder query request
failed,reason=…` — so read that before changing anything about it.
[LADDER.md](LADDER.md) has the rest, including the four handler names behind the proxy.

**Chat has no history and cannot get one from the protocol.** It is real IRC: a joiner
gets an echo of his JOIN and a member list, nothing else. Replaying the last N lines
to him is possible — the client draws whatever arrives, and it packs colour and font
into the message text itself — but it is our invention, and replayed lines will look
like they were just said, because the wire carries no timestamps.

Accounts are still "any name, any password". The client has no registration
screen (`UI/MPRegister` is the progress window), but the wire has
`NEWUSERREQUEST` and the client knows how to say "name taken" and "wrong
password", so creating an account on first login needs no client change —
Сеня chose that over a website or a new screen. Removing the CD-key prompt is still
open too: the key sits in the client's `ubi_cdkey` setting, used by the screens at
0x87B790, 0x87C840, 0x87CF50, 0x87D2B0.

# The ladder

The one part of this server with no prior art at all: the reference
implementations stop at the lobby, and Ubisoft's stats end never existed in the
open. But the client asks for it by name, and everything it wants is named in the
exe — so the shape is not a guess even though the behaviour is ours to invent.

## The proxy has four handlers

The proxy is a switchboard. Its handler names are four literals in `.rdata`
(0xFF87CC…0xFF87F8 in `H5_Game_H5E.exe`):

```
clanservice
remotealgorithm
persistantdata
ladderquery
```

The client asks the router's wait module *where* a handler lives (`PROXY_HANDLER`
subtype 1, body `[name, "0", "0"]`) and we answer with an address — that is the
exchange that already works. Then it opens the proxy's own wait module and sends
the real request there.

## `ladderquery` is request 1281, and it is the only one

Measured twice in one session, on the proxy wait module (port 40031), unanswered
so far:

```
PROXY_HANDLER  8->11
  "1281"
  "1"
  [ "1"
    [ "1", "HEROES_29988429c481f219", "1", "0",
      [ "1", [ "Senyaak", "1" ] ],
      [ [], [], [] ] ] ]
```

That 1281 is `0x501`, and it comes straight out of the exe: at 0x42BC92 the
request is built as

```
push  <param>
push  501h
push  0
push  0
push  0FF87F8h        ; "ladderquery"
call  0041DF10h       ; the request builder
```

so the number is the ladder query's own request type, paired with the handler name
in the same call. **There is exactly one**: `--push` finds `0x501` at four call
sites (0x42BC92, and three in the function at 0x42BEB0) and finds *nothing* for
0x500 or 0x502…0x510. One answer shape to write, not a family.

Reproduce, in the editor repo (it owns the disassembler):

```bash
node tools/net-probe.ts <exe> --push 1281
node tools/net-probe.ts <exe> --func 0x42bc40
```

Read against the body above, the payload is a query for **one game, one player,
and no named keys** — `HEROES_…` is the game, `Senyaak` the player, and the three
empty lists are where key names would go.

**Answered since 12.08.2026**, by `src/net/ladder.ts` plus the `LADDER_QUERY` branch in
`router-service.ts`: the pivot user is read out of the request (five levels down), his
row is created at 1500 on first sight, and the reply carries all 46 keys as named pairs.
The store is a JSON file, `data/ladder.json`, so a rating outlives the process. Whether
the client *reads* that row is the thing to check in its log — see below.

### What the answer has to be shaped like

Not known in detail yet, but the client's own vocabulary constrains it. These are
its ladder calls, as literals in the exe:

```
LadderQuery_CreateRequest(          LadderQuery_RequestPivotUser(
LadderQuery_SendRequest()           LadderQuery_StartResultEntryEnumeration(
LadderQuery_GetCurrentEntryField(
```

So a reply is **an enumeration of entries, each of which has named fields** — rows
of players, fields from the table below — and a request can pivot on a user, which
is how "the ten players around me" is asked for. `NUbi::ILadderRow`,
`NUbi::CLadderRowImpl` and `NUbi::SGetLadderRow` confirm a row is a first-class
thing on the client side.

The reply's own log line is `NUbi::CClient2::LadderQueryRcv_RequestReply:`
followed by `succeeded` or `failed`, so the mirrored game log will say plainly
whether an answer was understood — no guessing needed once there is one to send.

### Silence is handled, but it costs something

The client has a path for this and names it:

```
Failed to get Ladder row for myself, setting N/A
Failed to get Ladder row for myself, setting N/A, set OWN player info send failed
Ladder info acquired, set OWN player info sent, waiting reply
```

So an unanswered ladder query means the player's own rating shows **N/A**, and it
happens on the way to sending his player info — which is why the session survives
it. What it does not survive for free is the wait: an unanswered step is 30 seconds
(see STATE.md), so this is one of the pauses to remove later even if nobody cares
about rankings yet.

Match results, note, do **not** come through this handler — they go through the
lobby (`LobbySend_InitMatchResults`, `LobbySend_SetMatchResult`,
`LobbySend_SubmitMatchResult`, `LobbySend_ClearMatchResult`, answered by
`LobbyRcv_SubmitMatchResultReply` and `LobbyRcv_FinalMatchResults`). The ladder
handler is read; the lobby is where writing happens.

## The 46 keys, in the exe's own order

The client's stat vocabulary, read out of 0xFE5CC0…0xFE5F1C — reproduce with
`node tools/net-probe.ts <exe> --strings 0xfe5cc0 0xfe5f20`:

```
RATING              GAMES_PLAYED        WINS                LOSSES
MAX_WINS_STREAK     MAX_LOSSES_STREAK   CUR_WINS_STREAK     CUR_LOSSES_STREAK
TOT_TIME_PLAYED     TOT_HEROES_HIRED    TOT_HEROES_LOST     TOT_HEROES_DEFEATED
W_<race>            L_<race>            H_<race>            G_<race>
AVERAGE_HERO_LEVEL  DISCONNECTIONS
```

The four per-race families run over the eight factions in this order —
`HEAVEN, PRESERVE, ACADEMY, DUNGEON, NECROMANCY, INFERNO, DWARVES, ORCS` — which
gives 46 keys in all. `W_` and `L_` are wins and losses with that faction. `H_` and
`G_` are **not** known; they sit in the same table and the same order, and naming
them from their letters would be a guess.

Two things follow from the list that are worth noticing before designing anything:
it counts `DISCONNECTIONS` separately from `LOSSES`, and it keeps both maximum and
current streaks — so the client expects a server that watched the game end, not one
that was merely told a winner.

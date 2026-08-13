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
row is created at 1500 on first sight, and the reply carries all 46 keys. The store is a
JSON file, `data/ladder.json`, so a rating outlives the process. It was a refusal until
13.08.2026 and it is a real table now; whether the client *reads* that table is the thing
to check in its log — see below.

### What the answer has to be shaped like

**Read on 13.08.2026**, at 0x432c80 — the parser the payload goes through once the
envelope has been accepted. The shape, and `ladderPayload` in
[src/net/ladder.ts](../src/net/ladder.ts) is it:

```
[ "1",                                 <- atoi'd and compared with 1 (0x443740)
  [ "<the ladder's request id>", "0",  <- two numbers, kept at result+8 and +0xC
    [ ["RATING","1"], ["WINS","1"], … ],   <- the columns: pairs of strings, ≤32 chars
    [ ["1500","6", … ] ] ] ]               <- the rows: strings, ≤128 chars each
```

**The first number is the request's own id, not a count.** A query carries two ids —
the module's (`body[1]`: 1, 3, 5, 7) which the reply is matched by, and the ladder's own
(the query's first field: 1, 2, 3, 4) which the GAME compares against what it is waiting
for. The reader resolves the first correctly and then overwrites it with this one
(0x42c987). Send anything else and every query after the first is dropped with "not
waiting reply with RequestId=…" — and the first one works, because both ids are 1 there.

Three rules are the whole of it, and all three refuse in silence:

- **a row has exactly as many cells as there are columns.** 0x432b10 divides both
  vectors by their element size and returns error 3 if the counts differ — there is no
  such thing as omitting a stat.
- **every cell is a whole decimal number.** A field is looked up by name in the row's
  own map and run through `strtol`, and 0x431f20 requires the entire string to have been
  consumed (0x42bb90 is the call above it). "N/A", "1500 " and "" are all "no such
  field", which the UI shows as nothing at all.

The two numbers at the head and the second string of each column pair are what is left
guessed: element 0 of a pair is pushed onto the result's ordered column vector, element 1
goes into a second map that nothing we have read consults.

Everything below was written before that reading, and it is what constrained the search:

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
lobby. That path is read below.

## How the stats are filled in: what the client sends when a rated game ends

Read 13.08.2026, all of it out of `NUbi::CStatePlaying::ProcessGameFinishRated`
(**0xe1d4e0**) and down. Nothing here has been seen on the wire yet — no rated game has
been played against this server — but the client's half is written down completely, and
its own log narrates every step, so one rated game will confirm it rather than discover
it.

**Three of the four "sends" send nothing.** `Init`/`Set`/`Clear` build a table in
memory; only `Submit` puts a message on the wire.

| the client's log line | what it really is |
|---|---|
| `LobbySend_InitMatchResults(<matchId>)` | 0x41c2e0 — **allocates** the results table at `client+0x160` and writes the match id into it. No bytes sent. |
| `LobbySend_SetMatchResult(<name>, <statId>, <value>)` | 0x419ec0 → 0x43ff10 — **one cell**: find-or-create the row for that player NAME, then store `statId → value` in it. No bytes sent. |
| `LobbySend_ClearMatchResult()` | throws the table away — it is what every failure path does. |
| `LobbySend_SubmitMatchResult(<a>, <b>)` | 0x41b430 — serialises the table and sends it, **once**, as lobby subtype **30** (`SUBMIT_MATCH`, confirmed against the sender table at 0x42d970: 23 is JOIN_LOBBY, 24 JOIN_ROOM, 12 CREATE_ROOM, 17 START_MATCH, …, 30 this). |

So a rated game ends in **one message with the whole table in it**, and the log lists
every cell that went into it beforehand. The serialisers (0x43fbc0 for the table,
0x440410 for a row) say the shape:

```
table:  [ matchId, 0, <row>, <row>, … ]
row:    [ name, highestStatId, howManyStats, mask, v1, v2, … ]
```

**The stat ids are not in the row — the mask is.** A row carries its values in id order
and a 32-bit mask of which ids are present (0x4403a0 sets `1 << id`), so the reader is
expected to walk the mask. That also caps the vocabulary at 32 — the ladder's own key
table has 46 names, so these ids are **not** indices into it, and what they are is the
one thing this reading does not say. The game's log names them all as numbers the moment
a rated game is played.

Then the client waits, in two states, and both are picky:

- `CStateWaitSubmitMatchResultReply` — the reply is logged as
  `ucType=…,iReason=…,iMatchID=…`, so it is the usual 38/39 plus a **match id**.
- `CStateWaitFinalMatchResults` — waits for `FINAL_MATCH_RESULTS` (71), insists the type
  byte at `+0x10` is 38 and that the id at `+0x0C` equals the match id it started with,
  and says so when it does not: *"iMatchID in reply doesn't match with stored
  context.matchId"* (0xe136b7). It reads nothing else — the new ratings are not in it;
  the client goes and asks the ladder for those.

Two things follow for whoever writes this end of the server. The client reports **raw
per-player numbers, not a winner** — deciding the rating is the server's job, which is
the same thing the ladder's key list already implied (streaks and disconnections are
things only a server that watched can count). And an unrated game takes a different door
entirely: `ProcessGameFinishUnrated` (0xE1DEB0) sends `LobbySend_GameFinish(…)`, subtype
**35**, one field — the room id — and no table at all. *(It said 45 here until 13.08.2026;
45 is `LobbySend_MatchFinish`, sent from `CStateWaitAllPlayersFinishedMatch::ProcessStep`
at 0xE13945, which is inside the rated chain and after the results have gone.)*

**All of this happens, and it was measured on 13.08.2026** — an ordinary map in the
Ranked channel, two live players. `START_MATCH` arrived, both clients answered our
`MATCH_STARTED` push with subtype 44 within 200 ms, played for eight minutes, and each
sent the table below. **We answered neither, and both screens hung on "Пожалуйста,
подождите пока результаты игры не отправятся на ubi.com"** — which is what an unanswered
`CStateWaitSubmitMatchResultReply` looks like from the player's chair.

*(A page of this file used to say the opposite — that the whole rated chain was dead code,
because `[ctx+0xE8]` gates START_MATCH and nothing seemed to set it. That was written
after a DUEL, which never sends START_MATCH at all. The gate is real and its polarity was
read correctly; what sets the byte the first time is still not found, and is a question
for the game's own code rather than the lobby library. **Do not design around that flag.**
The rated branch is answered unconditionally, because it turns on without us.)*

The two things owed back, both now implemented:

```
SubmitMatchResultReply   ["38", ["30", [matchId]]]
FINAL_MATCH_RESULTS 71   ["71", [matchId, "38", [[name, [numbers…]], …]]]   ← BARE
MatchFinishReply         ["38", ["45", [matchId]]]
```

**71 must not be wrapped in a 38 envelope.** Its parser (0x426380) reads `body[1][0]` as
the match id — the slot an envelope fills with the echoed subtype — so a wrapped push
delivers the id as 71, the client compares it with what it stored and waits for ever
(0xE136D4, *"iMatchID in reply doesn't match"*). The rows are parsed (a name of at most
32 characters, then a list of numbers) but read by nobody: the handler looks at the type
byte and the id only, and goes to the ladder for the new ratings. An empty list of ROWS,
though, makes the client fail itself with reason 65.

**The match id is ours.** It is the second field of `MATCH_STARTED`, the client stores it
(`ctx+0x258`, 0xE1D2B0) and quotes it at the head of its table; we send the room's id and
take it back out of the request rather than the room, which by then may be gone.

## What the numbers are, as far as two matches say

The stat ids are built by the GAME, not by the lobby library, and are named nowhere in it.
The client does print every cell into its own log — `LobbySend_SetMatchResult(name, statId,
value)`, and they come out in id order 0…21 — which confirms that the position in the list
IS the stat id, and nothing more. **They are not ladder keys**: id 0 would be RATING, and
it arrives as 0 or 1.

Three rated matches, same map, same two accounts. The third was played on purpose with
the **host losing**, which is what separated "who won" from "which seat":

```
             id: 0  1  3    9  14 15 16      17   19   21
game A (18:56)  host Senyaak2
  Senyaak       0  1  980  1  2  0  65536   474  0    0
  Senyaak2      1  7  0    0  0  1  65536   474  250  1
game B (20:38)  host Senyaak, and RED won
  Senyaak       1  7  0    0  0  1  65536   111  250  1
  Senyaak2      0  1  0    1  1  0  65536   111  0    0
game C (20:49)  host Senyaak, and he LOST — BLUE won
  Senyaak       0  7  0    0  2  0  65536   267  0    1
  Senyaak2      1  1  350  1  0  1  98304   267  0    0
```

(Every id not listed was 0 for everybody in all three.)

Game C also came with the end-of-game screens of both players, which turns guesses into
readings:

| id | what it is | how it was read |
|---|---|---|
| **0** | **the WIN, 1 or 0** | C's winner was the guest, not the host — the column followed the winner. Confirmed against A and B, and against "red won" in B. |
| 1 | the faction | 7 for the player who played Stronghold, 1 for Sylvan; it stays with the SEAT across games, not with the account |
| 9 | the seat/colour | 0 for red, 1 for blue in all three; it is why this and the faction looked like they carried the result |
| 14 | heroes lost — **or** battles lost | red's screen says both, and both are 2; nothing in three games separates them |
| 15 | towns captured — **or** heroes killed | blue's screen says both, and both are 1 |
| 17 | **the match in seconds** | 267 exactly matches the wire (20:49:40 → 20:54:07); 474 vs 495 and 111 vs 93 differ by the load |
| 16 | 65536, and 98304 once | 0x10000 and 0x18000 — a fixed-point 1.0 and 1.5. Not read. |
| 3, 19 | 980, 350, 250 | nothing on either screen matches these. Not read. |
| 21 | artefacts collected | red's screen: 1 artefact, and red has 21:1 in B and C; blue, with none, has 0 |

Plenty on the screens — gold, creatures recruited, resources — **does not travel at all**,
so the table is a selection, not a dump.

**id 0 is enough to rate a game**: it names the winner outright, and the length is in id 17
if a rating should care about it. Nothing computes a rating yet — that is a decision about
numbers, not about the protocol.

## What the profile screen draws, key by key

Read 13.08.2026 out of `CMPProfileScreen` — the ladder→screen table is 0x93F4C0 and the
drawing is 0x93C3C0. This is what a ladder row is FOR, so it decides what is worth writing
into one.

| key | on screen |
|---|---|
| `RATING` | the experience bar, its two labels, **and the rank** |
| `MAX_WINS_STREAK`, `MAX_LOSSES_STREAK`, `CUR_WINS_STREAK`, `CUR_LOSSES_STREAK` | the four streak lines |
| `TOT_TIME_PLAYED` | hours played (it divides by 60, so **seconds**), days played, average game length |
| `TOT_HEROES_LOST`, `TOT_HEROES_DEFEATED` | heroes lost, heroes defeated |
| `W_<faction>`, `L_<faction>` | the wins/losses columns of the faction table — **and the games, wins and losses at the top, which are their sums** |
| `H_<faction>` | the "heroes used" column, as a percentage of their own total; their sum is "heroes hired" |
| `G_<faction>` | the "armies used" column, likewise — **and the alignment needle, and the favourite faction** |
| `AVERAGE_HERO_LEVEL` | average hero level, **as 16.16 fixed point**: multiply by 65536 |

**`GAMES_PLAYED`, `WINS`, `LOSSES`, `TOT_HEROES_HIRED` and `DISCONNECTIONS` are not read
by this screen at all** — it counts games, wins and losses from the per-faction columns.
They still have to be sent (the parser wants one cell per column) and may well be read
somewhere else, but nothing on the profile depends on them.

**The alignment needle is `G_` and nothing else** (0x93C611): good is HEAVEN, PRESERVE,
ACADEMY and DWARVES, evil is DUNGEON, NECROMANCY, INFERNO and ORCS, and the needle sits at
`good ÷ total`. With all of them zero the ratio defaults to exactly one half — which is why
it was dead centre — and "good" also selects which NAME a rank has: the same eleven ranks
come in a good and an evil flavour (peasant/slave, knight/pack leader, regent/overlord).

## Rank is the rating divided by a hundred

`0x93CD4B` divides `RATING` by 100 to get a LEVEL; the bar's labels are that level and the
next, and the bar itself is the remainder over 100. The level is then looked up in a table
of eleven ranks that lives in the game's data, not the exe —
`UI/UIGameRoot.(UIGameRoot).xdb`, node `<ranks>` — matched as `min ≤ level < max`:

Read out of the file itself (`data.pak`, `UI/UIGameRoot.(UIGameRoot).xdb`), eleven bands
thirty levels wide, each with a good and an evil face:

| levels | rating | good | evil |
|---|---|---|---|
| 0 … 29 | 0 … 2999 | peasant, Haven's Peasant | slave, Inferno's Familiar |
| 30 … 59 | 3000 … 5999 | recruit, Militiaman | minion, Imp |
| 60 … 89 | 6000 … 8999 | scout, **Sylvan's Wood Elf** | harbinger, Dark Assassin |
| 90 … 119 | 9000 … 11999 | legionnaire, Swordsman | beast, Horned Demon |
| 120 … 149 | 12000 … 14999 | captain, Footman | taskmaster, Blood Witch |
| 150 … 179 | 15000 … 17999 | squire, **Sylvan's Druid** | pack hound, Marauder |
| 180 … 209 | 18000 … 20999 | knight, Cavalier | pack leader, Vampire Lord |
| 210 … 239 | 21000 … 23999 | champion, Paladin | ringleader, Matron |
| 240 … 269 | 24000 … 26999 | baron, Priest | mastermind, Demilich |
| 270 … 299 | 27000 … 29999 | duke, **Academy's Giant** | overseer, Arch Devil |
| 300 and up | 30000 and up | regent, Arch Angel | overlord, Shadow Dragon |

The portrait beside the rank is a CREATURE — the same 128px face the combat arena uses —
and which creature is fixed by the band, not by what the player plays: the good ladder is
mostly Haven with a wood elf, a druid and a giant along the way, the evil one mostly
Inferno and Dungeon with two undead at the end. Twenty-two portraits in all, and a player
"unlocks" one by reaching the band, which is the whole of that mechanism.

**There is no avatar to choose.** The screen has `AvatarBack` and `AvatarForward` buttons
and their tooltips say "pick the previous/next badge", but they are the stump of a cut
feature: their `.xdb` says `<Enabled>false</Enabled>` with no commands, and in the exe each
name appears exactly once — where the screen finds the button and sets its visibility. No
handler, no list, no index (the field that looks like it held one is zeroed and never
read). The picture is `<Icon>` of the rank record and nothing else, so **the only things
that change a player's portrait are his rating and which factions he has played**. Giving
players a real choice would mean patching the exe and the two `.xdb` files.

**And the profile blob holds only the comment.** Three captures of a real save differ in
one field: a UTF-16 string of what the player typed into "Additional information", under a
constant header. No avatar, no rank, no statistics — the screen's numbers all come from the
ladder. So storing that blob opaquely, as this server does, loses nothing.

**Which says what the number was meant to be.** A scale whose top rank begins at 30000 and
whose bands are 3000 wide is not an Elo rating — it is an accumulating score, points per
game played. Our 1500 start lands a new player halfway through the FIRST band, and Elo's
±16 a game would keep him there for life: it would take a hundred wins to move a rank at
all. At a hundred experience per win, the second rank is fifteen wins away.

A rating below zero is worse than useless: the level matches no row and the screen draws an
empty rank with no icon (0x93D451). Zero itself is fine — level 0, first rank, empty bar —
so the Elo update floors at 0.

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

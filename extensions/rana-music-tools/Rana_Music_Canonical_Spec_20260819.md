# Rana / MyGO Five-Bot Music Canonical Specification

**Status:** Canonical baseline for Codex / child agents / reviewers  
**Date:** 2026-08-19  
**Scope:** OpenClaw Music / Voice orchestration for Rana, Tomori, Anon, Soyo, and Taki  
**Authority:** This document defines intended target behavior. Evaluate existing implementation against this spec; do not infer requirements from legacy code.

---

## 1. Core Definition

Music is a **shared capability**, not a shared player.

All five personas use one common Music implementation and one common extraction layer, but each persona must behave as an **independent playback entity**.

```text
Rana / 樂奈
Tomori / 燈
Anon / 愛音
Soyo / 爽世
Taki / 立希
        │
        ▼
Shared Music Tool / LIVE.py
        │
        ▼
Route by bot_id
        │
        ├─ rana   → voice bridge :8081
        ├─ tomori → voice bridge :8082
        ├─ anon   → voice bridge :8083
        ├─ soyo   → voice bridge :8084
        └─ taki   → voice bridge :8085
```

**Shared implementation does not imply shared runtime ownership.**

The five bots may share code, yt-dlp, LIVE.py, and Lavalink infrastructure, but must not accidentally share:

- queue
- current track
- volume
- Discord voice state
- reconnect state
- queue panel ownership
- player ownership
- playback lifecycle

---

## 2. Supported Persona Identities

Canonical bot IDs:

```text
rana
tomori
anon
soyo
taki
```

Canonical voice bridge mapping:

```text
rana   → 8081
tomori → 8082
anon   → 8083
soyo   → 8084
taki   → 8085
```

This mapping is fixed unless this specification is explicitly revised.

---

## 3. Identity Is a First-Class Boundary

A Music request should preserve or resolve:

```text
bot_id
persona_id
account_id
guild_id
voice_channel_id
text_channel_id
requester_id
session_key
request_id
```

`bot_id` is authoritative for Music ownership. It determines:

```text
Discord bot account
voice bridge
voice connection
queue
current track
player
volume
queue panel
reconnect state
```

### 3.1 Fail-Closed Identity

Forbidden:

```text
missing bot_id → rana
unknown bot_id → rana
invalid bot_id → :8081
garbage identity → default
```

Required:

```text
missing / unknown / invalid identity
→ fail closed
→ no playback side effect
→ no fallback to another persona
```

A failed Taki request must not become a Rana request.

---

## 4. Playback Ownership Model

Legacy single-bot assumptions such as:

```text
guild_id → one queue / one player
```

are insufficient.

Canonical ownership:

```text
PlaybackOwner = bot_id + guild_id
```

For voice placement:

```text
PlaybackContext =
    bot_id
  + guild_id
  + voice_channel_id
```

Therefore:

```text
rana + GuildA
```

and:

```text
taki + GuildA
```

are different playback owners and may coexist simultaneously.

---

## 5. Per-Bot State Isolation

Conceptually:

```text
state[bot_id][guild_id]
```

If each bot runs in a dedicated voice bridge process, process-local:

```text
state[guild_id]
```

is acceptable **only if that process is permanently bound to exactly one bot identity**.

Each bot must independently own at least:

```text
voiceStates
guildChannels
voicePending
reconnecting
playQueues
queueRunning
currentTracks
activePlayers
stayVoiceGuilds
guildVolumes
queuePanels
Lavalink session
Lavalink player namespace
```

Invariant:

```text
Action on Bot A
must never mutate Bot B state.
```

Example:

```text
Rana:
  Current = Song A
  Queue   = Song B, Song C

Taki:
  Current = Song X
  Queue   = Song Y
```

After:

```text
@樂奈 跳過
```

Expected:

```text
Rana:
  Current = Song B
  Queue   = Song C

Taki:
  unchanged
```

---

## 6. LIVE.py Responsibility

`LIVE.py :8080` is the shared extraction and dispatch layer.

Responsibilities:

```text
YouTube URL
keyword search
playlist expansion
Bilibili
supported media
        ↓
yt-dlp / source normalization
        ↓
title / duration / playable media
        ↓
route to target voice bridge by bot_id
```

LIVE.py must **not** become the authoritative owner of persona playback state.

Canonical separation:

```text
LIVE.py
= extraction + normalization + dispatch

voice_bridge
= Discord voice + queue + player + playback ownership
```

### 6.1 YouTube Transport

Current known-good architecture:

```text
YouTube URL
→ working yt-dlp nightly
→ extracted playable media
→ target voice bridge
→ Lavalink
→ Discord voice audio
```

Do not add GoogleVideo proxy workarounds without fresh evidence that the currently working upstream path has failed again.

---

## 7. Voice Bridge Routing

Known bot identity must map to exactly one bridge:

```text
rana   → :8081
tomori → :8082
anon   → :8083
soyo   → :8084
taki   → :8085
```

Forbidden:

```text
taki bridge offline
→ silently route to rana
```

Required:

```text
taki bridge unavailable
→ Taki Music request fails
→ Rana / Tomori / Anon / Soyo remain unaffected
```

---

## 8. Queue Semantics

Each bot owns its own queue.

Supported operations must target the mentioned / resolved bot:

```text
play
list / queue
next
skip
remove
stop
volume
join
leave
```

### 8.1 New Play Request

Existing playback + new play request:

```text
current song playing
+
new play request
        ↓
append to that bot's queue
```

Forbidden default behavior:

```text
new play
→ auto-skip current
```

Only explicit control commands may replace or stop the current song:

```text
skip
stop
leave
```

---

## 9. Concurrent Playback Is a Required Feature

### 9.1 Different Guilds

Required:

```text
Guild A:
  Rana → Song A

Guild B:
  Taki → Song B
```

Both must play simultaneously.

### 9.2 Same Guild, Different Voice Channels

Required:

```text
Guild A

VC 1:
  Rana → Song A

VC 2:
  Taki → Song B
```

Both must coexist with independent:

```text
Discord voice connections
queues
players
volume
panels
reconnect state
```

### 9.3 Same Guild, Same Voice Channel

Required target behavior:

```text
VC 1:
  Rana → Song A
  Taki → Song B
```

Both Discord bot accounts may be present and audible simultaneously.

This is **not** considered a collision.

Expected audible result:

```text
Song A + Song B
```

if the user explicitly ordered both bots to play.

The actual forbidden collision is:

```text
Rana command
→ mutates Taki player / queue / volume / voice state
```

---

## 10. Lavalink Ownership

A shared Lavalink server is allowed:

```text
Lavalink :2333
```

but player ownership must remain isolated.

If Lavalink player identity is effectively:

```text
sessionId + guildId
```

then each voice bridge must maintain an independent Lavalink WebSocket session.

Required:

```text
Rana Lavalink Session + Guild A
≠
Taki Lavalink Session + Guild A
```

This allows two bots in the same guild to own independent players.

### 10.1 Critical Lavalink Invariant

```text
No two bot identities may accidentally share the same logical Lavalink player namespace.
```

---

## 11. Discord Voice Credential Isolation

The following Discord voice data belongs to a specific bot account and guild:

```text
VOICE_STATE_UPDATE
VOICE_SERVER_UPDATE
session_id
token
endpoint
```

Forbidden:

```text
Rana voice token
→ Taki Lavalink player
```

Forbidden:

```text
Taki reconnect
→ clear Rana voiceStates
```

Each bridge must only accept authoritative voice state for its own configured `BOT_USER_ID`.

---

## 12. Stop Is Not Leave

Canonical invariant:

```text
stop != leave
```

Example:

```text
@立希 停止
```

Expected:

```text
Taki playback stops
Taki remains in voice
Rana remains unaffected
```

Only:

```text
@立希 離開
```

may disconnect the Taki account from voice.

A control action against one bot must not disconnect another bot.

---

## 13. Queue Panel Ownership

Queue panel ownership must be scoped at least as:

```text
bot_id + guild_id + text_channel_id
```

Rana and Taki panels are different UI objects.

Recommended panel titles:

```text
樂奈的歌單
燈的歌單
愛音的歌單
爽世的歌單
立希的歌單
```

### 13.1 Explicit List Command

User command:

```text
@樂奈 列表
```

must create a **new Discord queue panel message**.

If the user sends it again:

```text
@樂奈 列表
```

it must create another new panel at the current conversation position.

It must not silently edit an old inherited panel.

### 13.2 Panel Refresh Button

The panel's own refresh/update button should:

```text
edit the clicked panel in place
```

Canonical distinction:

```text
explicit list command
→ NEW panel

panel refresh button
→ EDIT current panel
```

---

## 14. Tool Routing

Direct Music execution requires:

```text
resolved bot identity
+
explicit action intent
```

Valid:

```text
@立希 播放 <URL>
@樂奈 列表
@燈 下一首
@愛音 音量 20
```

Invalid as direct playback triggers:

```text
立希
MyGO!!!!!
CRYCHIC
春日影很好聽
```

Core rule:

```text
Tools require explicit action intent,
not keyword presence.
```

Bare names and lore topics must remain model-first.

---

## 15. Persona and Tool Separation

Music backend results should be role-neutral structured data.

Example:

```json
{
  "status": "playing",
  "bot_id": "taki",
  "title": "Song B",
  "queued": 3,
  "guild_id": "..."
}
```

Backend tools should not hardcode persona prose such as:

```text
嗯。立希幫你播了。
```

Visible phrasing should be generated or formatted according to the active bot persona.

This preserves:

```text
one Music implementation
+
five persona-specific visible behaviors
```

without forking the Music engine.

---

## 16. Error Isolation

A single bot's failure must not bring down the other bots.

Example:

```text
Taki :8085 crashes
```

Expected:

```text
Taki Music   ❌
Rana :8081   ✅
Tomori :8082 ✅
Anon :8083   ✅
Soyo :8084   ✅
LIVE :8080   ✅
Lavalink     ✅
```

Do not restart or clear every bot merely because one child fails, unless the failure is proven to be in shared infrastructure.

---

## 17. Shared Infrastructure vs Independent Ownership

Shared:

```text
Music implementation
LIVE.py
yt-dlp
Lavalink server
common tool contracts
common source normalization
```

Independent:

```text
Discord bot account
voice connection
voice credentials
queue
current track
player
volume
queue panel
reconnect lifecycle
playback state
```

Canonical summary:

```text
share code
do not share ownership
```

---

## 18. Required Functional Matrix

| Capability | Required |
|---|---|
| Rana plays independently | YES |
| Tomori plays independently | YES |
| Anon plays independently | YES |
| Soyo plays independently | YES |
| Taki plays independently | YES |
| Independent queue per bot | YES |
| Independent volume per bot | YES |
| Independent queue panel per bot | YES |
| Concurrent playback across guilds | YES |
| Concurrent playback in same guild, different VC | YES |
| Concurrent playback in same guild, same VC | YES |
| Bot A skip does not affect Bot B | YES |
| Bot A stop does not affect Bot B | YES |
| Bot A leave does not affect Bot B | YES |
| Bot A crash does not break Bot B | YES |
| Unknown identity falls back to Rana | NO |
| Shared guild-wide queue across personas | NO |
| Shared Discord voice credentials | NO |
| New play auto-skips current | NO |

---

## 19. Canonical Acceptance Scenarios

### Scenario A — Independent Playback

Input:

```text
@樂奈 播放 Song A
@立希 播放 Song B
```

Expected:

```text
Rana current = Song A
Taki current = Song B
```

Both may be audible simultaneously.

### Scenario B — Independent Queue

Initial:

```text
Rana:
  Current = A
  Queue = B, C

Taki:
  Current = X
  Queue = Y, Z
```

Input:

```text
@樂奈 跳過
```

Expected:

```text
Rana:
  Current = B
  Queue = C

Taki:
  Current = X
  Queue = Y, Z
```

### Scenario C — Independent Volume

Input:

```text
@立希 音量 20
```

Expected:

```text
Taki volume = 20
Rana volume unchanged
Tomori volume unchanged
Anon volume unchanged
Soyo volume unchanged
```

### Scenario D — Explicit List Creates Fresh Panel

Input:

```text
@樂奈 列表
```

Expected:

```text
new queue panel message
```

Second input:

```text
@樂奈 列表
```

Expected:

```text
another new queue panel message
```

Not:

```text
edit first panel
```

### Scenario E — Panel Refresh

Input:

```text
click "更新" on a queue panel
```

Expected:

```text
that same panel is edited in place
```

### Scenario F — Stop Isolation

Input:

```text
@樂奈 停止
```

Expected:

```text
Rana playback stops
Rana remains in VC
Taki playback continues
```

### Scenario G — Leave Isolation

Input:

```text
@立希 離開
```

Expected:

```text
Taki leaves VC
Rana remains connected and playing
```

### Scenario H — Unknown Identity

Input:

```text
bot_id = unknown
play = Song X
```

Expected:

```text
fail closed
no bridge call
no playback side effect
```

Forbidden:

```text
route to Rana :8081
```

---

## 20. Required Invariants

### I1 — Identity Fail-Closed

```text
missing / invalid bot identity
→ no playback side effect
```

### I2 — Unique Bridge Routing

```text
bot_id → exactly one voice bridge
```

### I3 — Queue Ownership

```text
queue ownership = bot_id + guild_id
```

### I4 — Player Isolation

```text
Bot A player state never aliases Bot B player state
```

### I5 — Voice Credential Isolation

```text
Discord voice credentials never cross bot identity
```

### I6 — Append-by-Default

```text
new play request while active
→ append queue
```

### I7 — Stop Is Not Leave

```text
stop != disconnect
```

### I8 — Cross-Bot Mutation Is Forbidden

```text
Bot A control
→ only Bot A state
```

### I9 — Same-Guild Multi-Bot Playback

```text
multiple bots may play concurrently in one guild
```

### I10 — Same-VC Multi-Bot Playback

```text
multiple bots may play concurrently in one voice channel
```

### I11 — Explicit List Means New Panel

```text
user sends list command
→ new Discord panel message
```

### I12 — Refresh Means In-Place Edit

```text
panel refresh button
→ edit that panel only
```

### I13 — LIVE.py Does Not Own Persona Playback State

```text
LIVE.py = extraction + dispatch
```

### I14 — Single-Bot Failure Isolation

```text
failure of one bridge
→ no state destruction in other bridges
```

### I15 — Success Requires Backend Evidence

Visible success must only be emitted after actual backend evidence exists.

Examples of acceptable evidence:

```text
playback accepted by target bridge
queue mutation confirmed
player PATCH confirmed
panel send/edit confirmed
```

No fake success.

---

## 21. Forbidden Implementation Shortcuts

Do not solve multi-bot support by:

```text
one shared guild queue
one global currentTrack
one global volume
one global queue panel
one shared Discord voice token
fallback all unknown identity to Rana
serialize all five bots to one owner
block concurrent same-guild playback
block concurrent same-VC playback merely for convenience
fork five independent Music implementations
duplicate LIVE.py five times
silently mutate another bot's state
```

Do not weaken identity isolation to make tests pass.

Do not infer `single owner per guild` from legacy code as a target requirement.

---

## 22. Target Architecture

```text
                         ┌─ Rana   :8081 ─ voice / queue / player / volume
                         ├─ Tomori :8082 ─ voice / queue / player / volume
Discord → OpenClaw ──────┼─ Anon   :8083 ─ voice / queue / player / volume
          │              ├─ Soyo   :8084 ─ voice / queue / player / volume
          │              └─ Taki   :8085 ─ voice / queue / player / volume
          │
          └── Music Tool
                │
                ▼
             LIVE.py :8080
                │
                ├─ yt-dlp
                ├─ URL / keyword / playlist extraction
                └─ dispatch by bot_id

8081–8085
     │
     └── Shared Lavalink :2333
             │
             └── independent session/player namespaces
```

---

## 23. Final User-Visible Target Result

Example:

```text
User:
@樂奈 播放 Song A

Rana:
嗯。Song A。
```

At the same time:

```text
User:
@立希 播放 Song B

Taki:
……Song B。
```

Voice result:

```text
same or different VC:
Rana Bot → Song A
Taki Bot → Song B
```

Then:

```text
@樂奈 列表
```

shows Rana's queue.

```text
@立希 列表
```

shows Taki's queue.

Then:

```text
@樂奈 停止
```

stops only Rana. Taki continues playing.

---

## 24. Definition of Done

This feature is not complete merely because:

```text
8081–8085 are listening
all /health endpoints return 200
static routing tests pass
mocked queue tests pass
```

Completion requires real multi-bot runtime evidence.

Minimum live acceptance:

1. Rana plays a real track.
2. Taki plays a different real track concurrently.
3. Both remain independently controllable.
4. `@樂奈 列表` shows only Rana state.
5. `@立希 列表` shows only Taki state.
6. Rana skip does not alter Taki.
7. Taki volume change does not alter Rana.
8. Rana stop does not stop Taki.
9. One bot may leave without disconnecting the other.
10. No unknown identity falls back to another bot.
11. Same-guild concurrent playback is demonstrated.
12. Same-VC concurrent playback is demonstrated if Discord/Lavalink runtime permits it as designed.

If a live condition cannot be verified, report it as **UNVERIFIED**, not PASS.

---

# Canonical One-Line Definition

> **Music is a shared capability, not a shared player: the five bots share extraction and implementation, while each bot owns an independent voice connection, queue, player, volume, panel, reconnect lifecycle, and playback state, including concurrent playback in the same guild or voice channel.**

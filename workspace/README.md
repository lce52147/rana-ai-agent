# Kaname Rana — Music System

> All packages installed. All configs set. This is the daily-use guide.

---

## Before You Order Rana to Play Music

Every session, launch in this exact order:

### 1. Start Lavalink + LIVE.py

Double-click or run:

```
C:\Users\Administrator\.openclaw\workspace\services\music_core\start_live.bat
```

Two console windows will open. Wait until the **Lavalink** window shows:

```
Lavalink is ready to accept connections.
```

---

### 2. Start the Voice Bridge

Open a terminal in `services\music_core\` and run:

```powershell
node voice_bridge.js
```

Wait until you see all three of these lines:

```
[DISCORD] Logged in as <BotName>
[LAVALINK] Session established: ...
[BRIDGE] HTTP API on http://127.0.0.1:8081
```

---

### 3. Make Sure OpenClaw Is Running

The OpenClaw gateway must be active (you can verify at http://127.0.0.1:18789).

---

### 4. Join a Voice Channel in Discord

> You must be **inside a voice channel** before ordering Rana. The bot joins wherever you are.

---

### 5. Order Rana

```
play https://www.youtube.com/watch?v=xxxxx
```

Supported sources: YouTube, Bilibili, Threads, Instagram Reels, Facebook Video.

To stop:
```
stop
```

---

## Quick Status Check

Before ordering, confirm all three services are alive:

| Service | How to check |
|---|---|
| Lavalink | Console window still open and running |
| LIVE.py | http://127.0.0.1:8080/health → `{"status":"ok"}` |
| Voice Bridge | http://127.0.0.1:8081/health → `{"discord":"online","lavalink_session":"..."}` |

---

## Startup Checklist

```
[ ] start_live.bat is running    (Lavalink port 2333 + LIVE.py port 8080)
[ ] node voice_bridge.js running (port 8081, Discord logged in)
[ ] OpenClaw gateway is running
[ ] You are in a Discord voice channel
--> Order Rana to play
```

---

## What Each Piece Does

| Component | Port | Role |
|---|---|---|
| Lavalink.jar | 2333 | Audio engine — streams audio to Discord |
| LIVE.py | 8080 | Extracts media URL via yt-dlp |
| voice_bridge.js | 8081 | Joins your VC + hands audio to Lavalink |
| OpenClaw | 18789 | AI agent — Rana lives here |

Flow: `Discord message → OpenClaw → voice_bridge (8081) → LIVE.py (8080) → Lavalink (2333) → your VC`

---

## Troubleshooting

**Rana says `LIVE掛了` / nothing happens**
→ `voice_bridge.js` is not running. Run `node voice_bridge.js`.

**`Login failed: invalid token`**
→ Token in `.env` is wrong or expired. Go to [Discord Developer Portal](https://discord.com/developers/applications) → your bot → Reset Token → paste the new token into `.env` as `DISCORD_TOKEN=`.

**Lavalink WebSocket 1006 (abnormal closure)**
→ 1006 means the connection dropped without a clean goodbye — usually a network hiccup or the OS killed an idle socket. The bridge now handles this automatically:

```
[LAVALINK] ⚠️  Disconnected with 1006 (abnormal closure)
[LAVALINK]     Reconnecting in 5s... (session will be resumed automatically)
[LAVALINK] ✅ Session RESUMED: <same session id>
[LAVALINK] [RESUME] Session resuming registered (HTTP 200)
```

If you see `Session RESUMED` — music continues, nothing to do.
If you see `Session established` (not resumed) — the 60s window expired; the current track was lost. Just re-order the song.
If 1006 keeps repeating every few seconds → Lavalink itself crashed. Restart `start_live.bat`.

**`Lavalink session not established`**
→ Lavalink window crashed or hasn't finished starting. Restart `start_live.bat` and wait for the ready message before running the bridge.

**Rana replies but no audio plays**
→ Bot joined VC but Lavalink couldn't load the track. Check if the URL is from a supported platform. Try a plain YouTube link first.

**Bot doesn't join the voice channel**
→ Make sure you are in a voice channel. Also check the bot has `Connect` and `Speak` permissions in that channel.


---

## File Locations

```
.openclaw\
├── Lavalink.jar
├── application.yml
├── openclaw.json                          <- OpenClaw main config
└── workspace\
    ├── README.md                          <- this file
    ├── tools\
    │   ├── rana_play_music.json           <- play tool definition
    │   └── rana_stop_music.json           <- stop tool definition
    └── services\music_core\
        ├── .env                           <- Discord token + Lavalink config
        ├── LIVE.py                        <- FastAPI media server (port 8080)
        ├── voice_bridge.js                <- Discord voice gateway (port 8081)
        └── start_live.bat                 <- one-click launcher
```

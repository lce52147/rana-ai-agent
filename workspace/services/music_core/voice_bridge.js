/**
 * voice_bridge.js — Rana Voice Gateway Bridge v3.0
 * =================================================
 * discord.js + Lavalink v4.
 * Uses the Discord bot token to join VC and feed real voice state to Lavalink.
 * This is the PROVEN architecture (worked 2026-04-27, bridge.log confirmed).
 *
 * Architecture:
 *   LIVE.py (yt-dlp extract) → POST :8081/voice/play → voice_bridge
 *   voice_bridge → discord.js OP4 join → capture VOICE_STATE + VOICE_SERVER
 *   voice_bridge → Lavalink WS (session) + PATCH (play)
 *
 * Run: node voice_bridge.js
 */

require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const { Client, GatewayIntentBits, GatewayDispatchEvents } = require('discord.js');

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || '1202969643162013776';
const LAVALINK_HOST = process.env.LAVALINK_HOST || '127.0.0.1';
const LAVALINK_PORT = parseInt(process.env.LAVALINK_PORT || '2333');
const LAVALINK_PASS = process.env.LAVALINK_PASS || 'youshallnotpass';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8081');

if (!DISCORD_TOKEN) {
  console.error('[BOOT] ERROR: DISCORD_TOKEN is not set. Create a .env file with DISCORD_TOKEN=your_token');
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────────────
let lavalinkSessionId = null;
let lavalinkWs = null;
let discordReady = false;
let lavalinkPingTimer = null;   // keepalive interval handle
let reconnectDelay = 5000;   // exponential backoff, resets on successful connect
const RESUME_KEY = 'rana-voice-bridge-resume-key'; // session resume key

// Per-guild voice state cache: guildId → { token, endpoint, sessionId }
const voiceStates = new Map();
// Pending voice join resolvers: guildId → { resolve, reject, timer }
const voicePending = new Map();
// Per-guild channel cache (needed for 4006 rejoin): guildId → channelId
const guildChannels = new Map();
// Debounce guard for 4006 reconnects: guildId → true
const reconnecting = new Map();

function log(tag, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}]`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// Discord.js Client — handles OP4 voice join + VOICE_STATE/SERVER events
// ═══════════════════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once('clientReady', () => {
  discordReady = true;
  log('DISCORD', `Logged in as ${client.user.tag} (${client.user.id})`);
  const guilds = [...client.guilds.cache.values()].map(g => `${g.name} (${g.id})`).join(', ');
  log('DISCORD', `Guilds: ${guilds || 'none'}`);

  // On startup: force a VOICE_SERVER_UPDATE for every guild the bot is already in VC.
  // This captures the live token+endpoint so play calls don't need to rejoin.
  // We do this by sending OP4 join to each channel the bot is currently in.
  setTimeout(() => {
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.cache.get(client.user.id);
      if (me && me.voice && me.voice.channelId) {
        const channelId = me.voice.channelId;
        log('VOICE', `[STARTUP] Bot already in channel ${channelId} (guild ${guild.id}) — refreshing voice state`);
        guildChannels.set(guild.id, channelId);
        client.ws.shards.first()?.send({
          op: 4,
          d: { guild_id: guild.id, channel_id: channelId, self_mute: false, self_deaf: true },
        });
      }
    }
  }, 3000);
});



client.on('error', (err) => {
  log('DISCORD', `Error: ${err.message}`);
});

// Intercept raw WS packets from Discord for VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE
// These arrive before discord.js processes them — we need the raw sessionId
client.ws.on(GatewayDispatchEvents.VoiceStateUpdate, (data) => {
  if (data.user_id !== BOT_USER_ID) return;
  const guildId = data.guild_id;
  const sessionId = data.session_id;
  log('VOICE', `State update: guild=${guildId} session=${sessionId}`);

  if (!voiceStates.has(guildId)) voiceStates.set(guildId, {});
  voiceStates.get(guildId).sessionId = sessionId;
  _tryResolveVoice(guildId);
});

client.ws.on(GatewayDispatchEvents.VoiceServerUpdate, (data) => {
  const guildId = data.guild_id;
  const token = data.token;
  const endpoint = data.endpoint;
  log('VOICE', `Server update: guild=${guildId} endpoint=${endpoint}`);

  if (!voiceStates.has(guildId)) voiceStates.set(guildId, {});
  const state = voiceStates.get(guildId);
  state.token = token;
  state.endpoint = endpoint;
  _tryResolveVoice(guildId);
});

/**
 * Called each time VOICE_STATE or VOICE_SERVER arrives.
 * Resolves the pending promise only when BOTH have arrived.
 */
function _tryResolveVoice(guildId) {
  const state = voiceStates.get(guildId);
  const pending = voicePending.get(guildId);
  if (!pending) return;
  if (state && state.sessionId && state.token && state.endpoint) {
    clearTimeout(pending.timer);
    voicePending.delete(guildId);
    pending.resolve({ ...state });
  }
}

/**
 * Send OP 4 (voice state update) to Discord to join a voice channel.
 * Returns a promise that resolves once both VOICE_STATE + VOICE_SERVER arrive.
 */
function joinVoiceChannel(guildId, channelId) {
  guildChannels.set(guildId, channelId);

  return new Promise((resolve, reject) => {
    const guildShard = client.ws.shards.first();
    if (!guildShard) return reject(new Error('No shard available'));

    // Fast path: if we already have fresh voice credentials cached (from startup refresh
    // or a previous successful join), use them directly without sending OP4.
    // Sending OP4 to an already-joined channel causes Discord to skip VOICE_SERVER_UPDATE.
    const cached = voiceStates.get(guildId);
    if (cached && cached.token && cached.endpoint && cached.sessionId) {
      log('VOICE', `[JOIN] Using cached voice state for guild=${guildId} (token=${cached.token.substring(0, 8)}...)`);
      return resolve({ ...cached });
    }

    // Slow path: send OP4 join and wait for both VOICE_STATE + VOICE_SERVER events
    voiceStates.delete(guildId);
    const timer = setTimeout(() => {
      voicePending.delete(guildId);
      reject(new Error(`Voice join timeout for guild=${guildId} channel=${channelId}`));
    }, 12000);
    voicePending.set(guildId, { resolve, reject, timer });

    log('VOICE', `Sent OP4: join guild=${guildId} channel=${channelId}`);
    guildShard.send({
      op: 4,
      d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: true },
    });
  });
}





/**
 * Reconnect handler for Lavalink WebSocketClosedEvent code=4006.
 * Re-sends OP4, waits for fresh VOICE_STATE + VOICE_SERVER, then re-PATCHes
 * Lavalink so the player continues without user intervention.
 *
 * A 5-second debounce per guild prevents storm loops if Lavalink fires
 * 4006 repeatedly in quick succession.
 */
async function handle4006Reconnect(guildId) {
  if (reconnecting.get(guildId)) {
    log('RECONNECT', `[4006] guild=${guildId} already reconnecting — skipped`);
    return;
  }
  reconnecting.set(guildId, true);

  const channelId = guildChannels.get(guildId);
  if (!channelId) {
    log('RECONNECT', `[4006] guild=${guildId} — no cached channelId, cannot rejoin`);
    reconnecting.delete(guildId);
    return;
  }
  if (!lavalinkSessionId) {
    log('RECONNECT', `[4006] guild=${guildId} — Lavalink session gone, aborting`);
    reconnecting.delete(guildId);
    return;
  }

  log('RECONNECT', `[4006] guild=${guildId} — starting rejoin to channel=${channelId}`);

  try {
    // Step 1: Re-send OP4; collect fresh VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE
    const voiceState = await joinVoiceChannel(guildId, channelId);
    log('RECONNECT', `[4006] guild=${guildId} — got fresh voice state: session=${voiceState.sessionId} endpoint=${voiceState.endpoint}`);

    // Strip port from endpoint (Lavalink v4 wants bare hostname)
    let endpoint = voiceState.endpoint || '';
    if (endpoint.includes(':')) endpoint = endpoint.split(':')[0];

    // Step 2: Re-PATCH Lavalink player with new voice credentials (no track change)
    const playerPath = `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=true`;
    const patchBody = {
      voice: {
        token: voiceState.token,
        endpoint: endpoint,
        sessionId: voiceState.sessionId,
      },
    };
    log('RECONNECT', `[4006] guild=${guildId} — PATCHing Lavalink: token=${voiceState.token?.substring(0, 8)}... endpoint=${endpoint}`);
    const patchRes = await lavalinkREST('PATCH', playerPath, patchBody);

    if (patchRes.status === 200 || patchRes.status === 204) {
      log('RECONNECT', `[4006] guild=${guildId} ✅ Lavalink PATCH OK (HTTP ${patchRes.status}) — voice restored`);
    } else {
      log('RECONNECT', `[4006] guild=${guildId} ❌ Lavalink PATCH failed: HTTP ${patchRes.status} — ${JSON.stringify(patchRes.body)}`);
    }
  } catch (err) {
    log('RECONNECT', `[4006] guild=${guildId} ❌ Rejoin failed: ${err.message}`);
  } finally {
    // Release debounce after 5s to allow future reconnects if needed
    setTimeout(() => reconnecting.delete(guildId), 5000);
  }
}

/**
 * Send OP 4 to leave a voice channel.
 */
function leaveVoiceChannel(guildId) {
  const guildShard = client.ws.shards.first();
  if (!guildShard) return;
  guildShard.send({
    op: 4,
    d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
  });
  voiceStates.delete(guildId);
  log('VOICE', `Left guild=${guildId}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Lavalink v4 WebSocket — session management
// ═══════════════════════════════════════════════════════════════════════════
function connectLavalink() {
  const url = `ws://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/websocket`;
  log('LAVALINK', `Connecting to ${url}... (resume key: ${RESUME_KEY})`);

  lavalinkWs = new WebSocket(url, {
    headers: {
      'Authorization': LAVALINK_PASS,
      'User-Id': BOT_USER_ID,
      'Client-Name': 'RanaVoiceBridge/3.0',
      // Tell Lavalink we want to resume an existing session if it exists.
      // Lavalink will match this key and hand back the old sessionId + players.
      'Session-Resuming-Key': RESUME_KEY,
    },
  });

  lavalinkWs.on('open', () => {
    log('LAVALINK', 'WebSocket connected.');

    // ── Keepalive ping every 30s to prevent 1006 idle drops ────────────────
    // WS 1006 = abnormal closure, most often caused by the OS/router silently
    // killing an idle TCP connection. Sending a ping frame keeps it alive.
    if (lavalinkPingTimer) clearInterval(lavalinkPingTimer);
    lavalinkPingTimer = setInterval(() => {
      if (lavalinkWs && lavalinkWs.readyState === WebSocket.OPEN) {
        lavalinkWs.ping();
        log('LAVALINK', '[PING] keepalive sent');
      }
    }, 30_000);
  });

  lavalinkWs.on('pong', () => {
    log('LAVALINK', '[PONG] keepalive ack received');
  });

  lavalinkWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.op === 'ready') {
        const resumed = msg.resumed === true;
        lavalinkSessionId = msg.sessionId;
        reconnectDelay = 5000; // reset backoff on successful connect
        log('LAVALINK', `✅ Session ${resumed ? 'RESUMED' : 'established'}: ${lavalinkSessionId}`);

        // Register our resume key with this session so future reconnects
        // can reclaim it (Lavalink v4 PATCH /v4/sessions/:id)
        lavalinkREST('PATCH', `/v4/sessions/${lavalinkSessionId}`, {
          resuming: true,
          timeout: 60,   // seconds Lavalink waits for us to reconnect
        }).then(r => {
          log('LAVALINK', `[RESUME] Session resuming registered (HTTP ${r.status})`);
        }).catch(e => {
          log('LAVALINK', `[RESUME] Failed to register resuming: ${e.message}`);
        });

      } else if (msg.op === 'event') {
        const guild = msg.guildId;
        if (msg.type === 'WebSocketClosedEvent') {
          log('LAVALINK', `⚠️  WebSocketClosed guild=${guild} code=${msg.code} reason="${msg.reason}" byRemote=${msg.byRemote}`);
          if (msg.code === 4014) {
            // Discord forcibly removed the bot — clear state, wait for next play
            voiceStates.delete(guild);
            guildChannels.delete(guild);
            log('LAVALINK', `[RESET] 4014: Voice state cleared for guild=${guild}`);
          } else if (msg.code === 4006) {
            // Session invalidated — actively reconnect without user intervention
            log('LAVALINK', `[4006] Triggering automatic voice reconnect for guild=${guild}...`);
            handle4006Reconnect(guild).catch(() => { }); // fire-and-forget, errors logged inside
          }
        } else if (msg.type === 'TrackStartEvent') {
          log('LAVALINK', `▶️  TrackStart guild=${guild} track=${msg.track?.info?.title?.substring(0, 50) || '?'}`);
        } else if (msg.type === 'TrackEndEvent') {
          log('LAVALINK', `⏹  TrackEnd guild=${guild} reason=${msg.reason}`);
        } else {
          log('LAVALINK', `[EVENT] ${msg.type} guild=${guild}`);
        }
      }
    } catch (e) {
      log('LAVALINK', `Parse error: ${e.message}`);
    }
  });

  lavalinkWs.on('close', (code) => {
    // Stop the keepalive ping — socket is gone
    if (lavalinkPingTimer) {
      clearInterval(lavalinkPingTimer);
      lavalinkPingTimer = null;
    }
    lavalinkSessionId = null;

    if (code === 1006) {
      log('LAVALINK', `⚠️  Disconnected with 1006 (abnormal closure — likely idle timeout or network drop).`);
      log('LAVALINK', `    Reconnecting in ${reconnectDelay / 1000}s... (session will be resumed automatically)`);
    } else {
      log('LAVALINK', `Disconnected (code=${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    }

    // Exponential backoff: 5s → 10s → 20s → 40s, capped at 60s
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    setTimeout(connectLavalink, delay);
  });

  lavalinkWs.on('error', (err) => {
    // 'error' always fires just before 'close' on abnormal drops — log only
    log('LAVALINK', `WS Error: ${err.message}`);
  });
}

// ── Lavalink REST helper ────────────────────────────────────────────────────
function lavalinkREST(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: LAVALINK_HOST,
      port: LAVALINK_PORT,
      path: path,
      method: method,
      headers: {
        'Authorization': LAVALINK_PASS,
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Full play flow (proven working 2026-04-27):
 *  1. Join VC via discord.js OP4 (captures real token/endpoint/sessionId)
 *  2. loadtracks with the yt-dlp stream URL → get encoded track object
 *  3. PATCH player with encoded track + voice state → HTTP 200 + TrackStartEvent
 *
 * NOTE: loadtracks with the googlevideo stream URL returns loadType=track (works).
 * loadtracks with the original YouTube URL returns loadType=error (broken).
 * LIVE.py always sends the extracted stream URL, so this path works.
 */
async function lavalinkPlay(guildId, channelId, streamUrl, title) {
  if (!lavalinkSessionId) throw new Error('Lavalink session not established. Is Lavalink running?');
  if (!discordReady) throw new Error('Discord bot not ready yet.');

  // Step 1: Join the voice channel
  log('PLAY', `[START] guild=${guildId} channel=${channelId} title="${title || '?'}"`);
  const voiceState = await joinVoiceChannel(guildId, channelId);
  log('PLAY', `[VOICE] token=${voiceState.token?.substring(0, 8)}... endpoint=${voiceState.endpoint} session=${voiceState.sessionId}`);

  // Discord sends endpoint as "hostname:port" — Lavalink v4 wants just the hostname
  let endpoint = voiceState.endpoint || '';
  if (endpoint.includes(':')) endpoint = endpoint.split(':')[0];

  // Step 2: loadtracks with the yt-dlp stream URL
  // Lavalink's http source handles raw googlevideo URLs and returns loadType=track
  log('LAVALINK', `[LOAD] stream_url=${streamUrl.substring(0, 80)}...`);
  const loadRes = await lavalinkREST('GET',
    `/v4/loadtracks?identifier=${encodeURIComponent(streamUrl)}`
  );
  log('LAVALINK', `[LOAD] HTTP ${loadRes.status} loadType=${loadRes.body?.loadType}`);

  // Build track object: prefer encoded (Lavalink decoded), fall back to raw identifier
  let trackObj;
  if (loadRes.status === 200 && loadRes.body) {
    const lt = loadRes.body.loadType;
    if (lt === 'track' || lt === 'TRACK_LOADED') {
      const td = loadRes.body.data || (loadRes.body.tracks || [])[0];
      if (td && td.encoded) {
        trackObj = { encoded: td.encoded };
        log('LAVALINK', `[LOAD] Got encoded track ✅`);
      }
    }
  }
  if (!trackObj) {
    // Fallback: pass raw URL as identifier — Lavalink http source will try to play it
    trackObj = { identifier: streamUrl };
    log('LAVALINK', `[LOAD] loadtracks failed (${loadRes.body?.loadType}), using raw identifier fallback`);
  }

  // Step 3: Combined PATCH — track + voice in ONE request (proven working 2026-04-27)
  // Lavalink requires a track to be present when creating a new player.
  // Lavalink v4.2.2 REQUIRES channelId in the voice object (new field vs older versions).
  const playerPath = `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=false`;
  const combinedPatch = {
    track: trackObj,
    voice: {
      token: voiceState.token,
      endpoint: endpoint,
      sessionId: voiceState.sessionId,
      channelId: channelId,           // ← Required by Lavalink v4.2.2
    },
  };
  log('LAVALINK', `[PATCH] ${playerPath}`);
  log('LAVALINK', `[PATCH] token=${voiceState.token?.substring(0, 8)}... endpoint=${endpoint} session=${voiceState.sessionId} channel=${channelId}`);

  log('LAVALINK', `[PATCH] Payload: ${JSON.stringify(combinedPatch).substring(0, 120)}...`);

  const playRes = await lavalinkREST('PATCH', playerPath, combinedPatch);
  if (playRes.status === 200 || playRes.status === 204) {
    log('LAVALINK', `[PATCH] ✅ HTTP ${playRes.status} — playback started`);
  } else {
    log('LAVALINK', `[PATCH] ❌ HTTP ${playRes.status}: ${JSON.stringify(playRes.body)}`);
  }
  return playRes;
}




// ═══════════════════════════════════════════════════════════════════════════
// HTTP Server — port 8081 — LIVE.py calls this
// ═══════════════════════════════════════════════════════════════════════════
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const respond = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── GET /health ───────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    return respond(200, {
      service: 'voice_bridge',
      version: '3.0',
      discord: discordReady ? 'online' : 'offline',
      lavalink_session: lavalinkSessionId || 'none',
      guilds: discordReady ? client.guilds.cache.size : 0,
    });
  }

  // ── GET /guilds — lists all guilds + channels the bot can see ─
  if (req.method === 'GET' && req.url === '/guilds') {
    if (!discordReady) return respond(503, { error: 'Discord not ready' });
    const guilds = [...client.guilds.cache.values()].map(g => ({
      guild_id: g.id,
      guild_name: g.name,
      voice_channels: [...g.channels.cache.values()]
        .filter(c => c.type === 2) // 2 = GUILD_VOICE
        .map(c => ({ channel_id: c.id, channel_name: c.name, members: c.members.size })),
    }));
    return respond(200, { guilds });
  }


  // ── GET /init — used by LIVE.py on startup ────────────────
  if (req.method === 'GET' && req.url === '/init') {
    if (!lavalinkSessionId) {
      return respond(503, { status: 'initializing', message: 'Lavalink session not established yet' });
    }
    return respond(200, {
      status: 'ready',
      discord: discordReady ? 'online' : 'offline',
      lavalink_session: lavalinkSessionId,
    });
  }

  // ── POST /voice/play ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/voice/play') {
    const body = await parseBody(req);
    const { guild_id, channel_id, stream_url, title } = body;

    if (!guild_id || !channel_id || !stream_url) {
      return respond(400, { error: 'Missing guild_id, channel_id, or stream_url' });
    }
    if (!lavalinkSessionId) {
      return respond(503, { error: 'Lavalink session not established. Is Lavalink running?' });
    }
    if (!discordReady) {
      return respond(503, { error: 'Discord bot not ready yet.' });
    }

    try {
      const result = await lavalinkPlay(guild_id, channel_id, stream_url, title);
      if (result.status === 200 || result.status === 204) {
        log('PLAY', `✅ SUCCESS: "${title}"`);
        return respond(200, {
          status: 'playing',
          guild_id,
          title: title || 'Unknown',
          session: lavalinkSessionId,
        });
      } else {
        log('PLAY', `❌ LAVALINK_ERROR ${result.status}: ${JSON.stringify(result.body)}`);
        return respond(500, { status: 'error', message: `Lavalink ${result.status}`, detail: result.body });
      }
    } catch (err) {
      log('PLAY', `❌ ERROR: ${err.message}`);
      return respond(500, { status: 'error', message: err.message });
    }
  }

  // ── POST /voice/leave ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/voice/leave') {
    const body = await parseBody(req);
    leaveVoiceChannel(body.guild_id);
    return respond(200, { status: 'left', guild_id: body.guild_id });
  }

  respond(404, { error: 'Not found' });
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
log('BOOT', 'Rana Voice Bridge v3.0 starting...');
log('BOOT', `Lavalink: ${LAVALINK_HOST}:${LAVALINK_PORT}`);
log('BOOT', `Bridge port: ${BRIDGE_PORT}`);

// Connect Lavalink WS first (fast)
connectLavalink();

// Login Discord bot
client.login(DISCORD_TOKEN).catch((err) => {
  log('DISCORD', `❌ Login failed: ${err.message}`);
  log('DISCORD', 'Shutting down gracefully...');
  // Close Lavalink WS before exit to avoid UV_HANDLE_CLOSING crash
  if (lavalinkWs) {
    try { lavalinkWs.terminate(); } catch (_) { }
  }
  server.close(() => process.exit(1));
});

// Start HTTP server
server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  log('BRIDGE', `HTTP API on http://127.0.0.1:${BRIDGE_PORT}`);
  log('BRIDGE', `  GET  /health`);
  log('BRIDGE', `  GET  /init`);
  log('BRIDGE', `  POST /voice/play   { guild_id, channel_id, stream_url, title }`);
  log('BRIDGE', `  POST /voice/leave  { guild_id }`);
});
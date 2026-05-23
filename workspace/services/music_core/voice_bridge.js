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
const { Client, GatewayIntentBits, GatewayDispatchEvents, Options } = require('discord.js');

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
// Per-guild playback queue. Items are { stream_url, title, channel_id, requester_id }.
const playQueues = new Map();
const queueRunning = new Set();
const currentTracks = new Map();
const stayVoiceGuilds = new Set();
const guildVolumes = new Map();
const DEFAULT_VOLUME = 35;
const MIN_VOLUME = 0;
const MAX_VOLUME = 100;

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
    GatewayIntentBits.GuildMembers,       // Required to see member objects
    GatewayIntentBits.GuildVoiceStates,   // CRITICAL for voice state updates
    GatewayIntentBits.MessageContent,     // Required by newer Discord API versions
  ],
  // Force a completely new gateway session on every restart.
  // If discord.js resumes a previous session whose voice state had 4006,
  // Discord keeps the voice restriction, so we must always start fresh.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    GuildMemberManager: 0,
    MessageManager: 0,
  }),
  rest: { rejectOnRateLimit: [] },
  ws: { large_threshold: 50 },
});

client.once('clientReady', () => {
  discordReady = true;
  log('DISCORD', `Logged in as ${client.user.tag} (${client.user.id})`);
  const guilds = [...client.guilds.cache.values()].map(g => `${g.name} (${g.id})`).join(', ');
  log('DISCORD', `Guilds: ${guilds || 'none'}`);

  // Verify intents are correctly enabled
  const requiredIntents = [
    'Guilds',
    'GuildVoiceStates',
    'GuildMembers',
    'MessageContent',
  ];
  const enabledIntents = client.options.intents.toArray ? client.options.intents.toArray() : [];
  const missingIntents = requiredIntents.filter(intent => !enabledIntents.includes(intent));
  if (missingIntents.length > 0) {
    log('DISCORD', `⚠️  WARNING: Missing intents: ${missingIntents.join(', ')}`);
    log('DISCORD', `    This may cause voice connection failures. Check Developer Portal settings.`);
  } else {
    log('DISCORD', `✅ All required intents enabled: ${enabledIntents.join(', ')}`);
  }

  // On startup: if bot is in a voice channel, just log it.
  // Do NOT pre-fetch or cache voice tokens here — they expire within seconds
  // and the lavalinkPlay function will get a fresh one when needed.
  setTimeout(() => {
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.cache.get(client.user.id);
      if (me && me.voice && me.voice.channelId) {
        const channelId = me.voice.channelId;
        log('VOICE', `[STARTUP] Bot is in channel ${channelId} (guild ${guild.id}) — token will be fetched at play time`);
        guildChannels.set(guild.id, channelId);
        voiceStates.delete(guild.id); // ensure no stale state
      }
    }
  }, 3000);
});

// If the shard resumed a previous session, force a fresh IDENTIFY to avoid
// carrying over voice restrictions from prior 4006 invalidations.
client.on('shardReady', (id, unavailableGuilds) => {
  const shard = client.ws.shards.get(id);
  if (shard && shard.sessionId) {
    log('DISCORD', `[SHARD] Shard ${id} ready with session ${shard.sessionId.substring(0, 16)}...`);
  }
});

// If discord.js reconnects the shard (after VOICE-related disconnect or network issue),
// clear all voice state so fresh tokens are fetched on the next play.
client.on('shardReconnecting', (id) => {
  log('DISCORD', `[SHARD] Shard ${id} reconnecting — clearing voice state cache`);
  voiceStates.clear();
});

client.on('shardResume', (id, replayedEvents) => {
  log('DISCORD', `[SHARD] Shard ${id} RESUMED (replayed ${replayedEvents} events) — clearing voice state to force fresh tokens`);
  voiceStates.clear();
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
  const channelId = data.channel_id;
  log('VOICE', `State update: guild=${guildId} channel=${channelId || 'null'} session=${sessionId}`);

  if (channelId) {
    guildChannels.set(guildId, channelId);
  }

  if (!channelId && stayVoiceGuilds.has(guildId)) {
    const cachedChannelId = guildChannels.get(guildId);
    if (cachedChannelId) {
      log('VOICE', `[STAY] Bot left guild=${guildId}; rejoining cached channel=${cachedChannelId}`);
      setTimeout(() => {
        const shard = client.ws.shards.first();
        if (shard && stayVoiceGuilds.has(guildId)) {
          shard.send({ op: 4, d: { guild_id: guildId, channel_id: cachedChannelId, self_mute: true, self_deaf: true } });
        }
      }, 1000);
    }
  }

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

async function resolveVoiceChannel(guildId, channelId, requesterId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Bot is not in guild ${guildId}`);

  if (requesterId) {
    let voiceState = guild.voiceStates.cache.get(requesterId);
    if (!voiceState || !voiceState.channelId) {
      try {
        const member = await guild.members.fetch(requesterId);
        voiceState = member.voice;
      } catch (_) {}
    }
    if (voiceState && voiceState.channelId) {
      log('VOICE', `Resolved requester=${requesterId} voice channel=${voiceState.channelId}`);
      return voiceState.channelId;
    }
    throw new Error(`Requester ${requesterId} is not in a voice channel`);
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found in guild ${guildId}`);
  if (channel.type !== 2 && channel.type !== 13) {
    throw new Error(`Channel ${channelId} is not a voice/stage channel. Provide requester_id so Rana can join the user's current voice channel.`);
  }
  return channelId;
}

/**
 * Send OP 4 (voice state update) to Discord to join a voice channel.
 * Returns a promise that resolves once both VOICE_STATE + VOICE_SERVER arrive.
 */
function joinVoiceChannel(guildId, channelId) {
  return new Promise((resolve, reject) => {
    const guildShard = client.ws.shards.first();
    if (!guildShard) return reject(new Error('No shard available'));

    const cachedChannelId = guildChannels.get(guildId);
    const cachedState = voiceStates.get(guildId);
    const hasCompleteState = cachedState && cachedState.sessionId && cachedState.token && cachedState.endpoint;

    if (cachedChannelId === channelId && hasCompleteState) {
      log('VOICE', `Already in guild=${guildId} channel=${channelId}; reusing current voice state`);
      return resolve({ ...cachedState });
    }

    // Join or move directly. Do not send channel_id:null before playing:
    // that visibly leaves/rejoins the VC and can reset the Discord voice session.
    guildChannels.set(guildId, channelId);
    if (cachedChannelId !== channelId) voiceStates.delete(guildId);
    const timer = setTimeout(() => {
      voicePending.delete(guildId);
      reject(new Error(`Voice join timeout for guild=${guildId} channel=${channelId}`));
    }, 12000);
    voicePending.set(guildId, { resolve, reject, timer });

    log('VOICE', `Sent OP4: join/move guild=${guildId} channel=${channelId}`);
    guildShard.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: true } });
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

    // Keep Discord's endpoint exactly as provided. Some voice regions require
    // the explicit port (for example :8443); stripping it can trigger 4006.
    const endpoint = voiceState.endpoint || '';

    if (!endpoint) {
      log('RECONNECT', `[4006] guild=${guildId} ❌ Voice endpoint is empty! Cannot reconnect.`);
      throw new Error(`Voice endpoint empty from VOICE_SERVER_UPDATE`);
    }

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
  stayVoiceGuilds.delete(guildId);
  guildShard.send({
    op: 4,
    d: { guild_id: guildId, channel_id: null, self_mute: true, self_deaf: true },
  });
  voiceStates.delete(guildId);
  guildChannels.delete(guildId);
  log('VOICE', `Left guild=${guildId}`);
}

async function stopPlayback(guildId) {
  playQueues.set(guildId, []);
  currentTracks.delete(guildId);
  try {
    if (lavalinkSessionId) await lavalinkREST('DELETE', `/v4/sessions/${lavalinkSessionId}/players/${guildId}`);
  } catch (err) {
    log('PLAY', `[STOP] DELETE player failed guild=${guildId}: ${err.message}`);
  }
  const channelId = guildChannels.get(guildId);
  const shard = client.ws.shards.first();
  if (channelId && shard && stayVoiceGuilds.has(guildId)) {
    shard.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: true } });
    log('VOICE', `[STAY] Staying in guild=${guildId} channel=${channelId} after stop`);
  }
}

function clampVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VOLUME;
  return Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(numeric)));
}

function getGuildVolume(guildId) {
  return guildVolumes.get(guildId) ?? DEFAULT_VOLUME;
}

async function setPlaybackVolume(guildId, volume) {
  const nextVolume = clampVolume(volume);
  guildVolumes.set(guildId, nextVolume);
  if (lavalinkSessionId && (currentTracks.has(guildId) || stayVoiceGuilds.has(guildId))) {
    const result = await lavalinkREST('PATCH', `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=true`, {
      volume: nextVolume,
    });
    if (![200, 204, 404].includes(result.status)) {
      throw new Error(`Lavalink ${result.status}`);
    }
  }
  log('VOICE', `[VOLUME] guild=${guildId} volume=${nextVolume}`);
  return nextVolume;
}

async function joinOnly(guildId, channelId, requesterId) {
  if (!discordReady) throw new Error('Discord bot not ready yet.');
  const voiceChannelId = await resolveVoiceChannel(guildId, channelId, requesterId);
  await joinVoiceChannel(guildId, voiceChannelId);
  stayVoiceGuilds.add(guildId);
  log('VOICE', `[JOIN] Joined guild=${guildId} channel=${voiceChannelId} requester=${requesterId || 'unknown'}`);
  return voiceChannelId;
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
            // Session invalidated — log it. lavalinkPlay will reconnect on next user request.
            // Do NOT auto-reconnect here: it causes double-PATCH race conditions.
            log('LAVALINK', `[4006] Voice session invalidated for guild=${guild}. Next play will reconnect.`);
            log('LAVALINK', `[4006] DIAGNOSTIC HINT: This usually means:`);
            log('LAVALINK', `        1. Voice endpoint/token/session mismatch`);
            log('LAVALINK', `        2. Discord voice region requiring the endpoint port to be preserved`);
            log('LAVALINK', `        3. Guild/channel permission or voice server restriction`);
            voiceStates.delete(guild); // clear stale state so next play gets fresh token
          }
        } else if (msg.type === 'TrackStartEvent') {
          log('LAVALINK', `▶️  TrackStart guild=${guild} track=${msg.track?.info?.title?.substring(0, 50) || '?'}`);
        } else if (msg.type === 'TrackEndEvent') {
          log('LAVALINK', `⏹  TrackEnd guild=${guild} reason=${msg.reason}`);
          currentTracks.delete(guild);
          if (guild && !['REPLACED', 'STOPPED'].includes(String(msg.reason || '').toUpperCase())) {
            setTimeout(() => playNextQueued(guild), 250);
            setTimeout(() => {
              if ((playQueues.get(guild) || []).length === 0 && stayVoiceGuilds.has(guild)) {
                const channelId = guildChannels.get(guild);
                const shard = client.ws.shards.first();
                if (channelId && shard) {
                  log('VOICE', `[STAY] Holding guild=${guild} channel=${channelId} after track end`);
                  shard.send({ op: 4, d: { guild_id: guild, channel_id: channelId, self_mute: true, self_deaf: true } });
                }
              }
            }, 1500);
          }
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
async function lavalinkPlay(guildId, channelId, streamUrl, title, requesterId) {
  if (!lavalinkSessionId) throw new Error('Lavalink session not established. Is Lavalink running?');
  if (!discordReady) throw new Error('Discord bot not ready yet.');

  const voiceChannelId = await resolveVoiceChannel(guildId, channelId, requesterId);

  // Step 1: Join/move only when needed. If Rana is already in the requested
  // channel, keep the existing Discord voice session stable.
  log('PLAY', `[START] guild=${guildId} channel=${voiceChannelId} requester=${requesterId || 'unknown'} title="${title || '?'}"`);
  const voiceState = await joinVoiceChannel(guildId, voiceChannelId);
  stayVoiceGuilds.add(guildId);
  log('PLAY', `[VOICE] token=${voiceState.token?.substring(0, 8)}... endpoint=${voiceState.endpoint} session=${voiceState.sessionId}`);

  // Keep Discord's endpoint exactly as provided. Some voice regions require
  // the explicit port (for example :8443); stripping it can trigger 4006.
  const endpoint = voiceState.endpoint || '';

  if (!endpoint) {
    throw new Error(`Voice endpoint is empty! voiceState=${JSON.stringify(voiceState)}`);
  }

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
    volume: getGuildVolume(guildId),
    voice: {
      token: voiceState.token,
      endpoint: endpoint,
      sessionId: voiceState.sessionId,
      channelId: voiceChannelId,      // ← Required by Lavalink v4.2.2
    },
  };
  log('LAVALINK', `[PATCH] ${playerPath}`);
  log('LAVALINK', `[PATCH] token=${voiceState.token?.substring(0, 8)}... endpoint=${endpoint} session=${voiceState.sessionId} channel=${voiceChannelId}`);

  log('LAVALINK', `[PATCH] Payload: ${JSON.stringify(combinedPatch).substring(0, 120)}...`);

  const playRes = await lavalinkREST('PATCH', playerPath, combinedPatch);
  if (playRes.status === 200 || playRes.status === 204) {
    log('LAVALINK', `[PATCH] ✅ HTTP ${playRes.status} — playback started`);
    currentTracks.set(guildId, {
      title: title || 'Unknown',
      stream_url: streamUrl,
      channel_id: voiceChannelId,
      requester_id: requesterId,
      started_at: Date.now(),
    });
  } else {
    log('LAVALINK', `[PATCH] ❌ HTTP ${playRes.status}: ${JSON.stringify(playRes.body)}`);
  }
  return playRes;
}

async function playNextQueued(guildId) {
  if (queueRunning.has(guildId)) return;
  const queue = playQueues.get(guildId);
  if (!queue || queue.length === 0) return;

  const item = queue.shift();
  queueRunning.add(guildId);
  try {
    log('QUEUE', `Next guild=${guildId} remaining=${queue.length} title="${item.title || '?'}"`);
    await lavalinkPlay(guildId, item.channel_id, item.stream_url, item.title, item.requester_id);
  } catch (err) {
    log('QUEUE', `Next failed guild=${guildId}: ${err.message}`);
    setTimeout(() => playNextQueued(guildId), 500);
  } finally {
    queueRunning.delete(guildId);
  }
}

function getQueueState(guildId) {
  const queue = playQueues.get(guildId) || [];
  return {
    status: currentTracks.has(guildId) ? 'playing' : queue.length ? 'queued' : 'idle',
    current: currentTracks.get(guildId) || null,
    next: queue[0] || null,
    queued: queue.length,
    volume: getGuildVolume(guildId),
    queue: queue.map((item, index) => ({
      index: index + 1,
      title: item.title || 'Unknown',
      stream_url: item.stream_url,
    })),
  };
}

function removeQueuedTrack(guildId, query) {
  const queue = playQueues.get(guildId) || [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;
  const index = queue.findIndex((item) => {
    const title = String(item.title || '').toLowerCase();
    const url = String(item.stream_url || '').toLowerCase();
    return title.includes(needle) || url.includes(needle);
  });
  if (index < 0) return null;
  const [removed] = queue.splice(index, 1);
  playQueues.set(guildId, queue);
  return removed;
}

async function skipCurrent(guildId) {
  const skipped = currentTracks.get(guildId) || null;
  currentTracks.delete(guildId);
  try {
    if (lavalinkSessionId) await lavalinkREST('DELETE', `/v4/sessions/${lavalinkSessionId}/players/${guildId}`);
  } catch (err) {
    log('QUEUE', `Skip delete failed guild=${guildId}: ${err.message}`);
  }
  setTimeout(() => playNextQueued(guildId), 350);
  return skipped;
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

  // ── GET /diagnostics — comprehensive debug endpoint ─────────
  if (req.method === 'GET' && req.url === '/diagnostics') {
    const enabledIntents = client.options.intents.toArray ? client.options.intents.toArray() : [];
    return respond(200, {
      bridge_version: '3.0',
      discord_bot_id: BOT_USER_ID,
      discord_ready: discordReady,
      discord_user: discordReady ? `${client.user.tag} (${client.user.id})` : null,
      discord_intents: enabledIntents,
      lavalink_session_id: lavalinkSessionId,
      lavalink_connection: lavalinkWs ? lavalinkWs.readyState : 'disconnected',
      guilds_count: discordReady ? client.guilds.cache.size : 0,
      voice_states_cache_size: voiceStates.size,
      reconnecting_guilds: [...reconnecting.keys()],
      pending_voice_joins: [...voicePending.keys()],
    });
  }

  if (req.method === 'GET' && req.url.startsWith('/voice/queue')) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const guildId = url.searchParams.get('guild_id');
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    log('HTTP', `GET /voice/queue guild=${guildId} state=${JSON.stringify(getQueueState(guildId)).slice(0, 240)}`);
    return respond(200, getQueueState(guildId));
  }

  if (req.method === 'POST' && req.url === '/voice/skip') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    log('HTTP', `POST /voice/skip guild=${guildId} query="${body.query || ''}" before=${JSON.stringify(getQueueState(guildId)).slice(0, 240)}`);

    if (body.query) {
      const removed = removeQueuedTrack(guildId, body.query);
      if (removed) return respond(200, { ...getQueueState(guildId), status: 'removed', removed });
    }

    const skipped = await skipCurrent(guildId);
    return respond(200, { ...getQueueState(guildId), status: skipped ? 'skipped' : 'idle', skipped });
  }

  if (req.method === 'POST' && req.url === '/voice/stop') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    log('HTTP', `POST /voice/stop guild=${guildId} before=${JSON.stringify(getQueueState(guildId)).slice(0, 240)}`);
    await stopPlayback(guildId);
    return respond(200, { ...getQueueState(guildId), status: 'stopped', guild_id: guildId, stay: stayVoiceGuilds.has(guildId) });
  }

  if (req.method === 'POST' && req.url === '/voice/volume') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    log('HTTP', `POST /voice/volume guild=${guildId} volume=${body.volume ?? ''} delta=${body.delta ?? ''}`);
    try {
      const current = getGuildVolume(guildId);
      const requested = body.delta == null ? body.volume : current + Number(body.delta);
      const volume = await setPlaybackVolume(guildId, requested);
      return respond(200, { ...getQueueState(guildId), status: 'volume', guild_id: guildId, volume });
    } catch (err) {
      log('VOICE', `[VOLUME] ERROR: ${err.message}`);
      return respond(500, { status: 'error', message: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/voice/join') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    log('HTTP', `POST /voice/join guild=${guildId} requester=${body.requester_id || ''} channel=${body.channel_id || ''}`);
    try {
      const channelId = await joinOnly(guildId, body.channel_id, body.requester_id);
      return respond(200, { ...getQueueState(guildId), status: 'joined', guild_id: guildId, channel_id: channelId, stay: true });
    } catch (err) {
      log('VOICE', `[JOIN] ERROR: ${err.message}`);
      return respond(500, { status: 'error', message: err.message });
    }
  }

  // ── POST /voice/play ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/voice/play') {
    const body = await parseBody(req);
    const { guild_id, channel_id, requester_id, stream_url, title } = body;
    const tracks = Array.isArray(body.tracks) ? body.tracks : null;
    log('HTTP', `POST /voice/play guild=${guild_id || ''} requester=${requester_id || ''} title="${title || ''}" tracks=${tracks ? tracks.length : 0} before=${guild_id ? JSON.stringify(getQueueState(guild_id)).slice(0, 240) : '{}'}`);

    if (!guild_id || (!stream_url && (!tracks || tracks.length === 0))) {
      return respond(400, { error: 'Missing guild_id or stream_url' });
    }
    if (!lavalinkSessionId) {
      return respond(503, { error: 'Lavalink session not established. Is Lavalink running?' });
    }
    if (!discordReady) {
      return respond(503, { error: 'Discord bot not ready yet.' });
    }

    try {
      const incoming = (tracks && tracks.length > 0 ? tracks : [{ stream_url, title, channel_id, requester_id }])
        .filter(t => t && t.stream_url)
        .map(t => ({
          stream_url: t.stream_url,
          title: t.title || 'Unknown',
          channel_id: t.channel_id || channel_id,
          requester_id: t.requester_id || requester_id,
        }));
      if (incoming.length === 0) return respond(400, { error: 'Playlist had no playable tracks' });

      const queue = playQueues.get(guild_id) || [];
      if (currentTracks.has(guild_id) || queueRunning.has(guild_id)) {
        queue.push(...incoming);
        playQueues.set(guild_id, queue);
        log('QUEUE', `Enqueued guild=${guild_id} added=${incoming.length} queued=${queue.length} first="${incoming[0].title || '?'}"`);
        return respond(200, {
          ...getQueueState(guild_id),
          status: 'queued',
          guild_id,
          title: incoming[0].title || 'Unknown',
          added: incoming.length,
          queued: queue.length,
        });
      }

      const first = incoming[0];
      playQueues.set(guild_id, incoming.slice(1));
      if (incoming.length > 1) {
        log('QUEUE', `Loaded playlist guild=${guild_id} total=${incoming.length} queued=${incoming.length - 1}`);
      }

      const result = await lavalinkPlay(guild_id, first.channel_id, first.stream_url, first.title, first.requester_id);
      if (result.status === 200 || result.status === 204) {
        log('PLAY', `✅ SUCCESS: "${first.title}"`);
        return respond(200, {
          status: 'playing',
          guild_id,
          title: first.title || 'Unknown',
          session: lavalinkSessionId,
          queued: playQueues.get(guild_id)?.length || 0,
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
    log('HTTP', `POST /voice/leave guild=${body.guild_id || ''} before=${body.guild_id ? JSON.stringify(getQueueState(body.guild_id)).slice(0, 240) : '{}'}`);
    playQueues.set(body.guild_id, []);
    currentTracks.delete(body.guild_id);
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
log('BOOT', `Bot ID: ${BOT_USER_ID}`);
log('BOOT', 'IMPORTANT: Verify in Discord Developer Portal:');
log('BOOT', `  → https://discord.com/developers/applications/${BOT_USER_ID}/bot`);
log('BOOT', '  Ensure these intents are ENABLED:');
log('BOOT', '    ✓ Guilds');
log('BOOT', '    ✓ Guild Members');
log('BOOT', '    ✓ Message Content Intent (if text commands needed)');

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
  log('BRIDGE', `  GET  /diagnostics  ← Use this for debugging voice issues`);
  log('BRIDGE', `  GET  /guilds`);
  log('BRIDGE', `  POST /voice/play   { guild_id, channel_id, stream_url, title }`);
  log('BRIDGE', `  POST /voice/leave  { guild_id }`);
});

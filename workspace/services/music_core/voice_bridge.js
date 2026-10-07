/**
 * voice_bridge.js — Rana Voice Gateway Bridge v3.2.1
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
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GatewayDispatchEvents,
  ModalBuilder,
  Options,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { createVisionFeedbackStore, parseVisionFeedbackCustomId } = require('./vision_feedback');

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || '1202969643162013776';
const LAVALINK_HOST = process.env.LAVALINK_HOST || '127.0.0.1';
const LAVALINK_PORT = parseInt(process.env.LAVALINK_PORT || '2333');
const LAVALINK_PASS = process.env.LAVALINK_PASS || 'youshallnotpass';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8081');
const LIVE_RESOLVE_HOST = process.env.LIVE_RESOLVE_HOST || '127.0.0.1';
const LIVE_RESOLVE_PORT = parseInt(process.env.LIVE_RESOLVE_PORT || '8080');
const LIVE_RESOLVE_TIMEOUT_MS = parseInt(process.env.LIVE_RESOLVE_TIMEOUT_MS || '30000');
const STREAM_FRESH_MS = parseInt(process.env.STREAM_FRESH_MS || '60000');

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
let lavalinkResumeSessionId = null; // Lavalink v4 resume uses Session-Id header

// Per-guild voice state cache: guildId → { token, endpoint, sessionId }
const voiceStates = new Map();
// Pending voice join resolvers: guildId → { resolve, reject, timer }
const voicePending = new Map();
// Per-guild channel cache (needed for 4006 rejoin): guildId → channelId
const guildChannels = new Map();
// Debounce guard for 4006 reconnects: guildId → true
const reconnecting = new Map();
// Per-guild playback queue. Items may keep a stable source_url plus a short-lived stream_url.
const playQueues = new Map();
const queueRunning = new Set();
// Coalesce every automatic queue advance per guild. Track-end, skip, and
// recovery paths can otherwise schedule overlapping FIFO consumers and skip
// over the requested playlist order.
const queueAdvanceTimers = new Map();
const handledQueueInteractions = new Set();
const currentTracks = new Map();
const activePlayers = new Set();
const stayVoiceGuilds = new Set();
const queuePanels = new Map();
const guildVolumes = new Map();
const visionFeedbackStore = createVisionFeedbackStore();
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
        stayVoiceGuilds.add(guild.id);
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

client.on('interactionCreate', async (interaction) => {
  const customId = String(interaction.customId || '');
  if (interaction.isButton?.() && customId.startsWith('rana_queue|')) {
    await handleQueueButton(interaction);
    return;
  }
  if (interaction.isButton?.() && customId.startsWith('vf|')) {
    await handleVisionFeedbackButton(interaction);
    return;
  }
  if (interaction.isModalSubmit?.() && customId.startsWith('vfm|')) {
    await handleVisionFeedbackModal(interaction);
  }
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
    const needsFreshVoiceServer = cachedChannelId === channelId && !hasCompleteState;

    if (cachedChannelId === channelId && hasCompleteState) {
      log('VOICE', `Already in guild=${guildId} channel=${channelId}; reusing current voice state`);
      return resolve({ ...cachedState });
    }

    // Join or move directly. Normally we avoid channel_id:null because it is a
    // visible leave/rejoin. If Discord already has us in the target channel but
    // we lack VOICE_SERVER_UPDATE credentials, a fresh leave/join is the only
    // reliable way to make Discord emit a new token + endpoint.
    guildChannels.set(guildId, channelId);
    if (cachedChannelId !== channelId || needsFreshVoiceServer) voiceStates.delete(guildId);
    const timer = setTimeout(() => {
      voicePending.delete(guildId);
      reject(new Error(`Voice join timeout for guild=${guildId} channel=${channelId}`));
    }, 20000);
    voicePending.set(guildId, { resolve, reject, timer });

    if (needsFreshVoiceServer) {
      log('VOICE', `Missing voice server credentials for guild=${guildId}; forcing fresh voice handshake channel=${channelId}`);
      guildShard.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: true, self_deaf: true } });
      setTimeout(() => {
        log('VOICE', `Sent OP4: fresh join guild=${guildId} channel=${channelId}`);
        guildShard.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: true } });
      }, 800);
      return;
    }

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
    if (lavalinkSessionId && activePlayers.has(guildId) && stayVoiceGuilds.has(guildId)) {
      const result = await lavalinkREST('PATCH', `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=false`, {
        track: { encoded: null },
      });
      if (![200, 204, 404].includes(result.status)) {
        throw new Error(`Lavalink ${result.status}`);
      }
      log('PLAY', `[STOP] Cleared track but kept player/voice guild=${guildId}`);
    } else if (lavalinkSessionId) {
      await lavalinkREST('DELETE', `/v4/sessions/${lavalinkSessionId}/players/${guildId}`);
      activePlayers.delete(guildId);
    }
  } catch (err) {
    log('PLAY', `[STOP] clear player failed guild=${guildId}: ${err.message}`);
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
  const requestedResumeSessionId = lavalinkResumeSessionId;
  const headers = {
    'Authorization': LAVALINK_PASS,
    'User-Id': BOT_USER_ID,
    'Client-Name': 'RanaVoiceBridge/3.1',
  };
  // Lavalink v4 resumes by Session-Id, not the removed Resume-Key mechanism.
  if (requestedResumeSessionId) headers['Session-Id'] = requestedResumeSessionId;
  log('LAVALINK', `Connecting to ${url}... resumeSession=${requestedResumeSessionId || 'none'}`);

  lavalinkWs = new WebSocket(url, { headers });

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
        lavalinkResumeSessionId = msg.sessionId;
        reconnectDelay = 5000; // reset backoff on successful connect
        log('LAVALINK', `✅ Session ${resumed ? 'RESUMED' : 'established'}: ${lavalinkSessionId}`);

        if (requestedResumeSessionId && !resumed) {
          // The old session could not be resumed; local playback state must not
          // pretend those players still exist in the new Lavalink session.
          activePlayers.clear();
          currentTracks.clear();
          log('LAVALINK', `[RESUME] Requested ${requestedResumeSessionId} but server created a new session; cleared stale local player state.`);
        }

        // Enable resuming for this v4 session so the Session-Id handshake can reclaim it.
        lavalinkREST('PATCH', `/v4/sessions/${lavalinkSessionId}`, {
          resuming: true,
          timeout: 60,   // seconds Lavalink waits for us to reconnect
        }).then(r => {
          log('LAVALINK', `[RESUME] Session resuming registered (HTTP ${r.status})`);
        }).catch(e => {
          log('LAVALINK', `[RESUME] Failed to register resuming: ${e.message}`);
        });
        syncActivePlayers().catch(e => {
          log('LAVALINK', `[SYNC] Failed to sync players: ${e.message}`);
        });

      } else if (msg.op === 'event') {
        const guild = msg.guildId;
        if (msg.type === 'WebSocketClosedEvent') {
          log('LAVALINK', `⚠️  WebSocketClosed guild=${guild} code=${msg.code} reason="${msg.reason}" byRemote=${msg.byRemote}`);
          if (msg.code === 4014) {
            // Discord forcibly removed the bot — clear state, wait for next play
            voiceStates.delete(guild);
            guildChannels.delete(guild);
            activePlayers.delete(guild);
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
          activePlayers.add(guild);
        } else if (msg.type === 'TrackEndEvent') {
          log('LAVALINK', `⏹  TrackEnd guild=${guild} reason=${msg.reason}`);
          currentTracks.delete(guild);
          if (String(msg.reason || '').toUpperCase() !== 'REPLACED') {
            activePlayers.delete(guild);
          }
          if (guild && !['REPLACED', 'STOPPED'].includes(String(msg.reason || '').toUpperCase())) {
            scheduleNextQueued(guild, 250, `track-end:${msg.reason || 'unknown'}`);
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
    if (lavalinkSessionId) lavalinkResumeSessionId = lavalinkSessionId;
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

async function syncActivePlayers() {
  if (!lavalinkSessionId) return;
  const result = await lavalinkREST('GET', `/v4/sessions/${lavalinkSessionId}/players`);
  if (result.status !== 200 || !Array.isArray(result.body)) {
    log('LAVALINK', `[SYNC] players unavailable HTTP ${result.status}`);
    return;
  }
  for (const player of result.body) {
    const guildId = player.guildId || player.guild_id;
    if (!guildId) continue;
    const channelId = player.voice?.channelId || player.voice?.channel_id;
    if (player.state?.connected && channelId) {
      activePlayers.add(guildId);
      guildChannels.set(guildId, channelId);
      if (!currentTracks.has(guildId) && player.track) {
        currentTracks.set(guildId, {
          title: player.track.info?.title || 'Unknown',
          stream_url: player.track.info?.uri || player.track.userData?.identifier || '',
          channel_id: channelId,
          requester_id: null,
          started_at: Date.now(),
        });
      }
    } else {
      activePlayers.delete(guildId);
    }
  }
  log('LAVALINK', `[SYNC] active players=${[...activePlayers].join(',') || 'none'}`);
}

async function hasConnectedPlayer(guildId, channelId) {
  if (!lavalinkSessionId) return false;
  const result = await lavalinkREST('GET', `/v4/sessions/${lavalinkSessionId}/players/${guildId}`);
  if (result.status === 404) {
    activePlayers.delete(guildId);
    currentTracks.delete(guildId);
    return false;
  }
  if (result.status !== 200 || !result.body) {
    log('LAVALINK', `[PLAYER] state unavailable guild=${guildId} HTTP ${result.status}`);
    return false;
  }
  const connected = result.body.state?.connected === true;
  const playerChannelId = result.body.voice?.channelId || result.body.voice?.channel_id;
  const sameChannel = playerChannelId === channelId;
  if (connected && sameChannel) {
    activePlayers.add(guildId);
    return true;
  }
  activePlayers.delete(guildId);
  if (!connected) currentTracks.delete(guildId);
  log('LAVALINK', `[PLAYER] track-only disabled guild=${guildId} connected=${connected} playerChannel=${playerChannelId || 'null'} target=${channelId}`);
  return false;
}

function makePlaybackError(stage, message, result = null) {
  const err = new Error(message);
  err.name = 'PlaybackStageError';
  err.stage = stage;
  err.upstreamStatus = result?.status ?? null;
  err.detail = result?.body ?? null;
  return err;
}

function playbackErrorPayload(err) {
  return {
    status: 'error',
    message: err?.message || String(err),
    stage: err?.stage || 'voice_bridge',
    upstream_status: err?.upstreamStatus ?? null,
    detail: err?.detail ?? null,
  };
}

function resolveTrackFromLive(sourceUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url: sourceUrl });
    const req = http.request({
      hostname: LIVE_RESOLVE_HOST,
      port: LIVE_RESOLVE_PORT,
      path: '/api/resolve-track',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = raw; }
        if (res.statusCode === 200 && parsed?.status === 'resolved' && parsed?.stream_url) {
          resolve(parsed);
          return;
        }
        reject(makePlaybackError(
          'resolve_track',
          `LIVE track resolution failed (HTTP ${res.statusCode})`,
          { status: res.statusCode, body: parsed },
        ));
      });
    });
    req.setTimeout(LIVE_RESOLVE_TIMEOUT_MS, () => {
      req.destroy(makePlaybackError('resolve_track', `LIVE track resolution timeout after ${LIVE_RESOLVE_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ensurePlayableItem(item, { forceRefresh = false } = {}) {
  const now = Date.now();
  const resolvedAt = Number(item?.resolved_at || 0);
  const hasFreshStream = Boolean(item?.stream_url) && resolvedAt > 0 && now - resolvedAt <= STREAM_FRESH_MS;
  if (!forceRefresh && hasFreshStream) return { ...item };
  if (!item?.source_url) {
    if (item?.stream_url) return { ...item };
    throw makePlaybackError('resolve_track', 'Queue item has neither source_url nor stream_url');
  }
  const resolved = await resolveTrackFromLive(item.source_url);
  return {
    ...item,
    source_url: resolved.source_url || item.source_url,
    stream_url: resolved.stream_url,
    title: repairDisplayText(resolved.title) || item.title || 'Unknown',
    resolved_at: Date.now(),
  };
}

async function reconcileGuildPlaybackState(guildId) {
  if (!lavalinkSessionId) return { known: false, playing: currentTracks.has(guildId) };
  const result = await lavalinkREST('GET', `/v4/sessions/${lavalinkSessionId}/players/${guildId}`);
  if (result.status === 404) {
    activePlayers.delete(guildId);
    currentTracks.delete(guildId);
    return { known: true, playing: false };
  }
  if (result.status !== 200 || !result.body) {
    log('LAVALINK', `[STATE] guild=${guildId} unavailable HTTP ${result.status}; retaining local state conservatively`);
    return { known: false, playing: currentTracks.has(guildId) };
  }

  const player = result.body;
  const connected = player.state?.connected === true;
  const track = player.track || null;
  if (connected) activePlayers.add(guildId);
  else activePlayers.delete(guildId);

  if (!track) {
    currentTracks.delete(guildId);
    return { known: true, playing: false };
  }

  if (!currentTracks.has(guildId)) {
    currentTracks.set(guildId, {
      title: track.info?.title || 'Unknown',
      stream_url: track.info?.uri || '',
      channel_id: player.voice?.channelId || player.voice?.channel_id || guildChannels.get(guildId) || null,
      requester_id: null,
      started_at: Date.now(),
    });
  }
  return { known: true, playing: true };
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
  const canTryTrackOnly = await hasConnectedPlayer(guildId, voiceChannelId);

  log('PLAY', `[START] guild=${guildId} channel=${voiceChannelId} requester=${requesterId || 'unknown'} title="${title || '?'}"`);
  stayVoiceGuilds.add(guildId);

  // Step 1: loadtracks with the yt-dlp stream URL
  // Lavalink's http source handles raw googlevideo URLs and returns loadType=track
  log('LAVALINK', `[LOAD] stream_url=${streamUrl.substring(0, 80)}...`);
  const loadRes = await lavalinkREST('GET',
    `/v4/loadtracks?identifier=${encodeURIComponent(streamUrl)}`
  );
  log('LAVALINK', `[LOAD] HTTP ${loadRes.status} loadType=${loadRes.body?.loadType}`);

  // Update Player accepts an identifier too, but when that identifier resolves
  // to empty/search/playlist Lavalink returns 400. Do not disguise a failed
  // loadtracks result as a later player PATCH failure.
  let trackObj;
  if (loadRes.status === 200 && loadRes.body) {
    const lt = String(loadRes.body.loadType || '').toLowerCase();
    if (lt === 'track' || lt === 'track_loaded') {
      const td = loadRes.body.data || (loadRes.body.tracks || [])[0];
      if (td && td.encoded) {
        trackObj = { encoded: td.encoded };
        log('LAVALINK', `[LOAD] Got encoded track ✅`);
      }
    }
  }
  if (!trackObj) {
    const loadType = loadRes.body?.loadType || 'unknown';
    log('LAVALINK', `[LOAD] ❌ HTTP ${loadRes.status} loadType=${loadType} body=${JSON.stringify(loadRes.body)}`);
    throw makePlaybackError(
      'loadtracks',
      `Lavalink could not resolve extracted stream (loadType=${loadType})`,
      loadRes,
    );
  }

  const playerPath = `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=false`;
  let playRes = null;

  if (canTryTrackOnly) {
    const trackPatch = {
      track: trackObj,
      volume: getGuildVolume(guildId),
    };
    log('LAVALINK', `[PATCH] track-only ${playerPath}`);
    playRes = await lavalinkREST('PATCH', playerPath, trackPatch);
    if (!(playRes.status === 200 || playRes.status === 204)) {
      log('LAVALINK', `[PATCH] track-only failed HTTP ${playRes.status}; falling back to voice patch`);
      activePlayers.delete(guildId);
      playRes = null;
    }
  }

  if (!playRes) {
    // Join/move only when a Lavalink player needs fresh voice state. Reusing
    // an existing player avoids the visible leave/rejoin on normal playback.
    const voiceState = await joinVoiceChannel(guildId, voiceChannelId);
    log('PLAY', `[VOICE] token=${voiceState.token?.substring(0, 8)}... endpoint=${voiceState.endpoint} session=${voiceState.sessionId}`);

    // Keep Discord's endpoint exactly as provided. Some voice regions require
    // the explicit port (for example :8443); stripping it can trigger 4006.
    const endpoint = voiceState.endpoint || '';
    if (!endpoint) {
      throw new Error(`Voice endpoint is empty! voiceState=${JSON.stringify(voiceState)}`);
    }

    // Combined PATCH — track + voice in ONE request (needed for a new player).
    // Lavalink v4.2.2 REQUIRES channelId in the voice object.
    const combinedPatch = {
      track: trackObj,
      volume: getGuildVolume(guildId),
      voice: {
        token: voiceState.token,
        endpoint: endpoint,
        sessionId: voiceState.sessionId,
        channelId: voiceChannelId,
      },
    };
    log('LAVALINK', `[PATCH] voice+track ${playerPath}`);
    log('LAVALINK', `[PATCH] token=${voiceState.token?.substring(0, 8)}... endpoint=${endpoint} session=${voiceState.sessionId} channel=${voiceChannelId}`);
    log('LAVALINK', `[PATCH] Payload: ${JSON.stringify(combinedPatch).substring(0, 120)}...`);
    playRes = await lavalinkREST('PATCH', playerPath, combinedPatch);
  }

  if (playRes.status === 200 || playRes.status === 204) {
    log('LAVALINK', `[PATCH] ✅ HTTP ${playRes.status} — playback started`);
    activePlayers.add(guildId);
    currentTracks.set(guildId, {
      title: title || 'Unknown',
      stream_url: streamUrl,
      channel_id: voiceChannelId,
      requester_id: requesterId,
      started_at: Date.now(),
    });
  } else {
    log('LAVALINK', `[PATCH] ❌ HTTP ${playRes.status}: ${JSON.stringify(playRes.body)}`);
    if (playRes.status === 404) activePlayers.delete(guildId);
    currentTracks.delete(guildId);
    throw makePlaybackError('update_player', `Lavalink player update failed (HTTP ${playRes.status})`, playRes);
  }
  return playRes;
}

function scheduleNextQueued(guildId, delayMs = 250, reason = 'unspecified') {
  const existing = queueAdvanceTimers.get(guildId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    queueAdvanceTimers.delete(guildId);
    playNextQueued(guildId).catch(err => {
      log('QUEUE', `Advance failed guild=${guildId} reason=${reason}: ${err.message}`);
    });
  }, delayMs);
  queueAdvanceTimers.set(guildId, timer);
  log('QUEUE', `Advance scheduled guild=${guildId} delay=${delayMs}ms reason=${reason}`);
}

async function playNextQueued(guildId) {
  if (queueRunning.has(guildId)) {
    log('QUEUE', `Advance suppressed guild=${guildId}: consumer already running`);
    return;
  }
  const queue = playQueues.get(guildId);
  if (!queue || queue.length === 0) return;

  // If another advance already started a track, do not consume another item.
  // This is the critical FIFO guard for duplicate TrackEnd/skip timers.
  if (currentTracks.has(guildId)) {
    log('QUEUE', `Advance suppressed guild=${guildId}: current track already restored`);
    return;
  }

  // Transactional queue head: do not dequeue until playback has actually
  // started. A transient resolver/loadtracks failure therefore cannot silently
  // eat an item that waited in queue for hours.
  const item = queue[0];
  queueRunning.add(guildId);
  try {
    const playable = await ensurePlayableItem(item);
    Object.assign(item, playable);
    const retryCount = Number(item._queue_retry_count || 0);
    log('QUEUE', `Next attempt guild=${guildId} queued=${queue.length} retry=${retryCount} playlist_index=${item.playlist_index ?? '-'} title="${item.title || '?'}" resolved=${item.source_url ? 'jit-capable' : 'stream-only'}`);
    await lavalinkPlay(guildId, item.channel_id, item.stream_url, item.title, item.requester_id);

    if (queue[0] === item) queue.shift();
    else {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
    }
    delete item._queue_retry_count;
    playQueues.set(guildId, queue);
    const current = currentTracks.get(guildId);
    if (current) {
      current.source_url = item.source_url || current.source_url || '';
      current.resolved_at = Number(item.resolved_at || 0) || Date.now();
    }
    log('QUEUE', `Next committed guild=${guildId} remaining=${queue.length} title="${item.title || '?'}"`);
  } catch (err) {
    item._queue_retry_count = Number(item._queue_retry_count || 0) + 1;
    const attempt = item._queue_retry_count;
    if (item.source_url && (err.stage === 'loadtracks' || err.stage === 'resolve_track')) {
      item.resolved_at = 0; // force a fresh signed/proxy URL on retry
    }
    log('QUEUE', `Next failed but preserved guild=${guildId} retry=${attempt} stage=${err.stage || 'unknown'} status=${err.upstreamStatus ?? 'n/a'}: ${err.message} detail=${JSON.stringify(err.detail ?? null)}`);

    if (attempt <= 2) {
      scheduleNextQueued(guildId, 500 * attempt, `retry-head-${attempt}`);
    } else {
      if (queue[0] === item) queue.shift();
      else {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
      }
      playQueues.set(guildId, queue);
      log('QUEUE', `Head skipped after bounded retries guild=${guildId} remaining=${queue.length} title="${item.title || '?'}"`);
      scheduleNextQueued(guildId, 250, 'bounded-retry-exhausted');
    }
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
      source_url: item.source_url || null,
      stream_url: item.stream_url || null,
      resolved_at: Number(item.resolved_at || 0) || null,
      playlist_index: item.playlist_index ?? null,
    })),
  };
}

function textQualityScore(text) {
  const source = String(text || '');
  const useful = (source.match(/[\u3040-\u30ff\u3400-\u9fff\w]/g) || []).length;
  const mojibake = (source.match(/[ÃÂâäåæçèéï�]/g) || []).length;
  return useful - mojibake * 4;
}

function repairDisplayText(value) {
  const original = String(value || '').trim();
  if (!original) return '';
  let best = original;
  let bestScore = textQualityScore(best);
  const candidates = [Buffer.from(original, 'latin1').toString('utf8')];
  candidates.push(Buffer.from(candidates[0], 'latin1').toString('utf8'));
  for (const candidate of candidates) {
    const score = textQualityScore(candidate);
    if (score > bestScore + 2) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function shortText(value, max = 90) {
  const text = repairDisplayText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text || 'Unknown';
  return `${text.slice(0, max - 1)}…`;
}

function queuePanelPayload(guildId) {
  const state = getQueueState(guildId);
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const currentTitle = state.current?.title ? shortText(state.current.title, 96) : '沒有在播。';
  const nextTitle = state.next?.title ? shortText(state.next.title, 96) : '後面沒有。';
  const queueLines = queue.slice(0, 8).map((item) => `\`${String(item.index).padStart(2, '0')}\` ${shortText(item.title, 64)}`);
  const hiddenCount = Math.max(0, queue.length - queueLines.length);
  if (hiddenCount > 0) queueLines.push(`\`…\` 還有 ${hiddenCount} 首。`);

  const embed = new EmbedBuilder()
    .setColor(0x7fd6a4)
    .setTitle('樂奈的歌單')
    .addFields(
      { name: '正在播', value: currentTitle, inline: true },
      { name: '下一首', value: nextTitle, inline: true },
      { name: '音量', value: `${state.volume ?? DEFAULT_VOLUME}`, inline: true },
      { name: `後面 ${queue.length} 首`, value: queueLines.join('\n') || '沒有。', inline: false },
    )
    .setFooter({ text: `更新 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rana_queue|refresh|${guildId}`).setEmoji({ name: '🔄' }).setLabel('再看').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rana_queue|skip|${guildId}`).setEmoji({ name: '⏭️' }).setLabel('跳過').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rana_queue|remove_next|${guildId}`).setEmoji({ name: '🗑️' }).setLabel('下一首').setStyle(ButtonStyle.Secondary).setDisabled(queue.length === 0),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rana_queue|vol_down|${guildId}`).setEmoji({ name: '🔉' }).setLabel('小聲').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rana_queue|vol_up|${guildId}`).setEmoji({ name: '🔊' }).setLabel('大聲').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rana_queue|stop|${guildId}`).setEmoji({ name: '⏹️' }).setLabel('停下').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rana_queue|leave|${guildId}`).setEmoji({ name: '🚪' }).setLabel('出去').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

async function publishQueuePanel(guildId, textChannelId, forceNew = false) {
  if (!discordReady) throw new Error('Discord bot not ready yet.');
  if (!textChannelId) throw new Error('Missing text_channel_id');

  const channel = await client.channels.fetch(textChannelId);
  if (!channel || typeof channel.send !== 'function') {
    throw new Error(`Channel ${textChannelId} is not a text channel`);
  }

  const key = `${guildId}:${textChannelId}`;
  const payload = queuePanelPayload(guildId);
  const cached = queuePanels.get(key);
  if (!forceNew && cached?.messageId && channel.messages?.fetch) {
    try {
      const message = await channel.messages.fetch(cached.messageId);
      await message.edit(payload);
      return { message_id: message.id, updated: true };
    } catch (err) {
      log('QUEUE_UI', `Cached panel edit failed, sending a new one: ${err.message}`);
    }
  }

  const message = await channel.send(payload);
  queuePanels.set(key, { channelId: textChannelId, messageId: message.id });
  return { message_id: message.id, updated: false };
}

async function performQueuePanelAction(action, guildId) {
  if (action === 'skip') {
    await skipCurrent(guildId);
    await new Promise(resolve => setTimeout(resolve, 600));
  } else if (action === 'remove_next') {
    const queue = playQueues.get(guildId) || [];
    queue.shift();
    playQueues.set(guildId, queue);
  } else if (action === 'vol_down') {
    await setPlaybackVolume(guildId, getGuildVolume(guildId) - 10);
  } else if (action === 'vol_up') {
    await setPlaybackVolume(guildId, getGuildVolume(guildId) + 10);
  } else if (action === 'stop') {
    await stopPlayback(guildId);
  } else if (action === 'leave') {
    playQueues.set(guildId, []);
    currentTracks.delete(guildId);
    activePlayers.delete(guildId);
    leaveVoiceChannel(guildId);
  }
}

async function handleQueueButton(interaction) {
  const [scope, action, guildId] = String(interaction.customId || '').split('|');
  if (scope !== 'rana_queue' || !guildId) return;
  if (interaction.guildId && String(interaction.guildId) !== String(guildId)) {
    log('QUEUE_UI', `Button rejected: guild mismatch custom=${guildId} actual=${interaction.guildId}`);
    return;
  }

  // The same bot account is also connected by OpenClaw. Acknowledge our
  // sidecar-owned rana_queue interaction immediately so the 3-second Discord
  // interaction window cannot expire while skip/volume/network work runs.
  const interactionId = String(interaction.id || '');
  if (interactionId && handledQueueInteractions.has(interactionId)) {
    log('QUEUE_UI', `Duplicate button ignored id=${interactionId} action=${action} guild=${guildId}`);
    return;
  }
  if (interactionId) {
    handledQueueInteractions.add(interactionId);
    setTimeout(() => handledQueueInteractions.delete(interactionId), 60_000);
  }

  let acknowledged = false;
  try {
    await interaction.deferUpdate();
    acknowledged = true;
  } catch (err) {
    // Another gateway session may have acknowledged first. The sidecar still
    // owns rana_queue actions, so continue the action and edit the message via
    // the normal bot REST path instead of dropping the click.
    log('QUEUE_UI', `Button defer failed but action continues id=${interactionId || '-'} action=${action} guild=${guildId}: ${err.message}`);
  }

  try {
    log('QUEUE_UI', `Button action id=${interactionId || '-'} action=${action} guild=${guildId}`);
    await performQueuePanelAction(action, guildId);
    const payload = queuePanelPayload(guildId);
    if (interaction.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit(payload);
    } else if (acknowledged && typeof interaction.editReply === 'function') {
      await interaction.editReply(payload);
    }
  } catch (err) {
    log('QUEUE_UI', `Button ${action} failed guild=${guildId}: ${err.message}`);
    const reply = { content: `不行。${err.message || '怪。'}`, ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied || acknowledged) await interaction.followUp(reply);
      else await interaction.reply(reply);
    } catch (replyErr) {
      log('QUEUE_UI', `Button error reply also failed guild=${guildId}: ${replyErr.message}`);
    }
  }
}

async function feedbackUnauthorized(interaction) {
  const reply = { content: '這不是你的辨識回饋。', ephemeral: true };
  if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
  else await interaction.reply(reply);
}

async function handleVisionFeedbackButton(interaction) {
  const parsed = parseVisionFeedbackCustomId(interaction.customId);
  if (!parsed?.requestId || !parsed.requesterId) return;
  if (String(interaction.user?.id || '') !== parsed.requesterId) {
    await feedbackUnauthorized(interaction);
    return;
  }
  const pending = visionFeedbackStore.readPending(parsed.requestId);
  if (!pending) {
    await interaction.reply({ content: '這次辨識紀錄已經不在了。', ephemeral: true });
    return;
  }
  if (parsed.action === 'ok') {
    visionFeedbackStore.record(parsed.requestId, interaction.user.id, 'correct');
    await interaction.reply({ content: '嗯。記下來了。', ephemeral: true });
    return;
  }
  if (parsed.action === 'wrong') {
    const input = new TextInputBuilder()
      .setCustomId('correct_identity')
      .setLabel('正確是誰？不知道也可以寫不知道')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);
    const modal = new ModalBuilder()
      .setCustomId(`vfm|${parsed.requestId}|${parsed.requesterId}`)
      .setTitle('修正圖片辨識')
      .addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }
}

async function handleVisionFeedbackModal(interaction) {
  const parsed = parseVisionFeedbackCustomId(interaction.customId);
  if (!parsed?.requestId || !parsed.requesterId) return;
  if (String(interaction.user?.id || '') !== parsed.requesterId) {
    await feedbackUnauthorized(interaction);
    return;
  }
  const correction = String(interaction.fields?.getTextInputValue('correct_identity') || '').trim();
  const result = visionFeedbackStore.record(parsed.requestId, interaction.user.id, 'incorrect', correction);
  await interaction.reply({
    content: result.status === 'recorded' ? '嗯。這張要改。' : '這次辨識紀錄已經不在了。',
    ephemeral: true,
  });
}

function removeQueuedTrack(guildId, query) {
  const queue = playQueues.get(guildId) || [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;
  const index = queue.findIndex((item) => {
    const title = String(item.title || '').toLowerCase();
    const streamUrl = String(item.stream_url || '').toLowerCase();
    const sourceUrl = String(item.source_url || '').toLowerCase();
    return title.includes(needle) || streamUrl.includes(needle) || sourceUrl.includes(needle);
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
    if (lavalinkSessionId) {
      // Stop only the current track and keep the player/voice session alive.
      // DELETEing the player can create extra end/reconnect races while a
      // queued successor is starting.
      const result = await lavalinkREST('PATCH', `/v4/sessions/${lavalinkSessionId}/players/${guildId}?noReplace=false`, {
        track: { encoded: null },
      });
      if (![200, 204, 404].includes(result.status)) {
        throw new Error(`Lavalink ${result.status}`);
      }
    }
  } catch (err) {
    log('QUEUE', `Skip stop failed guild=${guildId}: ${err.message}`);
  }
  scheduleNextQueued(guildId, 350, 'manual-skip');
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
      version: '3.2.1',
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
      bridge_version: '3.2.1',
      discord_bot_id: BOT_USER_ID,
      discord_ready: discordReady,
      discord_user: discordReady ? `${client.user.tag} (${client.user.id})` : null,
      discord_intents: enabledIntents,
      lavalink_session_id: lavalinkSessionId,
      lavalink_connection: lavalinkWs ? lavalinkWs.readyState : 'disconnected',
      guilds_count: discordReady ? client.guilds.cache.size : 0,
      active_players: [...activePlayers],
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

  if (req.method === 'POST' && req.url === '/voice/queue-panel') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    const textChannelId = body.text_channel_id;
    if (!guildId || !textChannelId) return respond(400, { error: 'Missing guild_id or text_channel_id' });
    log('HTTP', `POST /voice/queue-panel guild=${guildId} text_channel=${textChannelId}`);
    try {
      const panel = await publishQueuePanel(guildId, textChannelId, true);
      return respond(200, { ...getQueueState(guildId), status: 'panel', ...panel });
    } catch (err) {
      log('QUEUE_UI', `Panel failed guild=${guildId}: ${err.message}`);
      return respond(500, { status: 'error', message: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/voice/queue/import') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId || !Array.isArray(body.queue)) return respond(400, { error: 'Missing guild_id or queue' });
    const restored = body.queue
      .filter(item => item && (item.stream_url || item.source_url))
      .map(item => ({
        source_url: item.source_url || '',
        stream_url: item.stream_url || '',
        resolved_at: Number(item.resolved_at || 0) || 0,
        title: repairDisplayText(item.title) || 'Unknown',
        channel_id: item.channel_id || body.channel_id || guildChannels.get(guildId) || null,
        requester_id: item.requester_id || body.requester_id || null,
        playlist_index: Number.isFinite(Number(item.playlist_index)) ? Number(item.playlist_index) : null,
      }));
    playQueues.set(guildId, restored);
    if (body.current?.title || body.current?.stream_url || body.current?.source_url) {
      currentTracks.set(guildId, {
        title: repairDisplayText(body.current.title) || 'Unknown',
        source_url: body.current.source_url || '',
        stream_url: body.current.stream_url || '',
        resolved_at: Number(body.current.resolved_at || 0) || 0,
        channel_id: body.current.channel_id || body.channel_id || guildChannels.get(guildId) || null,
        requester_id: body.current.requester_id || body.requester_id || null,
        started_at: body.current.started_at || Date.now(),
      });
    }
    log('QUEUE', `Imported guild=${guildId} queued=${restored.length} current=${currentTracks.has(guildId)}`);
    return respond(200, { ...getQueueState(guildId), status: 'imported', imported: restored.length });
  }

  if (req.method === 'POST' && req.url === '/voice/resume-current') {
    const body = await parseBody(req);
    const guildId = body.guild_id;
    if (!guildId) return respond(400, { error: 'Missing guild_id' });
    const current = currentTracks.get(guildId);
    if (!(current?.stream_url || current?.source_url)) return respond(404, { status: 'idle', message: 'No current track to resume' });
    log('HTTP', `POST /voice/resume-current guild=${guildId} title="${current.title || ''}"`);
    try {
      const playable = await ensurePlayableItem(current);
      await lavalinkPlay(guildId, playable.channel_id, playable.stream_url, playable.title, playable.requester_id);
      const restored = currentTracks.get(guildId);
      if (restored) {
        restored.source_url = playable.source_url || restored.source_url || '';
        restored.resolved_at = Number(playable.resolved_at || 0) || Date.now();
      }
      return respond(200, { ...getQueueState(guildId), status: 'resumed' });
    } catch (err) {
      log('QUEUE', `Resume current failed guild=${guildId}: ${err.message}`);
      return respond(500, { status: 'error', message: err.message });
    }
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
    const { guild_id, channel_id, requester_id, stream_url, source_url, resolved_at, title, request_id } = body;
    const tracks = Array.isArray(body.tracks) ? body.tracks : null;
    log('HTTP', `POST /voice/play request=${request_id || '-'} guild=${guild_id || ''} requester=${requester_id || ''} title="${title || ''}" tracks=${tracks ? tracks.length : 0} before=${guild_id ? JSON.stringify(getQueueState(guild_id)).slice(0, 240) : '{}'}`);

    if (!guild_id || (!(stream_url || source_url) && (!tracks || tracks.length === 0))) {
      return respond(400, { error: 'Missing guild_id or playable source' });
    }
    if (!lavalinkSessionId) {
      return respond(503, { error: 'Lavalink session not established. Is Lavalink running?' });
    }
    if (!discordReady) {
      return respond(503, { error: 'Discord bot not ready yet.' });
    }

    try {
      const incoming = (tracks && tracks.length > 0
        ? tracks
        : [{ source_url, stream_url, resolved_at, title, channel_id, requester_id }])
        .filter(t => t && (t.stream_url || t.source_url))
        .map(t => ({
          source_url: t.source_url || '',
          stream_url: t.stream_url || '',
          resolved_at: Number(t.resolved_at || resolved_at || 0) || 0,
          title: t.title || 'Unknown',
          channel_id: t.channel_id || channel_id,
          requester_id: t.requester_id || requester_id,
          playlist_index: Number.isFinite(Number(t.playlist_index)) ? Number(t.playlist_index) : null,
        }));
      if (incoming.length === 0) return respond(400, { error: 'Playlist had no playable tracks' });
      log('QUEUE', `Incoming order guild=${guild_id}: ${incoming.map((t, i) => `${t.playlist_index ?? i + 1}:${String(t.title || '?').slice(0, 48)}`).join(' | ').slice(0, 1800)}`);

      const queue = playQueues.get(guild_id) || [];
      const actualState = await reconcileGuildPlaybackState(guild_id);
      if (actualState.playing || queueRunning.has(guild_id)) {
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

      const playable = await ensurePlayableItem(first);
      const result = await lavalinkPlay(guild_id, playable.channel_id, playable.stream_url, playable.title, playable.requester_id);
      if (result.status === 200 || result.status === 204) {
        const current = currentTracks.get(guild_id);
        if (current) {
          current.source_url = playable.source_url || current.source_url || '';
          current.resolved_at = Number(playable.resolved_at || 0) || Date.now();
        }
        log('PLAY', `✅ SUCCESS: "${playable.title}"`);
        return respond(200, {
          status: 'playing',
          guild_id,
          title: playable.title || 'Unknown',
          session: lavalinkSessionId,
          queued: playQueues.get(guild_id)?.length || 0,
        });
      } else {
        log('PLAY', `❌ LAVALINK_ERROR ${result.status}: ${JSON.stringify(result.body)}`);
        return respond(500, { status: 'error', message: `Lavalink ${result.status}`, detail: result.body });
      }
    } catch (err) {
      const failure = playbackErrorPayload(err);
      log('PLAY', `❌ ERROR request=${request_id || '-'} stage=${failure.stage} upstream=${failure.upstream_status ?? 'n/a'}: ${failure.message} detail=${JSON.stringify(failure.detail)}`);
      return respond(502, failure);
    }
  }

  // ── POST /voice/leave ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/voice/leave') {
    const body = await parseBody(req);
    log('HTTP', `POST /voice/leave guild=${body.guild_id || ''} before=${body.guild_id ? JSON.stringify(getQueueState(body.guild_id)).slice(0, 240) : '{}'}`);
    playQueues.set(body.guild_id, []);
    currentTracks.delete(body.guild_id);
    activePlayers.delete(body.guild_id);
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
  log('BRIDGE', `  POST /voice/queue-panel { guild_id, text_channel_id }`);
  log('BRIDGE', `  POST /voice/resume-current { guild_id }`);
  log('BRIDGE', `  POST /voice/play   { guild_id, channel_id, stream_url, title }`);
  log('BRIDGE', `  POST /voice/leave  { guild_id }`);
});

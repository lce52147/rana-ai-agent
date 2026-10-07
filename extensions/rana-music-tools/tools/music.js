import {
  firstText,
  isCurrentTurnToolAuthorized,
  isPlainKeyword,
  isProtectedBareNoun,
  parseMusicCommand,
} from "../../rana-runtime/tool_contracts.js";
import {
  recentContextSnapshot,
  recentDiscordText,
  recentRequesterId,
  recentTextChannelId,
  rememberToolEvidence,
  resolveRequesterId,
  resolveTextChannelId,
} from "../../rana-runtime/context_store.js";
import { resolveBotContext } from "../../rana-runtime/bot_context.js";
import { resolveTrustedInvocationContext, trustedContextHint, trustedToolError } from "../../rana-runtime/architecture/turn_isolation.js";
import {
  DEFAULT_GUILD_ID,
  getQueue,
  isRequestTimeoutError,
  playTimeoutMsFor,
  postJoin,
  postLeave,
  postPlay,
  postQueuePanel,
  postSkip,
  postStop,
  postVolume,
  queueStateAfterSlowPlay,
  resolvePlayTarget,
} from "../sidecars/music.js";

const VOICE_BASE_BY_BOT = Object.freeze({
  rana: "http://127.0.0.1:8081",
  tomori: "http://127.0.0.1:8082",
  anon: "http://127.0.0.1:8083",
  soyo: "http://127.0.0.1:8084",
  taki: "http://127.0.0.1:8085",
});

const MUSIC_TOOL_NAMES = new Set([
  "rana_play_music",
  "rana_stop_music",
  "rana_show_queue",
  "rana_skip_music",
  "rana_volume_music",
  "rana_join_voice",
  "rana_leave_voice",
]);


function normalizeMusicBotId(value) {
  const clean = firstText(value).trim().toLowerCase();
  if (clean === "default" || clean === "main") return "rana";
  return Object.hasOwn(VOICE_BASE_BY_BOT, clean) ? clean : null;
}

function routeFromEvent(event, ctx) {
  const context = resolveBotContext(event, ctx);
  const botId = normalizeMusicBotId(context?.botId || context?.personaId || context?.accountId);
  return {
    botId,
    personaId: context?.personaId || botId || "",
    accountId: context?.accountId || (botId === "rana" ? "default" : botId || ""),
    sessionKey: context?.sessionKey || "",
    baseUrl: botId ? VOICE_BASE_BY_BOT[botId] : null,
    identityError: botId ? null : "missing or unknown bot identity",
  };
}

function routeFromParams(params = {}, trusted = null) {
  const snapshot = trusted ? trustedContextHint(trusted) : recentContextSnapshot(params);
  // Shared recent context may provide requester/channel metadata, but it must
  // never select the bot bridge for this invocation.
  const botId = normalizeMusicBotId(trusted
    ? (trusted.accountId || trusted.agentId)
    : firstText(params?.bot_id) || firstText(params?.botId));
  return {
    botId,
    personaId: trusted ? botId || "" : firstText(params?.persona_id) || firstText(params?.personaId) || botId || "",
    accountId: trusted ? trusted.accountId : firstText(params?.account_id) || firstText(params?.accountId) || (botId === "rana" ? "default" : botId || ""),
    sessionKey: trusted ? trusted.sessionKey : firstText(params?.session_key) || firstText(params?.sessionKey) || snapshot.session_key || "",
    baseUrl: botId ? VOICE_BASE_BY_BOT[botId] : null,
    identityError: botId ? null : "missing or unknown bot identity",
  };
}

function currentTurnMusicHint(event, ctx) {
  const context = resolveBotContext(event, ctx);
  return {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
  };
}

function musicIntentBlock(toolName = "rana_play_music") {
  return {
    block: true,
    blockReason: toolName === "rana_play_music"
      ? "rana_play_music requires explicit current-turn playback intent"
      : `${toolName} requires matching explicit current-turn music intent`,
  };
}

function invalidRouteData(route) {
  return {
    status: "error",
    code: "INVALID_BOT_ID",
    message: "",
    llm_hint: route?.identityError || "missing or unknown bot identity",
  };
}

function invalidRouteText(route) {
  return ranaError(invalidRouteData(route).llm_hint);
}

function compactText(value) {
  return firstText(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function routeLog(kind, text, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`[rana-music-tools] route=${kind}${suffix} text="${compactText(text)}"`);
}

function ok(text) {
  return `嗯。${text}`;
}

export function hasPlaybackEvidence(data) {
  if (!data || data.status === "error") return false;
  if (data.status === "extracted" && (data.message || data.llm_hint)) return false;
  return Number(data?.queued || 0) > 0
    || Boolean(data?.current?.title)
    || Number(data?.queued_count || 0) > 0
    || data?.status === "queued"
    || data?.status === "playing"
    || data?.status === "ok";
}

export function ranaPlayPendingFromQueue(data) {
  const queued = Number(data?.queued || 0);
  if (queued > 0) return ok(`還在排。隊列 ${queued} 首。`);
  if (data?.current?.title) return ok(`現在是 ${data.current.title}。`);
  return "不行。還沒有播放證據。";
}

export function ranaError(message) {
  const raw = firstText(message);
  if (/fetch failed|network(?:\s+error)?|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(raw)) return "不行。連不上。";
  if (/request timeout|timed?\s*out|timeout/i.test(raw)) return "不行。音源太慢，還沒確認有播。";
  if (/voice bridge.*offline|Discord bot not ready|Discord not ready/i.test(raw)) return "不行。現在進不去。";
  if (/Bot is not in guild|not in guild/i.test(raw)) return "不行。我不在那裡。";
  if (/not in voice|voice channel|Voice join timeout|Missing requester/i.test(raw)) return "不行。你要先在語音頻道。";
  if (/Lavalink|session not established|player/i.test(raw)) return "不行。現在播不了。";
  if (/no playable|no result|Playlist had no playable|yt-dlp search returned no playable/i.test(raw)) return "找不到。無聊。";
  if (/Sign in|login|required|private|members-only|age/i.test(raw)) return "不行。那個要登入或有限制。";
  if (/Extraction|playback failed|Unexpected|HTTP \d+|api\/play|127\.0\.0\.1|stack|Error:|ValidationError|JSON/i.test(raw)) return "不行。現在播不了。";
  const clean = raw.replace(/https?:\/\/\S+/g, "").replace(/\{[\s\S]*\}/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 32) return "不行。播放沒成功。";
  return `不行。${clean}`;
}

function formatNext(data) {
  return data?.next?.title ? ok(`下一首 ${data.next.title}。`) : "後面沒有。";
}

function formatVolume(data) {
  const volume = Number(data?.volume ?? 35);
  if (volume === 0) return "嗯。靜音。";
  return ok(`音量 ${volume}。`);
}

function playbackEvidenceHint(source, context, route, requesterId) {
  return {
    ...(source || {}),
    ...(context || {}),
    requester_id: requesterId,
    botId: route.botId,
    personaId: route.personaId,
    sessionKey: route.sessionKey,
  };
}

function markPlaybackEvidence(data, action = "play", hint) {
  rememberToolEvidence("rana_play_music", action, hasPlaybackEvidence(data), hint);
}

function recordJoinEvidence(data, event, ctx, route, requesterId) {
  if (data?.status !== "joined") return false;
  rememberToolEvidence("rana_join_voice", "join", true, {
    ...(event || {}),
    ...(ctx || {}),
    requester_id: requesterId,
    botId: route.botId,
    personaId: route.personaId,
    sessionKey: route.sessionKey,
  }, "join");
  return true;
}

function resolveToolRequesterId(params = {}, trusted = null) {
  return trusted?.requesterSenderId || recentRequesterId(params) || firstText(params?.requester_id) || firstText(params?.requester);
}

function voiceStatus(data = {}, requesterId = "", action = "play", contextHint = null) {
  const context = recentContextSnapshot(contextHint || { requester_id: requesterId });
  const failed = data?.status === "error";
  return {
    action,
    guild_id: DEFAULT_GUILD_ID,
    requester_id: requesterId || context.requester_id || "",
    text_channel_id: context.text_channel_id,
    sidecar_status: firstText(data?.status),
    playback_evidence: hasPlaybackEvidence(data),
    current: data?.current || null,
    queued: Number(data?.queued ?? data?.queued_count ?? 0),
    message: failed ? "" : firstText(data?.message),
    llm_hint: failed ? ranaError(data?.llm_hint || data?.message || data?.error) : firstText(data?.llm_hint),
  };
}

function attachVoiceStatus(data = {}, requesterId = "", action = "play", contextHint = null) {
  const failed = data?.status === "error";
  const { error: _error, stack: _stack, ...safeData } = data || {};
  const publicData = failed
    ? { ...safeData, message: "", llm_hint: ranaError(data?.llm_hint || data?.message || data?.error) }
    : safeData;
  return {
    ...publicData,
    voice_status: voiceStatus(publicData, requesterId, action, contextHint),
  };
}

function voiceToolFailure(error, requesterId = "", action = "play", contextHint = null) {
  console.warn(`[rana-music-tools] tool error (${action}): ${error?.message || String(error)}`);
  return attachVoiceStatus({
    status: "error",
    llm_hint: ranaError(error?.message || String(error)),
  }, requesterId, action, contextHint);
}

async function playRequest(target, params, sourceText, signal, route = routeFromParams(params)) {
  const playUrl = await resolvePlayTarget(target, sourceText);
  const currentCommand = parseMusicCommand(sourceText);
  const queueMode = currentCommand?.queue_mode === "next" ? "next" : "append";
  const data = await postPlay({
    ...params,
    guild_id: DEFAULT_GUILD_ID,
    url: playUrl,
    queue_mode: queueMode,
    requester_id: params.requester_id,
    requester: firstText(params.requester) || params.requester_id,
    bot_id: route.botId,
    persona_id: route.personaId,
    account_id: route.accountId,
    session_key: route.sessionKey,
  }, signal, playTimeoutMsFor(playUrl));
  return { data, playUrl };
}

function normalizePlayResult(data) {
  if (data?.status === "error") return { ok: false, message: firstText(data?.llm_hint) || firstText(data?.message) || "playback failed" };
  if (data?.status === "extracted" && (data?.message || data?.llm_hint)) {
    return { ok: false, message: firstText(data?.llm_hint) || firstText(data?.message) || "extracted but playback failed" };
  }
  if (!hasPlaybackEvidence(data)) return { ok: false, message: "no playback evidence" };
  return { ok: true };
}

export async function handleControlRequest(control, event, ctx, routeText) {
  const route = routeFromEvent(event, ctx);
  routeLog(control.kind, routeText, control.query ? `query="${compactText(control.query)}"` : "");
  if (!route.baseUrl) return { handled: true, text: invalidRouteText(route) };
  try {
    if (control.kind === "queue") {
      await postQueuePanel({
        guild_id: DEFAULT_GUILD_ID,
        text_channel_id: resolveTextChannelId(event, ctx),
      }, undefined, route.baseUrl);
      return { handled: true, text: ok("歌單丟出去了。") };
    }
    if (control.kind === "next") return { handled: true, text: formatNext(await getQueue(DEFAULT_GUILD_ID, undefined, route.baseUrl)) };
    if (control.kind === "skip") {
      const data = await postSkip({ guild_id: DEFAULT_GUILD_ID, query: control.query, bot_id: route.botId }, undefined, route.baseUrl);
      if (data.status === "removed") return { handled: true, text: ok(`${data.removed?.title || "那首"} 拿掉了。`) };
      if (data.status === "not_found") return { handled: true, text: "找不到那首。" };
      if (data.status === "skipped") return { handled: true, text: ok(data.current?.title ? `跳到 ${data.current.title}。` : "跳過了。") };
      return { handled: true, text: "沒有東西能跳。" };
    }
    if (control.kind === "volume") return { handled: true, text: formatVolume(await postVolume({ guild_id: DEFAULT_GUILD_ID, volume: control.volume, delta: control.delta, bot_id: route.botId }, undefined, route.baseUrl)) };
    if (control.kind === "volume_query") return { handled: true, text: formatVolume(await getQueue(DEFAULT_GUILD_ID, undefined, route.baseUrl)) };
    if (control.kind === "stop") {
      await postStop({ guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, undefined, route.baseUrl);
      return { handled: true, text: "停下來了。" };
    }
    if (control.kind === "join") {
      const requesterId = resolveRequesterId(event, ctx);
      console.log(`[rana-music-tools] control=join bot_id=${route.botId} bridge=${route.baseUrl} requester_id=${requesterId || "-"} guild_id=${DEFAULT_GUILD_ID}`);
      if (!requesterId) return { handled: true, text: "不行。找不到你。" };
      const data = await postJoin({ guild_id: DEFAULT_GUILD_ID, requester_id: requesterId, bot_id: route.botId, persona_id: route.personaId, account_id: route.accountId }, undefined, route.baseUrl);
      if (!recordJoinEvidence(data, event, ctx, route, requesterId)) throw new Error("voice join did not confirm joined status");
      return { handled: true, text: ok("進來了。") };
    }
    if (control.kind === "leave") {
      await postLeave({ guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, undefined, route.baseUrl);
      return { handled: true, text: "出去了。" };
    }
  } catch (err) {
    console.warn(`[rana-music-tools] control error (${control.kind}): ${err?.message || String(err)}`);
    return { handled: true, text: ranaError(err?.message || String(err)) };
  }
  return null;
}

export async function handlePlayRequest(parsed, event, ctx, routeText) {
  const route = routeFromEvent(event, ctx);
  routeLog("play", routeText, parsed.query ? `query="${compactText(parsed.query)}" source="${parsed.source || "youtube"}"` : `url="${compactText(parsed.url)}"`);
  if (!route.baseUrl) return { handled: true, text: invalidRouteText(route) };
  const requesterId = resolveRequesterId(event, ctx);
  if (!requesterId) return { handled: true, text: "不行。找不到你。" };
  try {
    const target = parsed.url || parsed.query;
    const { data } = await playRequest(target, {
      guild_id: DEFAULT_GUILD_ID,
      requester_id: requesterId,
      requester: requesterId,
    }, routeText, undefined, route);
    const normalized = normalizePlayResult(data);
    if (!normalized.ok) throw new Error(normalized.message);
    markPlaybackEvidence(data, "play", playbackEvidenceHint(event, ctx, route, requesterId));
    const title = firstText(data?.title) || parsed.display || target;
    const playlistCount = Number(data?.playlist_count || 0);
    const queuedCount = Number(data?.queued_count || 0);
    if (playlistCount > 1) return { handled: true, text: ok(`${playlistCount} 首。排了。`) };
    if (queuedCount > 0) return { handled: true, text: ok(`${title} 排了。`) };
    return { handled: true, text: ok(`${title}。`) };
  } catch (err) {
    console.warn(`[rana-music-tools] play error: ${err?.message || String(err)}`);
    if (isRequestTimeoutError(err)) {
      try {
        const queueState = await queueStateAfterSlowPlay(route.baseUrl);
        if (hasPlaybackEvidence(queueState)) {
          markPlaybackEvidence(queueState, "pending", playbackEvidenceHint(event, ctx, route, requesterId));
          return { handled: true, text: ranaPlayPendingFromQueue(queueState) };
        }
      } catch (queueErr) {
        console.warn(`[rana-music-tools] queue check after play timeout failed: ${queueErr?.message || String(queueErr)}`);
      }
    }
    return { handled: true, text: ranaError(err?.message || String(err)) };
  }
}

export function registerMusicTools(api) {
  api.on("before_tool_call", (event, ctx) => {
    const toolName = String(event?.toolName || "");
    if (!MUSIC_TOOL_NAMES.has(toolName)) return;
    const hint = currentTurnMusicHint(event, ctx);
    if (!hint.agentId || !hint.sessionKey) return musicIntentBlock(toolName);
    const sourceText = firstText(ctx?.currentTurnText).trim() || recentDiscordText(hint);
    if (!sourceText || !isCurrentTurnToolAuthorized({ toolName, text: sourceText })) {
      return musicIntentBlock(toolName);
    }
  }, { priority: 6000, timeoutMs: 5000 });

  api.registerTool({
    name: "rana_play_music",
    label: "Rana Play Music",
    description: "Allowed only when the current user turn explicitly requests playback (播放/play) or play-next insertion (插歌/插播/下一首播放/play next). Queue position is derived from trusted current-turn text, never model-supplied parameters.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Audio URL when the user provides one." },
        query: { type: "string", description: "Song title or search query when the user asks to play music without a URL." },
        source_text: { type: "string", description: "Original user message, used to verify explicit play intent." },
        guild_id: { type: "string", description: "Discord guild id. Prefer 1486679037605842944." },
        channel_id: { type: "string" },
        requester_id: { type: "string" },
        requester: { type: "string" },
        bot_id: { type: "string" },
        persona_id: { type: "string" },
        account_id: { type: "string" },
        session_key: { type: "string" },
      },
      required: ["guild_id"],
    },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx, { requireRequester: true });
      if (!trusted.ok) return trustedToolError("rana_play_music", trusted);
      const trustedHint = trustedContextHint(trusted);
      const target = firstText(params?.url) || firstText(params?.query);
      if (!target) return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "沒有歌曲。" }) }] };
      if (isPlainKeyword(target) && isProtectedBareNoun(target)) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "那是名詞，不是播放指令。" }) }] };
      }
      const sourceText = recentDiscordText(trustedHint);
      if (!sourceText) return trustedToolError("rana_play_music", { error: "missing trusted current source text" });
      if (isPlainKeyword(target) && !isCurrentTurnToolAuthorized({ toolName: "rana_play_music", text: sourceText })) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "沒有明確播放指令。" }) }] };
      }
      const route = routeFromParams(params, trusted);
      if (!route.baseUrl) {
        const data = invalidRouteData(route);
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "play", trustedHint)) }] };
      }
      const requesterId = resolveToolRequesterId(params, trusted);
      if (!requesterId) {
        const data = { status: "error", llm_hint: "找不到點歌的人。" };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "play", trustedHint)) }] };
      }
      try {
        const { data } = await playRequest(target, {
          ...params,
          guild_id: DEFAULT_GUILD_ID,
          requester_id: requesterId,
        }, sourceText, signal, route);
        const normalized = normalizePlayResult(data);
        markPlaybackEvidence(data, "play", playbackEvidenceHint(trustedHint, trustedHint, route, requesterId));
        if (!normalized.ok) {
          const failed = attachVoiceStatus({
            ...data,
            status: "error",
            message: "",
            llm_hint: ranaError(normalized.message),
          }, requesterId, "play", trustedHint);
          return { content: [{ type: "text", text: JSON.stringify(failed) }] };
        }
        const result = attachVoiceStatus(data, requesterId, "play", trustedHint);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        if (!isRequestTimeoutError(err)) {
          const data = { status: "error", message: err?.message || String(err), llm_hint: ranaError(err?.message || String(err)) };
          return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "play", trustedHint)) }] };
        }
        let queueState = null;
        try {
          queueState = await queueStateAfterSlowPlay(route.baseUrl);
        } catch (_) {}
        if (!hasPlaybackEvidence(queueState)) {
          const data = { status: "error", message: "play request timed out before playback evidence", llm_hint: ranaError(err?.message || String(err)) };
          return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "play", trustedHint)) }] };
        }
        markPlaybackEvidence(queueState, "pending", playbackEvidenceHint(trustedHint, trustedHint, route, requesterId));
        const data = { status: "pending", message: "play request is still processing", queued_count: Number(queueState?.queued || 0), title: queueState?.current?.title || null, llm_hint: ranaPlayPendingFromQueue(queueState || {}) };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "pending", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_stop_music",
    label: "Rana Stop Music",
    description: "Current-turn only: stop playback when the user explicitly says stop / 停 / 停下 / 停止 / 停止播放. Keep the bot in voice.",
    parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx);
      if (!trusted.ok) return trustedToolError("rana_stop_music", trusted);
      const trustedHint = trustedContextHint(trusted);
      try {
        const route = routeFromParams(params, trusted);
        if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), "", "stop", trustedHint)) }] };
        const data = await postStop({ ...params, guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, signal, route.baseUrl);
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "stop", trustedHint)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, "", "stop", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_show_queue",
    label: "Rana Show Queue",
    description: "Current-turn only: show the queue for explicit queue/list requests such as 列表 / 歌單 / 現在還有哪些歌.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, text_channel_id: { type: "string" }, panel: { type: "boolean" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx);
      if (!trusted.ok) return trustedToolError("rana_show_queue", trusted);
      const trustedHint = trustedContextHint(trusted);
      const route = routeFromParams(params, trusted);
      if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), "", "queue", trustedHint)) }] };
      try {
        if (params?.panel !== false) {
          const trustedChannelId = firstText(trustedHint?.channelId) || recentTextChannelId(trustedHint);
          await postQueuePanel({ guild_id: DEFAULT_GUILD_ID, text_channel_id: trustedChannelId, bot_id: route.botId }, signal, route.baseUrl);
        }
        const data = await getQueue(DEFAULT_GUILD_ID, signal, route.baseUrl);
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "queue", trustedHint)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, "", "queue", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_skip_music",
    label: "Rana Skip Music",
    description: "Current-turn only: skip/remove when the user explicitly says skip / 跳過 / 拿掉.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, query: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx);
      if (!trusted.ok) return trustedToolError("rana_skip_music", trusted);
      const trustedHint = trustedContextHint(trusted);
      try {
        const route = routeFromParams(params, trusted);
        if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), "", "skip", trustedHint)) }] };
        const data = await postSkip({ ...params, guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, signal, route.baseUrl);
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "skip", trustedHint)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, "", "skip", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_volume_music",
    label: "Rana Volume Music",
    description: "Current-turn only: read/change volume for explicit 音量 / volume / 小聲 / 大聲 / 靜音 commands.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, volume: { type: "number" }, delta: { type: "number" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx);
      if (!trusted.ok) return trustedToolError("rana_volume_music", trusted);
      const trustedHint = trustedContextHint(trusted);
      const route = routeFromParams(params, trusted);
      if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), "", "volume", trustedHint)) }] };
      try {
        if (typeof params?.volume === "number" || typeof params?.delta === "number") {
          const data = await postVolume({ ...params, guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, signal, route.baseUrl);
          return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "volume", trustedHint)) }] };
        }
        const data = await getQueue(DEFAULT_GUILD_ID, signal, route.baseUrl);
        return { content: [{ type: "text", text: JSON.stringify({ volume: data?.volume ?? 35 }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, "", "volume", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_join_voice",
    label: "Rana Join Voice",
    description: "Current-turn only: join the requester's voice channel for an explicit 進來 / 加入 / join command.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, requester_id: { type: "string" }, channel_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx, { requireRequester: true });
      if (!trusted.ok) return trustedToolError("rana_join_voice", trusted);
      const trustedHint = trustedContextHint(trusted);
      const route = routeFromParams(params, trusted);
      const requesterId = resolveToolRequesterId(params, trusted);
      if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), requesterId, "join", trustedHint)) }] };
      if (!requesterId) {
        const data = { status: "error", llm_hint: "找不到進語音的人。" };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "join", trustedHint)) }] };
      }
      try {
        const data = await postJoin({ ...params, guild_id: DEFAULT_GUILD_ID, requester_id: requesterId, bot_id: route.botId, persona_id: route.personaId, account_id: route.accountId }, signal, route.baseUrl);
        if (!recordJoinEvidence(data, trustedHint, trustedHint, route, requesterId)) throw new Error("voice join did not confirm joined status");
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "join", trustedHint)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, requesterId, "join", trustedHint)) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_leave_voice",
    label: "Rana Leave Voice",
    description: "Current-turn only: leave voice for an explicit 離開 / 出去 / leave / disconnect command.",
    parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx);
      if (!trusted.ok) return trustedToolError("rana_leave_voice", trusted);
      const trustedHint = trustedContextHint(trusted);
      try {
        const route = routeFromParams(params, trusted);
        if (!route.baseUrl) return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(invalidRouteData(route), "", "leave", trustedHint)) }] };
        const data = await postLeave({ ...params, guild_id: DEFAULT_GUILD_ID, bot_id: route.botId }, signal, route.baseUrl);
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "leave", trustedHint)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(voiceToolFailure(error, "", "leave", trustedHint)) }] };
      }
    },
  });
}

export const __test = {
  attachVoiceStatus,
  currentTurnMusicHint,
  normalizeMusicBotId,
  markPlaybackEvidence,
  playbackEvidenceHint,
  recordJoinEvidence,
  resolveToolRequesterId,
  voiceStatus,
  routeFromEvent,
  routeFromParams,
};

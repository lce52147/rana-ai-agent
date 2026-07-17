import {
  firstText,
  hasExplicitPlayIntent,
  isPlainKeyword,
  isProtectedBareNoun,
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
  if (/request timeout|timed?\s*out|timeout/i.test(raw)) return "不行。音源太慢，還沒確認有播。";
  if (/voice bridge.*offline|Discord bot not ready|Discord not ready/i.test(raw)) return "不行。語音橋沒醒。";
  if (/Bot is not in guild|not in guild/i.test(raw)) return "不行。Rana 不在這個伺服器語音狀態裡。";
  if (/not in voice|voice channel|Voice join timeout|Missing requester/i.test(raw)) return "不行。你要先在語音頻道。";
  if (/Lavalink|session not established|player/i.test(raw)) return "不行。Lavalink 沒接好。";
  if (/no playable|no result|Playlist had no playable|yt-dlp search returned no playable/i.test(raw)) return "找不到。無聊。";
  if (/Sign in|login|required|private|members-only|age/i.test(raw)) return "不行。那個要登入或有限制。";
  if (/Extraction|playback failed|Unexpected|HTTP \d+|api\/play|127\.0\.0\.1|stack|Error:|ValidationError|JSON/i.test(raw)) return "不行。音源抓到了，但播放沒成功。";
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

function markPlaybackEvidence(data, action = "play") {
  rememberToolEvidence("rana_play_music", action, hasPlaybackEvidence(data), data);
}

function resolveToolRequesterId(params = {}) {
  return recentRequesterId() || firstText(params?.requester_id) || firstText(params?.requester);
}

function voiceStatus(data = {}, requesterId = "", action = "play") {
  const context = recentContextSnapshot({ requester_id: requesterId });
  return {
    action,
    guild_id: DEFAULT_GUILD_ID,
    requester_id: requesterId || context.requester_id || "",
    text_channel_id: context.text_channel_id,
    sidecar_status: firstText(data?.status),
    playback_evidence: hasPlaybackEvidence(data),
    current: data?.current || null,
    queued: Number(data?.queued ?? data?.queued_count ?? 0),
    message: firstText(data?.message),
    llm_hint: firstText(data?.llm_hint),
  };
}

function attachVoiceStatus(data = {}, requesterId = "", action = "play") {
  return {
    ...data,
    voice_status: voiceStatus(data, requesterId, action),
  };
}

async function playRequest(target, params, sourceText, signal) {
  const playUrl = await resolvePlayTarget(target, sourceText);
  const data = await postPlay({
    ...params,
    guild_id: DEFAULT_GUILD_ID,
    url: playUrl,
    requester_id: params.requester_id,
    requester: firstText(params.requester) || params.requester_id,
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
  routeLog(control.kind, routeText, control.query ? `query="${compactText(control.query)}"` : "");
  try {
    if (control.kind === "queue") {
      await postQueuePanel({
        guild_id: DEFAULT_GUILD_ID,
        text_channel_id: resolveTextChannelId(event, ctx),
      });
      return { handled: true, text: ok("歌單丟出去了。") };
    }
    if (control.kind === "next") return { handled: true, text: formatNext(await getQueue(DEFAULT_GUILD_ID)) };
    if (control.kind === "skip") {
      const data = await postSkip({ guild_id: DEFAULT_GUILD_ID, query: control.query });
      if (data.status === "removed") return { handled: true, text: ok(`${data.removed?.title || "那首"} 拿掉了。`) };
      if (data.status === "skipped") return { handled: true, text: ok(data.current?.title ? `跳到 ${data.current.title}。` : "跳過了。") };
      return { handled: true, text: "沒有東西能跳。" };
    }
    if (control.kind === "volume") return { handled: true, text: formatVolume(await postVolume({ guild_id: DEFAULT_GUILD_ID, volume: control.volume, delta: control.delta })) };
    if (control.kind === "volume_query") return { handled: true, text: formatVolume(await getQueue(DEFAULT_GUILD_ID)) };
    if (control.kind === "stop") {
      await postStop({ guild_id: DEFAULT_GUILD_ID });
      return { handled: true, text: "停下來了。" };
    }
    if (control.kind === "join") {
      const requesterId = resolveRequesterId(event, ctx);
      if (!requesterId) return { handled: true, text: "不行。找不到你。" };
      await postJoin({ guild_id: DEFAULT_GUILD_ID, requester_id: requesterId });
      return { handled: true, text: ok("進來了。") };
    }
    if (control.kind === "leave") {
      await postLeave({ guild_id: DEFAULT_GUILD_ID });
      return { handled: true, text: "出去了。" };
    }
  } catch (err) {
    console.warn(`[rana-music-tools] control error (${control.kind}): ${err?.message || String(err)}`);
    return { handled: true, text: ranaError(err?.message || String(err)) };
  }
  return null;
}

export async function handlePlayRequest(parsed, event, ctx, routeText) {
  routeLog("play", routeText, parsed.query ? `query="${compactText(parsed.query)}" source="${parsed.source || "youtube"}"` : `url="${compactText(parsed.url)}"`);
  const requesterId = resolveRequesterId(event, ctx);
  if (!requesterId) return { handled: true, text: "不行。找不到你。" };
  try {
    const target = parsed.url || parsed.query;
    const { data } = await playRequest(target, {
      guild_id: DEFAULT_GUILD_ID,
      requester_id: requesterId,
      requester: requesterId,
    }, routeText);
    const normalized = normalizePlayResult(data);
    if (!normalized.ok) throw new Error(normalized.message);
    markPlaybackEvidence(data);
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
        const queueState = await queueStateAfterSlowPlay();
        if (hasPlaybackEvidence(queueState)) {
          markPlaybackEvidence(queueState, "pending");
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
  api.registerTool({
    name: "rana_play_music",
    label: "Rana Play Music",
    description: [
      "Play music through Rana's Discord voice pipeline.",
      "MUST call this tool for explicit playback requests, including 播放春日影, 播放 <YouTube/Bilibili URL>, play <song>.",
      "For a named song without URL, pass query as the song/search text and source_text as the original user message.",
      "Use guild_id 1486679037605842944 when unsure; the tool will also enforce the correct guild internally.",
      "Do not call this tool for bare lore, band, character, or topic names such as CRYCHIC, MyGO!!!!!, Ave Mujica, or 樂奈 unless the user explicitly asks to play/listen/queue it.",
      "If the tool result says status:error or contains llm_hint/message failure, do not claim playback success.",
    ].join(" "),
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
      },
      required: ["guild_id"],
    },
    execute: async (_toolCallId, params, signal) => {
      const target = firstText(params?.url) || firstText(params?.query);
      if (!target) return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "沒有歌曲。" }) }] };
      if (isPlainKeyword(target) && isProtectedBareNoun(target)) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "那是名詞，不是播放指令。" }) }] };
      }
      const sourceText = firstText(params?.source_text) || recentDiscordText(params);
      if (isPlainKeyword(target) && !hasExplicitPlayIntent(sourceText)) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", llm_hint: "沒有明確播放指令。" }) }] };
      }
      const requesterId = resolveToolRequesterId(params);
      if (!requesterId) {
        const data = { status: "error", llm_hint: "找不到點歌的人。" };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "play")) }] };
      }
      try {
        const { data } = await playRequest(target, {
          ...params,
          guild_id: DEFAULT_GUILD_ID,
          requester_id: requesterId,
        }, sourceText, signal);
        const normalized = normalizePlayResult(data);
        markPlaybackEvidence(data);
        const result = attachVoiceStatus(data, requesterId, "play");
        if (!normalized.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ...result, status: "error", llm_hint: ranaError(normalized.message) }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        if (!isRequestTimeoutError(err)) {
          const data = { status: "error", message: err?.message || String(err), llm_hint: ranaError(err?.message || String(err)) };
          return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "play")) }] };
        }
        let queueState = null;
        try {
          queueState = await queueStateAfterSlowPlay();
        } catch (_) {}
        if (!hasPlaybackEvidence(queueState)) {
          const data = { status: "error", message: "play request timed out before playback evidence", llm_hint: ranaError(err?.message || String(err)) };
          return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "play")) }] };
        }
        markPlaybackEvidence(queueState, "pending");
        const data = { status: "pending", message: "play request is still processing", queued_count: Number(queueState?.queued || 0), title: queueState?.current?.title || null, llm_hint: ranaPlayPendingFromQueue(queueState || {}) };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "pending")) }] };
      }
    },
  });

  api.registerTool({
    name: "rana_stop_music",
    label: "Rana Stop Music",
    description: "Stop playback but keep Rana in the current Discord voice channel.",
    parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => ({ content: [{ type: "text", text: JSON.stringify(await postStop({ ...params, guild_id: DEFAULT_GUILD_ID }, signal)) }] }),
  });

  api.registerTool({
    name: "rana_show_queue",
    label: "Rana Show Queue",
    description: "Show Rana's music queue or refresh the Discord queue panel.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, text_channel_id: { type: "string" }, panel: { type: "boolean" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => {
      if (params?.panel !== false) {
        await postQueuePanel({ guild_id: DEFAULT_GUILD_ID, text_channel_id: firstText(params?.text_channel_id) || recentTextChannelId() }, signal);
      }
      return { content: [{ type: "text", text: JSON.stringify(await getQueue(DEFAULT_GUILD_ID, signal)) }] };
    },
  });

  api.registerTool({
    name: "rana_skip_music",
    label: "Rana Skip Music",
    description: "Skip the current song or remove a queued song by title.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, query: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => ({ content: [{ type: "text", text: JSON.stringify(await postSkip({ ...params, guild_id: DEFAULT_GUILD_ID }, signal)) }] }),
  });

  api.registerTool({
    name: "rana_volume_music",
    label: "Rana Volume Music",
    description: "Read or change Rana's music volume.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, volume: { type: "number" }, delta: { type: "number" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => {
      if (typeof params?.volume === "number" || typeof params?.delta === "number") {
        return { content: [{ type: "text", text: JSON.stringify(await postVolume({ ...params, guild_id: DEFAULT_GUILD_ID }, signal)) }] };
      }
      const data = await getQueue(DEFAULT_GUILD_ID, signal);
      return { content: [{ type: "text", text: JSON.stringify({ volume: data?.volume ?? 35 }) }] };
    },
  });

  api.registerTool({
    name: "rana_join_voice",
    label: "Rana Join Voice",
    description: "Join the requester's current Discord voice channel.",
    parameters: { type: "object", properties: { guild_id: { type: "string" }, requester_id: { type: "string" }, channel_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => {
      const requesterId = resolveToolRequesterId(params);
      if (!requesterId) {
        const data = { status: "error", llm_hint: "找不到進語音的人。" };
        return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "join")) }] };
      }
      const data = await postJoin({ ...params, guild_id: DEFAULT_GUILD_ID, requester_id: requesterId }, signal);
      return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, requesterId, "join")) }] };
    },
  });

  api.registerTool({
    name: "rana_leave_voice",
    label: "Rana Leave Voice",
    description: "Leave the Discord voice channel.",
    parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
    execute: async (_toolCallId, params, signal) => {
      const data = await postLeave({ ...params, guild_id: DEFAULT_GUILD_ID }, signal);
      return { content: [{ type: "text", text: JSON.stringify(attachVoiceStatus(data, "", "leave")) }] };
    },
  });
}

export const __test = {
  attachVoiceStatus,
  resolveToolRequesterId,
  voiceStatus,
};

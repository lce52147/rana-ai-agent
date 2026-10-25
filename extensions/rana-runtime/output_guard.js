import OpenCC from "opencc-js";
import { writeGenerationTrace } from "./architecture/generation_trace.js";
import {
  firstText,
  hasExplicitPlayIntent,
  isCurrentSessionMemoryQuestion,
  isExplicitMemoryIntent,
  expectedToolForText,
  parseControlRequest,
  parsePlayRequest,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
} from "./tool_contracts.js";
import {
  consumeRecentToolEvidence,
  consumeRecentToolOutcome,
  isNoMatchContext,
  isRecentDirectMention,
  recentDiscordText,
} from "./context_store.js";
import { resolveBotContext } from "./bot_context.js";

const DISCORD_REPLY_MAX_CHARS = 1800;
const CONVERT_SIMPLIFIED_TO_TRADITIONAL = OpenCC.Converter({ from: "cn", to: "tw" });

export function toTraditionalLite(text) {
  return CONVERT_SIMPLIFIED_TO_TRADITIONAL(firstText(text));
}

function outgoingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string" ? item : firstText(item?.text))
      .filter(Boolean)
      .join("\n");
  }
  return firstText(value?.text) || firstText(value?.content);
}

function stripRanaSelfSpeakerLabel(value) {
  return String(value || "")
    .replace(/^\s*(?:要)?樂奈\s*[:：]\s*/u, "")
    .trimStart();
}

export function sanitizeRanaTone(text) {
  const clean = toTraditionalLite(text).trim();
  if (/Context limit exceeded|reset our conversation|compaction buffer|reserveTokensFloor/i.test(clean)) {
    return "頭撞到上限了。再一次。";
  }

  let normalized = stripRanaSelfSpeakerLabel(clean)
    .replace(/```(?:plaintext|text)?\s*NO_REPLY\.?\s*```/gi, "")
    .replace(/^NO_REPLY\.?\s*/i, "")
    .replace(/\bNO_REPLY\.?\b/gi, "")
    .replace(/\[\[reply_to_current\]\]/gi, "")
    .trim();

  normalized = normalized
    .replace(/對(?:要)?樂奈而言/gu, "對我來說")
    .replace(/(?:要)?樂奈認為/gu, "我覺得")
    .replace(/(?:要)?樂奈對([^，。\n]{1,40})的印象/gu, "我對$1的印象")
    .replace(/(?:要)?樂奈覺得/gu, "我覺得")
    .replace(/(?:要)?樂奈知道/gu, "我知道")
    .replace(/(?:要)?樂奈記得/gu, "我記得");

  if (!normalized) return "\u7121\u804a\u3002";
  if (normalized.length <= DISCORD_REPLY_MAX_CHARS) return normalized;
  const clipped = normalized.slice(0, DISCORD_REPLY_MAX_CHARS);
  const boundary = Math.max(
    clipped.lastIndexOf("\u3002"),
    clipped.lastIndexOf("\uff01"),
    clipped.lastIndexOf("\uff1f"),
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );
  return (boundary >= 24 ? clipped.slice(0, boundary + 1) : clipped).trim();
}

function looksLikePlaybackSuccess(text) {
  return /(?:Now playing|queued|playing)/i.test(text)
    || /(?:\u5f48\u4e86|\u64ad\u4e86|\u6b63\u5728\u64ad\u653e|\u5df2\u52a0\u5165|\u6392\u4e86|\u6392\u9032|\u958b\u59cb\u64ad)/u.test(text);
}

const MUSIC_TOOL_IDS = Object.freeze({
  join: "rana_join_voice",
  leave: "rana_leave_voice",
  play: "rana_play_music",
  queue: "rana_show_queue",
  skip: "rana_skip_music",
  volume: "rana_volume_music",
  stop: "rana_stop_music",
});

function fallbackNoticeMetadata(value) {
  if (!value || typeof value !== "object") return false;
  return value.isFallbackNotice === true
    || value.metadata?.isFallbackNotice === true
    || value.contextHint?.isFallbackNotice === true
    || value.contextHint?.metadata?.isFallbackNotice === true;
}

function isRuntimeFallbackNotice(text, content, contextHint) {
  if (fallbackNoticeMetadata(content) || fallbackNoticeMetadata(contextHint)) return true;
  const clean = firstText(text).trim();
  return /^(?:↪️\s*)?Model Fallback:\s*[\s\S]*$/iu.test(clean)
    || /^(?:↪️\s*)?Model Fallback cleared:\s*[\s\S]*$/iu.test(clean)
    || /^(?:↪️\s*)?selected model unavailable(?:\s*[:：-]\s*\S[\s\S]*)?$/iu.test(clean);
}

function toolMetaValues(contextHint) {
  return [
    contextHint?.toolMetas,
    contextHint?.metadata?.toolMetas,
    contextHint?.toolResults,
    contextHint?.metadata?.toolResults,
  ].flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
}

function toolMetaName(meta) {
  return firstText(meta?.toolName || meta?.tool_name || meta?.name || meta?.tool || meta?.id);
}

function toolMetaAction(meta) {
  return firstText(meta?.action || meta?.toolAction || meta?.tool_action || meta?.operation);
}

function hasSuccessfulToolMeta(contextHint, toolId, action) {
  return toolMetaValues(contextHint).some((meta) => {
    if (toolMetaName(meta) !== toolId) return false;
    if (toolMetaAction(meta) && toolMetaAction(meta) !== action) return false;
    if (meta?.ok === false || meta?.success === false || meta?.error) return false;
    const result = meta?.result || meta?.output || meta?.response;
    const resultStatus = String(result?.status || "").toLowerCase();
    return meta?.ok === true
      || meta?.success === true
      || ["ok", "success", "completed", "joined", "playing", "queued"].includes(String(meta?.status || "").toLowerCase())
      || result?.ok === true
      || result?.success === true
      || ["ok", "success", "completed", "joined", "playing", "queued"].includes(resultStatus);
  });
}

function consumeMusicEvidence(evidencePairs, contextHint) {
  if (evidencePairs.some(({ toolId, action }) => hasSuccessfulToolMeta(contextHint, toolId, action))) return true;
  return evidencePairs.some(({ toolId, action }) => consumeRecentToolEvidence(toolId, action, contextHint));
}

function evidencePairsForRequest(sourceText, kind) {
  const control = parseControlRequest({ body: sourceText, content: sourceText });
  if (kind === "voice") {
    return [{
      toolId: control?.kind === "leave" ? MUSIC_TOOL_IDS.leave : MUSIC_TOOL_IDS.join,
      action: control?.kind === "leave" ? "leave" : "join",
    }];
  }
  if (parsePlayRequest({ body: sourceText, content: sourceText })) {
    return [
      { toolId: MUSIC_TOOL_IDS.play, action: "play" },
      { toolId: MUSIC_TOOL_IDS.play, action: "pending" },
    ];
  }
  const byKind = {
    queue: { toolId: MUSIC_TOOL_IDS.queue, action: "queue" },
    next: { toolId: MUSIC_TOOL_IDS.queue, action: "next" },
    skip: { toolId: MUSIC_TOOL_IDS.skip, action: "skip" },
    volume: { toolId: MUSIC_TOOL_IDS.volume, action: "volume" },
    volume_query: { toolId: MUSIC_TOOL_IDS.volume, action: "volume_query" },
    stop: { toolId: MUSIC_TOOL_IDS.stop, action: "stop" },
  };
  return byKind[control?.kind] ? [byKind[control.kind]] : [];
}

function musicSuccessKind(text, sourceText, allowUnscoped = false) {
  if (!sourceText) {
    if (!allowUnscoped) return null;
    if (/^(?:已加入(?:語音頻道|語音)|加入了語音頻道|我進來了|進來了|joined(?: the)? voice(?: channel)?|connected to voice(?: channel)?|已離開(?:語音頻道|語音)|left(?: the)? voice(?: channel)?|disconnected from voice)[。.!！]?$/iu.test(text)) return "voice";
    if (/^(?:正在播放|已開始播放|已加入隊列|已排入隊列|已跳過|已停止播放|音量已(?:設為|調整為)|Now playing\b|queued\b|skipped\b|stopped\b|playing\b)[\s\S]*$/iu.test(text)) return "music";
    return null;
  }
  const control = parseControlRequest({ body: sourceText, content: sourceText });
  const play = Boolean(parsePlayRequest({ body: sourceText, content: sourceText }));
  const voice = control?.kind === "join" || control?.kind === "leave";
  const music = play || (control && !voice);
  if (!voice && !music) return null;
  if (voice && /(?:joined|connected|left|disconnected|已加入|加入了|進入|連上|離開|退出|我進來了|進來了)/iu.test(text)) return "voice";
  if (music && looksLikePlaybackSuccess(text)) return "music";
  if (music && /(?:queued|queue updated|skipped|stopped|paused|resumed|volume|已排入|排進|佇列|跳過|停止播放|暫停|繼續播放|音量)/iu.test(text)) return "music";
  return null;
}

function looksLikeMemoryRememberSuccess(text) {
  return /(?:saved|remembered)/i.test(text)
    || /(?:\u8a18\u4f4f\u4e86|\u8a18\u4e0b\u4e86|\u5df2\u8a18\u4f4f|\u5e6b\u4f60\u8a18)/u.test(text);
}

function leaksInternalText(text) {
  return /(?:tool_call|before_dispatch|message_sending|source_text|llm_hint|system prompt|persona|routing|rana-music-tools|rana_hot_tools|sidecar|pre-dispatch|dispatch|NO_REPLY)/i.test(text)
    || /(?:查(?:一下)?記憶|查詢記憶|呼叫工具|調用工具|工具回傳|正在查|查資料庫|內部流程|內部動作)/u.test(text);
}

function leaksRanaDataLanguage(text) {
  return /(?:recognitionLevel|memoryAnchors|allowedKnowledge|allowedReactionStyle|forbiddenExpansion|canonicalId|canonicalName|sourceRefs|rana_character_impressions|rana_person_context|rana_lore)/i.test(text)
    || /(?:認知層級|互動層級|記憶錨點|外層(?:關係|脈絡|資料)|單次記憶|形成印象|資料欄位|事件索引|研究摘要|根據(?:劇情|設定|資料|研究)|依據(?:是|為|來自)|官方設定顯示)/u.test(text)
    || /(?:^|\n)#{1,3}\s*(?:Rana Runtime Core|Rana First-Person Knowledge|Rana Remembered People|Rana Speech Style|CHARACTER_CORE)/iu.test(text);
}

function exposesInternalFailureWording(text) {
  return /(?:工具(?:沒抓到資料|失敗|出錯)|搜尋(?:失敗|出錯))/u.test(text);
}

function hideMemoryProvenance(text) {
  const clean = firstText(text).trim();
  if (/^(?:根據|依照|照著)(?:我的)?記憶(?:裡|中)?[，,：:]?\s*/u.test(clean)) {
    return clean.replace(/^(?:根據|依照|照著)(?:我的)?記憶(?:裡|中)?[，,：:]?\s*/u, "").trim();
  }
  if (/^(?:在)?(?:我的)?記憶(?:裡|中)(?:沒有|沒)(?:關於)?/u.test(clean)
    || /^(?:沒有|沒)有(?:關於)?.{0,80}(?:記憶|資料|資訊)/u.test(clean)) {
    return "不知道。";
  }
  return clean;
}

function looksLikeBrokenPunctuation(text) {
  const compact = firstText(text).replace(/\s+/g, "");
  if (compact.length < 12) return false;
  if (/^[?？!！.。…~～、,，;；:：]+$/u.test(compact)) return true;
  const questionMarks = (compact.match(/[?？]/gu) || []).length;
  return questionMarks >= 8 && compact.replace(/[?？]/gu, "").length <= 3;
}

export function guardOutgoingMessage(content, contextHint) {
  const text = outgoingText(content).trim();
  if (!text) return undefined;
  if (isRuntimeFallbackNotice(text)) {
    writeGenerationTrace({
      phase: "output_guard_protocol_boundary",
      action: "cancel_runtime_fallback_notice",
      sessionKey: String(contextHint?.sessionKey || ""),
      runId: String(contextHint?.runId || ""),
      rawCandidate: text.slice(0, 4000),
    });

    return {
      cancel: true,
      cancelReason: "runtime_model_fallback_notice",
    };
  }
  const botContext = resolveBotContext(contextHint, contextHint);
  writeGenerationTrace({
    phase: "output_guard_observation",
    action: "observe_only_no_output_intervention",
    sessionKey: String(contextHint?.sessionKey || ""),
    runId: String(contextHint?.runId || ""),
    personaId: botContext?.personaId || "",
    rawCandidate: text.slice(0, 4000),
  });
  // Anti-cheat invariant: model text is the only generative output owner.
  // No conversion, cleanup, clipping, fixed fallback, cancellation, retry, or
  // semantic replacement is allowed here. Tool execution remains governed by
  // pre-tool authorization, not by post-generation text rewriting.
  return undefined;
}


export const __test = {
  guardOutgoingMessage,
  sanitizeRanaTone,
  toTraditionalLite,
  looksLikeBrokenPunctuation,
  leaksRanaDataLanguage,
  hideMemoryProvenance,
  stripRanaSelfSpeakerLabel,
};

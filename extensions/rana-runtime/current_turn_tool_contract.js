const MUSIC_TOOL = "rana_play_music";
const MUSIC_TOOL_NAMES = Object.freeze([
  MUSIC_TOOL,
  "rana_stop_music",
  "rana_show_queue",
  "rana_skip_music",
  "rana_volume_music",
  "rana_join_voice",
  "rana_leave_voice",
]);
const VISION_TOOL = "rana_analyze_image";
const STOCK_TOOL = "rana_stock_research";
const RANA_LORE_TOOL = "rana_lore_search";
const PERSONA_LORE_TOOL = "persona_lore_search";
const PERSONA_EVIDENCE_TOOL_NAMES = Object.freeze([RANA_LORE_TOOL, PERSONA_LORE_TOOL]);

export const CONTROLLED_TOOL_NAMES = Object.freeze([...MUSIC_TOOL_NAMES, VISION_TOOL, STOCK_TOOL, ...PERSONA_EVIDENCE_TOOL_NAMES]);
const CONTROLLED_TOOL_SET = new Set(CONTROLLED_TOOL_NAMES);
const CURRENT_MEDIA_TTL_MS = 2 * 60 * 1000;

const PLAY_COMMAND_RE = /^(?:(?:播放|撥放|點歌|放歌|幫我(?:播放|播|放))\s*|play\s+)(\S[\s\S]*?)\s*$/iu;
const PLAY_NEXT_COMMAND_RE = /^(?:插歌|插播|插一首|下一首(?:播放|播|放)|play\s+next)\s*(\S[\s\S]*?)\s*$/iu;
const PLAY_MISSING_TARGET_RE = /^(?:播放|撥放|點歌|放歌|幫我(?:播放|播|放)|play)\s*$/iu;
const PLAY_NEXT_MISSING_TARGET_RE = /^(?:插歌|插播|插一首|下一首(?:播放|播|放)|play\s+next)\s*$/iu;
const NEXT_QUERY_TARGET_RE = /^(?:什麼|甚麼|哪首|哪一首|什麼歌|哪首歌)[?？]?$/iu;

const MUSIC_CONTROL_TOOL_BY_KIND = Object.freeze({
  join: "rana_join_voice",
  leave: "rana_leave_voice",
  queue: "rana_show_queue",
  next: "rana_show_queue",
  skip: "rana_skip_music",
  volume: "rana_volume_music",
  volume_query: "rana_volume_music",
  stop: "rana_stop_music",
});
const STOCK_COMMAND_RE = /^\u6211\u60f3\u770b\u7f8e\u80a1\s+([A-Z][A-Z0-9.]{0,7})$/u;

const NEGATED_VISION_OPERATION_RE =
  /(?:\u4e0d\u8981|\u4e0d\u7528|\u5225|\u4e0d\u5fc5|\u7121\u9700).{0,8}(?:\u770b|\u8fa8\u8b58|\u8fa8\u8a8d|\u8b58\u5225|\u5206\u6790|\u67e5|\u78ba\u8a8d|\u63cf\u8ff0|\u89e3\u8b80|\u8b80\u53d6)|(?:do\s+not|don't|no\s+need\s+to).{0,16}(?:look|check|identify|recognize|analy[sz]e|describe)/iu;
const REQUESTED_VISION_OPERATION_RE =
  /(?:\u5e6b\u6211|\u8acb|\u9ebb\u7169|\u53ef\u4ee5|\u80fd\u4e0d\u80fd|\u80fd|\u66ff\u6211).{0,8}(?:\u770b|\u8fa8\u8b58|\u8fa8\u8a8d|\u8b58\u5225|\u5206\u6790|\u67e5|\u78ba\u8a8d|\u63cf\u8ff0|\u89e3\u8b80|\u8b80\u53d6)|^(?:\u770b\u770b|\u770b\u4e00\u4e0b|\u770b|\u77a7|\u8fa8\u8b58|\u8fa8\u8a8d|\u8b58\u5225|\u5206\u6790|\u67e5|\u78ba\u8a8d|\u63cf\u8ff0|\u89e3\u8b80|\u8b80\u53d6)(?:\s|[\uff1a:\uff0c,\u3002\uff01\uff1f!?]|$)|(?:please\s+)?(?:look\s+at|check|identify|recognize|analy[sz]e|describe)\b/iu;
const DEICTIC_VISION_QUESTION_RE =
  /(?:\u9019|\u90a3|\u4ed6|\u5979|\u5b83|\u5716\u7247?|\u7167\u7247|\u756b\u9762|\u88e1\u9762|\u4e0a\u9762).{0,24}(?:\u662f\u8ab0|\u662f\u4ec0\u9ebc|\u54ea\u4f4d|\u54ea\u500b|\u6709\u4ec0\u9ebc|\u5728\u505a\u4ec0\u9ebc|\u600e\u9ebc\u4e86|\u770b\u5f97\u51fa|\u8a8d\u5f97\u55ce)|(?:who|what)\s+(?:is|are)\s+(?:this|that|he|she|they)|what(?:'s|\s+is)\s+(?:in|on)\s+(?:this|that)\s+(?:image|picture|photo)/iu;
const PRESENTED_IMAGE_RE =
  /(?:\u7d66|\u9001|\u5206\u4eab\u7d66|\u62ff\u7d66|\u50b3\u7d66)(?:\u4f60|\u59b3|\u4f60\u5011)|(?:\u4f60|\u59b3)(?:\u770b\u770b|\u770b\u4e00\u4e0b)(?:\u9019|\u90a3|\u5716|\u7167\u7247)?|(?:for\s+you|sending\s+you|sent\s+you|here(?:'s|\s+is))\b/iu;
const TOOL_DISCUSSION_RE =
  /(?:\b(?:tool|tools|keyword|trigger|invoke|call|schema|permission|authorization)\b|\u5de5\u5177|\u95dc\u9375\u5b57|\u89f8\u767c|\u547c\u53eb|\u6b0a\u9650|\u8a0e\u8ad6|discussion)/iu;
const OPERATION_WORD_RE =
  /(?:\u64ad\u653e|\u63d2\u6b4c|\u63d2\u64ad|play|\u97f3\u6a02|\u7f8e\u80a1|stock|vision|image|\u5716\u7247|\u7167\u7247)/iu;

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  if (value && typeof value === "object")
    return firstText(value.text) || firstText(value.content) || firstText(value.body);
  return "";
}

export function extractCurrentTurnText(value) {
  const text = firstText(value);
  if (!text) return "";
  const imageBlock = text.match(/\[Image\]\s*User text:\s*([\s\S]*?)(?:\r?\nDescription:|$)/iu);
  const markers = [
    ...text.matchAll(
      /UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/giu,
    ),
  ];
  const marker = markers.at(-1);
  const selected = imageBlock?.[1] || marker?.[1] || text;
  return selected
    .replace(
      /^\s*To send an image back, use the message tool with structured media fields[^\r\n]*(?:\r?\n)?/gimu,
      "",
    )
    .replace(/^\s*\[Discord[^\]]+\]\s*[^:\r\n]{1,160}:\s*/iu, "")
    .replace(/^\s*User text:\s*/iu, "")
    .replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/u, "")
    .trim();
}

function stripCurrentTurnAddress(value) {
  let clean = extractCurrentTurnText(value)
    .replace(/\[media attached:\s*[^\]]+\]\s*/giu, "")
    .replace(/<@!?\d+>/gu, "")
    .trimStart();
  const leadingName = /^@[\p{L}\p{N}_.-]+(?:#\d{4})?(?=\s|$|[,.!?;:\u3002\uff0c\uff1f\uff01\u3001])/u;
  while (leadingName.test(clean)) clean = clean.replace(leadingName, "").trimStart();
  return clean.trim();
}

function isToolDiscussion(value) {
  const clean = stripCurrentTurnAddress(value);
  return TOOL_DISCUSSION_RE.test(clean) && OPERATION_WORD_RE.test(clean);
}

export function parseMusicCommand(value) {
  const clean = stripCurrentTurnAddress(value);
  if (!clean || isToolDiscussion(clean)) return null;

  const playNext = clean.match(PLAY_NEXT_COMMAND_RE);
  if (playNext) {
    const target = String(playNext[1] || "").trim();
    if (!target || NEXT_QUERY_TARGET_RE.test(target)) return null;
    return { target, queue_mode: "next" };
  }

  const match = clean.match(PLAY_COMMAND_RE);
  if (!match) return null;
  const target = String(match[1] || "").trim();
  return target ? { target, queue_mode: "append" } : null;
}

export function isMissingMusicTarget(value) {
  const clean = stripCurrentTurnAddress(value);
  return PLAY_MISSING_TARGET_RE.test(clean) || PLAY_NEXT_MISSING_TARGET_RE.test(clean);
}

export function parseMusicControlCommand(value) {
  const clean = stripCurrentTurnAddress(value);
  if (!clean || isToolDiscussion(clean)) return null;

  if (
    /^(?:join|進來|加入)\s*$/iu.test(clean) ||
    /(?:join|voice|vc|進來|加入).*(?:voice|vc|語音|頻道)|(?:進來我這個頻道)/iu.test(clean)
  ) return { kind: "join" };

  if (
    /^(?:leave|disconnect|離開|出去|退語音|離開語音|退出語音)\s*$/iu.test(clean) ||
    /(?:leave|disconnect|離開|出去|退出).*(?:voice|vc|語音|頻道)|(?:退語音|離開這個頻道)/iu.test(clean)
  ) return { kind: "leave" };

  if (
    /^(?:queue|列表|歌單|歌曲列表|還有哪些歌|現在還有哪些歌|現在有(?:哪|什麼)些歌|現在有什麼歌|(?:現在|目前)(?:播|放)(?:什麼|甚麼))\s*[?？]?$/iu.test(clean)
  ) return { kind: "queue" };

  if (
    /^(?:next|下一首|下一首(?:歌)?(?:是|要)?(?:什麼|甚麼|哪首|哪一首)|下一首(?:歌)?[呢嗎]|下一首(?:放|播|播放)(?:什麼|甚麼|哪首|哪一首))\s*[?？]?$/iu.test(clean)
  ) return { kind: "next" };

  const volumeSet = clean.match(/^(?:volume|vol|音量)\s*(?:=|:|設(?:成)?|to)?\s*(\d{1,3})\s*%?$/iu);
  if (volumeSet) return { kind: "volume", volume: Number(volumeSet[1]) };

  if (/^(?:volume\?|vol\?|音量多少|現在音量)\s*[?？]?$/iu.test(clean)) return { kind: "volume_query" };
  if (/^(?:volume down|vol down|小聲|小聲一點|降音量|降低音量)\s*$/iu.test(clean)) return { kind: "volume", delta: -10 };
  if (/^(?:volume up|vol up|大聲|大聲一點|加音量|提高音量)\s*$/iu.test(clean)) return { kind: "volume", delta: 10 };
  if (/^(?:mute|靜音)\s*$/iu.test(clean)) return { kind: "volume", volume: 0 };

  const skip = clean.match(/^(?:skip|跳過|切歌|拿掉)(?:\s*(?:這一首|這首|目前這首|current)|\s+(.+))?\s*$/iu);
  if (skip) {
    const query = String(skip[1] || "").trim() || null;
    return { kind: "skip", query, remove_only: Boolean(query) };
  }

  if (/^(?:stop|停下|停|停歌|停止|停止播放|安靜|別放了|不要放了)\s*$/iu.test(clean)) return { kind: "stop" };

  return null;
}

export function musicControlToolName(commandOrKind) {
  const kind = typeof commandOrKind === "string" ? commandOrKind : commandOrKind?.kind;
  return MUSIC_CONTROL_TOOL_BY_KIND[String(kind || "")] || null;
}

export function parseStockCommand(value) {
  const clean = stripCurrentTurnAddress(value);
  const match = clean.match(STOCK_COMMAND_RE);
  return match ? { ticker: match[1] } : null;
}

export function hasExplicitVisionIntent(value) {
  const clean = stripCurrentTurnAddress(value);
  if (!clean || NEGATED_VISION_OPERATION_RE.test(clean)) return false;
  return (
    REQUESTED_VISION_OPERATION_RE.test(clean) ||
    DEICTIC_VISION_QUESTION_RE.test(clean) ||
    PRESENTED_IMAGE_RE.test(clean)
  );
}

function normalizeMediaPath(value) {
  const text = String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

function freezeMediaProvenance(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.attachments)) return null;
  const provenance = {
    currentTurn: value.currentTurn !== false,
    attachments: value.attachments.map((item) =>
      item && typeof item === "object" ? Object.freeze({ ...item }) : item,
    ),
  };
  if (Number.isFinite(Number(value.recordedAt))) provenance.recordedAt = Number(value.recordedAt);
  if (Array.isArray(value.authorizedPaths)) {
    provenance.authorizedPaths = value.authorizedPaths.map((item) => String(item || ""));
  }
  Object.freeze(provenance.attachments);
  if (provenance.authorizedPaths) Object.freeze(provenance.authorizedPaths);
  return Object.freeze(provenance);
}

/**
 * Reads only host-supplied per-run media evidence. Prompt text is deliberately
 * excluded: a [media attached: ...] marker is not provenance by itself.
 */
export function resolveCurrentTurnMediaProvenance(event = {}, ctx = {}) {
  const candidates = [
    event?.currentTurnMediaProvenance,
    event?.currentTurnMediaEvidence,
    event?.mediaProvenance,
    event?.mediaEvidence,
    ctx?.currentTurnMediaProvenance,
    ctx?.currentTurnMediaEvidence,
    ctx?.mediaProvenance,
    ctx?.mediaEvidence,
    event,
    ctx,
  ];
  for (const candidate of candidates) {
    const provenance = freezeMediaProvenance(candidate);
    if (provenance) return provenance;
  }
  return null;
}

export function currentTurnImagePaths(value) {
  const found = [];
  for (const match of extractCurrentTurnText(value).matchAll(
    /\[media attached:\s*([^\]\r\n]+?\.(?:png|jpe?g|webp|gif))(?:\s|\])/giu,
  )) {
    const path = String(match[1] || "").trim();
    if (path) found.push(path);
  }
  return [...new Set(found)];
}

export function isCurrentUsableImagePath(filePath, provenance = {}) {
  const supplied = normalizeMediaPath(filePath);
  if (!supplied || !Array.isArray(provenance?.attachments) || !provenance.attachments.length)
    return false;
  if (provenance.currentTurn === false) return false;
  if (
    Number.isFinite(provenance.recordedAt) &&
    Date.now() - provenance.recordedAt > CURRENT_MEDIA_TTL_MS
  )
    return false;
  const authorizedPaths = new Set(
    (Array.isArray(provenance.authorizedPaths) ? provenance.authorizedPaths : [])
      .map(normalizeMediaPath)
      .filter(Boolean),
  );
  return provenance.attachments.some((item) => {
    if (!item || typeof item !== "object") return false;
    const serialized = JSON.stringify(item).toLowerCase().replace(/\\\\/g, "\\");
    if (/(?:generated|youtube|thumbnail|preview|staged|synthetic)/iu.test(serialized)) return false;
    if (item.isGenerated === true || item.generated === true || item.userUploaded === false)
      return false;
    const kind = String(item.kind || item.type || "").toLowerCase();
    const mime = String(
      item.mimeType || item.mime_type || item.contentType || item.content_type || "",
    );
    const isImage = kind === "image" || /^image\//iu.test(mime);
    const itemPaths = [
      item.path,
      item.filePath,
      item.file_path,
      item.localPath,
      item.local_path,
      item.sourcePath,
      item.source_path,
      ...(Array.isArray(item.paths) ? item.paths : []),
    ]
      .map(normalizeMediaPath)
      .filter(Boolean);
    return isImage && (itemPaths.includes(supplied) || authorizedPaths.has(supplied));
  });
}

function normalizedAgentId(value) {
  const raw = String(value || "").trim();
  return raw === "rana" ? "main" : raw;
}

function isPersonaEvidenceToolAuthorized(toolName, plan, agentId) {
  const agent = normalizedAgentId(agentId);

  // The legacy Rana-only tool is never self-authorized by the model.
  // All five personas (Rana included) use persona_lore_search.
  if (toolName === RANA_LORE_TOOL) return false;

  if (!plan?.evidence?.required || plan?.evidence?.source !== "persona_canonical") return false;
  if (!agent) return false;

  if (toolName === PERSONA_LORE_TOOL) {
    return true;
  }
  return false;
}

export function isCurrentTurnToolAuthorized({ toolName, plan, mediaProvenance, mediaPath, agentId } = {}) {
  const requestedTool = String(toolName || "");
  const semanticTool = plan?.tool && typeof plan.tool === "object" ? plan.tool : { requested: false, kind: "none", toolName: "" };

  if (requestedTool === MUSIC_TOOL) {
    return semanticTool.kind === "music_play" && semanticTool.toolName === MUSIC_TOOL;
  }
  if (MUSIC_TOOL_NAMES.includes(requestedTool)) {
    return semanticTool.kind === "music_control" && semanticTool.toolName === requestedTool;
  }

  switch (requestedTool) {
    case STOCK_TOOL:
      return semanticTool.kind === "stock" && semanticTool.toolName === STOCK_TOOL;
    case RANA_LORE_TOOL:
    case PERSONA_LORE_TOOL:
      return isPersonaEvidenceToolAuthorized(requestedTool, plan, agentId);
    case VISION_TOOL: {
      if (!(semanticTool.kind === "vision" && semanticTool.toolName === VISION_TOOL)) return false;
      const textPaths = Array.isArray(semanticTool?.arguments?.imagePaths)
        ? semanticTool.arguments.imagePaths
        : [];
      const paths = textPaths.filter((path) => isCurrentUsableImagePath(path, mediaProvenance));
      if (mediaPath) {
        if (!isCurrentUsableImagePath(mediaPath, mediaProvenance)) return false;
        if (textPaths.length === 0) return true;
        return (
          paths.length === textPaths.length &&
          paths.some((path) => normalizeMediaPath(path) === normalizeMediaPath(mediaPath))
        );
      }
      if (textPaths.length > 0) return paths.length === textPaths.length;
      const attachments = Array.isArray(mediaProvenance?.attachments)
        ? mediaProvenance.attachments
        : [];
      return attachments.some((item) => {
        if (!item || typeof item !== "object") return false;
        const itemPath = item.path || item.filePath || item.localPath || item.sourcePath;
        return isCurrentUsableImagePath(itemPath, mediaProvenance);
      });
    }
    default:
      return false;
  }
}

export function resolveCurrentTurnToolSurface({ plan, mediaProvenance, toolNames, agentId } = {}) {
  const names = Array.isArray(toolNames)
    ? toolNames.filter((name) => typeof name === "string")
    : [];
  const allowedSensitive = new Set(
    CONTROLLED_TOOL_NAMES.filter((toolName) =>
      isCurrentTurnToolAuthorized({
        toolName,
        plan,
        mediaProvenance,
        agentId,
      }),
    ),
  );
  return {
    allowedToolNames: names.filter(
      (name) => !CONTROLLED_TOOL_SET.has(name) || allowedSensitive.has(name),
    ),
    allowedSensitiveToolNames: [...allowedSensitive],
  };
}

export const __test = {
  CONTROLLED_TOOL_NAMES,
  MUSIC_TOOL_NAMES,
  currentTurnImagePaths,
  extractCurrentTurnText,
  hasExplicitVisionIntent,
  isCurrentTurnToolAuthorized,
  isCurrentUsableImagePath,
  isMissingMusicTarget,
  musicControlToolName,
  parseMusicCommand,
  parseMusicControlCommand,
  parseStockCommand,
  resolveCurrentTurnMediaProvenance,
  resolveCurrentTurnToolSurface,
};

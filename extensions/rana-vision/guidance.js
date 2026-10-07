import { buildVisionEvidence } from "./evidence.js";
import { createVisionRequestId, traceVision } from "./debug.js";
import { loadInboundImage, loadRepliedDiscordImage } from "./client.js";
import { attachVisionFeedbackPanel, discordPromptMetadata, resolveDiscordResponseMessageId } from "./feedback.js";
import { buildMediaEvidenceContext } from "./media.js";
import { detectSearchPolicy } from "./deep_search.js";
import { buildLoreEvidencePack, loreEvidenceContext, safeEvidencePack } from "../rana-runtime/lore/retrieval.js";
import { rememberResolvedEntities, resolveEntityMentions } from "../rana-runtime/lore/entity_resolver.js";
import {
  hasExplicitVisionIntent as parseExplicitVisionIntent,
  isCurrentUsableImagePath,
} from "../rana-runtime/current_turn_tool_contract.js";

const pendingRuns = new Map();
const DELIVERY_TRACE_TTL_MS = 2 * 60 * 1000;
const RECENT_VISION_SUBJECT_TTL_MS = 30 * 60 * 1000;
const recentVisionSubjects = new Map();
const mediaProvenanceByTurn = new Map();
const MEDIA_PROVENANCE_TTL_MS = 2 * 60 * 1000;
const VISION_EVIDENCE_TTL_MS = 5 * 60 * 1000;

export function createVisionEvidenceCache(ttlMs = VISION_EVIDENCE_TTL_MS) {
  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (!entry?.createdAt || now - entry.createdAt > ttlMs) entries.delete(key);
    }
  }

  return {
    getOrCreate(key, factory, now = Date.now()) {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) return Promise.resolve().then(factory);
      prune(now);
      const existing = entries.get(normalizedKey);
      if (existing) return existing.promise;
      const entry = {
        createdAt: now,
        promise: Promise.resolve().then(factory),
      };
      entries.set(normalizedKey, entry);
      entry.promise.catch(() => {
        if (entries.get(normalizedKey) === entry) entries.delete(normalizedKey);
      });
      return entry.promise;
    },
    delete(key) {
      entries.delete(String(key || "").trim());
    },
    size(now = Date.now()) {
      prune(now);
      return entries.size;
    },
  };
}

const visionEvidenceCache = createVisionEvidenceCache();

function pruneMediaProvenance(now = Date.now()) {
  for (const [key, value] of mediaProvenanceByTurn) {
    if (!value?.recordedAt || now - value.recordedAt > MEDIA_PROVENANCE_TTL_MS) {
      mediaProvenanceByTurn.delete(key);
    }
  }
}

export function visionTurnKey(event = {}, ctx = {}) {
  const runId = String(ctx?.runId || event?.runId || "").trim();
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || "").trim();
  return runId && sessionKey ? `${runId}|${sessionKey}` : runId || sessionKey;
}

export function currentTurnProvenance(event, ctx) {
  pruneMediaProvenance();
  const key = visionTurnKey(event, ctx);
  return key ? mediaProvenanceByTurn.get(key) || null : null;
}

function createDeliveryTracker(ttlMs = DELIVERY_TRACE_TTL_MS) {
  const pending = [];

  function prune(now) {
    while (pending.length && now - pending[0].queuedAt > ttlMs) pending.shift();
  }

  function findNewestIndex(predicate) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (predicate(pending[index])) return index;
    }
    return -1;
  }

  function findIndex(context, now) {
    prune(now);
    if (!pending.length) return -1;
    const channelId = context?.channelId;
    const conversationId = context?.conversationId;
    // Outbound Discord hooks report `channelId: "discord"` and put the
    // actual Discord channel snowflake in `conversationId`.  Matching both
    // fields as if they were the same identifier drops every real delivery.
    // Prefer the concrete conversation id; only then fall back to channel id.
    if (conversationId) {
      const matched = findNewestIndex((entry) =>
        entry.conversationId === conversationId || entry.channelId === conversationId);
      if (matched >= 0) return matched;
    }
    if (channelId) {
      const matched = findNewestIndex((entry) =>
        entry.channelId === channelId || entry.conversationId === channelId);
      if (matched >= 0) return matched;
    }
    return pending.length === 1 ? 0 : -1;
  }

  return {
    enqueue(entry, now = Date.now()) {
      pending.push({ ...entry, queuedAt: now });
    },
    peek(context, now = Date.now()) {
      const index = findIndex(context, now);
      return index < 0 ? null : pending[index];
    },
    take(context, now = Date.now()) {
      const index = findIndex(context, now);
      return index < 0 ? null : pending.splice(index, 1)[0];
    },
    findByRunId(runId, now = Date.now()) {
      prune(now);
      if (!runId) return null;
      return pending.find((entry) => entry.runId === runId) || null;
    },
    findBySessionKey(sessionKey, now = Date.now()) {
      prune(now);
      if (sessionKey) {
        const index = findNewestIndex((entry) => entry.sessionKey === sessionKey);
        if (index >= 0) return pending[index];
      }
      return pending.length === 1 ? pending[0] : null;
    },
    size(now = Date.now()) {
      prune(now);
      return pending.length;
    },
  };
}

const deliveryTracker = createDeliveryTracker();

function rememberRecentVisionSubject(sessionKey, built) {
  const key = String(sessionKey || "").trim();
  const subject = built?.payload?.personaEvidence?.resolvedSubject;
  if (!key || !subject || subject.pipelineStatus !== "known") return;
  recentVisionSubjects.set(key, {
    updatedAt: Date.now(),
    payload: JSON.parse(JSON.stringify(built.payload)),
    sourceMessageId: built.sourceMessageId || "",
  });
}

function recallRecentVisionSubject(sessionKey) {
  const key = String(sessionKey || "").trim();
  const item = recentVisionSubjects.get(key);
  if (!item || Date.now() - item.updatedAt > RECENT_VISION_SUBJECT_TTL_MS) {
    if (item) recentVisionSubjects.delete(key);
    return null;
  }
  return item;
}

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  if (value && typeof value === "object") return firstText(value.text) || firstText(value.content) || firstText(value.body);
  return "";
}

function messageHasImage(message) {
  if (!message || typeof message !== "object") return false;
  if (String(message?.MediaPath || "").trim()) return true;
  if (Array.isArray(message?.MediaPaths) && message.MediaPaths.some((item) => String(item || "").trim())) return true;
  if (/^image\//i.test(String(message?.MediaType || ""))) return true;
  if (Array.isArray(message?.MediaTypes) && message.MediaTypes.some((item) => /^image\//i.test(String(item || "")))) return true;
  const content = firstText(message?.content);
  return /\[media attached:[^\]]+\.(?:png|jpe?g|webp|gif)|media:\/\/inbound\/|<media:image>|\[Image\]/i.test(content);
}

function messageContentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  return message?.content ? [message.content] : [];
}

function isVisionToolCallBlock(block) {
  return String(block?.type || "").toLowerCase() === "toolcall"
    && String(block?.name || "") === "rana_analyze_image";
}

export function stripHistoricalVisionWorkingPayloads(messages) {
  if (!Array.isArray(messages)) return [];
  const visionToolCallIds = new Set();
  for (const message of messages) {
    if (String(message?.role || "").toLowerCase() !== "assistant") continue;
    for (const block of messageContentBlocks(message)) {
      if (isVisionToolCallBlock(block) && block?.id) visionToolCallIds.add(String(block.id));
    }
  }

  const kept = [];
  for (const message of messages) {
    const role = String(message?.role || "").toLowerCase();
    if (role === "toolresult") {
      const toolName = String(message?.toolName || "");
      const toolCallId = String(message?.toolCallId || "");
      if (toolName === "rana_analyze_image" || visionToolCallIds.has(toolCallId)) continue;
    }
    if (role === "assistant") {
      const original = messageContentBlocks(message);
      const filtered = original.filter((block) => !isVisionToolCallBlock(block));
      if (filtered.length !== original.length) {
        if (!filtered.length) continue;
        kept.push({
          ...message,
          content: Array.isArray(message.content) ? filtered : filtered[0],
        });
        continue;
      }
    }
    kept.push(message);
  }
  return kept;
}

function isolateCurrentVisionHistory(messages) {
  if (!Array.isArray(messages)) return [];
  // A Vision Persona turn is fully grounded by the current user prompt and
  // personaEvidence. Keeping even text-only history here lets a short prior
  // answer (for example, a self-identity reply) override the current resolved
  // subject through prompt-cache continuation. Follow-up continuity is carried
  // explicitly by recentVisionSubjects and rebuilt as query-specific evidence.
  return [];
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role || "").toLowerCase() === "assistant") {
      const content = firstText(message?.content);
      if (content.trim()) return content.trim();
    }
  }
  return "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attachFeedbackAfterAgentEnd(pending, event) {
  const content = lastAssistantText(event?.messages);
  const channelId = pending?.discord?.channelId || pending?.conversationId || pending?.channelId;
  if (!content || !channelId) return { status: "skipped", reason: "agent_end_response_unavailable" };

  // The embedded Discord delivery path runs `before_message_write` but does
  // not emit global message_sent hooks. Poll the just-sent bot message instead
  // of leaving the panel permanently detached on that production path.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const responseMessageId = await resolveDiscordResponseMessageId({
      channelId,
      content,
      notBefore: pending.queuedAt,
    });
    if (responseMessageId) {
      const feedback = await attachVisionFeedbackPanel({
        requestId: pending.requestId,
        requesterId: pending.discord?.requesterId,
        channelId,
        sourceMessageId: pending.discord?.sourceMessageId,
        responseMessageId,
        userQuestion: pending.userQuestion,
        payload: pending.payload,
      });
      await traceVision(pending.requestId, "vision_feedback_panel", {
        ...feedback,
        deliveryStage: "agent_end_poll",
      }, { force: true });
      return feedback;
    }
    await delay(1000);
  }
  const result = { status: "skipped", reason: "discord_response_not_found_after_agent_end" };
  await traceVision(pending.requestId, "vision_feedback_panel", result, { force: true });
  return result;
}

function imageAnalysisStatus(evidence, primaryCharacter, externalIdentity = null) {
  if (primaryCharacter && (primaryCharacter.confidence === "high" || primaryCharacter.confidence === "medium")) {
    return "known";
  }
  if (externalIdentity && (externalIdentity.confidence === "high" || externalIdentity.confidence === "medium")) {
    return "known";
  }
  if (evidence?.search_policy?.mode === "exhaustive" && evidence?.deep_search?.status === "error") {
    return "error";
  }
  const observation = evidence?.vision?.observation;
  const visionStatus = evidence?.vision?.status;
  if (observation && typeof observation === "object" && !["unavailable", "error", "failed"].includes(visionStatus)) {
    return "unknown";
  }
  return "error";
}

function isIdentityQuestionText(value) {
  return /(?:這|那|他|她|它)?\s*(?:是誰|誰啊|誰呀)|叫什麼|哪個角色|辨識|辨認|認一下|看得出來|認得(?:出)?/iu.test(firstText(value));
}

function unresolvedIdentityBoundary(payload) {
  const understanding = payload?.imageUnderstanding || {};
  const status = String(understanding.analysisStatus || "unknown").toLowerCase();
  const unresolved = !understanding.primaryCharacter && !understanding.externalIdentity;
  return unresolved
    && ["unknown", "error"].includes(status)
    && !understanding.externalReference
    && isIdentityQuestionText(payload?.userQuestion || "");
}

function safeUnknownIdentityText(payload) {
  return String(payload?.imageUnderstanding?.analysisStatus || "").toLowerCase() === "error"
    ? "現在看不了。"
    : "不知道。";
}

function guardVisionIdentityOutput(content, payload = null) {
  const before = firstText(content).trim();
  if (!before) return before;
  const understanding = payload?.imageUnderstanding || {};
  const primary = understanding.primaryCharacter || null;
  const acceptedPrimary = primary && ["high", "medium"].includes(String(primary.confidence || "").toLowerCase());
  const allowedIds = new Set((understanding.detectedCharacters || [])
    .filter((item) => ["high", "medium"].includes(String(item?.confidence || "").toLowerCase()))
    .flatMap((item) => [item?.entityId, item?.canonicalId].filter(Boolean)));
  if (acceptedPrimary) {
    if (primary.entityId) allowedIds.add(primary.entityId);
    if (primary.canonicalId) allowedIds.add(primary.canonicalId);
  }
  let unsupported = [];
  try {
    unsupported = resolveEntityMentions(before).filter((item) =>
      !allowedIds.has(item.entity_id) && !allowedIds.has(item.canonical_id));
  } catch {
    // Missing derived identity data must not block an ordinary reply.
  }
  if (!acceptedPrimary && (unsupported.length || unresolvedIdentityBoundary(payload))) {
    return safeUnknownIdentityText(payload);
  }
  if (!acceptedPrimary) return before;

  const identityOnly = isIdentityQuestionText(payload?.userQuestion || "");
  const selfReportViolation = /(?:要樂奈|要楽奈|要乐奈|Rana|Raana|灰白短髮|灰白短发|異色瞳|异色瞳|畫面裡|画面里|圖中|图中|照片裡|照片里|這(?:個|位)?女孩|这(?:个|位)?女孩)/iu.test(before);
  const unsupportedAction = /(?:正(?:在)?吃|正在吃|吃著|吃着|咬著|咬着|喝著|喝着|拿著|拿着).{0,12}(?:抹茶|芭菲|甜點|甜点|食物)/u.test(before);
  if (primary.canonicalId === "rana" && identityOnly && (unsupported.length || selfReportViolation || unsupportedAction)) {
    return "是我。";
  }
  if (unsupported.length) return primary.canonicalId === "rana" ? "是我。" : `是${primary.canonicalName}。`;
  return before;
}

function replaceTextContent(value, text) {
  if (typeof value === "string") return text;
  if (Array.isArray(value)) {
    const copy = value.map((item) => {
      if (item && typeof item === "object" && String(item.type || "").toLowerCase() === "text") {
        const { textSignature: _staleTextSignature, ...rest } = item;
        return { ...rest, text };
      }
      return item;
    });
    if (!copy.some((item) => item && typeof item === "object" && String(item.type || "").toLowerCase() === "text")) {
      copy.unshift({ type: "text", text });
    }
    return copy;
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "text")) return { ...value, text };
    if (Object.prototype.hasOwnProperty.call(value, "content")) return { ...value, content: replaceTextContent(value.content, text) };
    return { ...value, text };
  }
  return text;
}

function guardAssistantMessage(message, payload = null) {
  const before = message?.role === "assistant" ? firstText(message?.content) : "";
  const after = guardVisionIdentityOutput(before, payload);
  if (!message || String(message?.role || "").toLowerCase() !== "assistant" || after === before) {
    return { message, before, after: before, changed: false };
  }
  return {
    message: { ...message, content: replaceTextContent(message.content, after) },
    before,
    after,
    changed: true,
  };
}

function guardAssistantMessageInPlace(message, payload = null) {
  const guarded = guardAssistantMessage(message, payload);
  if (guarded.changed && message && typeof message === "object") {
    message.content = guarded.message.content;
  }
  return { ...guarded, message };
}

function guardLlmOutputInPlace(event, payload = null) {
  const assistantTexts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : null;
  const before = firstText(assistantTexts?.length ? assistantTexts : event?.lastAssistant);
  const after = guardVisionIdentityOutput(before, payload);
  const changed = after !== before;
  if (changed && event && typeof event === "object") {
    if (Array.isArray(event.assistantTexts)) {
      event.assistantTexts.splice(0, event.assistantTexts.length, after);
    }
    if (event.lastAssistant && typeof event.lastAssistant === "object") {
      event.lastAssistant.content = replaceTextContent(event.lastAssistant.content, after);
    }
  }
  return { before, after, changed };
}

function extractUserMessageText(prompt) {
  const text = firstText(prompt);
  const imageBlock = text.match(/\[Image\]\s*User text:\s*([\s\S]*?)(?:\r?\nDescription:|$)/i);
  const markers = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/gi)];
  const marker = markers.at(-1);
  let selected = imageBlock?.[1] || marker?.[1] || text;
  selected = selected
    .replace(/^\s*To send an image back, use the message tool with structured media fields[^\r\n]*(?:\r?\n)?/gim, "")
    .replace(/\[media attached:\s*[^\]]+\]\s*/gi, "")
    .replace(/^\s*\[Discord[^\]]+\]\s*[^:\r\n]{1,160}:\s*/i, "")
    .replace(/^\s*User text:\s*/i, "")
    .trim();
  return selected;
}

function openClawGeneratedDescription(prompt) {
  const text = firstText(prompt);
  const match = text.match(/\[Image\][\s\S]*?\r?\nDescription:\s*([\s\S]*?)(?=\r?\n(?:\[media attached:|<<<END_EXTERNAL_UNTRUSTED_CONTENT|$))/i);
  return String(match?.[1] || "").trim().slice(0, 4000);
}

function isInternalTitleRequest(value) {
  return /(?:generate|produce) a short\s+\d+(?:\s*-\s*\d+)?\s+word filename slug|filename slug \(lowercase, hyphen-separated/i.test(firstText(value));
}

function stripRanaMention(value) {
  return firstText(value)
    .replace(/<@!?1202969643162013776>/g, "")
    .replace(/@Rana(?:#8264)?/gi, "")
    .replace(/@樂奈/g, "")
    .trim();
}

function imageAttachmentPath(value) {
  const match = firstText(value).match(/\[media attached:\s*([^\]\n]+?\.(?:png|jpe?g|webp|gif))(?:\s|\])/i);
  return match ? match[1].trim() : "";
}

function currentTurnMediaEvidence(event = {}) {
  const metadata = Array.isArray(event?.attachments) ? event.attachments : [];
  return { attachments: metadata };
}

function mediaMetadataAuthorizesPath(filePath, evidence = {}) {
  return isCurrentUsableImagePath(filePath, evidence);
}

export function repliedImageReference(value) {
  const text = firstText(value);
  const explicitMedia = /"body"\s*:\s*"<media:image>(?:\s*\(\d+\s+images?\))?"/i.test(text);
  // Discord replies often omit the replied attachment from OpenClaw's prompt.
  // Do not infer that this is a text-only reply from the user's wording: the
  // untrusted message body can be mojibake by the time this hook sees it.
  // The Discord API lookup below is the source of truth; if that message has
  // no image, buildImageEvidenceContext returns null and normal chat proceeds.
  const hasReplyContext = /"has_reply_context"\s*:\s*true/i.test(text);
  if (!explicitMedia && !hasReplyContext) return null;
  const channel = text.match(/"chat_id"\s*:\s*"channel:(\d{17,20})"/i)?.[1];
  const message = text.match(/"reply_to_id"\s*:\s*"(\d{17,20})"/i)?.[1];
  return channel && message ? { channel, message } : null;
}

function hasImagePlaceholder(value) {
  const text = firstText(value);
  return /<media:image>(?:\s*\(\d+\s+images?\))?/i.test(text) || /\[Image\]/i.test(text);
}

export function hasExplicitVisionIntent(value) {
  return parseExplicitVisionIntent(value);
}

function imageRequest(prompt, loaders = {}) {
  // OpenClaw's session-title/compaction prompts include old user messages verbatim.
  // They are not new Discord input and must never replay a previous image request.
  if (isInternalTitleRequest(prompt)) return null;
  const userText = extractUserMessageText(prompt);
  // An attachment is data, not permission to invoke Vision. Require the
  // current user to ask for image inspection/identification, or to explicitly
  // present/share the attached image with the bot.
  if (!hasExplicitVisionIntent(userText)) return null;
  const loadInbound = loaders.loadInboundImage || loadInboundImage;
  const loadReply = loaders.loadRepliedDiscordImage || loadRepliedDiscordImage;
  const attachmentPath = imageAttachmentPath(prompt);
  if (attachmentPath && mediaMetadataAuthorizesPath(attachmentPath, loaders.currentTurnMediaEvidence)) return {
    userText,
    sourceType: "inbound_path",
    attachmentPath,
    provenance: {
      currentTurn: true,
      authorizedPaths: [attachmentPath],
    },
    load: (signal, requestId) => loadInbound(attachmentPath, signal, requestId, {
      currentTurn: true,
      authorizedPaths: [attachmentPath],
    }),
  };
  const reply = repliedImageReference(prompt);
  if (reply) return {
    userText,
    sourceType: "discord_reply",
    sourceMessageId: reply.message,
    load: (signal, requestId) => loadReply(reply.channel, reply.message, signal, requestId),
  };
  if (hasImagePlaceholder(prompt)) {
    return {
      userText,
      sourceType: "unresolved_placeholder",
      load: async () => { throw new Error("image placeholder has no resolved attachment or reply reference"); },
    };
  }
  return null;
}

function visibleText(evidence) {
  // ToriiGate-reported text is model interpretation, not OCR. Keep it in the
  // raw trace, but never promote it to user-visible/OOGG text evidence.
  return [...new Set((evidence?.local_ocr?.normalized_lines || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

function publicCharacter(identity) {
  if (!identity) return null;
  return {
    entityId: identity.entityId,
    canonicalId: identity.canonicalId,
    canonicalName: identity.canonicalName,
    confidence: identity.confidence,
    confidenceScore: identity.confidenceScore,
    evidence: identity.evidence,
  };
}

function publicExternalIdentity(identity) {
  if (!identity) return null;
  return {
    name: String(identity.name || ""),
    work: String(identity.work || ""),
    scope: "external",
    confidence: identity.confidence,
    confidenceScore: Number(identity.confidenceScore || 0),
    sourceDomains: identity.sourceDomains || [],
    evidence: identity.evidence || [],
  };
}

export function ooggPayload(evidence, userQuestion = "") {
  const resolution = evidence?.identity_resolution || {};
  const externalIdentity = publicExternalIdentity(evidence?.external_identity || resolution.externalIdentity);
  const preferExternal = evidence?.identity_decision === "external_verified" && externalIdentity;
  const primary = preferExternal ? null : publicCharacter(resolution.primaryCharacter);
  const detected = (resolution.detectedCharacters || []).map((item) => ({
    ...publicCharacter(item),
    position: item.evidence?.find((entry) => entry.position)?.position || "",
    impression: item.impression ? {
      recognitionLevel: item.impression.recognitionLevel,
      tentative: item.impression.tentative,
    } : null,
  }));
  const impression = primary ? resolution.primaryImpression : null;
  const searchPolicy = evidence?.search_policy || { mode: "standard", rewardCue: null };
  const deepSearch = evidence?.deep_search || {};
  const analysisStatus = imageAnalysisStatus(evidence, primary, externalIdentity);
  const rejectedCandidates = [
    ...(evidence?.reverse_image?.rejected || []),
    ...(evidence?.local_identity_retrieval?.rejected || []),
  ].map((item) => ({
    id: String(item?.id || item?.title || item?.name || ""),
    reason: String(item?.reason || "rejected_by_identity_pipeline"),
  })).filter((item) => item.id);
  return {
    schema: "rana.vision.oogg-payload.v3",
    requestId: evidence?.request_id || "",
    canonicalIdentity: {
      status: analysisStatus,
      entity_id: primary?.entityId || null,
      canonical_id: primary?.canonicalId || null,
      confidence: primary?.confidence || (externalIdentity?.confidence || "unknown"),
      evidence: primary?.evidence || externalIdentity?.evidence || {},
      rejected_candidates: rejectedCandidates,
    },
    imageUnderstanding: {
      analysisStatus,
      searchMode: searchPolicy.mode || "standard",
      rewardCue: searchPolicy.rewardCue || null,
      identityDecision: evidence?.identity_decision || "unresolved",
      searchExhausted: deepSearch.searchExhausted === true,
      summary: String(evidence?.vision?.observation?.summary || ""),
      medium: evidence?.vision?.observation?.medium || "other",
      subjectType: evidence?.vision?.observation?.subject_type || "unknown",
      peopleCount: Number(evidence?.vision?.observation?.people_count || 0),
      visibleText: visibleText(evidence),
      externalReference: evidence?.external_work_reference ? {
        title: evidence.external_work_reference.title,
        confidence: evidence.external_work_reference.confidence,
        similarity: evidence.external_work_reference.similarity,
        corroboratingResults: evidence.external_work_reference.corroboratingResults,
        scope: evidence.external_work_reference.scope,
      } : null,
      externalIdentity,
      primaryCharacter: primary,
      detectedCharacters: detected,
      identityConflicts: evidence?.conflicts || [],
      deepSearchStatus: deepSearch.status || "skipped",
      deepSearchReason: deepSearch.reason || "",
    },
    ranaCharacterImpression: impression ? {
      recognitionLevel: impression.recognitionLevel,
      howRanaKnowsThem: impression.howRanaKnowsThem,
      memoryAnchors: impression.memoryAnchors,
      ranaCallsThem: impression.ranaCallsThem,
      allowedKnowledge: impression.allowedKnowledge,
      allowedReactionStyle: impression.allowedReactionStyle,
      forbiddenExpansion: impression.forbiddenExpansion,
      tentative: primary?.confidence === "medium",
    } : null,
    userQuestion,
    responseContract: {
      answerQuestionFirst: true,
      includeRanaReaction: true,
      avoidEncyclopedicVoice: true,
      avoidFragmentOnlyResponse: true,
      respectKnowledgeBoundary: true,
      ignoreOpenClawGeneratedDescriptionForIdentity: true,
      exhaustiveRewardPolicy: "matcha_parfait increases search effort only; it never supplies an identity answer",
      currentTurnIsolation: {
        useOnlyCurrentPayload: true,
        ignorePriorImageTurns: true,
        mentionMatchaOnlyWhenCurrentRewardCueIsMatchaParfait: true,
        neverUseOpenClawDescriptionForIdentityOrVisualReactionWhenAnalysisStatusIsError: true,
      },
      identityConfidenceRules: {
        high: "可以直接說辨識結果；人物印象仍受 recognitionLevel 限制",
        medium: "使用像是、應該是等保留語氣；人物印象視為 tentative",
        low: "不得注入或表現熟人反應",
        unknown: "不得猜角色姓名",
      },
    },
  };
}

function isWorkMetadataQuestion(value) {
  return /(?:哪部|哪個|什麼)(?:作品|動畫|漫畫)|(?:出自|來自)(?:哪|什麼)(?:部)?(?:作品|動畫|漫畫)|作品(?:名|名稱)?/u.test(String(value || ""));
}

function isRelationshipQuestion(value) {
  return /(?:什麼|哪種|有何)?關係|怎麼認識|熟不熟|認不認識|認識嗎|一起(?:做過|演出|排練)|隊友|團員/iu.test(String(value || ""));
}

function isRecognitionQuestion(value) {
  return /(?:妳|你|樂奈|Rana).*(?:認識|認得|記得|熟悉)|(?:認識|認得|記得|熟悉).*(?:她|他|這個人|那個人|這位|那位)/iu.test(String(value || ""));
}

function isPersonaFollowupQuestion(value) {
  const text = stripRanaMention(value);
  return !isIdentityQuestionText(text)
    && (isRelationshipQuestion(text) || isRecognitionQuestion(text) || isWorkMetadataQuestion(text));
}

function isDirectSelfIdentityQuestion(value) {
  const text = stripRanaMention(value)
    .normalize("NFKC")
    .replace(/[\s？?！!。．,.，]/gu, "");
  return /^(?:你|妳)(?:是誰|叫什麼|叫什麼名字)$/u.test(text);
}

function directSelfIdentityContext(value) {
  if (!isDirectSelfIdentityQuestion(value)) return "";
  return [
    "使用者本次只問你本人是誰。你就是要樂奈本人，直接用第一人稱自然回答目前姓名。",
    "只回答姓名；不得主動補充作品、MyGO!!!!!、樂團、吉他手、職責、履歷或角色介紹。",
    "不得用第三人稱介紹自己，不得輸出括號、星號、方括號、動作或旁白。",
    "最終文字由 OOGG 自己生成；外部程式不得後置改寫。",
  ].join("\n");
}

function safeCanonicalSubject(payload) {
  const canonical = payload?.canonicalIdentity || {};
  if (canonical.status === "known" && canonical.entity_id) {
    const resolved = resolveEntityMentions("", {
      forcedEntityIds: [canonical.entity_id, canonical.canonical_id].filter(Boolean),
    });
    return resolved.length === 1 ? resolved[0] : null;
  }
  const external = payload?.imageUnderstanding?.externalIdentity;
  if (canonical.status !== "known" || !external?.name) return null;
  const resolved = resolveEntityMentions(String(external.name));
  return resolved.length === 1 ? { ...resolved[0], source: "verified_external_alias" } : null;
}

function preferredAddress(exactSource, canonicalSubject, userQuestion) {
  const names = [...new Set([
    ...(exactSource?.rana_calls_them || []),
    exactSource?.inventory_name,
    canonicalSubject?.matched_alias,
    canonicalSubject?.canonical_name,
  ].map((item) => String(item || "").trim()).filter(Boolean))];
  const chineseQuestion = /\p{Script=Han}/u.test(String(userQuestion || ""));
  if (chineseQuestion) {
    const conciseHan = names.find((name) => /\p{Script=Han}/u.test(name) && name.length <= 3);
    if (conciseHan) return conciseHan;
  }
  return names[0] || "";
}

function personallyKnown(recognitionLevel, subjectId) {
  return subjectId === "bangdream.character.rana_kaname"
    || !["", "unknown", "unverified", "none"].includes(String(recognitionLevel || "").toLowerCase());
}

// Keep the persona prepend small enough that the actual image state and the
// current question remain salient to OOGG.  The previous 9000 character
// allowance still admitted duplicated lore payloads on identity turns.
const PERSONA_EVIDENCE_MAX_CHARS = 6000;

function isSharedExperienceQuestion(value) {
  return /(?:發生過什麼|发生过什么|一起做過|一起做过|共同經歷|共同经历|回憶|回忆|記得什麼|记得什么)/iu.test(String(value || ""));
}

function querySpecificRelationshipFacts(facts, mode) {
  const values = Array.isArray(facts) ? facts : [];
  if (mode === "relationship") {
    const metadata = new Set(["identity", "likes", "frequented", "frequents", "status", "current_use"]);
    return values.filter((fact) => String(fact?.polarity || "positive") !== "boundary"
      && !metadata.has(String(fact?.predicate || "")));
  }
  if (mode === "recognition") {
    return values.filter((fact) => ["recognizes", "has_seen", "knows_of"].includes(String(fact?.predicate || "")));
  }
  return [];
}

function compactRelationshipFact(fact) {
  return {
    factId: fact?.factId || null,
    subject: fact?.subject ?? null,
    predicate: fact?.predicate || "",
    object: fact?.object ?? null,
    polarity: fact?.polarity || "positive",
    confidence: fact?.confidence || "unknown",
    qualifiers: fact?.qualifiers || {},
    sourceRefs: fact?.sourceRefs || [],
    sourceClassification: fact?.sourceClassification || [],
    canonLevel: fact?.canonLevel || fact?.canon_level || "unverified",
    evidenceSummary: fact?.evidenceSummary || fact?.evidence_summary || "",
    allowedInference: fact?.allowedInference || [],
    forbiddenInference: fact?.forbiddenInference || [],
  };
}

function isConcreteRelationshipFact(fact) {
  return ![
    "recognizes",
    "has_seen",
    "knows_of",
    "member_of",
    "member_of_or_associated_with",
    "role",
  ].includes(String(fact?.predicate || ""));
}

function explicitNegativeRecognitionFact(recognitionLevel, subjectId, exactSource) {
  if (!["seen_not_close", "conflict", "hostile", "distant"].includes(String(recognitionLevel || "").toLowerCase())) return null;
  const sourceRefs = exactSource?.source_refs || [];
  return {
    factId: `recognition_state.${subjectId || "unknown"}`,
    subject: "bangdream.character.rana_kaname",
    predicate: "recognition_level",
    object: subjectId || null,
    polarity: "negative",
    confidence: sourceRefs.length ? "high" : "medium",
    qualifiers: { recognitionLevel },
    sourceRefs,
    sourceClassification: [{ classification: "structured_character_store", sourceRefs }],
    canonLevel: "reviewed",
    evidenceSummary: `explicit recognition level: ${recognitionLevel}`,
    allowedInference: ["the explicit recognition level only"],
    forbiddenInference: ["hostility, dislike, or stronger distance not explicitly stated"],
  };
}

function enforcePersonaEvidenceBudget(persona) {
  persona.evidenceBudget = {
    maxChars: PERSONA_EVIDENCE_MAX_CHARS,
    serializedChars: 0,
    hardLimitEnforced: true,
  };
  const dropOrder = [
    [null, "rejectedFacts", 0],
    [null, "retrievedFacts", 0],
    ["ranaRecognition", "memoryAnchors", 2],
    ["ranaRecognition", "allowedKnowledge", 2],
    ["ranaRecognition", "specificMemoryAnchors", 2],
    ["ranaRecognition", "positiveRelationshipFacts", 6],
    ["ranaRecognition", "negativeRelationshipFacts", 1],
    ["ranaRecognition", "relationshipBoundaries", 1],
    ["ranaRecognition", "forbiddenExpansion", 2],
    [null, "boundaries", 0],
  ];
  const size = () => JSON.stringify(persona).length;
  for (const [parent, key, minimum] of dropOrder) {
    const values = parent ? persona[parent]?.[key] : persona[key];
    while (Array.isArray(values) && values.length > minimum && size() > PERSONA_EVIDENCE_MAX_CHARS) {
      values.pop();
    }
  }
  persona.evidenceBudget.serializedChars = size();
  if (persona.evidenceBudget.serializedChars > PERSONA_EVIDENCE_MAX_CHARS) {
    throw new Error(`persona evidence exceeds hard budget: ${persona.evidenceBudget.serializedChars}/${PERSONA_EVIDENCE_MAX_CHARS} chars`);
  }
  return persona;
}

export async function buildVisionPersonaEvidence(payload, userQuestion = "", options = {}) {
  const question = stripRanaMention(userQuestion);
  const status = String(payload?.canonicalIdentity?.status || payload?.imageUnderstanding?.analysisStatus || "unknown");
  const canonicalSubject = safeCanonicalSubject(payload);
  const external = payload?.imageUnderstanding?.externalIdentity || null;
  let lorePack = null;
  let loreError = "";

  if (status === "known" && canonicalSubject?.entity_id) {
    try {
      lorePack = await buildLoreEvidencePack(question, {
        forcedEntityIds: [canonicalSubject.entity_id, canonicalSubject.canonical_id].filter(Boolean),
        visionSubjectEntityId: canonicalSubject.entity_id,
        personaQuery: true,
        sessionKey: options.sessionKey,
        signal: options.signal,
        visionStatus: "known",
      });
    } catch (error) {
      loreError = String(error?.message || error);
    }
  }

  const safeLore = lorePack ? safeEvidencePack(lorePack) : null;
  const exactSource = safeLore?.exact_sources?.find((item) => item.entity_ids?.includes(canonicalSubject?.entity_id)) || null;
  const selfSubject = canonicalSubject?.entity_id === "bangdream.character.rana_kaname";
  const workRequested = isWorkMetadataQuestion(question);
  const relationshipRequested = isRelationshipQuestion(question);
  const recognitionRequested = isRecognitionQuestion(question);
  const sharedExperienceRequested = isSharedExperienceQuestion(question);
  const addressRequested = /(?:怎麼叫|怎么叫|叫她什麼|叫他什麼|稱呼|称呼)/u.test(question);
  const requestedMode = workRequested
    ? "work_metadata"
    : relationshipRequested
      ? "relationship"
      : recognitionRequested
        ? "recognition"
        : "identity";
  const evidenceMode = requestedMode === "relationship" || requestedMode === "recognition"
    ? requestedMode
    : "none";
  const verifiedName = selfSubject
    ? "我"
    : preferredAddress(exactSource, canonicalSubject, question)
      || String(external?.name || payload?.imageUnderstanding?.primaryCharacter?.canonicalName || "");
  const relationshipCorpus = [
    ...(safeLore?.relationship_evidence || []),
    ...(safeLore?.structured_facts || []),
  ];
  const relationshipFacts = querySpecificRelationshipFacts(relationshipCorpus, evidenceMode);
  const uniqueFacts = (facts) => {
    const seen = new Set();
    return facts.filter((fact) => {
      const key = String(fact?.factId || fact?.fact_id || "");
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const positiveRelationshipFacts = querySpecificRelationshipFacts(
    uniqueFacts([
      ...(safeLore?.positive_relationship_facts || []),
      ...relationshipFacts.filter((fact) => String(fact?.polarity || "positive") === "positive"),
    ]),
    evidenceMode,
  ).map(compactRelationshipFact);
  const negativeRelationshipFacts = querySpecificRelationshipFacts(
    uniqueFacts([
      ...(safeLore?.negative_relationship_facts || []),
      ...relationshipFacts.filter((fact) => String(fact?.polarity || "") === "negative"),
    ]),
    evidenceMode,
  ).map(compactRelationshipFact);
  const explicitRelationshipLabels = querySpecificRelationshipFacts(
    safeLore?.explicit_relationship_labels || [],
    evidenceMode,
  ).map(compactRelationshipFact);
  const unsupportedRelationshipLabels = [...new Set(
    (safeLore?.unsupported_relationship_labels || []).map((label) => String(label || "")).filter(Boolean),
  )];
  const specificMemoryFacts = positiveRelationshipFacts.filter(isConcreteRelationshipFact)
    .map((fact) => ({
      factId: fact.factId,
      predicate: fact.predicate,
    }));
  const relationshipBoundaries = (evidenceMode === "relationship"
    ? (safeLore?.relationship_boundaries || safeLore?.knowledge_boundaries || [])
    : []).map((boundary) => ({
    boundaryId: boundary.boundaryId,
    predicate: boundary.predicate,
    status: boundary.status,
    polarity: "boundary",
    sourceRefs: boundary.sourceRefs || [],
  }));

  if (canonicalSubject && external && !payload.imageUnderstanding.primaryCharacter) {
    payload.imageUnderstanding.primaryCharacter = {
      entityId: canonicalSubject.entity_id,
      canonicalId: canonicalSubject.canonical_id,
      canonicalName: canonicalSubject.canonical_name,
      confidence: external.confidence,
      confidenceScore: external.confidenceScore,
      evidence: [{ source: "verified_external_alias_map", name: external.name }],
    };
    payload.canonicalIdentity.persona_entity_id = canonicalSubject.entity_id;
    payload.canonicalIdentity.persona_binding = "verified_external_alias";
  }

  const recognitionLevel = selfSubject ? "self" : exactSource?.recognition_level || "unknown";
  const explicitNegative = explicitNegativeRecognitionFact(recognitionLevel, canonicalSubject?.entity_id, exactSource);
  if (explicitNegative && !negativeRelationshipFacts.some((fact) => fact.factId === explicitNegative.factId)) {
    negativeRelationshipFacts.unshift(explicitNegative);
  }
  const howKnown = evidenceMode === "recognition"
    ? (exactSource?.how_rana_knows_them || []).slice(0, 4)
    : [];
  const forbiddenExpansion = evidenceMode === "relationship"
    ? (exactSource?.forbidden_expansion || []).slice(0, 8)
    : [];
  if (evidenceMode === "relationship") {
    for (const [index, rule] of forbiddenExpansion.entries()) {
      relationshipBoundaries.push({
        boundaryId: `forbidden_expansion.${canonicalSubject?.entity_id || "unresolved"}.${index}`,
        predicate: "forbidden_expansion",
        status: String(rule),
        polarity: "boundary",
        sourceRefs: exactSource?.source_refs || [],
      });
    }
  }
  const relationshipSourceRefs = evidenceMode === "relationship"
    ? [...new Set([
      ...(exactSource?.source_refs || []),
      ...positiveRelationshipFacts.flatMap((fact) => fact.sourceRefs || []),
      ...negativeRelationshipFacts.flatMap((fact) => fact.sourceRefs || []),
      ...relationshipBoundaries.flatMap((boundary) => boundary.sourceRefs || []),
    ])]
    : [];
  return enforcePersonaEvidenceBudget({
    schema: "rana.vision.persona-evidence.v1",
    speaker: {
      entityId: "bangdream.character.rana_kaname",
      canonicalName: "要樂奈",
      perspective: "first_person",
      pronoun: "我",
      personallySpeaking: true,
      neverExternalNarrator: true,
      neverDescribeSelfAsCharacterEntry: true,
    },
    queryPlan: {
      intent: requestedMode,
      speaker: { type: "first_person_speaker", entity_id: "bangdream.character.rana_kaname" },
      subject: { type: canonicalSubject ? "resolved_subject" : "external_or_unresolved_subject", entity_id: canonicalSubject?.entity_id || null },
      requested_predicates: workRequested ? ["work_metadata"] : relationshipRequested ? ["explicit_pairwise_relationship"] : recognitionRequested ? ["recognizes", "has_seen"] : ["identity", "preferred_name"],
      answer_focus: workRequested ? "requested_work_only" : relationshipRequested ? "rana_subject_relationship_only" : recognitionRequested ? "rana_personal_recognition_only" : "subject_name_first",
      work_metadata_requested: workRequested,
      relationship_requested: relationshipRequested,
      persona_query: true,
    },
    resolvedSubject: {
      pipelineStatus: status,
      identityDecision: payload?.imageUnderstanding?.identityDecision || "unresolved",
      entityId: canonicalSubject?.entity_id || null,
      canonicalId: canonicalSubject?.canonical_id || null,
      verifiedName,
      confidence: payload?.canonicalIdentity?.confidence || "unknown",
      externalVerifiedName: external?.name || null,
      workMetadata: workRequested ? (external?.work || exactSource?.group || null) : null,
      self: selfSubject,
    },
    ...(evidenceMode === "recognition" || evidenceMode === "relationship" ? {
      ranaRecognition: {
        personallyKnown: personallyKnown(recognitionLevel, canonicalSubject?.entity_id),
        recognitionLevel,
        ...(addressRequested ? {
          ranaCallsThem: selfSubject ? ["我"] : (exactSource?.rana_calls_them || (verifiedName ? [verifiedName] : [])),
        } : {}),
        howRanaKnowsThem: howKnown,
        ...(evidenceMode === "recognition" ? {
          positiveRelationshipFacts: positiveRelationshipFacts.slice(0, 6),
          negativeRelationshipFacts: negativeRelationshipFacts.slice(0, 4),
        } : {}),
        ...(evidenceMode === "relationship" ? {
          positiveRelationshipFacts: positiveRelationshipFacts.slice(0, 10),
          negativeRelationshipFacts: negativeRelationshipFacts.slice(0, 8),
          explicitRelationshipLabels: explicitRelationshipLabels.slice(0, 6),
          unsupportedRelationshipLabels: unsupportedRelationshipLabels.slice(0, 8),
          specificMemoryAnchors: specificMemoryFacts.slice(0, 8),
          relationshipBoundaries: relationshipBoundaries.slice(0, 6),
          sourceRefs: relationshipSourceRefs,
          memoryAnchors: (exactSource?.memory_anchors || []).slice(0, 6),
          allowedKnowledge: (exactSource?.allowed_knowledge || []).slice(0, 6),
          forbiddenExpansion,
        } : {}),
      },
    } : {}),
    retrievedFacts: [],
    rejectedFacts: [],
    boundaries: relationshipRequested
      ? (safeLore?.knowledge_boundaries || []).slice(0, 8)
      : (status === "known" ? [] : [{
      subject: "image_identity",
      predicate: "identity",
      object: null,
      status: `vision_${status}`,
    }]),
    incomplete: safeLore?.knowledge_contract === "unknown" || Boolean(loreError),
    retrievalError: loreError || null,
    responseContract: {
      answerOnlyWhatWasAsked: true,
      speakerSubjectBinding: selfSubject ? "same_entity" : "distinct_entities",
      preferredAddressWhenNamingSubject: relationshipRequested || recognitionRequested
        ? "resolvedSubject.verifiedName"
        : null,
      avoidUnnecessaryCanonicalFullName: Boolean(relationshipRequested || recognitionRequested),
      pronounAllowedWhenReferentIsClear: Boolean(relationshipRequested || recognitionRequested),
      ...(requestedMode === "identity" ? { identityQuestion: "preferred name only" } : {}),
      ...(selfSubject ? { selfImage: "first-person self" } : {}),
      ...(relationshipRequested ? {
        relationship: "explicit labels, concrete facts, negatives, and boundaries are separate; ABSENT not negative; boundaries are not claims",
        relationshipLabelsMustBeExplicitlySupported: true,
      } : {}),
      ...(workRequested ? { workTitle: "only when asked or needed for disambiguation" } : {}),
      ...(status === "unknown" ? { unknown: "say I do not know; never guess" } : {}),
      ...(status === "error" ? { error: "say I cannot inspect it now; never guess" } : {}),
      outputAuthority: "OOGG final; no rewrite",
    },
  });
}

function ooggContext(evidence, userQuestion = "", suppliedPayload = null) {
  const payload = suppliedPayload || ooggPayload(evidence, userQuestion);
  const persona = payload.personaEvidence || null;
  const mode = persona?.queryPlan?.intent || "identity";
  const lines = [
    "以下 Persona Evidence 是本次請求唯一有效的 production 證據。最終文字由 OOGG 自己決定，不得由外部程式改寫。",
    "你就是要樂奈本人，不是旁白、資料庫或介紹樂奈的第三人。永遠用第一人稱表達自己的認知、關係與反應。",
    "只回答 queryPlan 指定的問題；只處理 JSON 內的 userQuestion 與 personaEvidence。",
    "身分只能使用 personaEvidence.resolvedSubject。不得從人物印象反推身分，也不得從模型記憶、上文或使用者暗示猜姓名。",
    "speaker 是第一人稱「我」的唯一身分；resolvedSubject 是圖片中的對象。speakerSubjectBinding=distinct_entities 時，resolvedSubject.verifiedName 屬於對方，不是 speaker 的名字，禁止把它說成我的名字或把對方經歷寫成我的身分。",
    "resolvedSubject.self=true 時照片裡是我：直接以我本人回應，禁止輸出『這是 Rana／要樂奈』或第三人稱角色介紹。",
    "pipelineStatus=unknown 時自然說我不知道；pipelineStatus=error 時自然說我現在看不了。不得再補角色名、作品名或猜測。",
    "不要輸出 schema、trace、provider、模型、系統流程、括號式動作或第三人稱角色扮演。",
  ];
  if (mode === "relationship") {
    lines.push(
      "關係回答只讀 positiveRelationshipFacts、negativeRelationshipFacts、explicitRelationshipLabels、unsupportedRelationshipLabels、specificMemoryAnchors、relationshipBoundaries；保持各陣列與 sourceRefs 的來源順序。",
      "只有 explicitRelationshipLabels 或 negativeRelationshipFacts 明確支持時，才能使用朋友、家人、戀愛、敵對、疏遠等標籤。ABSENT 不是 NEGATIVE；BOUNDARY 不是事實；recognizes、同團或互動不能自行推出朋友，也不能降格成不熟。",
      "直接用一至兩項來源支持的具體互動回答；不新增 fact 外的動作、物件或情節。",
    );
  } else if (mode === "recognition") {
    lines.push(
      "recognition 模式只使用 recognitionLevel、personallyKnown、howRanaKnowsThem 與 recognition predicates；recognizes 不等於朋友或其他關係標籤。",
    );
  } else {
    lines.push(
      "需要稱呼 subject 時優先使用 responseContract.preferredAddressWhenNamingSubject 指向的 verifiedName；名字不是必出字串。",
      "identity/work 模式只使用 resolvedSubject 的身分狀態、verifiedName 與被明確詢問的 workMetadata；問是誰就只答稱呼，不補關係、記憶或作品履歷。",
    );
  }
  lines.push(
    "本次圖片 pipeline 已完整執行。直接依 JSON 回答，不得再呼叫 Vision、lore 或其他工具。",
    JSON.stringify({
      userQuestion: payload.userQuestion || userQuestion,
      personaEvidence: persona,
      analysisStatus: persona?.resolvedSubject?.pipelineStatus || payload?.imageUnderstanding?.analysisStatus || "unknown",
      rewardCue: payload?.imageUnderstanding?.rewardCue || null,
      ...(persona ? {} : { imageUnderstanding: payload?.imageUnderstanding || null }),
    }),
  );
  return lines.join("\n");
}

export async function buildImageEvidenceContext(prompt, options = {}) {
  const request = imageRequest(prompt, options);
  if (!request) return null;
  const requestId = options.requestId || createVisionRequestId();
  const trace = options.trace || traceVision;
  const userQuestion = stripRanaMention(request.userText);
  await trace(requestId, "image_input_snapshot", {
    sourceType: request.sourceType || "unknown",
    attachmentPath: request.attachmentPath || "",
    userQuestion,
    openClawGeneratedDescription: openClawGeneratedDescription(prompt),
    imageMarkerCount: (firstText(prompt).match(/\[Image\]/gi) || []).length,
    mediaUriCount: (firstText(prompt).match(/media:\/\/inbound\//gi) || []).length,
    currentTurnMediaProvenance: Boolean(request.provenance),
  }, { force: true });
  await trace(requestId, "image_request_resolved", {
    sourceType: request.sourceType || "unknown",
    attachmentPath: request.attachmentPath || "",
    sourceMessageId: request.sourceMessageId || "",
    userQuestion,
  }, { force: true });
  try {
    const evidence = await (options.buildEvidence || buildVisionEvidence)(request.load, userQuestion, options.signal, requestId);
    evidence.request_id = requestId;
    const payload = ooggPayload(evidence, userQuestion);
    const context = ooggContext(evidence, userQuestion);
    await trace(requestId, "final_identity_payload", payload);
    await trace(requestId, "final_oogg_payload", payload, { force: true });
    await trace(requestId, "oogg_prepend_context", { context, payload }, { force: true });
    const resolvedName = payload.imageUnderstanding.primaryCharacter?.canonicalName
      || payload.imageUnderstanding.externalIdentity?.name
      || "unknown";
    console.log(`[rana-vision] request=${requestId} evidence ready identity=${resolvedName}`);
    return { requestId, context, evidence, payload, sourceMessageId: request.sourceMessageId || "" };
  } catch (error) {
    // A reply reference is only a candidate. Fetching the referenced Discord
    // message is the authoritative check; do not inject an image failure into
    // ordinary text replies merely because they have reply metadata.
    if (repliedImageReference(prompt)
      && /referenced message has no image attachment/i.test(String(error?.message || error))) {
      return null;
    }
    const message = String(error?.message || error);
    await trace(requestId, "vision_pipeline_error", { error: message }, { force: true });
    const searchPolicy = detectSearchPolicy(userQuestion);
    const evidence = {
      request_id: requestId,
      vision: { status: "unavailable", observation: null, error: message },
      local_ocr: { status: "unavailable", normalized_lines: [] },
      identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null, externalIdentity: null },
      search_policy: searchPolicy,
      deep_search: {
        status: "error",
        searchMode: searchPolicy.mode,
        searchExhausted: false,
        resolvedIdentity: null,
        reason: "vision_pipeline_error",
        error: message,
      },
      external_identity: null,
      conflicts: [],
    };
    const payload = ooggPayload(evidence, userQuestion);
    const context = ooggContext(evidence, userQuestion);
    await trace(requestId, "final_identity_payload", payload);
    await trace(requestId, "final_oogg_payload", payload, { force: true });
    await trace(requestId, "oogg_prepend_context", { context, payload }, { force: true });
    return { requestId, context, evidence, payload, sourceMessageId: request.sourceMessageId || "" };
  }
}

/* RANA_VISION_RAW_CAPTURE_START */
const RAW_CAPTURE_DIR = "C:\\tmp\\rana-vision-raw-model-capture\\raw";
const RAW_CAPTURE_MODE = String(process.env.RANA_VISION_TRACE_MODE || "").toLowerCase();
const RAW_CAPTURE_ENABLED = process.env.RANA_VISION_RAW_CAPTURE === "1"
  && !["core", "identity"].includes(RAW_CAPTURE_MODE);

function rawCaptureSerializable(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(item)) {
      return { type: "Buffer", byteLength: item.length, sha256Unavailable: true };
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }));
}

async function rawCaptureWrite(requestId, stage, data = {}) {
  if (!RAW_CAPTURE_ENABLED) return;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const safeId = String(requestId || "unmatched")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 160) || "unmatched";
    await fs.mkdir(RAW_CAPTURE_DIR, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      request_id: requestId || null,
      stage,
      data: rawCaptureSerializable(data),
    });
    await fs.appendFile(path.join(RAW_CAPTURE_DIR, `${safeId}.jsonl`), `${line}\n`, "utf8");
  } catch (error) {
    console.warn(`[rana-vision-raw] ${stage} capture failed: ${error?.message || String(error)}`);
  }
}
/* RANA_VISION_RAW_CAPTURE_END */
export function registerVisionGuidance(api) {
  // Passive diagnostics only. These hooks never return replacement content.
  api.on("llm_input", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "oogg_6969_llm_input_raw", {
      runId: event?.runId,
      sessionId: event?.sessionId,
      sessionKey: ctx?.sessionKey,
      provider: event?.provider,
      model: event?.model,
      systemPrompt: event?.systemPrompt,
      prompt: event?.prompt,
      historyMessages: event?.historyMessages,
      imagesCount: event?.imagesCount,
      tools: event?.tools,
      context: ctx,
    });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("model_call_started", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "model_call_started_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("model_call_ended", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "model_call_ended_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("llm_output", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "oogg_6969_llm_output_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("before_agent_finalize", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "before_agent_finalize_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("before_message_write", (event, ctx) => {
    const pending = deliveryTracker.findByRunId(ctx?.runId || event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    void rawCaptureWrite(pending.requestId, "out_before_message_write_raw", { event, context: ctx })
      .catch((error) => console.warn(`[rana-vision-raw] before_message_write capture failed: ${error?.message || error}`));
  }, { priority: 5000 });

  api.on("reply_payload_sending", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "out_reply_payload_sending_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("message_sending", async (event, ctx) => {
    const pending = deliveryTracker.peek(ctx);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "out_message_sending_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("message_sent", async (event, ctx) => {
    const pending = deliveryTracker.peek(ctx);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "out_message_sent_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("agent_end", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(ctx?.runId || event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    await rawCaptureWrite(pending.requestId, "agent_end_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("before_compaction", async (event, ctx) => {
    await rawCaptureWrite(`session-${ctx?.sessionId || ctx?.sessionKey || "unknown"}`, "before_compaction_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });

  api.on("after_compaction", async (event, ctx) => {
    await rawCaptureWrite(`session-${ctx?.sessionId || ctx?.sessionKey || "unknown"}`, "after_compaction_raw", { event, context: ctx });
  }, { priority: 5000, timeoutMs: 15_000 });
  api.on("before_prompt_build", async (event, ctx) => {
    if (Array.isArray(event?.messages)) {
      const sanitized = stripHistoricalVisionWorkingPayloads(event.messages);
      const changed = sanitized.length !== event.messages.length
        || sanitized.some((message, index) => message !== event.messages[index]);
      if (changed) {
        try {
          event.messages.splice(0, event.messages.length, ...sanitized);
        } catch {}
      }
    }
    let built = null;
    try {
      const turnKey = visionTurnKey(event, ctx);
      built = await visionEvidenceCache.getOrCreate(turnKey, () =>
        buildImageEvidenceContext(event?.prompt, {
          signal: ctx?.abortSignal,
          currentTurnMediaEvidence: currentTurnProvenance(event, ctx),
        }));
    } catch (error) {
      console.warn(`[rana-vision] evidence failed: ${error?.message || String(error)}`);
      return { prependContext: "圖片分析目前失敗。只能誠實說看不清楚；不得猜角色、不得假裝已辨識。" };
    }
    if (!built) {
      const followupQuestion = stripRanaMention(extractUserMessageText(event?.prompt));
      const selfIdentityContext = directSelfIdentityContext(followupQuestion);
      if (selfIdentityContext) return { prependContext: selfIdentityContext };
      const recent = isPersonaFollowupQuestion(followupQuestion)
        ? recallRecentVisionSubject(ctx?.sessionKey)
        : null;
      if (recent) {
        const requestId = createVisionRequestId();
        const payload = JSON.parse(JSON.stringify(recent.payload));
        payload.requestId = requestId;
        payload.userQuestion = followupQuestion;
        payload.personaEvidence = await buildVisionPersonaEvidence(payload, followupQuestion, {
          sessionKey: ctx?.sessionKey,
          signal: ctx?.abortSignal,
        });
        built = {
          requestId,
          evidence: null,
          payload,
          context: ooggContext(null, followupQuestion, payload),
          sourceMessageId: recent.sourceMessageId,
          personaReady: true,
          isFollowup: true,
        };
        await traceVision(requestId, "vision_persona_followup", {
          userQuestion: followupQuestion,
          sourceMessageId: recent.sourceMessageId,
          personaEvidence: payload.personaEvidence,
        }, { force: true });
      }
    }
    if (!built) {
      try {
        const mediaBuilt = await buildMediaEvidenceContext(event?.prompt, { signal: ctx?.abortSignal });
        if (mediaBuilt) return { prependContext: mediaBuilt.context };
      } catch (error) {
        console.warn(`[rana-media] analysis failed: ${error?.message || String(error)}`);
        return { prependContext: "附件分析失敗。直接說現在看不了這個附件；不得猜內容。" };
      }
      return;
    }
    try {
      if (!built.personaReady) {
        built.payload.personaEvidence = await buildVisionPersonaEvidence(
          built.payload,
          built.payload?.userQuestion || "",
          { sessionKey: ctx?.sessionKey, signal: ctx?.abortSignal },
        );
        built.context = ooggContext(built.evidence, built.payload?.userQuestion || "", built.payload);
        const lorePack = built.payload.personaEvidence?.queryPlan
          ? built.payload.personaEvidence
          : null;
        if (lorePack) {
          rememberResolvedEntities(ctx?.sessionKey, [{
            entity_id: built.payload.personaEvidence.resolvedSubject?.entityId,
            canonical_id: built.payload.personaEvidence.resolvedSubject?.canonicalId,
            canonical_name: built.payload.personaEvidence.resolvedSubject?.verifiedName,
            source: "vision_persona",
          }].filter((item) => item.entity_id));
        }
        await traceVision(built.requestId, "vision_persona_evidence", {
          userQuestion: built.payload?.userQuestion || "",
          personaEvidence: built.payload.personaEvidence,
        }, { force: true });
        await traceVision(built.requestId, "oogg_persona_prepend_context", {
          context: built.context,
          payload: built.payload,
        }, { force: true });
        rememberRecentVisionSubject(ctx?.sessionKey, built);
      }
      const messagesBeforeIsolation = RAW_CAPTURE_ENABLED && Array.isArray(event?.messages)
        ? [...event.messages]
        : [];
      const messagesBeforeIsolationCount = Array.isArray(event?.messages) ? event.messages.length : 0;
      const isolatedMessages = isolateCurrentVisionHistory(event?.messages);
      let historyIsolationApplied = false;
      if (Array.isArray(event?.messages) && isolatedMessages.length !== event.messages.length) {
        try {
          event.messages.splice(0, event.messages.length, ...isolatedMessages);
          historyIsolationApplied = true;
        } catch {}
      }
      await rawCaptureWrite(built.requestId, "vision_history_isolation", {
        beforeCount: messagesBeforeIsolationCount,
        afterCount: Array.isArray(event?.messages) ? event.messages.length : isolatedMessages.length,
        removedCount: Math.max(0, messagesBeforeIsolationCount - isolatedMessages.length),
        applied: historyIsolationApplied,
      });
      await rawCaptureWrite(built.requestId, "before_prompt_build_raw", {
        runId: ctx?.runId,
        sessionId: ctx?.sessionId,
        sessionKey: ctx?.sessionKey,
        channelId: ctx?.channelId,
        conversationId: ctx?.conversationId,
        prompt: event?.prompt,
        messagesBeforeIsolation,
        messages: event?.messages,
        generatedVisionContext: built.context,
        generatedVisionPayload: built.payload,
      });
      const promptDiscord = discordPromptMetadata(event?.prompt);
      const discord = {
        ...promptDiscord,
        // A reply can be a text-only question about an earlier image. Feedback
        // must fetch that image message again, not the intervening question.
        sourceMessageId: built.sourceMessageId || promptDiscord.sourceMessageId,
      };
      if (ctx?.runId) pendingRuns.set(ctx.runId, {
        requestId: built.requestId,
        channelId: ctx.channelId,
        conversationId: ctx.conversationId,
        payload: built.payload,
        discord,
      });
      if (ctx?.runId) deliveryTracker.enqueue({
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        requestId: built.requestId,
        channelId: ctx.channelId,
        conversationId: ctx.conversationId,
        payload: built.payload,
        userQuestion: built.payload?.userQuestion || "",
        discord,
      });
      return { prependContext: built.context };
    } catch (error) {
      console.warn(`[rana-vision] delivery state failed: ${error?.message || String(error)}`);
      return { prependContext: built.context };
    }
  }, { priority: 1000, timeoutMs: 180_000 });

  api.on("before_model_resolve", (event, ctx) => {
    pruneMediaProvenance();
    const key = visionTurnKey(event, ctx);
    if (!key) return;
    const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
    mediaProvenanceByTurn.set(key, {
      currentTurn: true,
      attachments,
      recordedAt: Date.now(),
    });
    // This hook records provenance only. It deliberately returns no routing
    // override and therefore cannot alter provider, model, or fallback policy.
    return;
  }, { priority: 5000, timeoutMs: 5000 });

  api.on("llm_output", async (event) => {
    const run = pendingRuns.get(event?.runId);
    if (!run) return;
    pendingRuns.delete(event.runId);
    const before = firstText(Array.isArray(event?.assistantTexts) && event.assistantTexts.length ? event.assistantTexts : event?.lastAssistant);
    const recommended = guardVisionIdentityOutput(before, run.payload);
    const wouldChange = recommended !== before;
    await traceVision(run.requestId, "oogg_raw_output", {
      provider: event.provider,
      model: event.model,
      assistant_texts: event.assistantTexts,
      last_assistant: event.lastAssistant,
      content_before: before,
      content_after: before,
      mutated: false,
      final_authority: "oogg",
      guard_recommendation: wouldChange ? recommended : null,
      guard_would_change: wouldChange,
      usage: event.usage,
    }, { force: true });
  });

  api.on("agent_end", async (event, ctx) => {
    const pending = deliveryTracker.findByRunId(ctx?.runId);
    if (!pending) return;
    await traceVision(pending.requestId, "agent_end", {
      success: event?.success,
      error: event?.error,
      durationMs: event?.durationMs,
    }, { force: true });
    if (event?.success) {
      void attachFeedbackAfterAgentEnd(pending, event).catch(async (error) => {
        await traceVision(pending.requestId, "vision_feedback_panel_error", {
          error: String(error?.message || error),
          deliveryStage: "agent_end_poll",
        }, { force: true });
        console.warn(`[rana-vision] feedback panel failed: ${error?.message || String(error)}`);
      });
    }
  });

  api.on("before_message_write", (event, ctx) => {
    const role = String(event?.message?.role || "unknown").toLowerCase();
    // Current user input is already captured by image_input_snapshot. Do not
    // attach later user messages to an older pending vision request.
    if (role !== "assistant") return;
    const pending = deliveryTracker.findByRunId(ctx?.runId || event?.runId)
      || deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    const before = firstText(event?.message?.content);
    const recommended = guardVisionIdentityOutput(before, pending.payload);
    const wouldChange = recommended !== before;
    if (!before && !recommended) return;
    void traceVision(pending.requestId, "oogg_output_before_message_write", {
      role,
      content_before: before,
      content_after: before,
      mutated: false,
      final_authority: "oogg",
      guard_recommendation: wouldChange ? recommended : null,
      guard_would_change: wouldChange,
    }, { force: true }).catch((error) =>
      console.warn(`[rana-vision] output trace failed: ${error?.message || error}`));
  });

  api.on("reply_dispatch", async (event) => {
    const pending = deliveryTracker.findByRunId(event?.runId);
    if (!pending) return;
    await traceVision(pending.requestId, "reply_dispatch", {
      sendPolicy: event?.sendPolicy,
      suppressUserDelivery: event?.suppressUserDelivery,
      shouldRouteToOriginating: event?.shouldRouteToOriginating,
      originatingChannel: event?.originatingChannel,
      originatingTo: event?.originatingTo,
      isTailDispatch: event?.isTailDispatch,
    }, { force: true });
  });

  api.on("message_sending", async (event, ctx) => {
    const pending = deliveryTracker.peek(ctx);
    if (!pending) return;
    const before = firstText(event?.content);
    const recommended = guardVisionIdentityOutput(before, pending.payload);
    const wouldChange = recommended !== before;
    await traceVision(pending.requestId, "oogg_output_message_sending", {
      content_before: before,
      content_after: before,
      mutated: false,
      final_authority: "oogg",
      guard_recommendation: wouldChange ? recommended : null,
      guard_would_change: wouldChange,
    }, { force: true });
  }, { priority: 2000 });

  api.on("message_sent", async (event, ctx) => {
    const pending = deliveryTracker.take(ctx);
    if (!pending) return;
    visionEvidenceCache.delete(visionTurnKey(event, ctx) || pending.runId);
    let responseMessageId = event?.messageId ?? event?.metadata?.messageId ?? null;
    if (!responseMessageId) {
      responseMessageId = await resolveDiscordResponseMessageId({
        channelId: pending.discord?.channelId || ctx?.conversationId || ctx?.channelId,
        content: event?.content,
      });
    }
    await traceVision(pending.requestId, "discord_final_output", {
      content: event?.content,
      success: event?.success,
      error: event?.error,
      messageId: responseMessageId,
      channelId: ctx?.channelId,
      accountId: ctx?.accountId,
      deliveryStage: "message_sent",
    }, { force: true });
    if (event?.success === false || !responseMessageId) return;
    try {
      const feedback = await attachVisionFeedbackPanel({
        requestId: pending.requestId,
        requesterId: pending.discord?.requesterId,
        channelId: pending.discord?.channelId || ctx?.channelId,
        sourceMessageId: pending.discord?.sourceMessageId,
        responseMessageId,
        userQuestion: pending.userQuestion,
        payload: pending.payload,
      });
      await traceVision(pending.requestId, "vision_feedback_panel", feedback, { force: true });
    } catch (error) {
      await traceVision(pending.requestId, "vision_feedback_panel_error", {
        error: String(error?.message || error),
      }, { force: true });
      console.warn(`[rana-vision] feedback panel failed: ${error?.message || String(error)}`);
    }
  });
}

export const __test = {
  buildImageEvidenceContext,
  extractUserMessageText,
  openClawGeneratedDescription,
  hasImagePlaceholder,
  imageAttachmentPath,
  imageRequest,
  isInternalTitleRequest,
  ooggContext,
  ooggPayload,
  buildVisionPersonaEvidence,
  querySpecificRelationshipFacts,
  compactRelationshipFact,
  isConcreteRelationshipFact,
  explicitNegativeRecognitionFact,
  isPersonaFollowupQuestion,
  isDirectSelfIdentityQuestion,
  directSelfIdentityContext,
  safeCanonicalSubject,
  repliedImageReference,
  stripRanaMention,
  createDeliveryTracker,
  createVisionEvidenceCache,
  lastAssistantText,
  messageHasImage,
  currentTurnMediaEvidence,
  mediaMetadataAuthorizesPath,
  visionTurnKey,
  currentTurnProvenance,
  isolateCurrentVisionHistory,
  isIdentityQuestionText,
  unresolvedIdentityBoundary,
  guardVisionIdentityOutput,
  imageAnalysisStatus,
  hasExplicitVisionIntent,
  guardAssistantMessage,
  guardAssistantMessageInPlace,
  guardLlmOutputInPlace,
};

import { buildVisionEvidence } from "./evidence.js";
import { createVisionRequestId, traceVision } from "./debug.js";
import { loadInboundImage, loadRepliedDiscordImage } from "./client.js";
import { identityReferenceCatalog } from "./character_catalog.js";
import { attachVisionFeedbackPanel, discordPromptMetadata, resolveDiscordResponseMessageId } from "./feedback.js";
import { buildMediaEvidenceContext } from "./media.js";

const pendingRuns = new Map();
const DELIVERY_TRACE_TTL_MS = 2 * 60 * 1000;

function createDeliveryTracker(ttlMs = DELIVERY_TRACE_TTL_MS) {
  const pending = [];

  function prune(now) {
    while (pending.length && now - pending[0].queuedAt > ttlMs) pending.shift();
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
      const matched = pending.findIndex((entry) =>
        entry.conversationId === conversationId || entry.channelId === conversationId);
      if (matched >= 0) return matched;
    }
    if (channelId) {
      const matched = pending.findIndex((entry) =>
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
        const match = pending.find((entry) => entry.sessionKey === sessionKey);
        if (match) return match;
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
const identityNames = identityReferenceCatalog();

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  if (value && typeof value === "object") return firstText(value.text) || firstText(value.content) || firstText(value.body);
  return "";
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

function normalizedIdentityText(value) {
  return firstText(value).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function mentionedIdentityIds(value) {
  const text = normalizedIdentityText(value);
  if (!text) return [];
  return identityNames.filter((identity) => identity.aliases.some((alias) => {
    const needle = normalizedIdentityText(alias);
    if (!needle) return false;
    if (/^[a-z0-9]+$/i.test(needle) && needle.length < 3) return false;
    return text.includes(needle);
  })).map((identity) => identity.id);
}

function asksForIdentity(value) {
  return /(?:這|这|她|他|它|右邊|右边|左邊|左边).{0,8}(?:是誰|是谁|哪個人|哪个人)|(?:是誰|是谁|認識|认识|認得|认得|叫什麼|叫什么|確定是|确定是)/u.test(firstText(value));
}

function asksForAppearance(value) {
  return /(?:外觀|外表|長什麼樣|长什么样|描述|看起來|看起来|表情|衣服|穿什麼|穿什么|在做什麼|在做什么)/u.test(firstText(value));
}

function asksForFullName(value) {
  return /(?:全名|名字叫什麼|名字叫什么|本名)/u.test(firstText(value));
}

function imageAnalysisStatus(evidence, primaryCharacter) {
  if (primaryCharacter && (primaryCharacter.confidence === "high" || primaryCharacter.confidence === "medium")) {
    return "known";
  }
  const observation = evidence?.vision?.observation;
  const visionStatus = evidence?.vision?.status;
  if (observation && typeof observation === "object" && !["unavailable", "error", "failed"].includes(visionStatus)) {
    return "unknown";
  }
  return "error";
}

function guardVisionIdentityOutput(content, payload) {
  const text = firstText(content).trim();
  if (!text) return text;
  const primary = payload?.imageUnderstanding?.primaryCharacter || null;
  const acceptedPrimary = primary && (primary.confidence === "high" || primary.confidence === "medium");
  const allowedIds = new Set((payload?.imageUnderstanding?.detectedCharacters || [])
    .filter((item) => item?.confidence === "high" || item?.confidence === "medium")
    .map((item) => item.canonicalId));
  if (acceptedPrimary) allowedIds.add(primary.canonicalId);
  const unsupported = mentionedIdentityIds(text).filter((id) => !allowedIds.has(id));
  const externalReference = payload?.imageUnderstanding?.externalReference || null;

  if (!acceptedPrimary && unsupported.length) {
    return payload?.imageUnderstanding?.analysisStatus === "error"
      ? "圖片分析失敗。不能確定是誰。"
      : "不認得。";
  }
  if (!acceptedPrimary && asksForIdentity(payload?.userQuestion) && !externalReference) {
    return payload?.imageUnderstanding?.analysisStatus === "error"
      ? "圖片分析失敗。不能確定是誰。"
      : "不認得。";
  }
  const selfIdentityOnly = primary?.canonicalId === "rana"
    && asksForIdentity(payload?.userQuestion)
    && !asksForAppearance(payload?.userQuestion)
    && !asksForFullName(payload?.userQuestion);
  const selfReportViolation = /(?:要樂奈|要楽奈|要乐奈|Rana|Raana|灰白短髮|灰白短发|異色瞳|异色瞳|畫面裡|画面里|圖中|图中|照片裡|照片里|這(?:個|位)?女孩|这(?:个|位)?女孩)/iu.test(text);
  const unsupportedAction = /(?:正(?:在)?吃|正在吃|吃著|吃着|咬著|咬着|喝著|喝着|拿著|拿着).{0,12}(?:抹茶|芭菲|甜點|甜点|食物)/u.test(text);
  if (selfIdentityOnly && (selfReportViolation || unsupportedAction)) return "是我。";
  if (unsupported.length) {
    return primary?.canonicalId === "rana" ? "是我。" : `是${primary.canonicalName}。`;
  }
  return text;
}

function guardAssistantMessage(message, payload) {
  if (message?.role !== "assistant") return { message, before: "", after: "", changed: false };
  const before = firstText(message?.content).trim();
  if (!before) return { message, before, after: before, changed: false };
  const after = guardVisionIdentityOutput(before, payload);
  if (after === before) return { message, before, after, changed: false };
  if (!Array.isArray(message.content)) {
    return { message: { ...message, content: after }, before, after, changed: true };
  }
  const nonText = message.content.filter((item) => item?.type !== "text");
  return {
    message: { ...message, content: [{ type: "text", text: after }, ...nonText] },
    before,
    after,
    changed: true,
  };
}

function guardAssistantMessageInPlace(message, payload) {
  const guarded = guardAssistantMessage(message, payload);
  if (guarded.changed && message && typeof message === "object") {
    Object.assign(message, guarded.message);
    guarded.message = message;
  }
  return guarded;
}

function replaceAssistantMessageTextInPlace(message, text) {
  if (!message || typeof message !== "object") return;
  if (!Array.isArray(message.content)) {
    message.content = text;
    return;
  }
  const nonText = message.content.filter((item) => item?.type !== "text");
  message.content.splice(0, message.content.length, { type: "text", text }, ...nonText);
}

function guardLlmOutputInPlace(event, payload) {
  const assistantTexts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : null;
  const before = firstText(assistantTexts?.length ? assistantTexts : event?.lastAssistant).trim();
  if (!before) return { before, after: before, changed: false };
  const after = guardVisionIdentityOutput(before, payload);
  if (assistantTexts) assistantTexts.splice(0, assistantTexts.length, after);
  replaceAssistantMessageTextInPlace(event?.lastAssistant, after);
  return { before, after, changed: before !== after };
}

function extractUserMessageText(prompt) {
  const text = firstText(prompt);
  const markers = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/gi)];
  const marker = markers.at(-1);
  return (marker?.[1] || text).replace(/\[media attached:[\s\S]*$/i, "").trim();
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

function repliedImageReference(value) {
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
  return /<media:image>(?:\s*\(\d+\s+images?\))?/i.test(firstText(value));
}

function imageRequest(prompt, loaders = {}) {
  // OpenClaw's session-title/compaction prompts include old user messages verbatim.
  // They are not new Discord input and must never replay a previous image request.
  if (isInternalTitleRequest(prompt)) return null;
  const userText = extractUserMessageText(prompt);
  const loadInbound = loaders.loadInboundImage || loadInboundImage;
  const loadReply = loaders.loadRepliedDiscordImage || loadRepliedDiscordImage;
  const attachmentPath = imageAttachmentPath(prompt);
  if (attachmentPath) return { userText, load: (signal, requestId) => loadInbound(attachmentPath, signal, requestId) };
  const reply = repliedImageReference(prompt);
  if (reply) return {
    userText,
    sourceMessageId: reply.message,
    load: (signal, requestId) => loadReply(reply.channel, reply.message, signal, requestId),
  };
  if (hasImagePlaceholder(prompt)) {
    return {
      userText,
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
    canonicalId: identity.canonicalId,
    canonicalName: identity.canonicalName,
    confidence: identity.confidence,
    confidenceScore: identity.confidenceScore,
    evidence: identity.evidence,
  };
}

function ooggPayload(evidence, userQuestion = "") {
  const resolution = evidence?.identity_resolution || {};
  const primary = publicCharacter(resolution.primaryCharacter);
  const detected = (resolution.detectedCharacters || []).map((item) => ({
    ...publicCharacter(item),
    position: item.evidence?.find((entry) => entry.position)?.position || "",
    impression: item.impression ? {
      recognitionLevel: item.impression.recognitionLevel,
      tentative: item.impression.tentative,
    } : null,
  }));
  const impression = resolution.primaryImpression;
  return {
    schema: "rana.vision.oogg-payload.v2",
    requestId: evidence?.request_id || "",
    imageUnderstanding: {
      analysisStatus: imageAnalysisStatus(evidence, primary),
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
      primaryCharacter: primary,
      detectedCharacters: detected,
      identityConflicts: evidence?.conflicts || [],
    },
    ranaCharacterImpression: impression ? {
      recognitionLevel: impression.recognitionLevel,
      howRanaKnowsThem: impression.howRanaKnowsThem,
      memoryAnchors: impression.memoryAnchors,
      ranaCallsThem: impression.ranaCallsThem,
      allowedKnowledge: impression.allowedKnowledge,
      allowedReactionStyle: impression.allowedReactionStyle,
      forbiddenExpansion: impression.forbiddenExpansion,
      tentative: impression.tentative,
    } : null,
    userQuestion,
    responseContract: {
      answerQuestionFirst: true,
      includeRanaReaction: true,
      avoidEncyclopedicVoice: true,
      avoidFragmentOnlyResponse: true,
      respectKnowledgeBoundary: true,
      identityConfidenceRules: {
        high: "可以直接說辨識結果；人物印象仍受 recognitionLevel 限制",
        medium: "使用像是、應該是等保留語氣；人物印象視為 tentative",
        low: "不得注入或表現熟人反應",
        unknown: "只回答畫面可見內容，不猜角色",
      },
    },
  };
}

function ooggContext(evidence, userQuestion = "") {
  const payload = ooggPayload(evidence, userQuestion);
  return [
    "以下是 Rana 圖片 production pipeline 的結構化結果。先回答使用者的圖片問題，再加入樂奈自己的自然反應。",
    "身分只能使用 imageUnderstanding 的 canonical identity 與 confidence；不得從人物印象反推身分。",
    "ranaCharacterImpression 只控制樂奈是否認得、如何稱呼與可使用的親身記憶。recognitionLevel=unknown 時即使身分辨識正確，也只能說不熟、可能見過或不知道。",
    "primaryCharacter 為 null、low 或 unknown 時，不得提任何角色姓名，也不得用『像某人』、『是不是某人』作比較或猜測。",
    "primaryCharacter.canonicalId=rana 時，這是自己：用第一人稱回答。除非使用者問全名，不要說『要樂奈』；除非使用者問外觀，不要重述髮色、瞳色或 Vision 摘要。",
    "使用者只問『是誰』時直接回答身分；不要用『畫面裡是』開頭，不要追加人物資料卡。",
    "Vision summary 可能包含推測。只有畫面直接可見的動作才能當成事實；suggesting、indicated、looks like 等推論不得改寫成『正在做』。使用者文字提到的物品也不等於出現在圖片中。",
    "externalReference is corroborated only at work scope. It may support naming that work plus direct visible content, but never an exact character name, relationships, or a character impression.",
    "不要輸出 schema、trace、provider、模型或系統流程。不要把全部資料傾倒成百科。",
    JSON.stringify(payload),
  ].join("\n");
}

export async function buildImageEvidenceContext(prompt, options = {}) {
  const request = imageRequest(prompt, options);
  if (!request) return null;
  const requestId = options.requestId || createVisionRequestId();
  const trace = options.trace || traceVision;
  const userQuestion = stripRanaMention(request.userText);
  try {
    const evidence = await (options.buildEvidence || buildVisionEvidence)(request.load, userQuestion, options.signal, requestId);
    evidence.request_id = requestId;
    const payload = ooggPayload(evidence, userQuestion);
    const context = ooggContext(evidence, userQuestion);
    await trace(requestId, "final_oogg_payload", payload, { force: true });
    console.log(`[rana-vision] request=${requestId} evidence ready identity=${payload.imageUnderstanding.primaryCharacter?.canonicalName || "unknown"}`);
    return { requestId, context, evidence, payload, sourceMessageId: request.sourceMessageId || "" };
  } catch (error) {
    // A reply reference is only a candidate.  Fetching the referenced Discord
    // message is the authoritative check; do not inject an image failure into
    // ordinary text replies merely because they have reply metadata.
    if (repliedImageReference(prompt)
      && /referenced message has no image attachment/i.test(String(error?.message || error))) {
      return null;
    }
    await trace(requestId, "vision_pipeline_error", { error: String(error?.message || error) }, { force: true });
    throw error;
  }
}

export function registerVisionGuidance(api) {
  api.on("before_prompt_build", async (event, ctx) => {
    let built = null;
    try {
      built = await buildImageEvidenceContext(event?.prompt, { signal: ctx?.abortSignal });
    } catch (error) {
      console.warn(`[rana-vision] evidence failed: ${error?.message || String(error)}`);
      return { prependContext: "圖片分析目前失敗。只能誠實說看不清楚；不得猜角色、不得假裝已辨識。" };
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
  }, { priority: 1000 });

  api.on("llm_output", async (event) => {
    const run = pendingRuns.get(event?.runId);
    if (!run) return;
    pendingRuns.delete(event.runId);
    const guarded = guardLlmOutputInPlace(event, run.payload);
    await traceVision(run.requestId, "oogg_response_before_output_guard", {
      provider: event.provider,
      model: event.model,
      assistant_texts_before: guarded.before,
      assistant_texts_after: event.assistantTexts,
      last_assistant_after: event.lastAssistant,
      output_guard_changed: guarded.changed,
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
    const pending = deliveryTracker.findBySessionKey(ctx?.sessionKey || event?.sessionKey);
    if (!pending) return;
    const guarded = guardAssistantMessageInPlace(event?.message, pending.payload);
    if (!guarded.before) return;
    void traceVision(pending.requestId, "output_guard_before", {
      content: guarded.before,
      hook: "before_message_write",
    }, { force: true }).catch((error) => console.warn(`[rana-vision] output trace failed: ${error?.message || error}`));
    void traceVision(pending.requestId, "output_guard_after", {
      content: guarded.after,
      changed: guarded.changed,
      hook: "before_message_write",
      acceptedIdentityIds: (pending.payload?.imageUnderstanding?.detectedCharacters || [])
        .filter((item) => item?.confidence === "high" || item?.confidence === "medium")
        .map((item) => item.canonicalId),
    }, { force: true }).catch((error) => console.warn(`[rana-vision] output trace failed: ${error?.message || error}`));
    if (guarded.changed) return { message: guarded.message };
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
    await traceVision(pending.requestId, "output_guard_before", { content: event?.content }, { force: true });
    const guardedContent = guardVisionIdentityOutput(event?.content, pending.payload);
    const changed = guardedContent !== firstText(event?.content).trim();
    await traceVision(pending.requestId, "output_guard_after", {
      content: guardedContent,
      changed,
      acceptedIdentityIds: (pending.payload?.imageUnderstanding?.detectedCharacters || [])
        .filter((item) => item?.confidence === "high" || item?.confidence === "medium")
        .map((item) => item.canonicalId),
    }, { force: true });
    if (changed) return { content: guardedContent };
  }, { priority: 2000 });

  api.on("message_sent", async (event, ctx) => {
    const pending = deliveryTracker.take(ctx);
    if (!pending) return;
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
  hasImagePlaceholder,
  imageAttachmentPath,
  imageRequest,
  isInternalTitleRequest,
  ooggContext,
  ooggPayload,
  repliedImageReference,
  stripRanaMention,
  createDeliveryTracker,
  lastAssistantText,
  guardVisionIdentityOutput,
  imageAnalysisStatus,
  mentionedIdentityIds,
  asksForAppearance,
  asksForFullName,
  guardAssistantMessage,
  guardAssistantMessageInPlace,
  guardLlmOutputInPlace,
};

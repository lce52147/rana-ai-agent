import { loadInboundImage, loadRepliedDiscordImage } from "./client.js";
import { buildVisionEvidence } from "./evidence.js";
import { createVisionRequestId } from "./debug.js";
import { currentTurnProvenance, ooggPayload, repliedImageReference, visionTurnKey } from "./guidance.js";
import {
  currentTurnImagePaths,
  isCurrentTurnToolAuthorized,
  isCurrentUsableImagePath,
} from "../rana-runtime/current_turn_tool_contract.js";

const authorizedInboundPaths = new Map();
const toolCapabilities = new Map();
const AUTHORIZATION_TTL_MS = 2 * 60 * 1000;

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return firstText(value.text) || firstText(value.content) || firstText(value.body);
  }
  return "";
}

function normalizeInboundPath(value) {
  const text = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!text) return "";
  return process.platform === "win32" ? text.toLowerCase() : text;
}

function currentInboundPaths(prompt) {
  return currentTurnImagePaths(prompt);
}

function hasAuthoritativeImageAttachment(filePath, provenance = {}) {
  return isCurrentUsableImagePath(filePath, provenance);
}

function authorizeCurrentPrompt(event, ctx = {}, provenance = {}) {
  pruneAuthorizationState();
  const paths = currentInboundPaths(event?.prompt);
  const key = visionTurnKey(event, ctx);
  if (!key) return [];
  const explicitIntent = isCurrentTurnToolAuthorized({
    toolName: "rana_analyze_image",
    text: event?.prompt,
    mediaProvenance: provenance,
  });
  const authorized = explicitIntent
    ? paths.filter((path) => isCurrentTurnToolAuthorized({
      toolName: "rana_analyze_image",
      text: event?.prompt,
      mediaProvenance: provenance,
      mediaPath: path,
    }))
    : [];
  authorizedInboundPaths.set(key, {
    key,
    paths: new Set(authorized),
    provenance,
    prompt: firstText(event?.prompt),
    explicitIntent,
    recordedAt: Date.now(),
  });
  return authorized;
}

function pruneAuthorizationState(now = Date.now()) {
  for (const [key, state] of authorizedInboundPaths) {
    if (!state?.recordedAt || now - state.recordedAt > AUTHORIZATION_TTL_MS) authorizedInboundPaths.delete(key);
  }
  for (const [toolCallId, capability] of toolCapabilities) {
    if (!capability?.createdAt || capability.consumed || now - capability.createdAt > AUTHORIZATION_TTL_MS) {
      toolCapabilities.delete(toolCallId);
    }
  }
}

function isAuthorizedInboundPath(value, context = {}) {
  pruneAuthorizationState();
  const key = normalizeInboundPath(value);
  const turn = visionTurnKey(context, context);
  const record = turn ? authorizedInboundPaths.get(turn) : null;
  return Boolean(key && record && !record.consumed && [...record.paths].some((item) => normalizeInboundPath(item) === key));
}

const VISION_AUTHORIZATION_BLOCK_REASON = "rana_analyze_image requires explicit current-turn Vision intent, authoritative current-turn image provenance, and an exact media path";

function visionAuthorizationBlock(reason = VISION_AUTHORIZATION_BLOCK_REASON) {
  return { block: true, blockReason: reason };
}

function ignoredTextOnlyToolCall() {
  return {
    status: "ignored",
    error_code: "no_current_image",
    instruction: "這一輪沒有真實圖片附件。忽略這次工具呼叫，直接依使用者原本的純文字訊息正常回答。不要提到圖片、看不了、工具、路徑或錯誤。",
  };
}

// The detailed exception stays in the gateway trace. This object is sent to
// the language model, so it must not contain endpoint, provider, or stack data
// that could be repeated to Discord.
export function visionToolFailure(requestId) {
  return {
    status: "error",
    request_id: requestId,
    error_code: "vision_unavailable",
    reply: "現在看不了這張。",
  };
}

export function registerVisionTool(api, options = {}) {
  // The automatic Vision pipeline already handles real Discord attachments and
  // replied images in guidance.js. This gate authorizes model calls only when
  // the current turn has explicit Vision intent and authoritative media.
  api.on("before_prompt_build", (event, ctx) => {
    // Reply-image candidates are handled by guidance.js through the
    // authoritative Discord API lookup. Do not inject a contradictory
    // text-only guard, and never turn reply metadata into a local path grant.
    if (repliedImageReference(event?.prompt)) return;
    const provenance = currentTurnProvenance(event, ctx) || options.currentTurnMediaEvidence || {};
    const paths = authorizeCurrentPrompt(event, ctx, provenance);
    if (paths.length > 0) return;
    return {
      prependSystemContext: "本輪沒有真實圖片附件。禁止呼叫 rana_analyze_image，也禁止自行編造 image_path、channel_id 或 reply_message_id；直接回答使用者的純文字。",
    };
  }, { priority: 6000 });

  api.on("before_tool_call", (event, ctx) => {
    pruneAuthorizationState();
    if (String(event?.toolName || "") !== "rana_analyze_image") return;
    const toolCallId = String(event?.toolCallId || "").trim();
    const turn = visionTurnKey(event, ctx);
    const imagePath = String(event?.params?.image_path || "").trim();
    const authorization = turn ? authorizedInboundPaths.get(turn) : null;
    if (!turn || !imagePath || !authorization) return visionAuthorizationBlock();
    if (authorization.capabilityBound) {
      return visionAuthorizationBlock("rana_analyze_image capability already bound for this turn");
    }
    if (!isAuthorizedInboundPath(imagePath, { runId: turn })) return visionAuthorizationBlock();
    if (!isCurrentTurnToolAuthorized({
      toolName: "rana_analyze_image",
      text: firstText(ctx?.currentTurnText).trim() || authorization.prompt,
      mediaProvenance: authorization.provenance,
      mediaPath: imagePath,
    })) return visionAuthorizationBlock();
    // OpenClaw's PluginHookBeforeToolCallEvent declares toolCallId optional.
    // An explicitly authorized event without it must not be vetoed here.
    if (!toolCallId) return;
    authorization.capabilityBound = true;
    toolCapabilities.set(toolCallId, {
      toolCallId,
      turn,
      imagePath: normalizeInboundPath(imagePath),
      createdAt: Date.now(),
      consumed: false,
    });
  }, { priority: 6000, timeoutMs: 5000 });

  api.registerTool({
    name: "rana_analyze_image",
    label: "Rana Analyze Image",
    description: "Allowed only when this current user turn has explicit Vision intent and a usable current image/media, including 給你抹茶芭菲... or 幫我查.... Image alone, intent without media, prior turns, model inference, or discussion is not authorization.",
    parameters: {
      type: "object",
      properties: {
        image_path: {
          type: "string",
          description: "Exact image path copied from the CURRENT turn's [media attached: ...] marker. Never create or guess a path.",
        },
        channel_id: { type: "string", description: "Reserved for the automatic Discord reply-image pipeline." },
        reply_message_id: { type: "string", description: "Reserved for the automatic Discord reply-image pipeline." },
        prompt: { type: "string" },
      },
      required: [],
    },
    execute: async (toolCallId, params, signal, _onUpdate) => {
      const requestId = createVisionRequestId();
      const imagePath = String(params?.image_path || "").trim();
      pruneAuthorizationState();
      const capability = toolCapabilities.get(String(toolCallId || "").trim());

      // Do not touch disk, Discord, ToriiGate, OCR, or reverse search unless the
      // path came from the current inbound media marker. Hallucinated workspace
      // paths return immediately and cannot contaminate the character reply.
      if (!toolCallId || !imagePath || !capability || capability.consumed
        || capability.toolCallId !== String(toolCallId).trim()
        || capability.imagePath !== normalizeInboundPath(imagePath)) {
        return { content: [{ type: "text", text: JSON.stringify(ignoredTextOnlyToolCall()) }] };
      }
      capability.consumed = true;
      toolCapabilities.delete(String(toolCallId).trim());
      authorizedInboundPaths.delete(capability.turn);

      try {
        const result = await (options.buildEvidence || buildVisionEvidence)(
          () => loadInboundImage(imagePath, signal, requestId, {
            currentTurn: true,
            authorizedPaths: [imagePath],
          }),
          params?.prompt,
          signal,
          requestId,
        );
        result.request_id = result.request_id || requestId;
        const compactResult = ooggPayload(result, params?.prompt);
        return { content: [{ type: "text", text: JSON.stringify(compactResult) }] };
      } catch (error) {
        console.warn(`[rana-vision] tool request=${requestId} failed: ${error?.message || String(error)}`);
        return { content: [{ type: "text", text: JSON.stringify(visionToolFailure(requestId)) }] };
      }
    },
  }, { optional: true });
}

export const __test = {
  authorizeCurrentPrompt,
  hasAuthoritativeImageAttachment,
  visionAuthorizationBlock,
  VISION_AUTHORIZATION_BLOCK_REASON,
  pruneAuthorizationState,
  currentInboundPaths,
  ignoredTextOnlyToolCall,
  isAuthorizedInboundPath,
  normalizeInboundPath,
  toolCapabilities,
};

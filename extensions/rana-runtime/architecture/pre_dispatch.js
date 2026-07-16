import {
  eventWasMentioned,
  firstText,
  isRanaMention,
  parseControlRequest,
  parseMemoryDeleteRequest,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
  parsePlayRequest,
  isExplicitHotToolIntent,
} from "../tool_contracts.js";
import { rememberDiscordContext, resolveRequesterId, resolveRequesterRoles } from "../context_store.js";
import { sanitizeRanaTone } from "../output_guard.js";
import { postJson } from "../sidecars/http.js";

const OWNER_IDS = new Set(["376320922484867073", "1197194412929843231"]);
const HOT_TOOLS_URL = "http://127.0.0.1:8091";
const MODEL_HEALTH_URL = process.env.RANA_MODEL_HEALTH_URL || "http://127.0.0.1:6969/v1/models";
const MODEL_HEALTH_TIMEOUT_MS = 1200;
const MODEL_ONLINE_CACHE_MS = 5000;

let modelHealthCache = { checkedAt: 0, online: false };

function compactText(value) {
  return firstText(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function routeLog(kind, text, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`[rana-music-tools] route=${kind}${suffix} text="${compactText(text)}"`);
}

export async function isModelOnline() {
  const now = Date.now();
  if (now - modelHealthCache.checkedAt < MODEL_ONLINE_CACHE_MS) return modelHealthCache.online;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(MODEL_HEALTH_URL, { signal: controller.signal });
    modelHealthCache = { checkedAt: now, online: res.ok };
  } catch (_) {
    modelHealthCache = { checkedAt: now, online: false };
  } finally {
    clearTimeout(timer);
  }
  return modelHealthCache.online;
}

export async function hotFallback(event, ctx, signal) {
  const res = await postJson(`${HOT_TOOLS_URL}/decide`, {
    body: firstText(event?.body),
    content: firstText(event?.content),
    senderId: firstText(event?.senderId) || firstText(ctx?.senderId),
    roles: resolveRequesterRoles(event, ctx),
    isGroup: Boolean(event?.isGroup),
  }, signal);
  if (!res?.handled) return null;
  return sanitizeRanaTone(firstText(res?.reply)) || null;
}

export function senderIdFromEvent(event, ctx) {
  const resolved = resolveRequesterId(event, ctx);
  if (resolved) return resolved;
  const directIds = [
    firstText(event?.senderId),
    firstText(event?.sender_id),
    firstText(event?.authorId),
    firstText(event?.author_id),
    firstText(ctx?.senderId),
    firstText(ctx?.sender_id),
  ].filter(Boolean);
  if (directIds.length > 0) return directIds[0];
  const channelIds = [
    firstText(event?.chat_id),
    firstText(event?.chatId),
    firstText(event?.conversationId),
    firstText(ctx?.chat_id),
    firstText(ctx?.chatId),
    firstText(ctx?.sessionKey),
  ].filter(Boolean);
  for (const value of channelIds) {
    const match = value.match(/(?:^|:)user:(\d{15,25})(?:$|:)/i) || value.match(/^user:(\d{15,25})$/i);
    if (match) return match[1];
  }
  return "";
}

export function isOwnerEvent(event, ctx) {
  const senderId = senderIdFromEvent(event, ctx);
  return Boolean(senderId && OWNER_IDS.has(senderId));
}

export function isDirectMessageEvent(event, ctx) {
  if (event?.isGroup === false) return true;
  const channelIds = [firstText(event?.chat_id), firstText(event?.chatId), firstText(ctx?.chat_id), firstText(ctx?.chatId), firstText(ctx?.sessionKey)].filter(Boolean);
  return channelIds.some((value) => /^user:/i.test(value) || /:user:\d{15,25}/i.test(value));
}

export function isTargetedEvent(event, ctx, text) {
  return eventWasMentioned(event) || isRanaMention(text) || (isDirectMessageEvent(event, ctx) && isOwnerEvent(event, ctx));
}

export function classifyPreDispatch(event, ctx, options = {}) {
  const routeText = firstText(event?.body) || firstText(event?.content);
  if (!isTargetedEvent(event, ctx, routeText)) return { kind: "pass", routeText };
  const control = parseControlRequest(event);
  if (control) return { kind: "voice_control", routeText, control };
  if (options.modelOnline) return { kind: "model", routeText };
  const parsed = parsePlayRequest(event);
  if (parsed) return { kind: "offline_play", routeText, parsed };
  if (isExplicitHotToolIntent(routeText)) return { kind: "offline_hot_tool", routeText };
  return { kind: "model", routeText };
}

export function registerPreDispatch(api, handlers = {}) {
  const {
    handleControlRequest,
    handleMemoryRequest,
    handlePlayRequest,
    isModelOnlineCheck = isModelOnline,
    normalizeRouteText = (value) => value,
  } = handlers;

  api.on("before_dispatch", async (event, ctx) => {
    let routeText = firstText(event?.body) || firstText(event?.content);
    if (isTargetedEvent(event, ctx, routeText)) {
      const normalizedRouteText = normalizeRouteText(routeText);
      if (normalizedRouteText !== routeText) {
        if (typeof event?.body === "string") event.body = normalizedRouteText;
        if (typeof event?.content === "string") event.content = normalizedRouteText;
        routeText = normalizedRouteText;
      }
    }

    if (!isTargetedEvent(event, ctx, routeText)) return;
    rememberDiscordContext(event, ctx);

    const control = parseControlRequest(event);
    if (control) return await handleControlRequest?.(control, event, ctx, routeText);

    const directUrlPlay = parsePlayRequest(event);
    if (directUrlPlay?.url) return await handlePlayRequest?.(directUrlPlay, event, ctx, routeText);

    const memoryWrite = parseMemoryRememberRequest(routeText);
    if (memoryWrite) return await handleMemoryRequest?.(memoryWrite, event, ctx, routeText);

    const memoryDelete = parseMemoryDeleteRequest(routeText);
    if (memoryDelete) return await handleMemoryRequest?.(memoryDelete, event, ctx, routeText);

    const memoryRecall = parseMemoryRecallRequest(routeText);
    if (memoryRecall) return await handleMemoryRequest?.(memoryRecall, event, ctx, routeText);

    const modelOnline = await isModelOnlineCheck();
    if (modelOnline) {
      if (isRanaMention(routeText)) routeLog("model-first", routeText);
      return;
    }

    const decision = classifyPreDispatch(event, ctx, { modelOnline: false });
    if (decision.kind === "model") {
      if (isRanaMention(routeText)) routeLog("model-first", routeText);
      return;
    }
    if (decision.kind === "offline_play") return await handlePlayRequest?.(decision.parsed, event, ctx, routeText);
    if (decision.kind === "offline_hot_tool") {
      routeLog("fallback", routeText);
      try {
        const hotReply = await hotFallback(event, ctx);
        if (hotReply) return { handled: true, text: hotReply };
      } catch (err) {
        console.warn(`[rana-music-tools] hot fallback unavailable: ${err?.message || String(err)}`);
        return { handled: true, text: "在睡覺..." };
      }
    }
    return;
  }, { priority: 1000 });
}

// OpenClaw resolves the model after pre-dispatch. Only an explicitly unreachable
// local endpoint selects Gemini; model errors remain errors rather than retries.
export function registerOfflineModelSelection(api, { isModelOnlineCheck = isModelOnline } = {}) {
  api.on("before_model_resolve", async (event) => {
    if (await isModelOnlineCheck()) return;
    routeLog("model-offline-gemini", event?.prompt || "");
    return {
      providerOverride: "google",
      modelOverride: "gemini-3.1-flash-lite",
    };
  }, { priority: 1000 });
}

export const __test = {
  classifyPreDispatch,
  hotFallback,
  isDirectMessageEvent,
  isModelOnline,
  isOwnerEvent,
  isTargetedEvent,
  registerOfflineModelSelection,
  registerPreDispatch,
  senderIdFromEvent,
};

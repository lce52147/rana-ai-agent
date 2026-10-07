import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixedReply } from "../persona_replies.js";
import { recordToolReceipt, toolReceiptVoiceEnabled } from "./tool_receipt.js";
import { buildUnifiedTurnPlan } from "./turn_plan.js";
import {
  eventWasMentioned,
  firstText,
  isRanaMention,
} from "../tool_contracts.js";
import { rememberDiscordContext, recentMemoryReferenceHints, resolveRequesterId, resolveRequesterRoles } from "../context_store.js";
import { mentionedPersonaIds, resolveBotContext } from "../bot_context.js";
import { sanitizeRanaTone } from "../output_guard.js";
import { postJson } from "../sidecars/http.js";

const OWNER_MENTION_RE = /(?:<@!?376320922484867073>|@很COG)/gu;
const OWNER_IDENTITY_QUESTION_RE = /咳咳咳咳咳（主人）\s*(?:是誰|是誰啊|是什麼人)[？?]?\s*$/u;
const HOT_TOOLS_URL = "http://127.0.0.1:8091";
const DEFAULT_MODEL_HEALTH_URL = "http://127.0.0.1:6969/v1/models";

// The runtime is "model online" when the primary model OR any configured
// fallback that lives on this machine / LAN / tailnet answers. Cloud fallbacks
// are not probed. RANA_MODEL_HEALTH_URL, when set, is used exclusively.
function modelHealthUrls() {
  const explicit = String(process.env.RANA_MODEL_HEALTH_URL || "").trim();
  if (explicit) return [explicit];
  const urls = [];
  try {
    const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
    const model = config?.agents?.defaults?.model || {};
    const providerIds = [model.primary, ...(Array.isArray(model.fallbacks) ? model.fallbacks : [])]
      .map((value) => String(value || "").split("/")[0])
      .filter(Boolean);
    for (const id of providerIds) {
      const base = String(config?.models?.providers?.[id]?.baseUrl || "").trim().replace(/\/+$/u, "");
      if (/^http:\/\//iu.test(base)) urls.push(`${base}/models`);
    }
  } catch (_) {
    // Missing or unreadable config: keep the default local probe only.
  }
  return urls.length ? [...new Set(urls)] : [DEFAULT_MODEL_HEALTH_URL];
}
const MODEL_HEALTH_TIMEOUT_MS = 3500;
const MODEL_ONLINE_CACHE_MS = 5000;
const MODEL_RECENT_SUCCESS_MS = 60000;

let modelHealthCache = { checkedAt: 0, online: true, lastSuccessAt: 0, lastError: "" };
let modelHealthInFlight = null;

function compactText(value) {
  return firstText(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function routeTextFrom(event, ctx) {
  const candidates = [
    event?.cleanedBody,
    event?.body,
    event?.content,
    event?.text,
    event?.prompt,
    event?.message?.content,
    event?.message?.text,
    event?.input?.content,
    event?.input?.text,
  ];
  return candidates.map(firstText).find(Boolean) || "";
}

function ensureRouteTextFields(event, routeText) {
  if (!event || !routeText) return event;
  event.body = routeText;
  event.content = routeText;
  return event;
}

function asBeforeAgentReplyResult(result) {
  if (!result?.handled || result.reply) return result;

  const text = firstText(result.text);

  return {
    handled: true,
    ...(text ? { reply: { text } } : {}),
  };
}

export function normalizeKnownDiscordMentions(value) {
  return firstText(value).replace(OWNER_MENTION_RE, "咳咳咳咳咳（主人）");
}

export function knownOwnerIdentityReply(value) {
  return OWNER_IDENTITY_QUESTION_RE.test(firstText(value)) ? "咳咳咳咳咳。主人。" : null;
}

function routeLog(kind, text, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`[rana-music-tools] route=${kind}${suffix} text="${compactText(text)}"`);
}

function modelNetworkErrorCode(error) {
  return String(error?.cause?.code || error?.code || "").toUpperCase();
}

function modelEndpointDefinitelyOffline(error) {
  return ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(modelNetworkErrorCode(error));
}

export async function isModelOnline() {
  const now = Date.now();
  if (now - modelHealthCache.checkedAt < MODEL_ONLINE_CACHE_MS) return modelHealthCache.online;
  if (modelHealthInFlight) return await modelHealthInFlight;

  modelHealthInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_HEALTH_TIMEOUT_MS);
    try {
      const attempts = await Promise.all(modelHealthUrls().map(async (url) => {
        try {
          return { ok: true, res: await fetch(url, { signal: controller.signal }) };
        } catch (error) {
          return { ok: false, error };
        }
      }));
      const alive = attempts.find((attempt) => attempt.ok);
      if (alive) {
        const checkedAt = Date.now();
        modelHealthCache = {
          checkedAt,
          online: true,
          lastSuccessAt: checkedAt,
          lastError: alive.res.ok ? "" : `HTTP ${alive.res.status}`,
        };
        return true;
      }
      const errors = attempts.map((attempt) => attempt.error);
      const definitelyOffline = errors.length > 0 && errors.every(modelEndpointDefinitelyOffline);
      const recentlyOnline = Date.now() - modelHealthCache.lastSuccessAt < MODEL_RECENT_SUCCESS_MS;
      const online = definitelyOffline ? false : true;
      const first = errors[0];
      modelHealthCache = {
        ...modelHealthCache,
        checkedAt: Date.now(),
        online,
        lastError: first?.name === "AbortError" ? "health_probe_timeout" : (first?.message || String(first)),
      };
      if (!online) {
        console.warn(`[rana-runtime] no model endpoint reachable (primary and local fallbacks): ${errors.map(modelNetworkErrorCode).filter(Boolean).join(",") || modelHealthCache.lastError}`);
      } else if (!recentlyOnline && first?.name !== "AbortError") {
        console.warn(`[rana-runtime] model health probe inconclusive; keeping model selected: ${modelHealthCache.lastError}`);
      }
      return online;
    } finally {
      clearTimeout(timer);
    }
  })();

  try {
    return await modelHealthInFlight;
  } finally {
    modelHealthInFlight = null;
  }
}

export async function hotFallback(event, ctx, signal) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return null;
  const res = await postJson(`${HOT_TOOLS_URL}/decide`, {
    body: firstText(event?.body),
    content: firstText(event?.content),
    senderId: firstText(event?.senderId) || firstText(ctx?.senderId),
    roles: resolveRequesterRoles(event, ctx),
    isGroup: Boolean(event?.isGroup),
    bot_id: botContext.botId,
    persona_id: botContext.personaId,
    account_id: botContext.accountId,
    session_key: botContext.sessionKey,
    requester_id: botContext.requesterId || senderIdFromEvent(event, ctx),
    guild_id: botContext.guildId,
    channel_id: botContext.channelId,
  }, signal);
  if (!res?.handled) return null;
  const reply = firstText(res?.reply).trim();
  return botContext.botId === "rana" ? sanitizeRanaTone(reply) || null : reply || null;
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

export function isDirectMessageEvent(event, ctx) {
  if (event?.isGroup === false) return true;
  const chatTypes = [event?.chatType, event?.chat_type, event?.ChatType, event?.conversation?.kind, ctx?.chatType, ctx?.chat_type, ctx?.ChatType, ctx?.conversation?.kind]
    .map(firstText)
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  if (chatTypes.some((value) => value === "channel" || value === "group" || value === "thread")) return false;
  if (chatTypes.some((value) => value === "direct" || value === "dm")) return true;
  const providers = [event?.messageProvider, event?.provider, event?.channel, ctx?.messageProvider, ctx?.channel]
    .map(firstText)
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  // OpenClaw 2026.7.x does not expose chatType to before_agent_reply for the
  // Control UI, but it does identify that direct surface as webchat.
  if (providers.includes("webchat")) return true;
  const channelIds = [firstText(event?.chat_id), firstText(event?.chatId), firstText(event?.sessionKey), firstText(ctx?.chat_id), firstText(ctx?.chatId), firstText(ctx?.sessionKey)].filter(Boolean);
  if (channelIds.some((value) => /discord:(?:[^:]+:)?(?:channel|group):/i.test(value))) return false;
  return channelIds.some((value) => /^user:/i.test(value) || /:(?:user|dm|direct):\d{15,25}(?:$|:)/i.test(value));
}

export function isTargetedEvent(event, ctx, text) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return false;
  const directMessage = isDirectMessageEvent(event, ctx);
  if (directMessage) return true;

  const source = firstText(text);
  const explicitPersonas = mentionedPersonaIds(source);
  if (explicitPersonas.size > 0) return explicitPersonas.has(botContext.personaId);
  if (/(?:^|\s)@(here|everyone)\b/iu.test(source)) return false;
  if (eventWasMentioned(event) || eventWasMentioned(ctx)) return true;
  return false;
}

export function classifyPreDispatch(event, ctx, options = {}) {
  const routeText = routeTextFrom(event, ctx);
  ensureRouteTextFields(event, routeText);
  if (!routeText) return { kind: "pass", routeText };
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return { kind: "pass", routeText };
  if (!isTargetedEvent(event, ctx, routeText)) return { kind: "pass", routeText };
  const plan = buildUnifiedTurnPlan(routeText, {
    personaId: botContext.personaId,
    ...recentMemoryReferenceHints({ ...(ctx || {}), ...(event || {}) }),
  });
  const tool = plan.tool || { requested: false, kind: "none", arguments: {} };
  if (tool.kind === "music_control") return { kind: "voice_control", routeText, control: tool.arguments?.control, turnPlan: plan };
  if (options.modelOnline) return { kind: "model", routeText, turnPlan: plan };
  if (tool.kind === "music_play") {
    const kind = resolveBotContext(event, ctx).botId === "rana" ? "offline_play" : "explicit_play";
    return { kind, routeText, parsed: tool.arguments?.playRequest, turnPlan: plan };
  }
  if (tool.kind === "music_missing_target") return { kind: "missing_play_target", routeText, turnPlan: plan };
  if (tool.kind === "hot_fallback") return { kind: "offline_hot_tool", routeText, turnPlan: plan };
  return { kind: "model", routeText, turnPlan: plan };
}

export function registerPreDispatch(api, handlers = {}) {
  const {
    handleControlRequest,
    handleMemoryRequest,
    handlePlayRequest,
    handleStockResearchRequest,
    isModelOnlineCheck = isModelOnline,
    normalizeRouteText = (value) => value,
  } = handlers;

  api.on(
    "before_agent_reply",
    async (event, ctx) => {
      const botContext = resolveBotContext(event, ctx);
      if (!botContext) return;
      let routeText = routeTextFrom(event, ctx);
      ensureRouteTextFields(event, routeText);
      if (!routeText) return;

      if (isTargetedEvent(event, ctx, routeText)) {
        const normalizedRouteText = normalizeRouteText(
          botContext.botId === "rana" ? normalizeKnownDiscordMentions(routeText) : routeText,
        );

        if (normalizedRouteText !== routeText) {
          event.body = normalizedRouteText;
          event.content = normalizedRouteText;
          routeText = normalizedRouteText;
        }
      }

      if (!isTargetedEvent(event, ctx, routeText)) {
        if (!isDirectMessageEvent(event, ctx)) return { handled: true };
        return;
      }

      const rememberedContext = rememberDiscordContext(event, ctx);

      const ownerIdentity = botContext.botId === "rana" ? knownOwnerIdentityReply(routeText) : null;
      if (ownerIdentity) {
        return {
          handled: true,
          reply: { text: ownerIdentity },
        };
      }

      const turnPlan = buildUnifiedTurnPlan(routeText, {
        personaId: botContext.personaId,
        currentExplicitTargetId: rememberedContext?.currentExplicitTargetId || "",
        currentExplicitTargetAliases: rememberedContext?.currentExplicitTargetAliases || [],
        previousExplicitTargetId: rememberedContext?.previousExplicitTargetId || "",
        previousExplicitTargetAliases: rememberedContext?.previousExplicitTargetAliases || [],
        previousUserText: rememberedContext?.previousUserText || "",
      });
      const tool = turnPlan.tool || { requested: false, kind: "none", arguments: {} };

      if (tool.kind === "music_control") {
        return asBeforeAgentReplyResult(
          await handleControlRequest?.(tool.arguments?.control, event, ctx, routeText),
        );
      }

      if (tool.kind === "music_play") {
        const playResult = asBeforeAgentReplyResult(
          await handlePlayRequest?.(tool.arguments?.playRequest, event, ctx, routeText),
        );
        if (playResult?.handled) return playResult;
        return { handled: true, reply: { text: fixedReply(botContext.personaId, "musicNotPlayed") } };
      }

      if (tool.kind === "music_missing_target") {
        return { handled: true, reply: { text: fixedReply(botContext.personaId, "musicWhich") } };
      }

      if (tool.kind === "memory") {
        const memoryResult = await handleMemoryRequest?.(tool.arguments?.memory, event, ctx, routeText);
        // Optional: let the character's own voice report the (already executed) operation.
        // Fixed wording remains the fallback whenever the flag is off, the model is
        // unreachable, or the receipt cannot be recorded.
        if (memoryResult?.receipt && toolReceiptVoiceEnabled() && await isModelOnlineCheck()) {
          if (recordToolReceipt(event, ctx, { tool: "rana_memory", ...memoryResult.receipt })) return;
        }
        return asBeforeAgentReplyResult(memoryResult);
      }

      if (tool.kind === "stock") {
        return asBeforeAgentReplyResult(
          await handleStockResearchRequest?.(event, ctx, routeText),
        );
      }

      const modelOnline = await isModelOnlineCheck();

      if (modelOnline) {
        if (botContext.botId === "rana" && isRanaMention(routeText)) {
          routeLog("model-first", routeText);
        }
        return;
      }

      const decision = classifyPreDispatch(event, ctx, {
        modelOnline: false,
      });

      if (decision.kind === "model") {
        if (botContext.botId === "rana" && isRanaMention(routeText)) {
          routeLog("model-first", routeText);
        }
        return;
      }

      if (decision.kind === "explicit_play" || decision.kind === "offline_play") {
        const playResult = asBeforeAgentReplyResult(
          await handlePlayRequest?.(
            decision.parsed,
            event,
            ctx,
            routeText,
          ),
        );
        if (playResult?.handled) return playResult;
        return {
          handled: true,
          reply: { text: fixedReply(botContext.personaId, "musicNotPlayed") },
        };
      }

      if (decision.kind === "missing_play_target") {
        return {
          handled: true,
          reply: { text: fixedReply(botContext.personaId, "musicWhich") },
        };
      }

      if (decision.kind === "offline_hot_tool") {
        // The hot-tools fallback rules answer in Rana's voice and read Rana's
        // memory. Every other persona must fall through to OpenClaw's own
        // model fallback instead of borrowing them.
        if (botContext.personaId !== "rana") return;
        routeLog("fallback", routeText);

        try {
          const hotReply = await hotFallback(event, ctx);

          if (hotReply) {
            return {
              handled: true,
              reply: { text: hotReply },
            };
          }
        } catch (err) {
          console.warn(
            `[rana-music-tools] hot fallback unavailable: ${
              err?.message || String(err)
            }`,
          );

          return {
            handled: true,
            reply: { text: fixedReply(botContext.personaId, "offline") },
          };
        }
      }

      return;
    },
    { priority: 1000 },
  );
}

export const __test = {
  classifyPreDispatch,
  hotFallback,
  isDirectMessageEvent,
  isModelOnline,
  knownOwnerIdentityReply,
  normalizeKnownDiscordMentions,
  isTargetedEvent,
  registerPreDispatch,
  senderIdFromEvent,
};

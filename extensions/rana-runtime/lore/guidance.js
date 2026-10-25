import fs from "node:fs";
import { normalizeTurnText } from "../architecture/turn_plan.js";
import { retrieveTurnContext } from "./turn_retrieval.js";
import { clearResolvedEntities } from "./entity_resolver.js";
import { resolveBotContext } from "../bot_context.js";
import { authoritativeTurnPlanFor } from "../architecture/turn_isolation.js";
import { recentContextSnapshot } from "../context_store.js";
import { localDiscordIds } from "../local_discord_ids.js";

const LORE_GUARD_TTL_MS = 120_000;
const recentLoreGuards = new Map();
const LORE_SAFE_UNCERTAINTY_RE = /(?:不知道|不清楚|不確定|無法確認|沒辦法確認|不能確認|不記得|想不起來)/u;

export function compactLoreSystemPrompt() {
  return [
    "CONTROLLED LORE RULE:",
    "Use the controlled evidence for character/canon claims at the exact subject, relationship direction, time and requested aspect it supports.",
    "An unresolved aspect establishes neither YES nor NO. Do not fill missing character events, current state, motives, relationships or provenance from model priors.",
    "Answer naturally as the active Persona. Never mention evidence, retrieval, LORE, system context, coverage, boundaries or unresolved status in the reply.",
  ].join("\n");
}
function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) || "";
  if (value && typeof value === "object") {
    return firstText(value.text || value.content || value.body || value.prompt);
  }
  return "";
}

function isRanaRuntimePersona(event = {}, ctx = {}, plan = null) {
  const resolved = String(resolveBotContext(event, ctx)?.personaId || "").trim().toLowerCase();
  const planned = String(plan?.personaId || plan?.r3?.taskContract?.capability?.personaId || "").trim().toLowerCase();
  // In the production Discord binding, agent id "main" is Rana. This is routing
  // alias normalization only; it does not classify turn semantics.
  return resolved === "rana" || resolved === "main" || planned === "rana" || planned === "main";
}

export function extractCurrentUserText(prompt) {
  const text = firstText(prompt);
  const imageBlock = text.match(/\[Image\]\s*User text:\s*([\s\S]*?)(?:\r?\nDescription:|$)/i);
  const markers = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/gi)];
  const selected = imageBlock?.[1] || markers.at(-1)?.[1] || text;

  const cleaned = selected
    .replace(/^\s*To send an image back[^\r\n]*(?:\r?\n)?/gim, "")
    .replace(/\[media attached:\s*[^\]]+\]\s*/gi, "")
    .replace(/^\s*\[Discord[^\]]+\]\s*[^:\r\n]{1,160}:\s*/i, "")
    .replace(/^\s*User text:\s*/i, "")
    .replace(new RegExp(`<@!?${localDiscordIds().ranaBotUserId}>`, "g"), "")
    .replace(/@Rana(?:#8264)?/gi, "")
    .replace(/@樂奈/g, "")
    .trim();
  return normalizeTurnText(cleaned);
}

export function extractSenderId(prompt) {
  const text = firstText(prompt);
  return text.match(/"sender_id"\s*:\s*"(\d{15,25})"/u)?.[1]
    || text.match(/Sender \(untrusted metadata\):[\s\S]*?"id"\s*:\s*"(\d{15,25})"/u)?.[1]
    || "";
}

function isInternalPrompt(value, ctx = {}) {
  const text = firstText(value);
  const channel = String(ctx?.channel || ctx?.provider || ctx?.chatType || "").toLocaleLowerCase("en-US");
  if (channel === "heartbeat") return true;
  return /(?:generate|produce) a short\s+\d+(?:\s*-\s*\d+)?\s+word filename slug|filename slug \(lowercase, hyphen-separated/i.test(text)
    || /^(?:Read HEARTBEAT\.md|\[OpenClaw heartbeat poll\])/iu.test(text)
    || /"channel"\s*:\s*"heartbeat"|"provider"\s*:\s*"heartbeat"/iu.test(text);
}

function hasImageInput(value) {
  return /<media:image>|\[Image\]|\[media attached:[^\]]+\.(?:png|jpe?g|webp|gif)/i.test(firstText(value));
}

function loreGuardKeys(value = {}) {
  return [
    value?.runId,
    value?.requestId,
    value?.sessionKey,
    value?.sessionId,
    value?.channelId,
    value?.chatId,
    value?.textChannelId,
  ].filter(Boolean).map(String);
}

function rememberLoreGuard(ctx, record) {
  for (const key of loreGuardKeys(ctx)) recentLoreGuards.set(key, record);
}

function findLoreGuard(event, ctx, { consume = false } = {}) {
  const now = Date.now();
  for (const key of [...loreGuardKeys(event), ...loreGuardKeys(ctx)]) {
    const record = recentLoreGuards.get(key);
    if (record && now - record.created_at <= LORE_GUARD_TTL_MS) {
      if (consume) {
        for (const [storedKey, storedRecord] of recentLoreGuards.entries()) {
          if (storedRecord === record) recentLoreGuards.delete(storedKey);
        }
      }
      return record;
    }
    if (record) recentLoreGuards.delete(key);
  }
  return null;
}

function parsePublicLorePayload(prependContext) {
  const text = firstText(prependContext).trim();
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  try { return JSON.parse(text.slice(newline + 1)); } catch { return null; }
}

const ROLE_LABELS = Object.freeze({
  guitarist: "吉他手",
  vocalist: "主唱",
  bassist: "貝斯手",
  drummer: "鼓手",
  keyboardist: "鍵盤手",
});

export function renderGroundedIdentity(publicPayload) {
  if (!publicPayload || publicPayload?.query_plan?.intent !== "identity") return null;
  const facts = Array.isArray(publicPayload?.facts) ? publicPayload.facts : [];
  const resolved = Array.isArray(publicPayload?.resolved_entities) ? publicPayload.resolved_entities[0] : null;
  const label = String(resolved?.matched_alias || resolved?.canonical_name || "").trim();
  if (!label) return "不知道。";

  const group = facts.find((fact) => ["member_of", "member_of_or_associated_with"].includes(String(fact?.predicate || "")));
  const role = facts.find((fact) => String(fact?.predicate || "") === "role");
  const groupText = Array.isArray(group?.object) ? group.object[0] : group?.object;
  const roleRaw = Array.isArray(role?.object) ? role.object[0] : role?.object;
  const roleText = ROLE_LABELS[String(roleRaw || "").toLowerCase()] || String(roleRaw || "").trim();

  if (groupText && roleText) return `${label}。${String(groupText).trim()} 的${roleText}。`;
  if (groupText) return `${label}。${String(groupText).trim()} 的成員。`;
  if (roleText) return `${label}。${roleText}。`;
  return "不知道。";
}

export function formatLoreOutgoing(content, guard) {
  const raw = firstText(content).trim();
  const groundedIdentity = renderGroundedIdentity(guard?.public_payload);
  return groundedIdentity ?? raw;
}

function recordOutputGuard(guard, rawOutput, finalOutput) {
  if (!guard?.trace_path || !fs.existsSync(guard.trace_path)) return;
  try {
    const trace = JSON.parse(fs.readFileSync(guard.trace_path, "utf8"));
    trace.output_guard = {
      captured_at: new Date().toISOString(),
      raw_output: rawOutput,
      final_output: finalOutput,
      guard_modified: rawOutput !== finalOutput,
    };
    fs.writeFileSync(guard.trace_path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  } catch {
    // Acceptance tracing must never block an outbound reply.
  }
}

function recordLlmInput(guard, event) {
  if (!guard?.trace_path || !fs.existsSync(guard.trace_path)) return;
  try {
    const trace = JSON.parse(fs.readFileSync(guard.trace_path, "utf8"));
    trace.llm_input = {
      captured_at: new Date().toISOString(),
      run_id: event?.runId || "",
      provider: event?.provider || "",
      model: event?.model || "",
      system_prompt: event?.systemPrompt || "",
      prompt: event?.prompt || "",
      history_messages: event?.historyMessages || [],
      images_count: event?.imagesCount || 0,
      tools: event?.tools || [],
    };
    fs.writeFileSync(guard.trace_path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  } catch {
    // Acceptance tracing must never block a model request.
  }
}

export function resolutionKey(prompt, ctx = {}) {
  const session = String(ctx?.sessionKey || ctx?.sessionId || "").trim();
  const sender = extractSenderId(prompt);
  if (!session) return sender ? `user:${sender}` : "";
  return sender ? `${session}|user:${sender}` : session;
}

export function registerLoreGuidance(api) {
  api.on("before_reset", (_event, ctx) => {
    clearResolvedEntities(ctx?.sessionKey || ctx?.sessionId);
  });

  api.on("session_end", (event, ctx) => {
    if (!["reset", "deleted", "daily", "idle"].includes(event?.reason)) return;
    clearResolvedEntities(ctx?.sessionKey || ctx?.sessionId);
  });

  api.on("before_prompt_build", async (event, ctx) => {
    if (ctx?.__ranaUnifiedRetrieval?.handled) return;
    if (isInternalPrompt(event?.prompt, { ...ctx, channel: event?.channel || ctx?.channel, provider: event?.provider || ctx?.provider }) || hasImageInput(event?.prompt)) return;

    const query = extractCurrentUserText(event?.prompt);
    const authoritativePlan = authoritativeTurnPlanFor(event, ctx, { create: true });
    if (!isRanaRuntimePersona(event, ctx, authoritativePlan)) return;
    const unified = await retrieveTurnContext({
      personaId: "rana",
      query,
      priorText: ctx?.previousUserText || ctx?.recentText || "",
      sessionKey: resolutionKey(event?.prompt, ctx),
      userId: ctx?.senderId || ctx?.requesterId || extractSenderId(event?.prompt) || "",
    });
    if (unified.text || unified.entries.length) {
      ctx.__ranaUnifiedRetrieval = { handled: true, result: unified };
      return {
        appendSystemContext: unified.text,
        __contextTrace: {
          retrieved: unified.entries.map((item) => ({ id: item.id, score: item.score })),
          retrieval: unified.trace,
        },
      };
    }
    return;
  }, { priority: 900, timeoutMs: 15_000 });

  api.on("before_tool_call", (event, ctx) => {
    if (!isRanaRuntimePersona(event, ctx)) return;
    const toolName = String(event?.toolName || "");
    // Memory and explicit web lookup have their own authorization owners.
    // web_search is still fail-closed by rana-web-search-guard when lookup intent is not explicit.
    if (toolName === "rana_memory" || toolName === "web_search") return;
    const guard = findLoreGuard(event, ctx);
    if (!guard) return;
    return {
      block: true,
      blockReason: "This turn already has a controlled LORE Evidence Pack; answer from those facts and boundaries.",
    };
  }, { priority: 1000 });

  api.on("llm_input", (event, ctx) => {
    if (!isRanaRuntimePersona(event, ctx)) return;
    const guard = findLoreGuard(event, ctx);
    if (!guard) return;
    recordLlmInput(guard, event);
  }, { priority: -1000 });

  api.on("message_sending", (event, ctx) => {
    if (!isRanaRuntimePersona(event, ctx)) return;
    const guard = findLoreGuard(event, ctx, { consume: true });
    if (!guard) return;
    const rawOutput = firstText(event?.content).trim();
    if (!rawOutput) return;
    const coverageSupported = guard?.relation_answers === true
      || (guard?.pack?.evidence_coverage?.supported !== false && guard?.pack?.knowledge_contract !== "unknown");
    const wouldViolateCoverage = !coverageSupported && !LORE_SAFE_UNCERTAINTY_RE.test(rawOutput);
    recordOutputGuard(guard, rawOutput, rawOutput);
    if (wouldViolateCoverage) {
      try {
        const trace = JSON.parse(fs.readFileSync(guard.trace_path, "utf8"));
        trace.output_guard = {
          ...(trace.output_guard || {}),
          action: "observe_only_no_output_intervention",
          would_violate_coverage: true,
        };
        fs.writeFileSync(guard.trace_path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
      } catch {}
    }
    // Anti-cheat invariant: LORE evidence may inform the prompt, never rewrite output.
  }, { priority: -1000 });


  api.registerTool({
    name: "rana_lore_search",
    label: "Rana Controlled LORE",
    description: "Read-only retrieval from manifest-approved Rana character knowledge. Use for explicit character, relationship, event, or source questions; not for ordinary name mentions or live-state guesses.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async (_toolCallId, params, signal) => {
      const activeContext = resolveBotContext(params, recentContextSnapshot(params));
      if (!activeContext || !["rana", "main"].includes(String(activeContext.personaId || "").toLowerCase())) {
        return {
          content: [{
            type: "text",
            text: "This Rana-only LORE tool is unavailable for the active persona. Use persona_lore_search.",
          }],
        };
      }
      const unified = await retrieveTurnContext({
        personaId: "rana",
        query: params?.query,
        priorText: "",
        sessionKey: activeContext?.sessionKey || "",
        userId: activeContext?.senderId || activeContext?.requesterId || "",
      });
      const context = unified.text || "Nothing relevant is in the controlled character memory for this question. Do not guess.";
      return {
        content: [{
          type: "text",
          text: context,
        }],
      };
    },
  });
}

export const __test = {
  extractCurrentUserText,
  extractSenderId,
  hasImageInput,
  isInternalPrompt,
  formatLoreOutgoing,
  renderGroundedIdentity,
  parsePublicLorePayload,
  resolutionKey,
  findLoreGuard,
  rememberLoreGuard,
};

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLoreEvidencePack, loreEvidenceContext, loreEvidencePayload, safeEvidencePack, shouldRetrieveLore } from "./retrieval.js";
import { loreEvidencePlanForTurn, turnPlanNeedsLore, normalizeTurnText } from "../architecture/turn_plan.js";
import { clearResolvedEntities } from "./entity_resolver.js";
import { resolveBotContext } from "../bot_context.js";
import { authoritativeTurnPlanFor } from "../architecture/turn_isolation.js";
import { recentContextSnapshot } from "../context_store.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
const ACCEPTANCE_POINTER = path.join(ROOT, "runtime-debug", "lore-formal-acceptance", ".active-rag-discord-final.txt");
const LORE_GUARD_TTL_MS = 120_000;
const recentLoreGuards = new Map();
const LORE_SAFE_UNCERTAINTY_RE = /(?:不知道|不清楚|不確定|無法確認|沒辦法確認|不能確認|不記得|想不起來)/u;

export function compactLoreSystemPrompt() {
  return [
    "CONTROLLED LORE RULE:",
    "Use the controlled evidence for character/canon claims at the exact subject, relationship direction, time and requested aspect it supports.",
    "An unresolved aspect establishes neither YES nor NO. Do not fill missing character events, current state, motives, relationships or provenance from model priors.",
    "Answer naturally as the active Persona. Do not mention internal retrieval mechanics or evidence field names unless the user explicitly asks about the system itself.",
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

function ranaCanonicalGenerationBoundary(pack, turnPlan) {
  const supported = pack?.evidence_coverage?.supported !== false && pack?.knowledge_contract !== "unknown";
  const responseFunction = String(turnPlan?.responseContract?.responseFunction || "");
  if (!supported) {
    return [
      "RANA_CANONICAL_GENERATION_BOUNDARY=UNRESOLVED_ONLY",
      "RANA_CANONICAL_UNRESOLVED_SENTENCE_COUNT=1",
      "RANA_CANONICAL_UNRESOLVED_SPECULATION=DENY",
      "RANA_CANONICAL_UNRESOLVED_CAUSAL_CONTINUATION=DENY",
      "RANA_CANONICAL_UNRESOLVED_TENTATIVE_SELF_ASSERTION=DENY",
      "RANA_CANONICAL_UNRESOLVED_MEMORY_ABSENCE_AS_FACT=DENY",
      "For the unsupported canonical point, give one short unresolved statement and stop. Do not continue with a cause, probability, tentative capability claim, or plausible first-person process. Do not use personal non-recall (for example, 'I have not heard/seen that') as proof that the canonical fact does not exist.",
    ].join("\n");
  }
  if (responseFunction === "ANSWER_CANONICAL_PERSONA_STANCE") {
    return [
      "RANA_CANONICAL_GENERATION_BOUNDARY=SUPPORTED_PERSONA_STANCE",
      "RANA_CANONICAL_STANCE_DOSSIER_PARAPHRASE=DENY",
      "RANA_CANONICAL_STANCE_NEUTRALIZATION=DENY",
      "Express only the directly supported stance/reaction in first-person character voice, plus at most one concrete supported fact. Do not turn the Evidence Pack into a wiki summary or invent hidden psychology/history.",
    ].join("\n");
  }
  return "";
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
    .replace(/<@!?1202969643162013776>/g, "")
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

function primitiveContext(ctx = {}) {
  return Object.fromEntries(Object.entries(ctx).filter(([, value]) =>
    value == null || ["string", "number", "boolean"].includes(typeof value)));
}

function writeAcceptanceTrace({ query, pack, prependContext, prompt, ctx }) {
  if (!fs.existsSync(ACCEPTANCE_POINTER)) return null;
  const acceptanceRoot = fs.readFileSync(ACCEPTANCE_POINTER, "utf8").replace(/^\uFEFF/u, "").trim();
  if (!acceptanceRoot.endsWith("-rag-discord-final") || !fs.existsSync(acceptanceRoot)) return null;
  const traceDir = path.join(acceptanceRoot, "live-trace");
  fs.mkdirSync(traceDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const traceId = `${capturedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const record = {
    trace_id: traceId,
    captured_at: capturedAt,
    hook: "before_prompt_build",
    query,
    request_id: ctx?.runId || ctx?.requestId || "",
    session_key: ctx?.sessionKey || "",
    session_id: ctx?.sessionId || "",
    context: primitiveContext(ctx),
    prompt_sha256: crypto.createHash("sha256").update(firstText(prompt), "utf8").digest("hex"),
    query_plan: pack.query_plan || null,
    retrieval: safeEvidencePack(pack),
    prepend_context: prependContext,
  };
  const tracePath = path.join(traceDir, `${traceId}.json`);
  fs.writeFileSync(tracePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { trace_id: traceId, trace_path: tracePath };
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
    if (isInternalPrompt(event?.prompt, { ...ctx, channel: event?.channel || ctx?.channel, provider: event?.provider || ctx?.provider }) || hasImageInput(event?.prompt)) return;

    const query = extractCurrentUserText(event?.prompt);
    const authoritativePlan = authoritativeTurnPlanFor(event, ctx, { create: true });
    if (!isRanaRuntimePersona(event, ctx, authoritativePlan)) return;
    const turnPlan = loreEvidencePlanForTurn(authoritativePlan);
    if (!turnPlanNeedsLore(turnPlan)) return;
    // Durable Memory may contain an overlapping lexical cue, but it cannot
    // preempt a TurnPlan whose semantic authority is Persona canonical LORE.
    // Memory remains authoritative for explicit memory-owned turns upstream.

    try {
      const pack = await buildLoreEvidencePack(query, {
        sessionKey: resolutionKey(event?.prompt, ctx),
        signal: ctx?.abortSignal,
        turnPlan,
      });
      const evidenceProjection = [
        loreEvidenceContext(pack),
        ranaCanonicalGenerationBoundary(pack, authoritativePlan),
      ].filter(Boolean).join("\n\n");
      const trace = writeAcceptanceTrace({ query, pack, prependContext: evidenceProjection, prompt: event?.prompt, ctx });
      rememberLoreGuard(ctx, {
        created_at: Date.now(),
        query,
        pack,
        public_payload: loreEvidencePayload(pack),
        ...(trace || {}),
      });
      return {
        prependSystemContext: compactLoreSystemPrompt(),
        appendSystemContext: evidenceProjection,
      };
    } catch (error) {
      api.logger.warn?.(`[rana-lore] retrieval unavailable: ${error?.message || String(error)}`);
      return {
        appendSystemContext: "CONTROLLED LORE STATUS: retrieval unavailable for this turn. Treat unestablished character/canon details as unresolved rather than filling them from model priors.",
      };
    }
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
    const coverageSupported = guard?.pack?.evidence_coverage?.supported !== false && guard?.pack?.knowledge_contract !== "unknown";
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
      const pack = await buildLoreEvidencePack(params?.query, { signal });
      const context = loreEvidenceContext(pack);
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

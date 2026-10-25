/**
 * Rana Runtime 3.0 Phase 3 — provider-bound semantic history projection.
 *
 * This is the single supported owner for which persisted session messages are
 * sent to the model. It does not generate text and it does not create another
 * inference path. The persisted OpenClaw transcript remains unchanged.
 */
import { buildUnifiedTurnPlan, normalizeTurnText } from "./turn_plan.js";
import { projectProviderMessages } from "./turn_isolation.js";
import { writeGenerationTrace } from "./generation_trace.js";

export const RANA_CONTEXT_ENGINE_ID = "rana-turn-context";
export const RANA_CONTEXT_ENGINE_VERSION = "3.0.0-phase3";

const RANA_DISCORD_SESSION_RE = /^agent:(?:main|tomori|anon|soyo|taki):discord:/u;

function countRole(messages, role) {
  return Array.isArray(messages)
    ? messages.filter((message) => String(message?.role || "").toLowerCase() === role).length
    : 0;
}

function textChars(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textChars(item, depth + 1), 0);
  if (typeof value === "object") {
    return Object.entries(value).reduce((sum, [key, item]) => {
      if (/^(?:embedding|vector|base64|image_data|audio_data)$/iu.test(key)) return sum;
      return sum + textChars(item, depth + 1);
    }, 0);
  }
  return 0;
}

function estimateTokens(messages) {
  // Conservative enough for CJK-heavy Persona transcripts without pretending
  // to be the provider tokenizer. OpenClaw/model overflow handling remains the
  // actual authority.
  const chars = textChars(messages);
  return Math.max(0, Math.ceil(chars / 2));
}

export function isRanaDiscordSessionKey(value) {
  return RANA_DISCORD_SESSION_RE.test(String(value || "").trim());
}

export function assembleRanaTurnContext(params = {}) {
  const sessionKey = String(params?.sessionKey || "").trim();
  const input = Array.isArray(params?.messages) ? params.messages.slice() : [];
  const currentPrompt = normalizeTurnText(params?.prompt || "");
  const targeted = isRanaDiscordSessionKey(sessionKey);
  const plan = currentPrompt ? buildUnifiedTurnPlan(currentPrompt) : null;

  // The context-engine slot is global. Every non-Rana/non-Discord session must
  // remain a true pass-through so this plugin cannot change unrelated agents.
  const projected = targeted
    ? projectProviderMessages(input, currentPrompt)
    : input;

  const inputDialogueRows = countRole(input, "user") + countRole(input, "assistant");
  const outputDialogueRows = countRole(projected, "user") + countRole(projected, "assistant");

  writeGenerationTrace({
    phase: "context_engine_assemble",
    sessionKey,
    contextEngineId: RANA_CONTEXT_ENGINE_ID,
    contextEngineVersion: RANA_CONTEXT_ENGINE_VERSION,
    targeted,
    currentUser: currentPrompt || null,
    historyPlan: plan?.history || null,
    historyPolicy: plan?.historyPolicy || null,
    inputMessageCount: input.length,
    outputMessageCount: projected.length,
    inputDialogueRows,
    outputDialogueRows,
    removedMessageCount: Math.max(0, input.length - projected.length),
  });

  return {
    messages: projected,
    estimatedTokens: estimateTokens(projected),
  };
}

export function createRanaTurnContextEngine() {
  return {
    info: {
      id: RANA_CONTEXT_ENGINE_ID,
      name: "Rana Turn Context",
      version: RANA_CONTEXT_ENGINE_VERSION,
      ownsCompaction: false,
    },

    async ingest() {
      // OpenClaw remains the durable transcript owner. This engine is only a
      // provider-bound projection and intentionally maintains no second store.
      return { ingested: true };
    },

    async ingestBatch() {
      return { ingested: true };
    },

    async assemble(params) {
      return assembleRanaTurnContext(params);
    },

    async compact(params) {
      // A non-owning context engine must delegate compaction rather than use a
      // no-op compact(), otherwise /compact and overflow recovery are broken.
      const { delegateCompactionToRuntime } = await import("openclaw/plugin-sdk/core");
      return await delegateCompactionToRuntime(params);
    },
  };
}

export function registerRanaTurnContextEngine(api) {
  if (typeof api?.registerContextEngine !== "function") {
    throw new Error("OpenClaw registerContextEngine API is unavailable; refusing Rana history projection.");
  }
  api.registerContextEngine(RANA_CONTEXT_ENGINE_ID, () => createRanaTurnContextEngine());
}

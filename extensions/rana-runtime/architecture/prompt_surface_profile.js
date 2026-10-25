/**
 * Rana Runtime 2.1.0 — Persona-first prompt surface selection.
 *
 * This module does not generate replies and does not own Persona wording.
 * It selects the host-owned `persona` prompt profile for Rana/MyGO user turns
 * and removes bootstrap files that do not need to be injected every turn.
 */
import { buildUnifiedTurnPlan, normalizeTurnText } from "./turn_plan.js";
import { writeGenerationTrace } from "./generation_trace.js";

const PERSONA_AGENT_IDS = new Set(["main", "rana", "tomori", "anon", "soyo", "taki"]);
const PERSONA_SESSION_RE = /^agent:(main|rana|tomori|anon|soyo|taki):discord:/u;
const KEEP_BOOTSTRAP_FILES = new Set([
  // Persona profile keeps only direct speaker/user conditioning. AGENTS.md
  // currently duplicates migrated tool notes and generic workflow prose;
  // BOOTSTRAP.md is first-run machinery, not per-turn Persona evidence.
  "SOUL.MD",
  "IDENTITY.MD",
  "USER.MD",
]);

function agentIdFrom(event = {}, ctx = {}) {
  const explicit = String(ctx?.agentId || ctx?.agent_id || event?.agentId || event?.agent_id || "").trim();
  if (explicit) return explicit;
  const sessionKey = String(ctx?.sessionKey || ctx?.session_key || event?.sessionKey || event?.session_key || "").trim();
  return sessionKey.match(/^agent:([^:]+):/u)?.[1] || "";
}

function isPersonaTarget(event = {}, ctx = {}) {
  const agentId = agentIdFrom(event, ctx);
  if (PERSONA_AGENT_IDS.has(agentId)) return true;
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || "").trim();
  return PERSONA_SESSION_RE.test(sessionKey);
}

function isUserFacingTrigger(ctx = {}) {
  const trigger = String(ctx?.trigger || "").trim().toLowerCase();
  return !trigger || trigger === "user" || trigger === "manual";
}

export function filterPersonaBootstrapFiles(files = []) {
  if (!Array.isArray(files)) return files;
  return files.filter((file) => KEEP_BOOTSTRAP_FILES.has(String(file?.name || "").trim().toUpperCase()));
}

export function registerPersonaPromptSurface(api) {
  if (typeof api?.registerHook !== "function") {
    throw new Error("OpenClaw agent:bootstrap hook API unavailable; refusing Persona-first bootstrap filtering.");
  }

  api.registerHook(
    "agent:bootstrap",
    (event) => {
      const context = event?.context && typeof event.context === "object" ? event.context : null;
      if (!context || !isPersonaTarget(context, context)) return;
      const before = Array.isArray(context.bootstrapFiles) ? context.bootstrapFiles : [];
      const after = filterPersonaBootstrapFiles(before);
      context.bootstrapFiles = after;
      writeGenerationTrace({
        phase: "prompt_surface_bootstrap",
        personaId: agentIdFrom(context, context) || null,
        sessionKey: String(context.sessionKey || "") || null,
        promptProfile: "persona",
        kept: after.map((file) => String(file?.name || "")),
        removed: before
          .filter((file) => !after.includes(file))
          .map((file) => String(file?.name || "")),
      });
    },
    { name: "rana-persona-bootstrap-minimizer" },
  );

  api.on(
    "before_prompt_build",
    (event, ctx) => {
      if (!isPersonaTarget(event, ctx) || !isUserFacingTrigger(ctx)) return;
      const current = normalizeTurnText(event?.prompt || "");
      const plan = current ? buildUnifiedTurnPlan(current) : null;
      writeGenerationTrace({
        phase: "prompt_surface_profile",
        runId: String(ctx?.runId || event?.runId || "") || null,
        personaId: agentIdFrom(event, ctx) || null,
        sessionKey: String(ctx?.sessionKey || event?.sessionKey || "") || null,
        promptProfile: "persona",
        lane: plan?.lane || null,
        action: plan?.action?.kind || null,
        evidence: plan?.evidence?.kind || null,
      });
      return { promptProfile: "persona" };
    },
    { priority: 8_000, timeoutMs: 2_000 },
  );
}

export const __test = {
  PERSONA_AGENT_IDS,
  KEEP_BOOTSTRAP_FILES,
  filterPersonaBootstrapFiles,
  isPersonaTarget,
  isUserFacingTrigger,
};

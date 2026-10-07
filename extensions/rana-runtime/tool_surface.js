import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import {
  resolveCurrentTurnMediaProvenance,
  resolveCurrentTurnToolSurface,
} from "./current_turn_tool_contract.js";

/*
 * Durable memory has deterministic owners before model generation:
 * - exact high-specificity MEMORY.md cue grounding in model_tool_guidance
 * - explicit remember / recall / delete operations in pre_dispatch
 *
 * rana_memory therefore must not be exposed for the model to self-authorize.
 */
const PRE_DISPATCH_ONLY_MODEL_HIDDEN_TOOLS = new Set(["rana_memory"]);
const EXPLICIT_ONLY_MODEL_TOOLS = new Set(["web_search"]);

function agentIdForToolSurface(event = {}, ctx = {}) {
  const explicit = String(ctx?.agentId || ctx?.agent_id || event?.agentId || event?.agent_id || "").trim();
  if (explicit) return explicit;
  const sessionKey = String(ctx?.sessionKey || ctx?.session_key || event?.sessionKey || event?.session_key || "").trim();
  return sessionKey.match(/^agent:([^:]+):/u)?.[1] || "";
}

/**
 * Narrows only the controlled Rana schemas for this prompt-build turn. The
 * host supplies the already-assembled per-run names; unrelated names pass
 * through unchanged. Vision exposure reads only trusted per-run evidence
 * carried by the hook event/context, not the Vision execution registry.
 */
export function registerTurnToolSurface(api) {
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      if (!Array.isArray(event?.tools)) return;
      const plan = buildUnifiedTurnPlan(event?.prompt);
      const surface = resolveCurrentTurnToolSurface({
        plan,
        mediaProvenance: resolveCurrentTurnMediaProvenance(event, ctx),
        toolNames: event.tools.map((tool) => tool?.name),
        agentId: agentIdForToolSurface(event, ctx),
      });
      const authorizedWeb = plan?.tool?.kind === "web" && plan?.tool?.toolName === "web_search";
      const modelVisibleToolNames = surface.allowedToolNames.filter((name) => {
        if (PRE_DISPATCH_ONLY_MODEL_HIDDEN_TOOLS.has(name)) return false;
        if (EXPLICIT_ONLY_MODEL_TOOLS.has(name) && !authorizedWeb) return false;
        return true;
      });
      return { toolsAllow: modelVisibleToolNames };
    },
    { priority: 7000, timeoutMs: 5000 },
  );
}

export const __test = {
  resolveCurrentTurnMediaProvenance,
  resolveCurrentTurnToolSurface,
};

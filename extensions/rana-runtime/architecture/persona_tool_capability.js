import { resolveTrustedInvocationContext } from "./turn_isolation.js";
import { getPersonaProfile, isKnownPersonaId } from "../persona_registry.js";
import { recentContextSnapshot } from "../context_store.js";
import { buildUnifiedTurnPlan, normalizeTurnText } from "./turn_plan.js";

const PERSONA_TOOL_CONTEXT_SYMBOL = Symbol.for("rana-runtime.persona-tool-context.v6.4.7");
const PERSONA_TOOL_CONTEXT_TTL_MS = 2 * 60_000;
const PERSONA_TRUSTED_TOOLS = new Set(["persona_lore_search"]);

const state = globalThis[PERSONA_TOOL_CONTEXT_SYMBOL] && typeof globalThis[PERSONA_TOOL_CONTEXT_SYMBOL] === "object"
  ? globalThis[PERSONA_TOOL_CONTEXT_SYMBOL]
  : { byToolCallId: new Map() };
if (!(state.byToolCallId instanceof Map)) state.byToolCallId = new Map();
globalThis[PERSONA_TOOL_CONTEXT_SYMBOL] = state;

function text(value) {
  return String(value ?? "").trim();
}

function toolNameOf(event = {}) {
  return text(event.toolName || event.tool_name || event.name);
}

function toolCallIdOf(event = {}) {
  return text(event.toolCallId || event.tool_call_id || event.callId || event.call_id);
}

function runIdOf(event = {}, ctx = {}) {
  return text(event.runId || event.run_id || ctx.runId || ctx.run_id);
}

function uniqueTrustedValue(values) {
  const present = [...new Set(values.map(text).filter(Boolean))];
  if (present.length > 1) return { ok: false, error: "ambiguous trusted runtime identity" };
  return { ok: true, value: present[0] || "" };
}

function agentIdFromSessionKey(value) {
  const match = text(value).match(/^agent:([^:]+):/u);
  return match?.[1] || "";
}

function deriveTrustedPersonaAccount(event = {}, ctx = {}) {
  const session = uniqueTrustedValue([
    ctx?.sessionKey, ctx?.session_key,
    event?.sessionKey, event?.session_key,
  ]);
  if (!session.ok) return session;

  const explicitAgent = uniqueTrustedValue([
    ctx?.agentId, ctx?.agent_id,
    event?.agentId, event?.agent_id,
  ]);
  if (!explicitAgent.ok) return explicitAgent;

  const sessionAgent = agentIdFromSessionKey(session.value);
  if (explicitAgent.value && sessionAgent && explicitAgent.value !== sessionAgent) {
    return { ok: false, error: "trusted agentId conflicts with trusted sessionKey" };
  }
  const agentId = explicitAgent.value || sessionAgent;
  if (!isKnownPersonaId(agentId)) {
    return { ok: false, error: "trusted non-Rana Persona agentId unavailable" };
  }

  const expectedAccountId = text(getPersonaProfile(agentId)?.accountId);
  if (!expectedAccountId) {
    return { ok: false, error: "trusted Persona account mapping unavailable" };
  }

  const eventDelivery = event?.deliveryContext && typeof event.deliveryContext === "object" ? event.deliveryContext : {};
  const ctxDelivery = ctx?.deliveryContext && typeof ctx.deliveryContext === "object" ? ctx.deliveryContext : {};
  const explicitAccount = uniqueTrustedValue([
    ctx?.accountId, ctx?.account_id, ctx?.agentAccountId, ctx?.agent_account_id,
    event?.accountId, event?.account_id, event?.agentAccountId, event?.agent_account_id,
    ctxDelivery?.accountId, ctxDelivery?.account_id,
    eventDelivery?.accountId, eventDelivery?.account_id,
  ]);
  if (!explicitAccount.ok) return explicitAccount;
  if (explicitAccount.value && explicitAccount.value !== expectedAccountId) {
    return { ok: false, error: "trusted accountId conflicts with trusted Persona agentId" };
  }

  return { ok: true, agentId, sessionKey: session.value, accountId: explicitAccount.value || expectedAccountId };
}

function currentTurnTextForTool(event = {}, ctx = {}, identity = null) {
  const direct = normalizeTurnText(
    ctx?.currentTurnText || ctx?.current_turn_text ||
    event?.currentTurnText || event?.current_turn_text ||
    event?.prompt || event?.body || event?.content || ""
  );
  if (direct) return direct;

  const derived = identity?.ok ? identity : deriveTrustedPersonaAccount(event, ctx);
  if (!derived?.ok) return "";
  const snap = recentContextSnapshot({
    agent_id: derived.agentId,
    session_key: derived.sessionKey,
    account_id: derived.accountId,
  });
  return snap?.fresh ? normalizeTurnText(snap.source_text || "") : "";
}

export function authorizePersonaEvidenceTool(event = {}, ctx = {}) {
  const toolName = toolNameOf(event);
  if (!PERSONA_TRUSTED_TOOLS.has(toolName)) return { ok: true, ignored: true };

  const identity = deriveTrustedPersonaAccount(event, ctx);
  if (!identity.ok) return identity;
  const current = currentTurnTextForTool(event, ctx, identity);
  if (!current) return { ok: false, error: "trusted current-turn text unavailable" };

  const plan = buildUnifiedTurnPlan(current);
  if (!plan?.evidence?.required || plan?.evidence?.source !== "persona_canonical") {
    return { ok: false, error: "Persona evidence tool is not authorized for this turn" };
  }

  const expected = "persona_lore_search";
  if (toolName !== expected) {
    return { ok: false, error: `Persona evidence tool mismatch: expected ${expected}` };
  }
  return { ok: true, current, plan, identity, expectedTool: expected };
}

export function prunePersonaToolCapabilities(now = Date.now()) {
  for (const [toolCallId, record] of state.byToolCallId.entries()) {
    if (!record || now - Number(record.createdAt || 0) > PERSONA_TOOL_CONTEXT_TTL_MS) {
      state.byToolCallId.delete(toolCallId);
    }
  }
}

export function bindTrustedPersonaToolContext(event = {}, ctx = {}, now = Date.now()) {
  const toolName = toolNameOf(event);
  if (!PERSONA_TRUSTED_TOOLS.has(toolName)) return { ok: false, ignored: true, error: "tool is not capability-bound" };

  const toolCallId = toolCallIdOf(event);
  if (!toolCallId) return { ok: false, error: "missing trusted toolCallId" };

  prunePersonaToolCapabilities(now);
  if (state.byToolCallId.has(toolCallId)) {
    return { ok: false, error: "duplicate trusted toolCallId" };
  }

  // before_tool_call event/ctx are runtime-owned. Keep the two sources in
  // separate aliases so resolveTrustedInvocationContext can detect conflicts
  // instead of silently letting one overwrite the other. Model params are
  // deliberately ignored and cannot grant Persona/session identity.
  const derivedIdentity = deriveTrustedPersonaAccount(event, ctx);
  if (!derivedIdentity.ok) return derivedIdentity;

  const eventDelivery = event?.deliveryContext && typeof event.deliveryContext === "object" ? event.deliveryContext : {};
  const ctxDelivery = ctx?.deliveryContext && typeof ctx.deliveryContext === "object" ? ctx.deliveryContext : {};
  const trusted = resolveTrustedInvocationContext({
    agentId: derivedIdentity.agentId,
    sessionKey: derivedIdentity.sessionKey,
    requesterSenderId: text(ctx?.requesterSenderId || ctx?.requester_sender_id || ctx?.requesterId || ctx?.requester_id),
    requester_sender_id: text(event?.requesterSenderId || event?.requester_sender_id || event?.requesterId || event?.requester_id),
    accountId: derivedIdentity.accountId,
    guildId: text(ctx?.guildId || ctx?.guild_id),
    guild_id: text(event?.guildId || event?.guild_id),
    channelId: text(ctx?.channelId || ctx?.channel_id || ctx?.currentChannelId || ctx?.current_channel_id),
    channel_id: text(event?.channelId || event?.channel_id || event?.currentChannelId || event?.current_channel_id),
    deliveryContext: { ...eventDelivery, ...ctxDelivery },
  });
  if (!trusted.ok) return trusted;
  const expectedAccountId = text(getPersonaProfile(trusted.agentId)?.accountId);
  if (!expectedAccountId || trusted.accountId !== expectedAccountId) {
    return { ok: false, error: "resolved trusted accountId does not match Persona registry" };
  }

  state.byToolCallId.set(toolCallId, {
    toolName,
    runId: runIdOf(event, ctx),
    createdAt: now,
    trusted: { ...trusted },
  });

  return { ok: true, toolCallId, toolName, runId: runIdOf(event, ctx) };
}

export function consumeTrustedPersonaToolContext(toolCallIdValue, expectedToolName, now = Date.now()) {
  const toolCallId = text(toolCallIdValue);
  const toolName = text(expectedToolName);
  if (!toolCallId) return { ok: false, error: "missing trusted toolCallId" };
  if (!PERSONA_TRUSTED_TOOLS.has(toolName)) return { ok: false, error: "unexpected capability tool" };

  prunePersonaToolCapabilities(now);
  const record = state.byToolCallId.get(toolCallId);
  // Delete before validation: a mismatch is still a consumed one-shot token.
  if (record) state.byToolCallId.delete(toolCallId);
  if (!record) return { ok: false, error: "missing or already-consumed trusted toolCallId" };
  if (record.toolName !== toolName) return { ok: false, error: "trusted toolCallId bound to a different tool" };
  if (now - Number(record.createdAt || 0) > PERSONA_TOOL_CONTEXT_TTL_MS) {
    return { ok: false, error: "expired trusted toolCallId" };
  }
  if (!record.trusted?.ok) return { ok: false, error: "trusted invocation context unavailable" };
  return { ...record.trusted, runId: record.runId, toolCallId, toolName };
}

export function registerPersonaToolCapabilityBinder(api) {
  api.on("before_tool_call", (event, ctx) => {
    const toolName = toolNameOf(event);
    if (!PERSONA_TRUSTED_TOOLS.has(toolName)) return;

    const authorization = authorizePersonaEvidenceTool(event, ctx);
    if (!authorization.ok) {
      return {
        block: true,
        blockReason: authorization.error || "Persona evidence tool is not authorized for this turn",
      };
    }

    const bound = bindTrustedPersonaToolContext(event, ctx);
    if (!bound.ok) {
      console.warn(`[rana-runtime] persona tool context bind failed tool=${toolName} call=${toolCallIdOf(event) || "?"}: ${bound.error || "unknown"}`);
      return {
        block: true,
        blockReason: bound.error || "trusted Persona tool context unavailable",
      };
    }
  }, { priority: 1_900, timeoutMs: 1_000 });
}

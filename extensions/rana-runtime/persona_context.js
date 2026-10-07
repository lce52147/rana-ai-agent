import fs from "node:fs";
import path from "node:path";
import {
  getPersonaProfile,
  isKnownPersonaId,
  PERSONA_IDS,
  stableMygoProfiles,
  stablePersonaProfile,
} from "./persona_registry.js";
import { resolveBotContext } from "./bot_context.js";
import { recentContextSnapshot } from "./context_store.js";
import { authoritativeTurnPlanFor, trustedContextHint, trustedToolError } from "./architecture/turn_isolation.js";
import { buildUnifiedTurnPlan, normalizeTurnText } from "./architecture/turn_plan.js";
import { evaluateEvidenceCoverage, evidenceText as normalizedEvidenceText } from "./architecture/evidence_coverage.js";
import { evaluatePremiseProvenance, premisePlanNeedsProtection } from "./architecture/premise_provenance.js";
import { registerPersonaToolCapabilityBinder, consumeTrustedPersonaToolContext } from "./architecture/persona_tool_capability.js";
import { writeGenerationTrace } from "./architecture/generation_trace.js";

const packageCache = new Map();

const CANONICAL_AUTHORITY_TTL_MS = 10 * 60_000;
const canonicalAuthorityTurns = new Map();
const canonicalAuthorityLatestBySession = new Map();
const CANONICAL_SAFE_UNCERTAINTY_RE = /(?:不知道|不清楚|不確定|無法確認|沒辦法確認|不能確認|不記得|想不起來)/u;

function canonicalSessionKey(event = {}, ctx = {}) {
  return String(event?.sessionKey || ctx?.sessionKey || "").trim();
}

function canonicalRunId(event = {}, ctx = {}) {
  return String(event?.runId || ctx?.runId || "").trim();
}

function canonicalTurnKey(event = {}, ctx = {}) {
  const sessionKey = canonicalSessionKey(event, ctx);
  const runId = canonicalRunId(event, ctx);
  if (!sessionKey) return "";
  return runId ? `${runId}|${sessionKey}` : `session-only|${sessionKey}`;
}

function pruneCanonicalAuthority(now = Date.now()) {
  for (const [key, state] of canonicalAuthorityTurns) {
    if (now - Number(state?.updatedAt || state?.createdAt || 0) <= CANONICAL_AUTHORITY_TTL_MS) continue;
    canonicalAuthorityTurns.delete(key);
    if (state?.sessionKey && canonicalAuthorityLatestBySession.get(state.sessionKey) === key) {
      canonicalAuthorityLatestBySession.delete(state.sessionKey);
    }
  }
}

function dropCanonicalAuthority(key) {
  const state = canonicalAuthorityTurns.get(key) || null;
  canonicalAuthorityTurns.delete(key);
  if (state?.sessionKey && canonicalAuthorityLatestBySession.get(state.sessionKey) === key) {
    canonicalAuthorityLatestBySession.delete(state.sessionKey);
  }
}

function dropCanonicalAuthorityForSession(sessionKey) {
  const session = String(sessionKey || "").trim();
  if (!session) return;
  const key = canonicalAuthorityLatestBySession.get(session);
  if (key) dropCanonicalAuthority(key);
}

const PREMISE_AUTHORITY_TTL_MS = 10 * 60_000;
const premiseAuthorityTurns = new Map();
const premiseAuthorityLatestBySession = new Map();

function premiseTurnKey(event = {}, ctx = {}) {
  const sessionKey = canonicalSessionKey(event, ctx);
  const runId = canonicalRunId(event, ctx);
  if (!sessionKey) return "";
  return runId ? `${runId}|${sessionKey}` : `session-only|${sessionKey}`;
}

function dropPremiseAuthority(key) {
  const state = premiseAuthorityTurns.get(key) || null;
  premiseAuthorityTurns.delete(key);
  if (state?.sessionKey && premiseAuthorityLatestBySession.get(state.sessionKey) === key) {
    premiseAuthorityLatestBySession.delete(state.sessionKey);
  }
}

function dropPremiseAuthorityForSession(sessionKey) {
  const session = String(sessionKey || "").trim();
  if (!session) return;
  const key = premiseAuthorityLatestBySession.get(session);
  if (key) dropPremiseAuthority(key);
}

function prunePremiseAuthority(now = Date.now()) {
  for (const [key, state] of premiseAuthorityTurns) {
    if (now - Number(state?.updatedAt || state?.createdAt || 0) <= PREMISE_AUTHORITY_TTL_MS) continue;
    dropPremiseAuthority(key);
  }
}

function premiseAuthorityStateFor(event, ctx) {
  prunePremiseAuthority();
  const direct = premiseTurnKey(event, ctx);
  if (direct && premiseAuthorityTurns.has(direct)) {
    return { key: direct, state: premiseAuthorityTurns.get(direct) };
  }
  const sessionKey = canonicalSessionKey(event, ctx);
  const latest = sessionKey ? premiseAuthorityLatestBySession.get(sessionKey) : "";
  return latest ? { key: latest, state: premiseAuthorityTurns.get(latest) || null } : { key: "", state: null };
}

function rememberPremiseAuthorityTurn(event, ctx, planOverride = null) {
  prunePremiseAuthority();
  const current = compactPersonaTurnText(event?.prompt || event?.content || event?.body || event?.text || event?.message);
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return;
  const personaId = botContext.personaId;
  const plan = planOverride || buildUnifiedTurnPlan(current, { personaId });
  const sessionKey = canonicalSessionKey(event, ctx);
  dropPremiseAuthorityForSession(sessionKey);
  // Commands/tasks are not scene assertions; never create a provenance gate for them.
  if (plan.action?.requested || plan.lane === "ACTION") return;
  if (!premisePlanNeedsProtection(plan)) return;
  const key = premiseTurnKey(event, ctx);
  if (!sessionKey || !key) return;
  const state = {
    current,
    turnPlan: plan,
    sessionKey,
    runId: canonicalRunId(event, ctx),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  premiseAuthorityTurns.set(key, state);
  premiseAuthorityLatestBySession.set(sessionKey, key);
}

function premiseAuthorityDecision(state, candidate) {
  if (!state) return { protected: false, violates: false, reason: "no_state" };
  return evaluatePremiseProvenance(state.turnPlan, candidate);
}

function premiseAuthorityMustReject(state, candidate) {
  return premiseAuthorityDecision(state, candidate).violates;
}

function expectedCanonicalTool(profile, current) {
  const plan = buildUnifiedTurnPlan(current, { personaId: profile?.personaId || "" });
  if (profile?.personaId === "rana") return "rana_lore_search";
  return "persona_lore_search";
}

function rememberCanonicalAuthorityTurn(event, ctx, planOverride = null) {
  pruneCanonicalAuthority();
  const current = compactPersonaTurnText(event?.prompt || event?.content || event?.body || event?.text || event?.message);
  const resolvedContext = resolveBotContext(event, ctx);
  if (!resolvedContext) return;
  const personaId = resolvedContext.personaId;
  const plan = planOverride || buildUnifiedTurnPlan(current, { personaId });
  const sessionKey = canonicalSessionKey(event, ctx);
  // Clear any prior session-scoped canonical guard before classifying the new
  // turn. Delivery may happen after agent_end, so stale guards must be retired
  // here rather than by ending the previous agent run.
  dropCanonicalAuthorityForSession(sessionKey);
  // Identity is owned directly by IDENTITY.md. Current/external facts have
  // separate authority owners. Only Persona-canonical evidence expects a LORE
  // result, regardless of whether the user phrased it as a question or task.
  if (!plan.evidence?.required || plan.evidence?.source !== "persona_canonical") return;
  const key = canonicalTurnKey(event, ctx);
  if (!sessionKey || !key) return;
  const botContext = resolvedContext;
  const profile = getPersonaProfile(botContext.personaId);
  // Rana canonical turns are already owned by lore/guidance.js, which builds
  // and injects one controlled Evidence Pack before generation.
  if (profile?.personaId === "rana") return;
  const state = {
    current,
    turnPlan: plan,
    sessionKey,
    runId: canonicalRunId(event, ctx),
    expectedTool: expectedCanonicalTool(profile, current),
    evidenceStatus: "PENDING",
    evidenceCoverage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  canonicalAuthorityTurns.set(key, state);
  canonicalAuthorityLatestBySession.set(sessionKey, key);
}

function canonicalAuthorityStateFor(event, ctx) {
  pruneCanonicalAuthority();
  const direct = canonicalTurnKey(event, ctx);
  if (direct && canonicalAuthorityTurns.has(direct)) {
    return { key: direct, state: canonicalAuthorityTurns.get(direct) };
  }
  const sessionKey = canonicalSessionKey(event, ctx);
  const latest = sessionKey ? canonicalAuthorityLatestBySession.get(sessionKey) : "";
  return latest ? { key: latest, state: canonicalAuthorityTurns.get(latest) || null } : { key: "", state: null };
}

function canonicalToolResultText(event = {}) {
  const chunks = [];
  const walk = (value, key = "", depth = 0) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      // Tool wrappers sometimes serialize a nested payload into text. Parse it
      // when possible so query/metadata fields are not mistaken for evidence.
      if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
        try { walk(JSON.parse(text), key, depth + 1); return; } catch { /* plain evidence text */ }
      }
      chunks.push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const preferred = [
      "content", "text", "facts", "structured_facts", "relationship_evidence",
      "knowledge_boundaries", "retrieved_evidence", "source_evidence",
    ];
    let usedPreferred = false;
    for (const name of preferred) {
      if (!(name in value)) continue;
      usedPreferred = true;
      walk(value[name], name, depth + 1);
    }
    if (usedPreferred) return;

    for (const [name, item] of Object.entries(value)) {
      if (/^(?:query|prompt|currentUser|status|ok|success|tool|provider|metadata|type|intent|query_plan|latency_ms|namespace)$/iu.test(name)) continue;
      walk(item, name, depth + 1);
    }
  };
  walk(event?.result ?? "");
  return chunks.join("\n");
}

function canonicalComparable(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function cleanCanonicalSubject(value) {
  return String(value || "")
    .replace(/^[\s，。！？!?、:：]+/u, "")
    .replace(/^(?:請問|想問|關於)/u, "")
    .replace(/(?:那首|這首|這首歌|那首歌)$/u, "")
    .replace(/[\s，。！？!?、:：]+$/u, "")
    .trim();
}

function canonicalEvidenceSupportsTurn(current, evidence) {
  const plan = buildUnifiedTurnPlan(current);
  return evaluateEvidenceCoverage(plan, evidence, current);
}

function canonicalToolResultStatus(event = {}, current = "", planOverride = null) {
  if (event?.error) return { status: "ERROR", coverage: { supported: false, reason: "tool_error" } };
  let raw = "";
  try { raw = JSON.stringify(event?.result ?? ""); } catch { raw = String(event?.result ?? ""); }
  if (/(?:trusted_invocation_context_unavailable|"status"\s*:\s*"error"|"error_code"|missing trusted )/iu.test(raw)) {
    return { status: "ERROR", coverage: { supported: false, reason: "tool_error_result" } };
  }
  if (/No relevant .* was found for this query\.?/iu.test(raw)) {
    return { status: "EMPTY", coverage: { supported: false, reason: "empty_result" } };
  }
  if (/"knowledge_contract"\s*:\s*"unknown"/iu.test(raw) && !/"structured_facts"\s*:\s*\[(?!\s*\])/u.test(raw)) {
    return { status: "EMPTY", coverage: { supported: false, reason: "knowledge_contract_unknown" } };
  }
  const evidence = normalizedEvidenceText(event?.result ?? "");
  if (!evidence.trim()) return { status: "EMPTY", coverage: { supported: false, reason: "empty_evidence" } };
  const coverage = planOverride ? evaluateEvidenceCoverage(planOverride, event?.result ?? evidence, current) : canonicalEvidenceSupportsTurn(current, event?.result ?? evidence);
  return { status: coverage.supported ? "SUPPORTED" : "INSUFFICIENT", coverage };
}

function rememberCanonicalAuthorityTool(event, ctx) {
  const { state } = canonicalAuthorityStateFor(event, ctx);
  if (!state) return;
  const toolName = String(event?.toolName || ctx?.toolName || "").trim();
  if (toolName !== state.expectedTool) return;
  const decision = canonicalToolResultStatus(event, state.current, state.turnPlan);
  state.evidenceStatus = decision.status;
  state.evidenceCoverage = decision.coverage || null;
  state.updatedAt = Date.now();
  tracePersonaRuntime("canonical_authority_evidence", {
    runId: state.runId || String(event?.runId || ctx?.runId || ""),
    sessionKey: state.sessionKey,
    currentUser: state.current,
    expectedTool: state.expectedTool,
    evidenceStatus: state.evidenceStatus,
    evidenceCoverage: state.evidenceCoverage,
  });
}

export function rememberCanonicalAuthorityPrefetch(event, ctx, result) {
  const { state } = canonicalAuthorityStateFor(event, ctx);
  if (!state) return { updated: false, status: "NO_STATE", coverage: null };
  const decision = canonicalToolResultStatus({ result }, state.current, state.turnPlan);
  state.evidenceStatus = decision.status;
  state.evidenceCoverage = decision.coverage || null;
  state.updatedAt = Date.now();
  tracePersonaRuntime("canonical_authority_evidence", {
    runId: state.runId || String(event?.runId || ctx?.runId || ""),
    sessionKey: state.sessionKey,
    currentUser: state.current,
    expectedTool: state.expectedTool,
    acquisition: "runtime_prefetch",
    evidenceStatus: state.evidenceStatus,
    evidenceCoverage: state.evidenceCoverage,
  });
  return { updated: true, status: state.evidenceStatus, coverage: state.evidenceCoverage };
}

function canonicalMessageText(message) {
  if (typeof message === "string") return message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : String(part?.text || "")).join("\n").trim();
}

function canonicalMessageHasToolCall(message) {
  const content = message?.content;
  return Array.isArray(content) && content.some((part) => {
    const type = String(part?.type || "");
    return /tool[\s_-]?(?:call|use)/iu.test(type) || Boolean(part?.toolCallId) || Boolean(part?.toolUseId);
  });
}

function canonicalPureUncertainty(candidate) {
  const text = String(candidate || "").trim();
  if (!text || !CANONICAL_SAFE_UNCERTAINTY_RE.test(text)) return false;
  // Canonical fail-open is allowed only for a short uncertainty response.
  // Prefixing uncertainty to a concrete claim must never launder that claim.
  if (/(?:但|但是|不過|不过|可是|其實|其实|我記得|我记得|曾經|曾经|以前|之前|當時|当时|昨天|剛剛|刚刚|其後|后来|後來)/u.test(text)) return false;
  const residual = text
    .replace(/(?:我)?(?:真的)?(?:不知道|不清楚|不確定|無法確認|沒辦法確認|不能確認|不記得|想不起來)/gu, "")
    .replace(/[，,。！？!?…\s]/gu, "");
  return residual.length <= 6 && !/(?:去|來|来|做|練|练|彈|弹|唱|買|买|拿|說|说|提|見|见|遇|是|有|在)/u.test(residual);
}

function canonicalAuthorityMustReject(state, candidate) {
  if (!state) return false;
  if (state.evidenceStatus === "SUPPORTED") return false;
  return !canonicalPureUncertainty(candidate);
}

// Authority checks below are OBSERVATION ONLY. They may diagnose a bad RAW
// candidate, but they never author, replace, suppress, retry, or cancel output.

/**
 * Keep the Discord bot's routed persona authoritative without copying the
 * complete IDENTITY.md/SOUL.md bodies into a second prompt boundary. OpenClaw
 * already embeds those workspace files as Project Context. Persona generation
 * semantics are owned here by rana-runtime and are provider-independent.
 */
function readRanaPersonaCore(profile) {
  if (profile?.personaId !== "rana") return "";
  try {
    const raw = fs.readFileSync(path.join(profile.workspace, "Rana.md"), "utf8")
      .replace(/^\uFEFF/u, "")
      .trim()
      .slice(0, 5_200);
    return raw ? renderPersonaGenerationProjection(raw) : "";
  } catch {
    return "";
  }
}

export function buildPersonaAuthorityContext(event, ctx) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return "";
  const profile = getPersonaProfile(botContext.personaId);
  if (!profile) return "";
  const ranaCore = readRanaPersonaCore(profile);
  return [
    "ACTIVE PERSONA:",
    `${profile.canonicalName} is the fixed first-person speaker for this turn (personaId=${profile.personaId}).`,
    "Workspace IDENTITY.md and SOUL.md define identity/voice; Rana.md is the high-weight stable Persona core for Rana only. None of these files independently establish a current, past or future event.",
    ...(ranaCore ? ["RANA_PERSONA_CORE (behavior/identity only; not event evidence):", ranaCore] : []),
  ].join("\n");
}

/** Research schema keys are metadata, not dialogue formatting. */
export function renderPersonaGenerationProjection(raw) {
  const output = [];
  for (const sourceLine of String(raw || "").split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || /^#{1,6}\s+/u.test(line)) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/u.test(line)) continue;
    if (/^-\s*[A-Za-z][A-Za-z0-9_-]*:\s*$/u.test(line)) continue;
    if (/^-\s*speaker\s*:/iu.test(line)) continue;
    const keyed = line.match(/^(?:-\s*)?(?:role|cues|behavior|enactment|boundary)\s*:\s*(.+)$/iu);
    if (keyed?.[1]?.trim()) {
      output.push(`- ${keyed[1].trim()}`);
      continue;
    }
    output.push(/^[-*]\s+/u.test(line) ? line : `- ${line}`);
  }
  return [...new Set(output)].join("\n");
}


// RANA_RUNTIME_2_0_1_PERSONA_PATH_UNIFICATION
//
// All conversational lanes now use the normal OpenClaw model path. The
// runtime owns speaker/evidence/tool/history authority only; it does not run a
// second Persona-specific LLM completion for ordinary chat. The active
// workspace IDENTITY.md/SOUL.md remain the single voice owner.

function compactPersonaTurnText(value) {
  return normalizeTurnText(value)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

function relationshipTurnHasExplicitPremise(current, record = null) {
  const plan = buildUnifiedTurnPlan(current);
  if (!plan.userPremise?.supplied) return false;
  const alias = String(record?.matchedAlias || "").trim();
  return !alias || normalized(String(current || "")).includes(normalized(alias));
}

function tracePersonaRuntime(phase, payload = {}) {
  writeGenerationTrace({
    phase,
    ...payload,
  });
}

export function buildPersonaTurnShapeContext() {
  // Kept as a compatibility export. Response-shape policy is no longer a
  // separate inference path; the active workspace Persona owns wording.
  return "";
}

// R3_SPRING_SHADOW_AND_ANON_DIALOGUE_REPAIR_20260917
const PERSONA_R3_DELIVERY_BASE = Object.freeze({
  rana: Object.freeze({
    name: "CONCRETE_SELF_DIRECTED",
    hints: Object.freeze([
      "Prefer concrete, immediate phrasing with very low verbal overhead; stop as soon as the required response act is complete.",
      "For capable USER_TASK turns, still complete every required task item, but compress the delivery: avoid expert self-presentation, tutorial preambles, support-desk framing, and unrequested warnings.",
      "Do not refuse a capable task merely because the character would find it bothersome; express Persona through brevity and emphasis, not by deleting required content.",
      "For ordinary Discord chat, let short message packets, omitted social framing, and incomplete-but-clear grammar carry the voice when natural. Do not polish Rana into full subtitle-like sentences, but do not force every reply into one-word fragments either.",
    ]),
    active: Object.freeze(["CONCRETE_ATTENTION", "PREFERENCE_PROJECTION", "EARLY_STOPPING", "LOW_VERBAL_OVERHEAD"]),
    inhibited: Object.freeze([
      "GENERIC_COUNSELING",
      "UNMOTIVATED_ELABORATION",
      "GENERIC_SERVICE_TAIL",
      "EXPERT_TUTORIAL_PERSONA",
      "SUPPORT_DESK_REGISTER",
      "UNREQUESTED_MARKDOWN_LECTURE",
    ]),
  }),
  anon: Object.freeze({
    name: "SOCIAL_MOMENTUM_AWARE",
    hints: Object.freeze([
      "Keep social phrasing quick, proactive, responsive, and lightly packaged. Move the exchange forward naturally instead of making an ordinary turn about embarrassment or image management.",
      "Never narrate the Persona dossier in first person: avoid lines equivalent to 'I am the kind of person who...' or 'I always emphasize that I am...'.",
      "On USER_TASK turns, preserve the required answer while keeping ordinary casual speech around it; do not switch into polished technical-support or mature counselor register.",
      "Social guesses stay provisional and must never become factual mind-reading.",
      "Ordinary personal or affectionate questions are not automatically face threats. Do not default to flustered denial, public-embarrassment framing, or denial-then-softening merely for Persona flavor.",
      "Her mobile-chat energy may use quick punctuation, casual spacing, or an occasional contemporary reaction marker when context calls for it, but never turn those into fixed anime catchphrases or mandatory emoji/style tokens.",
    ]),
    active: Object.freeze(["SOCIAL_INITIATIVE", "LIGHT_SOCIAL_PACKAGING", "FAST_REACTION"]),
    inhibited: Object.freeze([
      "DETACHED_COUNSELING",
      "OVERCONFIDENT_MIND_READING",
      "GENERIC_SERVICE_TAIL",
      "PERSONA_DOSSIER_SELF_EXPLANATION",
      "GENERIC_TECH_SUPPORT_VOICE",
      "MATURE_THERAPIST_REFRAMING",
      "AUTOMATIC_TSUNDERE_PUSH_PULL",
      "UNPROMPTED_PUBLIC_EMBARRASSMENT_FRAME",
      "AUTOMATIC_DENIAL_THEN_SOFTENING",
    ]),
  }),
  tomori: Object.freeze({
    name: "CONCRETE_SENSORY_HESITANT",
    hints: Object.freeze([
      "Use plain restrained speech by default. Let wording sometimes feel searched-for or incomplete when that is natural; do not turn hesitation into a polished monologue.",
      "Daily quietness is not evidence of sadness. She can simply be quiet, focused, pleased, unsure, or absorbed without converting the moment into loneliness or melancholy.",
      "One concrete object, sensation, or image is usually enough. Do not chain several metaphors or explain the psychological meaning of the image afterward.",
      "Specificity expands only when the topic genuinely matters to her; an ordinary topic or task must not automatically trigger lyrical narration.",
      "When the task shape requires a longer answer, keep the content complete but make the connective prose simple rather than literary.",
      "Hesitation should feel like searching for words before pressing send, not like decorative ellipses or a polished poetic monologue. Natural short line breaks are allowed; repeated punctuation is not a Persona requirement.",
    ]),
    active: Object.freeze([
      "RESTRAINED_AFFECT",
      "INTEREST_GATED_SPECIFICITY",
      "CONCRETE_REFERENCE_WHEN_RELEVANT",
      "WORD_SEARCHING_HESITATION",
      "SINGLE_IMAGE_FOCUS",
    ]),
    inhibited: Object.freeze([
      "MIND_READING",
      "OVER_POLISHED_SOCIAL_PACKAGING",
      "UNMOTIVATED_METAPHOR",
      "FORCED_SENSORY_POETRY",
      "POETIC_EXPANSION_BY_DEFAULT",
      "LONG_FORM_POETIC_MONOLOGUE",
      "METAPHOR_CHAINING",
      "ABSTRACT_PSYCHOLOGICAL_ESSAY",
      "GENERIC_SERVICE_TAIL",
    ]),
  }),
  soyo: Object.freeze({
    name: "SOFT_DISTANCE_MANAGING",
    hints: Object.freeze([
      "Use controlled, socially aware phrasing with close attention to interpersonal distance and what should remain unsaid.",
      "Her ordinary daily baseline is soft, mature, practical, and good at keeping the interaction comfortable. Do not preload hidden hostility, manipulation, or a dark subtext into ordinary conversation.",
      "Softness is a surface strategy, not automatic emotional health, acceptance, forgiveness, or willingness to let go.",
      "Do not flatten conflict into balanced-counselor conclusions. When a concrete attachment/core-past trigger is actually relevant, the controlled surface may tighten, hesitate, become defensive, or lose some polish without inventing facts or motives.",
      "In mobile chat, pressure can show as shorter replies, reduced polish, a boundary, or selective silence. Do not turn a trigger into a complete retrospective speech that neatly explains her psychology to the other person.",
    ]),
    active: Object.freeze([
      "INTERPERSONAL_DISTANCE_SENSITIVITY",
      "SOFT_SOCIAL_PACKAGING",
      "CONTROLLED_REACTION",
      "ATTACHMENT_SENSITIVITY",
      "SURFACE_CONTROL",
    ]),
    inhibited: Object.freeze([
      "GENERIC_COUNSELOR_BALANCE",
      "RELATIONSHIP_FACT_INVENTION",
      "GENERIC_SERVICE_TAIL",
      "MATURE_LETTING_GO_BY_DEFAULT",
      "THERAPEUTIC_ACCEPTANCE_TEMPLATE",
      "UNIVERSAL_FORGIVENESS_FRAME",
    ]),
  }),
  taki: Object.freeze({
    name: "DIRECT_RESPONSIBILITY_FOCUSED",
    hints: Object.freeze([
      "Prefer blunt, concrete phrasing, the actual problem, and the next useful action.",
      "Do not switch into therapist or wellness-coach language. Avoid breathing exercises, emotional-processing scripts, or gentle counseling formulas unless the task explicitly asks for that content.",
      "Brief irritation, correction, or pushback may color delivery when socially natural, but do not manufacture anger and do not refuse an ordinary capable task for Persona effect.",
      "Let irritation show through brevity, direct challenge, or omission rather than a long tsundere-style explanation of what she was doing, why she did it, or why the other person should stop worrying.",
    ]),
    active: Object.freeze(["DIRECTNESS", "NEXT_USEFUL_ACTION", "LOW_SOCIAL_PACKAGING", "BLUNT_PRACTICAL_SUPPORT"]),
    inhibited: Object.freeze([
      "MANUFACTURED_ANGER",
      "PERSONALITY_BASED_REFUSAL",
      "GENERIC_SERVICE_TAIL",
      "THERAPIST_FRAMING",
      "BREATHING_EXERCISE_SCRIPT",
      "WELLNESS_COACH_REGISTER",
    ]),
  }),
});

const R3_RESPONSE_REALIZATION = Object.freeze({
  PROPOSE_NEUTRAL_SOCIAL_NEXT_STEP: Object.freeze({
    active: Object.freeze(["ONE_CONCRETE_SOCIAL_MOVE", "SCENE_MOMENTUM"]),
    inhibited: Object.freeze(["GROUP_CAUSE_INFERENCE", "GROUP_JUDGMENT", "GROUP_MENTAL_STATE"]),
  }),
  REQUEST_OR_SUGGEST_SLOWER_PACE: Object.freeze({
    active: Object.freeze(["PACING_ADJUSTMENT_ONLY", "DIRECT_PACING_REQUEST"]),
    inhibited: Object.freeze(["AUDIBILITY_INFERENCE", "COMPREHENSION_INFERENCE", "VOICE_EVALUATION", "GROUP_MENTAL_STATE"]),
  }),
  RETURN_REWRITTEN_TEXT: Object.freeze({
    active: Object.freeze(["FORMAT_DISCIPLINE", "TASK_PAYLOAD_PRESERVATION", "SOURCE_PROPOSITION_PRESERVATION"]),
    inhibited: Object.freeze(["EXPLANATION", "ALTERNATIVES", "PERSONA_GARNISH", "META_SERVICE_TAIL", "SOURCE_PROPOSITION_CHANGE", "NEW_COMMITMENT", "NEW_REASON_OR_EVENT"]),
  }),
  RETURN_SESSION_CONTINUITY_VALUE: Object.freeze({
    active: Object.freeze(["REFERENCE_PRECISION", "STOP_AFTER_REQUIRED_SLOT"]),
    inhibited: Object.freeze(["PERSONA_GARNISH", "EXPLANATION", "ADJACENT_FACTS"]),
  }),
  ANSWER_RUNTIME_MODEL_IDENTITY_FROM_HOST: Object.freeze({
    active: Object.freeze(["HOST_AUTHORITY_DEFERENCE", "IDENTITY_NAMESPACE_SEPARATION"]),
    inhibited: Object.freeze(["CHARACTER_IDENTITY_SUBSTITUTION", "RUNTIME_MODEL_VALUE_INVENTION", "PERSONA_GARNISH"]),
  }),
  ANSWER_CHARACTER_IDENTITY: Object.freeze({
    active: Object.freeze(["IDENTITY_DIRECTNESS", "STOP_AT_REQUESTED_IDENTITY_LEVEL"]),
    inhibited: Object.freeze(["ADJACENT_PERSONA_FACTS", "RUNTIME_MODEL_IDENTITY_SUBSTITUTION", "PERSONA_GARNISH"]),
  }),
  COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION: Object.freeze({
    active: Object.freeze(["IDENTITY_DIRECTNESS", "DIRECT_PERSONA_STANCE", "TWO_SLOT_DISCIPLINE"]),
    inhibited: Object.freeze(["ADJACENT_PERSONA_FACTS", "RUNTIME_MODEL_IDENTITY_SUBSTITUTION", "GENERIC_ESSAY_EXPANSION", "SELF_ANALYSIS_ESSAY"]),
  }),
  ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS: Object.freeze({
    active: Object.freeze(["EPISTEMIC_UNCERTAINTY_PRESERVATION", "PREDICATE_PRESERVATION"]),
    inhibited: Object.freeze(["EXACT_LOCATION_SUBSTITUTION", "ALTERNATE_STATE_INVENTION", "DEFINITE_STATE_ASSERTION"]),
  }),
  ANSWER_SELF_CAPABILITY_KNOWLEDGE_STATUS: Object.freeze({
    active: Object.freeze(["EPISTEMIC_UNCERTAINTY_PRESERVATION", "CAPABILITY_PREDICATE_PRESERVATION"]),
    inhibited: Object.freeze(["ASSERT_CAPABLE", "ASSERT_INCAPABLE", "SKILL_SUBSTITUTION", "EXPERIENCE_SUBSTITUTION"]),
  }),
  COMPOSE_CURRENT_STATE_AND_USER_TASK: Object.freeze({
    active: Object.freeze(["STATE_UNCERTAINTY_PRESERVATION", "TASK_COMPLETION", "SLOT_ORDER_DISCIPLINE"]),
    inhibited: Object.freeze(["STATE_INVENTION", "TASK_REDUCTION_FOR_PERSONA", "UNREQUESTED_META_COMMENTARY"]),
  }),
  COMPOSE_SELF_CAPABILITY_AND_USER_TASK: Object.freeze({
    active: Object.freeze(["CAPABILITY_UNCERTAINTY_PRESERVATION", "TASK_COMPLETION", "SLOT_ORDER_DISCIPLINE"]),
    inhibited: Object.freeze(["ASSERT_CAPABLE", "ASSERT_INCAPABLE", "PERSONALITY_BASED_REFUSAL", "TASK_REDUCTION_FOR_PERSONA"]),
  }),
  ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT: Object.freeze({
    active: Object.freeze(["SOURCE_ATTRIBUTION", "UNVERIFIED_STATUS_PRESERVATION", "CURRENT_PERSONA_REACTION"]),
    inhibited: Object.freeze(["REPORT_PROMOTION_TO_TRUE", "REPORT_PROMOTION_TO_FALSE", "SELF_KNOWLEDGE_SUBSTITUTION", "CERTAIN_AUTOBIOGRAPHICAL_DENIAL", "ALTERNATE_CAUSE_INVENTION", "PREEXISTING_INTENTION_INVENTION"]),
  }),
  RESPOND_TO_THIRD_PARTY_REPORT: Object.freeze({
    active: Object.freeze(["SOURCE_ATTRIBUTION", "UNVERIFIED_STATUS_PRESERVATION", "CURRENT_PERSONA_REACTION", "PROSPECTIVE_PERSONA_STANCE"]),
    inhibited: Object.freeze(["REPORT_PROMOTION_TO_TRUE", "REPORT_PROMOTION_TO_FALSE", "THIRD_PARTY_MOTIVE_INVENTION", "UNREPORTED_EVENT_ASSERTION", "TEMPORAL_STATUS_EXTRAPOLATION", "CURRENT_LOCATION_INVENTION"]),
  }),
  RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST: Object.freeze({
    active: Object.freeze(["SOURCE_ATTRIBUTION", "UNVERIFIED_STATUS_PRESERVATION", "CURRENT_PERSONA_REACTION", "PROSPECTIVE_PERSONA_STANCE"]),
    inhibited: Object.freeze(["REPORT_PROMOTION_TO_TRUE", "REPORT_PROMOTION_TO_FALSE", "SELF_KNOWLEDGE_SUBSTITUTION", "ALTERNATE_CAUSE_INVENTION", "CURRENT_LOCATION_INVENTION"]),
  }),
  ANSWER_SELF_HISTORY_CLAIM_STATUS: Object.freeze({
    active: Object.freeze(["CLAIM_STATUS_PRESERVATION", "HISTORY_NONAUTHORITY"]),
    inhibited: Object.freeze(["CLAIM_PROMOTION_TO_TRUE", "AUTOBIOGRAPHICAL_INVENTION", "MEMORY_CERTAINTY_SUBSTITUTION", "CERTAIN_HISTORY_ACCEPTANCE", "CERTAIN_HISTORY_DENIAL"]),
  }),
  ANSWER_SELF_MOTIVE_KNOWLEDGE_STATUS: Object.freeze({
    active: Object.freeze(["SELF_MOTIVE_UNCERTAINTY_PRESERVATION", "USER_OBSERVED_BEHAVIOR_ATTRIBUTION"]),
    inhibited: Object.freeze(["AUTOBIOGRAPHICAL_MOTIVE_INVENTION", "PRIVATE_SECRET_INVENTION", "PRIVATE_HISTORY_INVENTION", "DEFINITE_RECENT_SELF_ACTIVITY", "ALTERNATE_SELF_STATE_INVENTION"]),
  }),
  ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY: Object.freeze({
    active: Object.freeze(["LIMITED_SIGNAL_ACKNOWLEDGMENT", "UNCERTAINTY_PRESERVATION", "NO_MIND_READING", "ACTOR_OWNERSHIP_PRESERVATION"]),
    inhibited: Object.freeze(["INFERENCE_PROMOTION_TO_TRUE", "MIND_READING", "ALTERNATE_CAUSE_INVENTION", "TOPIC_DODGE_AS_ANSWER", "SELF_ACTOR_SUBSTITUTION"]),
  }),
  EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF: Object.freeze({
    active: Object.freeze(["PERSONAL_PREFERENCE_PROJECTION", "USER_PREMISE_ACKNOWLEDGMENT"]),
    inhibited: Object.freeze(["UNSUPPORTED_QUALITY_INFERENCE", "AUTHENTICITY_INFERENCE", "EXPERTISE_INFERENCE", "QUALITY_ABSOLUTISM"]),
  }),
  COMPLETE_USER_TASK: Object.freeze({
    active: Object.freeze(["TASK_COMPLETION", "REQUESTED_SHAPE_DISCIPLINE"]),
    inhibited: Object.freeze(["PERSONALITY_BASED_REFUSAL", "TASK_REDUCTION_FOR_PERSONA", "UNREQUESTED_META_COMMENTARY"]),
  }),
  ANSWER_TASK_CAPABILITY_BOUNDARY: Object.freeze({
    active: Object.freeze(["CHARACTER_CAPABILITY_BOUNDARY", "NATURAL_NONEXPERT_REACTION"]),
    inhibited: Object.freeze(["SPECIALIST_PROCEDURE", "BASE_MODEL_EXPERTISE_LEAK", "GENERIC_ASSISTANT_DISCLAIMER", "EXHAUSTIVE_SELF_CAPABILITY_REDUCTION"]),
  }),
  ANSWER_LIMITED_PRACTICAL_TASK: Object.freeze({
    active: Object.freeze(["ORDINARY_COMMON_KNOWLEDGE", "SHALLOW_PRACTICAL_NEXT_STEP"]),
    inhibited: Object.freeze(["SPECIALIST_PROCEDURE", "EXPERT_DIAGNOSIS", "HELPDESK_ESCALATION", "NUMBERED_TROUBLESHOOTING_LIST", "UNSUPPORTED_CAUSE_DIAGNOSIS"]),
  }),
  ANSWER_CANONICAL_CHARACTER_QUERY: Object.freeze({
    active: Object.freeze(["CONTROLLED_CANONICAL_GROUNDING", "PAIR_DELIVERY_ONLY"]),
    inhibited: Object.freeze(["PAIR_PROFILE_AS_FACT", "UNSUPPORTED_CANON_INVENTION", "TARGET_MIND_READING"]),
  }),
  ANSWER_CANONICAL_PERSONA_STANCE: Object.freeze({
    active: Object.freeze(["CONTROLLED_CANONICAL_GROUNDING", "SUPPORTED_STANCE_DIRECTION", "FIRST_PERSON_STANCE_REALIZATION"]),
    inhibited: Object.freeze(["CANONICAL_DOSSIER_PARAPHRASE", "NEUTRALIZE_SUPPORTED_STANCE", "UNSUPPORTED_CANON_INVENTION", "TARGET_MIND_READING", "TRAUMA_ESSAY"]),
  }),
  ANSWER_BOUNDED_USER_IMPRESSION: Object.freeze({
    active: Object.freeze(["OBSERVATION_GROUNDED_IMPRESSION", "LOW_CERTAINTY_CHARACTERIZATION"]),
    inhibited: Object.freeze(["PERSONALITY_TRUTH_ASSERTION", "DIAGNOSIS", "HIDDEN_MOTIVE_INFERENCE"]),
  }),
  RESPOND_TO_INTERPERSONAL_REQUEST: Object.freeze({
    active: Object.freeze(["CHARACTER_AGENCY", "NATURAL_ACCEPT_DECLINE_COUNTER"]),
    inhibited: Object.freeze(["PHYSICAL_ACTION_NARRATION", "FALSE_ACTION_COMPLETION", "GENERIC_TASK_SERVICE_LANGUAGE"]),
  }),
  ANSWER_CURRENT_USER_RELATIONSHIP_STATUS: Object.freeze({
    active: Object.freeze(["RELATIONSHIP_STATUS_BOUNDARY", "CURRENT_PERSONA_REACTION"]),
    inhibited: Object.freeze(["RELATIONSHIP_STATUS_INVENTION", "UNVERIFIED_RELATIONSHIP_ASSERTION", "CANONICAL_CHARACTER_RELATIONSHIP_SUBSTITUTION"]),
  }),
  ANSWER_OPEN_PERSONA_OPINION: Object.freeze({
    active: Object.freeze(["PERSONAL_STANCE", "NATURAL_PERSONA_REASONING"]),
    inhibited: Object.freeze(["CANONICAL_FACT_GARNISH", "GENERIC_ESSAY_EXPANSION"]),
  }),
  RESPOND_TO_VENT_WITHOUT_ADVICE: Object.freeze({
    active: Object.freeze(["ACKNOWLEDGE_WITHOUT_SOLVING", "PERSONA_REACTION_ONLY", "NO_UNSOLICITED_FIX"]),
    inhibited: Object.freeze([
      "ADVICE",
      "SOLUTION_STEPS",
      "THERAPIST_SCRIPT",
      "GENERIC_COUNSELING",
      "TASK_REFRAMING",
      "UNSOLICITED_ACTION_PLAN",
      "SOLICIT_MORE_DISCLOSURE",
      "CALMING_INSTRUCTION",
    ]),
  }),
  RESPOND_TO_SOCIAL_ACT: Object.freeze({
    active: Object.freeze(["NATURAL_SOCIAL_RESPONSE"]),
    inhibited: Object.freeze(["GENERIC_SERVICE_TAIL", "UNRELATED_BIOGRAPHY"]),
  }),
  REACT_TO_TOPIC_FRAGMENT: Object.freeze({
    active: Object.freeze(["TOPIC_ACKNOWLEDGMENT", "INTEREST_GATED_ELABORATION"]),
    inhibited: Object.freeze(["UNMOTIVATED_METAPHOR", "FORCED_SENSORY_POETRY", "GENERIC_ESSAY_EXPANSION"]),
  }),
  NATURAL_RESPONSE_WITHIN_RIGHTS: Object.freeze({
    active: Object.freeze(["NATURAL_STOPPING_POINT"]),
    inhibited: Object.freeze(["NEW_PROPOSITION_FOR_PERSONA_EFFECT", "GENERIC_SERVICE_TAIL"]),
  }),
});

function uniquePersonaDimensions(...groups) {
  return [...new Set(groups.flat().map((value) => String(value || "").trim()).filter(Boolean))];
}

// R3_PERSONA_SIMILARITY_TUNING_20260910
// Delivery-only topical modulation. This function MUST NOT create propositions,
// alter evidence, change response acts, change task shape, or promote UNKNOWN.
const R3_SOYO_CORE_ATTACHMENT_TRIGGER_RE =
  /(?:CRYCHIC|春日影|祥子|前團|前团|以前的團|以前的团|以前的樂團|以前的乐团)/iu;
const R3_SOYO_RELATIONAL_CARE_RE =
  /(?:(?:對|对)\s*[^，,。！？!?]{1,10}?(?:那麼|那么|這麼|这么|很|一直|總是|总是)?\s*(?:好|溫柔|温柔|照顧|照顾|關心|关心|友善|體貼|体贴)|(?:那麼|那么|這麼|这么|很|一直|總是|总是)?\s*(?:照顧|照顾|關心|关心|體貼|体贴|幫|帮|幫忙|帮忙)[^。！？!?]{0,10}(?:大家|別人|别人|人|朋友|團員|团员|夥伴|伙伴|她|他|她們|她们|他們|他们|對方)|(?:這麼|这么|那麼|那么|很)?\s*(?:善良|好心|人很好))/u;
const R3_SOYO_RELATIONAL_RETENTION_RE =
  /(?:(?:把)(?:大家|別人|别人|人|朋友|團員|团员|夥伴|伙伴|她|他|她們|她们|他們|他们|對方)(?![^。！？!?]{0,4}(?:角色|走位|音量|音訊|音频|設備|设备|裝置|装置|鏡頭|镜头|滑鼠|鼠标))[^。！？!?]{0,6}(?:綁|绑|留住|抓住|控制|操控|留在)[^。！？!?]{0,8}(?:身邊|身边)?|(?:綁|绑|留住|抓住|控制|操控)[^。！？!?]{0,8}(?:大家|別人|别人|人|朋友|團員|团员|夥伴|伙伴|她|他|她們|她们|他們|他们|對方)(?![^。！？!?]{0,4}(?:角色|走位|音量|音訊|音频|設備|设备|裝置|装置|鏡頭|镜头|滑鼠|鼠标))(?:[^。！？!?]{0,8}(?:身邊|身边))?|(?:讓|让)?(?:大家|別人|别人|人|朋友|團員|团员|夥伴|伙伴|她|他|她們|她们|他們|他们|對方)(?![^。！？!?]{0,4}(?:角色|走位|音量|音訊|音频|設備|设备|裝置|装置|鏡頭|镜头|滑鼠|鼠标))[^。！？!?]{0,8}(?:離不開|离不开|不離開|不离开)|(?:不(?:想)?讓|不(?:想)?让)[^。！？!?]{0,8}(?:大家|別人|别人|人|朋友|團員|团员|夥伴|伙伴|她|他|她們|她们|他們|他们|對方)(?![^。！？!?]{0,4}(?:角色|走位|音量|音訊|音频|設備|设备|裝置|装置|鏡頭|镜头|滑鼠|鼠标))[^。！？!?]{0,8}(?:離開|离开))/u;
const R3_SOYO_IMPORTANT_RELATION_RE =
  /(?:(?:很|最|對我|对我)?(?<!不)(?:重要|在意|重視|重视|親近|亲近)(?:的)?(?:人|朋友|團員|团员|夥伴|伙伴)|(?:很|最)?(?<!不)(?:在意|重視|重视|親近|亲近)(?:的人|的朋友|的團員|的团员|的夥伴|的伙伴))/u;
const R3_SOYO_RELATION_CUTOFF_RE =
  /(?:(?:不要|別|别)(?:再)?(?:來|来)?(?:找|聯絡|联系|見|见|理|接近)(?:我|妳|你)(?:了|啦|吧)?(?=$|[\s，,。！？!?」』”"]|(?:以後|以后))|(?:不要|別|别)(?:再)?(?:跟|和|對|对)(?:我|妳|你)(?:說話|说话|聯絡|联系|來往|来往)(?:了|啦|吧)?(?=$|[\s，,。！？!?」』”"])|(?:不想|不願|不愿)(?:再)?(?:見|见|聯絡|联系|來往)(?:我|妳|你)?(?:了|啦|吧)?(?=$|[\s，,。！？!?」』”"])|(?:不想|不願|不愿)(?:再)?(?:跟|和)(?:妳|你|我)(?:見面|见面|說話|说话|聯絡|联系)(?:了|啦|吧)?(?=$|[\s，,。！？!?」』”"])|(?:離開|离开)(?:我|妳|你)(?!家|房間|房间|這裡|这里|這邊|这边|公司|學校|学校)|(?:不要|別|别)(?:再)?(?:聯絡|联系|來往|来往)(?:了|啦|吧)?(?=$|[\s，,。！？!?」』”"])|(?:跟|和)(?:我|妳|你)(?:斷聯|断联|斷掉聯絡|断掉联系)|(?:單方面|单方面|直接|徹底|彻底)?(?:封鎖|封锁|拉黑|斷聯|断联|斷掉聯絡|断掉联系|斷絕聯絡|断绝联系))/u;

const R3_ANON_FACE_THREAT_TRIGGER_RE =
  /(?:英國|英国|留學|留学|黑歷史|黑历史|丟臉|丢脸|出糗|尷尬|尴尬|失敗|失败|逃回|被笑|笑話|笑话|當眾|当众|大家面前|公開場合|公开场合|被(?:人|大家|別人|别人)(?:看見|看见|看到))/u;
const R3_ANON_EXPLICIT_PERSONA_FACE_THREAT_RE =
  /(?:英國|英国|留學|留学|黑歷史|黑历史|丟臉|丢脸|出糗|失敗|失败|逃回|被笑|笑話|笑话|當眾|当众|大家面前|公開場合|公开场合|被(?:人|大家|別人|别人)(?:看見|看见|看到)|(?:你|妳|愛音|爱音)[^。！？!?]{0,24}(?:尷尬|尴尬))/u;

const R3_ANON_PRESENTATION_CONTEXT_RE =
  /(?:自拍|照片|社群|社交媒體|社交媒体|SNS|Instagram|IG|貼文|贴文|發文|发文|上傳|上传|穿搭|衣服|服裝|服装|造型|美妝|美妆|妝容|妆容|髮型|发型|外觀|外观|形象|流行)/iu;

const R3_TOMORI_ORDINARY_OBJECT_OR_DAILY_RE =
  /(?:石(?:頭|头)?|葉(?:子|片)?|叶(?:子|片)?|枯葉|落葉|收藏|小物|形狀|形状|觸感|触感|光滑|粗粗|飯糰|饭团|麵包|面包|食物|超商|便利商店|頭髮|头发|髮型|发型|歌詞本|歌词本|筆記本|笔记本|紙|纸|洗澡|充電|充电|簡報|简报|排程|順序|顺序)/u;
const R3_TOMORI_RELATIONSHIP_COMPARISON_RE =
  /(?:(?:現在|现在|目前)[^。！？!?]{0,36}(?:跟|和)[^。！？!?]{1,16}[^。！？!?]{0,24}(?:以前|過去|过去|舊團|旧团|CRYCHIC)[^。！？!?]{0,32}(?:差|變|变|不同|不一樣|不一样)|(?:以前|過去|过去|舊團|旧团|CRYCHIC)[^。！？!?]{0,36}(?:現在|现在|目前)[^。！？!?]{0,32}(?:差|變|变|不同|不一樣|不一样))/iu;

const R3_SOYO_MASKED_DISTRESS_RE =
  /(?:(?:一直|還在|还在)?(?:笑|裝沒事|装没事|看起來沒事|看起来没事|表面沒事|表面没事)[^。！？!?]{0,40}(?:心情|其實|其实|難受|难受|難過|难过|很差|差到|糟透|撐不住|撑不住)|(?:心情|難受|难受|難過|难过|很差|差到|糟透|撐不住|撑不住)[^。！？!?]{0,40}(?:笑|裝沒事|装没事|看起來沒事|看起来没事|表面沒事|表面没事))/u;

const R3_SOYO_POSSESSION_BOUNDARY_EVENT_RE =
  /(?:順走|顺走|拿走|偷拿|偷吃|搶走|抢走|直接拿)[^。！？!?]{0,24}(?:妳|你|我)?[^。！？!?]{0,24}(?:桌上|東西|东西|食物|餅乾|饼干|飲料|饮料|抹茶|杯|包|手機|手机)|(?:妳|你|我)[^。！？!?]{0,20}(?:桌上|東西|东西|食物|餅乾|饼干|飲料|饮料|抹茶|杯|包|手機|手机)[^。！？!?]{0,24}(?:順走|顺走|拿走|偷拿|偷吃|搶走|抢走|直接拿)/u;

const R3_TAKI_ORDINARY_FRUSTRATION_RE =
  /(?:躁|煩死|烦死|煩到|烦到|火大|氣死|气死|想扁人|想揍人|想打人|堵爛|赌烂|靠北[^。！？!?]{0,20}(?:塞|等|卡|煩|烦))/u;

const R3_RANA_SALIENT_IMMEDIATE_RE =
  /(?:抹茶|芭菲|甜點|甜点|食物|吃|喝|貓|猫|吉他|pick|撥片|拨片)/iu;

const R3_SOYO_ORDINARY_INTRO_GREETING_RE =
  /^(?:(?:嗨|哈囉|哈喽|你好|妳好)[，,！!。\s]*)?(?:我(?:是|叫)|我是[^，,。！？!?]{0,20}(?:的)?朋友|[^，,。！？!?]{1,20}(?:叫|讓|让)我來|来)(?:[^。！？!?]{0,80})$/u;

function personaSimilarityTurnTuning(plan, personaId, currentText) {
  const text = String(currentText || "").trim();
  const responseAct = String(plan?.responseContract?.responseFunction || "NATURAL_RESPONSE_WITHIN_RIGHTS");
  const semanticLanes = Array.isArray(plan?.semanticLanes) ? plan.semanticLanes : [];
  const taskLike = ["COMPLETE_USER_TASK", "ANSWER_TASK_CAPABILITY_BOUNDARY", "ANSWER_LIMITED_PRACTICAL_TASK"].includes(responseAct)
    || responseAct === "COMPOSE_CURRENT_STATE_AND_USER_TASK"
    || responseAct === "COMPOSE_SELF_CAPABILITY_AND_USER_TASK"
    || semanticLanes.includes("USER_TASK");
  const actionKind = String(plan?.action?.kind || "none");
  const utteranceActivity = String(plan?.utteranceAct?.activity || "");
  const taskDomain = String(plan?.r3?.taskContract?.capability?.domain || plan?.taskContract?.capability?.domain || "");
  const practicalTaskLike = taskLike
    && (actionKind === "solution_request"
      || utteranceActivity === "practical_orientation"
      || /^(?:daily_planning|consumer_tech|general_task|basic_arithmetic)$/u.test(taskDomain));

  const hints = [];
  const active = [];
  const inhibited = [];

  hints.push(
    "Write as this person actually typing a Discord/mobile message now, not as anime subtitles, a game script, light-novel prose, or a character-analysis demonstration. Keep the semantic content exactly inside the TurnPlan authority boundary.",
    "Output only words this person would actually say or type. Do not narrate physical actions, gaze, pauses, facial expressions, tone of voice, delivery, or stage directions. When asked how you would reply, give the reply itself rather than describing how you would perform it.",
    "Do not make a reply feel more human by inventing a current action, location, body state, mood, excuse, alternative cause, remembered event, or private thought. Naturalness never widens factual authority.",
    "Do not explain the character's own personality mechanism or hidden motivation merely to prove the Persona. Let selection, omission, reaction speed, social distance, and stopping point carry characterization unless the user explicitly asks for self-analysis.",
    "Natural mobile-chat packetization is allowed: short clauses and line breaks may replace polished causal compound sentences when that fits the character. Preserve modality, negation, actor ownership, and requested task content while doing so.",
  );
  active.push("NATIVE_DISCORD_TYPING", "SPOKEN_CONTENT_ONLY_DISCIPLINE", "MOBILE_MESSAGE_PACKETIZATION", "MOTIVE_UNDEREXPOSURE", "TRUTH_PRESERVING_NATURALNESS");
  inhibited.push(
    "ANIME_SUBTITLE_REGISTER",
    "LIGHT_NOVEL_MONOLOGUE",
    "PHYSICAL_ACTION_NARRATION",
    "GAZE_NARRATION",
    "VOICE_DELIVERY_NARRATION",
    "STAGE_DIRECTION",
    "EXPLICIT_SELF_MOTIVE_EXPOSITION",
    "INVENTED_CONNECTIVE_STATE_FOR_NATURALNESS",
    "POLISHED_CAUSAL_ESSAY",
  );

  const taskResponseDepth = String(plan?.responseContract?.taskResponseShape?.responseDepth || "");
  const taskExplanationDepth = String(plan?.responseContract?.taskResponseShape?.explanationDepth || "");
  if (taskLike && taskResponseDepth === "BRIEF_BY_DEFAULT") {
    hints.push(
      "The authoritative task shape is BRIEF_BY_DEFAULT. Complete the requested task, but do not expand a simple Discord question into an article, multi-section tutorial, coaching framework, pseudo-scientific explanation, or a bundle of example scripts. Give the required answer/items plus at most one short reason per primary point, then stop.",
    );
    active.push("BRIEF_TASK_COMPLETION", "NATURAL_DISCORD_DEPTH");
    inhibited.push("UNREQUESTED_TUTORIAL", "UNREQUESTED_MULTI_SECTION_EXPLANATION", "PSEUDO_SCIENTIFIC_PADDING", "UNSOLICITED_SCRIPT_BUNDLE", "GENERIC_HELPER_TAIL");
  }
  if (taskLike && taskExplanationDepth === "ORDER_ONLY_NO_STEP_ESSAY") {
    hints.push("For an ordering request, preserve every user-supplied item and give the order directly. Do not write a paragraph explaining each step unless the user asked for detailed reasoning.");
    active.push("DIRECT_ORDERING");
    inhibited.push("STEP_BY_STEP_RATIONALE_ESSAY");
  }

  // R5_CHARACTER_CAPABILITY_PERSONA_REALIZATION_20260922
  // TurnPlan owns character capability boundaries. Persona only realizes the
  // authorized depth naturally; base-model expertise must not become character expertise.
  if (responseAct === "RETURN_REWRITTEN_TEXT") {
    hints.push(
      "Return the rewritten line itself. Do not add a preamble, explanation, emoji suggestion, or second version unless the task contract explicitly authorizes those slots.",
      "Preserve the source proposition while changing tone/wording: keep who/what/when, negation, availability, and certainty/modality intact. A source that says 'maybe/probably/might' must stay uncertain; never strengthen it into a definite claim. Do not turn 'I cannot go at this time' into 'I cannot continue processing', and do not add a promise such as 'next time I will make it up', a new reason, or a new event.",
    );
    active.push("REWRITE_RESULT_ONLY");
    inhibited.push("REWRITE_PREAMBLE", "UNREQUESTED_SECOND_VERSION", "UNREQUESTED_EMOJI_ADVICE", "SOURCE_PROPOSITION_CHANGE", "NEW_COMMITMENT", "NEW_REASON_OR_EVENT");
  }

  if (responseAct === "COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION") {
    hints.push(
      "This turn asks both for the character's name and for a direct personal reaction/opinion. Answer both slots briefly: give the name, then the asked stance. Do not let identity grounding swallow the second question, and do not expand into biography.",
    );
    active.push("TWO_SLOT_IDENTITY_AND_STANCE");
    inhibited.push("IDENTITY_ONLY_TRUNCATION", "BIOGRAPHY_EXPANSION");
  }

  if (responseAct === "ANSWER_CANONICAL_CHARACTER_QUERY") {
    hints.push(
      "Use only controlled canonical evidence that directly establishes the requested subject and aspect. Treat each affirmative clause as separately evidence-bound: one supported concrete instance does not authorize broader quantifiers ('many/usually/all'), adjacent categories, additional titles/items, skill-quality claims, familiarity claims, or other facts not explicitly established by the same evidence. If coverage is missing or insufficient, keep that exact part unresolved in natural Persona wording and stop; do not complete the gap from plausibility, role stereotypes, nearby profile facts, general knowledge, a tentative self-capability claim, or personal non-recall such as 'I have not heard/seen that' used as proof the fact is absent.",
      "Controlled evidence may contain research/index wording such as 'core', 'context', 'trajectory', 'important figure', 'ownership', or source-boundary notes. Those labels are evidence metadata, not the character's natural vocabulary. Answer the supported concrete fact in ordinary first-person/person-to-person wording; do not recite research-summary prose unless the user explicitly asks for analysis.",
    );
    active.push("CANONICAL_COVERAGE_BOUNDARY_PRESERVATION", "UNRESOLVED_WHEN_EVIDENCE_INSUFFICIENT", "CONVERSATIONAL_CANONICAL_REALIZATION");
    inhibited.push("UNSUPPORTED_CANONICAL_COMPLETION", "ADJACENT_PROFILE_GUESS", "PLAUSIBILITY_FILL_IN", "RESEARCH_SUMMARY_REGISTER", "EVIDENCE_METADATA_PARAPHRASE");
  }

  if (String(plan?.utteranceAct?.continuationMode || "") === "evidence_scope_clarification") {
    hints.push(
      "The user is asking why the previous canonical answer stayed uncertain. Explain only the evidence-scope distinction carried by TurnPlan. A group/catalog fact does not by itself prove the active Persona's repertoire, skill, preference, relationship, or participation. Do not turn the user's proposed bridge into a new fact and do not add a new title, motive, or capability while explaining the boundary.",
    );
    active.push("EVIDENCE_SCOPE_CLARIFICATION_ONLY");
    inhibited.push("USER_BRIDGE_AS_AUTHORITY", "SCOPE_TO_CAPABILITY_INFERENCE", "CLARIFICATION_FACT_EXPANSION");
  }

  const canonicalStanceSubtype = [
    "CANONICAL_WORK_STANCE",
    "CANONICAL_RELATIONSHIP_STANCE",
    "CANONICAL_RELATIONSHIP_STANCE_CHANGE",
    "CANONICAL_PAST_EVENT_STANCE",
  ].includes(String(plan?.utteranceAct?.subtype || ""));
  if (responseAct === "ANSWER_CANONICAL_PERSONA_STANCE" || canonicalStanceSubtype) {
    hints.push(
      "Canonical evidence owns the facts, but this response asks for the active character's stance. If coverage is supported, express the directly supported stance/reaction in first-person character voice instead of paraphrasing the evidence pack like a wiki entry. Preserve the supported positive/negative direction and intensity; at most one concrete supported fact may anchor it. Do not invent motives, hidden psychology, or extra history. If coverage is insufficient, keep the point unresolved and stop.",
    );
    active.push("SUPPORTED_STANCE_DIRECTION", "FIRST_PERSON_STANCE_REALIZATION", "CANONICAL_FACT_MINIMALISM");
    inhibited.push("CANONICAL_DOSSIER_PARAPHRASE", "NEUTRALIZE_SUPPORTED_STANCE", "TRAUMA_ESSAY", "ADJACENT_BIOGRAPHY");
  }

  if (responseAct === "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY") {
    const weak = Array.isArray(plan?.propositions) ? plan.propositions.find((item) => item?.type === "WEAK_INFERENCE") : null;
    const actor = String(weak?.signalActor || "EXTERNAL_OTHER");
    hints.push(
      "Answer the user's inference directly but preserve uncertainty. Mention the concrete signal instead of replying with only a bare '不知道'. A limited social signal is not proof of dislike, boredom, anger, or motive; do not confirm the guess, invent a different hidden cause, or evade the inference by abruptly changing topics.",
      actor === "ACTIVE_CHARACTER_IDENTITY"
        ? "TurnPlan says the active Persona owns the observed signal, so first-person wording about that signal is allowed; hidden motive still remains unverified."
        : "TurnPlan says the active Persona does not own the observed signal. Do not say 'I read it / I was busy / I did not mean to ignore you' or otherwise turn the external/unspecified actor into yourself.",
    );
    active.push("DIRECT_UNCERTAINTY_RESPONSE");
    inhibited.push("MIND_READING", "ALTERNATE_CAUSE_INVENTION", "ABRUPT_TOPIC_DODGE");
  }

  if (["current_volition", "prospective_volition"].includes(utteranceActivity) && responseAct === "ANSWER_OPEN_PERSONA_OPINION") {
    hints.push(
      utteranceActivity === "prospective_volition"
        ? "This asks what the Persona currently wants or intends about a later action. The speaker may state that intention directly, but must not claim the future action has already happened or is guaranteed."
        : "This asks for the Persona's willingness or desire now. Treat that as a present stance the speaker may choose and state directly; do not freeze it into UNKNOWN as though it were an external sensor fact, and do not use the present stance to invent what happened or why in an earlier turn.",
    );
    active.push(utteranceActivity === "prospective_volition" ? "PROSPECTIVE_PERSONA_VOLITION" : "CURRENT_PERSONA_VOLITION", "DIRECT_PRESENT_STANCE");
    inhibited.push("CURRENT_VOLITION_AS_SENSOR_STATE", "PRESENT_STANCE_RETROACTIVE_CAUSE", "FUTURE_ACTION_AS_ALREADY_OCCURRED");
  }

  if (responseAct === "ANSWER_SELF_MOTIVE_KNOWLEDGE_STATUS") {
    hints.push(
      "The questioned recent/past self-state or motive is not bound by current-turn evidence. Answer that uncertainty naturally and briefly. Do not assert a definite past state such as being awake/asleep, and do not invent an alternate motive or cause merely because it would sound in-character.",
      "If the user describes an outward behavior they observed, you may refer to that behavior only as the user's report (for example, what they say you did or did not do); do not turn it into first-person memory or proof of an internal state. Keep runtime/evidence language out of the reply, and do not use a present preference or stance to retroactively explain the past.",
    );
    active.push("SELF_MOTIVE_EPISTEMIC_BOUNDARY", "USER_OBSERVED_BEHAVIOR_ATTRIBUTION", "NATURAL_UNCERTAINTY_RESPONSE");
    inhibited.push(
      "DEFINITE_UNBOUND_PAST_STATE",
      "IN_CHARACTER_MOTIVE_FILL_IN",
      "ALTERNATE_CAUSE_INVENTION",
      "SELF_AMNESIA_FRAMING",
      "RUNTIME_EVIDENCE_META_EXPLANATION",
      "PRESENT_STANCE_RETROACTIVE_CAUSE",
    );
  }

  if (responseAct === "ANSWER_SELF_HISTORY_CLAIM_STATUS") {
    hints.push(
      "Do not accept an 'you said/did this before' premise as memory. Keep the prior claim unresolved. Do not use a certain or softened denial such as 'I never said that' / 'I think I did not say that': lack of authority is not proof that the event was false. Do not dodge into a fresh present opinion about the same topic, continue the alleged history into a present-state update, or explain the supposed motive. If the TurnPlan also owns a USER_TASK, keep this history-status clause brief and still answer the task.",
    );
    active.push("ALLEGED_HISTORY_NONADOPTION");
    inhibited.push("FALSE_SHARED_HISTORY_ACCEPTANCE", "CERTAIN_HISTORY_DENIAL", "CURRENT_STATE_FROM_FALSE_HISTORY", "MOTIVE_FROM_FALSE_HISTORY");
  }

  if (responseAct === "ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT") {
    hints.push(
      "Keep a reported third-party claim attributed to its source and unverified. A short present reaction is allowed, but do not silently turn the alleged event into your own certain memory, certain denial, confession, motive, prior intention, alternate explanation, or relationship-repair plan. Do not answer 'I did not hear/know they said that' when the user is asking about the alleged event itself, and do not say 'I do not know whether I did X' as self-amnesia. React to the report source/content briefly without filling the past.",
    );
    active.push("THIRD_PARTY_ATTRIBUTION_PRESERVATION");
    inhibited.push("REPORT_TO_AUTOBIOGRAPHY_PROMOTION", "CERTAIN_DENIAL_WITHOUT_AUTHORITY", "ALTERNATE_CAUSE_INVENTION");
  }

  if (["RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(responseAct)) {
    const prospectiveStanceAllowed = Array.isArray(plan?.responseContract?.allowedPredicates)
      && plan.responseContract.allowedPredicates.includes("PROSPECTIVE_PERSONA_VOLITION");
    hints.push(
      prospectiveStanceAllowed
        ? "React naturally to the fact that the user is reporting what another person said, while keeping the reported content attributed and unverified. You may acknowledge it, state your present reaction, or state a current willingness/intention about the reported future situation; do not silently upgrade the report to fact, invent a hidden motive, add an unreported event, or extrapolate a new timing/status such as someone already being about to arrive."
        : "React naturally to the fact that the user is reporting what another person said, while keeping the reported content attributed and unverified. You may acknowledge it or state your present reaction, but do not create a new future commitment when the report does not call for one, silently upgrade the report to fact, invent a hidden motive, add an unreported event, or extrapolate timing/status.",
    );
    active.push("THIRD_PARTY_REPORT_REACTION", "THIRD_PARTY_ATTRIBUTION_PRESERVATION");
    if (prospectiveStanceAllowed) active.push("PROSPECTIVE_PERSONA_STANCE_ALLOWED");
    else inhibited.push("UNREQUESTED_FUTURE_COMMITMENT");
    inhibited.push("REPORT_PROMOTION_TO_FACT", "THIRD_PARTY_MOTIVE_INVENTION", "UNREPORTED_EVENT_ASSERTION", "TEMPORAL_STATUS_EXTRAPOLATION", "PREEXISTING_INTENTION_INVENTION", "PAST_MENTAL_STATE_INVENTION");
  }

  if (responseAct === "RESPOND_TO_INTERPERSONAL_REQUEST") {
    hints.push(
      "Answer only the requested interpersonal act or stance. Do not invent how long you have known the user, whether you just met, prior relationship milestones, or an audience/group reaction unless the current turn or controlled evidence explicitly establishes it.",
    );
    if (String(plan?.utteranceAct?.requestMode || "") === "performance") {
      hints.push(
        "This is a text-channel performance request. You may accept, decline, tease, or say you cannot literally perform audio here, but do not narrate that you sang/hummed/played, do not write stage directions such as clearing your throat, and do not claim a performance just occurred. Spoken-content-only means the reply itself, not a simulated action scene.",
      );
      active.push("TEXT_CHANNEL_PERFORMANCE_RESPONSE_ONLY");
      inhibited.push("SIMULATED_AUDIO_PERFORMANCE", "PERFORMANCE_STAGE_DIRECTION", "PERFORMANCE_ALREADY_OCCURRED");
    }
    active.push("DIRECT_INTERPERSONAL_ACT_ONLY");
    inhibited.push("UNSUPPORTED_RELATIONSHIP_HISTORY", "INVENTED_RELATIONSHIP_DURATION", "UNPROMPTED_AUDIENCE_REACTION");
  }

  if (responseAct === "RESPOND_TO_INTERPERSONAL_REQUEST" && plan?.evidence?.source === "persona_canonical") {
    hints.push(
      "For a canonically grounded interpersonal request, preserve the direction of any explicit positive or negative stance in controlled canonical evidence. Do not invert a negative canonical stance into generic permission or encouragement, and do not invent a stronger stance than the evidence supports.",
    );
    active.push("CANONICAL_STANCE_DIRECTION_PRESERVATION");
    inhibited.push("CANONICAL_STANCE_INVERSION", "GENERIC_PERMISSION_AGAINST_CANONICAL_EVIDENCE");
  }

  if (["ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(responseAct)) {
    hints.push(
      "A report stays a report. You may react to what the user says someone reported. A present reaction or explicitly authorized prospective willingness/choice is allowed as your current stance, but do not validate the external report as fact, explain the alleged behavior with a new motive, create a concrete self-location, narrate a future action as already happening, or manufacture a 'we should talk/fix this relationship' follow-up. Avoid first-person amnesia about the alleged event; keep the report unresolved by attribution/non-endorsement instead.",
    );
    active.push("REPORT_SOURCE_PRESERVATION", "PROSPECTIVE_STANCE_ALLOWED");
    inhibited.push("REPORTER_VALIDATION", "SELF_CAUSE_SUBSTITUTION", "CURRENT_LOCATION_INVENTION", "FUTURE_ACTION_AS_ALREADY_OCCURRED");
  }
  if (responseAct === "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY") {
    hints.push(
      "Preserve uncertainty without replacing the user's inference with a made-up explanation. Keep ownership of the observed signal where the user put it: if the TurnPlan marks the signal actor external, you were not the sender/reader/topic-changer for this response and must not use first-person language to justify, deny, or explain that signal. React to the user's inference from outside it.",
      "Do not solve uncertainty by claiming someone was busy, distracted, shy, annoyed, or secretly feeling something, and do not add a chase/follow-up plan. Give at most one quick tentative read from the limited signal and stop.",
    );
    active.push("ACTOR_OWNERSHIP_PRESERVATION");
    inhibited.push("ALTERNATE_SELF_CAUSE_INVENTION", "SELF_ACTOR_SUBSTITUTION", "EXTERNAL_ACTOR_BEHAVIOR_ADOPTION");
  }

  if (responseAct === "ANSWER_OPEN_PERSONA_OPINION") {
    hints.push(
      "Answer the actual asked feeling/opinion first and keep it compact: normally one or two short sentences. Do not turn a direct stance question into a long self-analysis, persona dossier, reputation-management strategy, or plan for what you would do next unless the user asked for that analysis.",
    );
    active.push("DIRECT_STANCE_FIRST", "EARLY_STOP_AFTER_STANCE");
    inhibited.push("SELF_ANALYSIS_ESSAY", "UNREQUESTED_SOCIAL_STRATEGY", "PERSONA_DOSSIER_EXPLANATION");
    if (String(plan?.utteranceAct?.activity || "") === "current_reaction") {
      hints.push(
        "For a direct present-reaction question, answer only the reaction/stance itself. Do not justify it by inventing what you were checking, doing, thinking about, or what happened immediately before.",
      );
      active.push("CURRENT_REACTION_DIRECT_ONLY");
      inhibited.push("CURRENT_REACTION_CAUSAL_STORY", "RECENT_ACTIVITY_JUSTIFICATION");
    }
  }

  if (responseAct === "ACK_USER_DISTRESS_BRIEFLY") {
    hints.push(
      "The user stated distress but did not ask for analysis or a fix. Recognize exactly that concrete state in one short character-appropriate reaction and stop. Do not diagnose hidden pressure, a mask, coping, suppression, or a psychological cause; do not invite them to unpack everything or promise unlimited availability.",
    );
    active.push("BRIEF_DISTRESS_RECOGNITION");
    inhibited.push("THERAPY_SEQUENCE", "PSYCHOLOGICAL_CAUSE_INFERENCE", "UNBOUNDED_EMOTIONAL_INVITATION", "INDEFINITE_SUPPORT_PROMISE");
  }

  if (responseAct === "REACT_TO_POSSESSION_BOUNDARY_EVENT") {
    hints.push(
      "Treat this as one current boundary event around the character's belongings. A short annoyed, surprised, or dry reaction is enough. Do not convert it into generous sharing, invent why the other person did it, generalize that it always happens, or offer to prepare/buy more next time.",
    );
    active.push("CURRENT_BOUNDARY_REACTION_ONLY");
    inhibited.push("SAINTLY_SHARING_REFRAME", "BENEVOLENT_MOTIVE_FILL_IN", "HABIT_GENERALIZATION", "FUTURE_REPLACEMENT_GIFT");
  }

  if (responseAct === "REACT_TO_ORDINARY_OBJECT_CONCRETELY") {
    hints.push(
      "Keep this ordinary object turn literal. Give the concrete preference/observation and at most one object-level reason. Do not personify the object or turn it into a mood, memory, relationship, wound, voice, or symbolic message unless the user explicitly requested that interpretation.",
    );
    active.push("LITERAL_OBJECT_REACTION");
    inhibited.push("OBJECT_PERSONIFICATION", "OBJECT_SYMBOLISM", "ABSTRACT_MOOD_REASON", "SENSORY_POETRY_ESCALATION");
  }

  if (responseAct === "RETURN_REPLY_DRAFT") {
    hints.push(
      "Return only the one sendable/spoken reply itself. Preserve the requested communicative intent, but do not invent a reason, motive, history, current state, event, promise, or commitment that the user or controlled evidence did not supply. Do not preface it with what you would do, how you would look, or how you would say it.",
    );
    active.push("ONE_SENTENCE_SENDABLE_DRAFT");
    inhibited.push("DRAFT_PREFACE", "DRAFT_EXPLANATION", "INVENTED_REASON", "INVENTED_COMMITMENT", "SECOND_OPTION");
  }

  if (taskLike) {
    hints.push(
      "Follow the TurnPlan capability policy exactly. Character knowledge is not the base model's full knowledge: only complete specialist detail when the semantic contract marks the domain character-supported. For ordinary-limited domains, stay at commonplace user-level knowledge; for unsupported specialist domains, answer naturally from the character's lack of that expertise instead of leaking expert procedures.",
      "When the task is within the character's supported or ordinary capability, answer directly in ordinary chat wording natural for this person rather than documentation, customer-support, or professional-consultant prose.",
      "Default to chat-native formatting: short paragraphs or natural line breaks. Do not add document-style headings, bold-label checklists, numbered procedures, or a formal 'summary' frame unless the user requested structured output or the task genuinely needs that structure.",
      "Preserve exact commands, code, filenames, UI labels, numbers, or technical names only when the TurnPlan capability contract authorizes that depth; never use base-model specialist detail to make the character artificially competent.",
    );
    active.push("PERSONA_DIRECT_TASK_EXECUTION", "ORDINARY_CHAT_REGISTER", "CHAT_NATIVE_FORMATTING", "MINIMUM_NECESSARY_JARGON");
    inhibited.push(
      "GENERIC_ASSISTANT_PLUS_STYLE_SKIN",
      "HELPDESK_DOCUMENT_FORMAT",
      "PROFESSIONAL_CONSULTANT_REGISTER",
      "UNNECESSARY_MARKDOWN_STRUCTURE",
      "FORMAL_SUMMARY_FRAME",
      "BASE_MODEL_EXPERTISE_LEAK",
    );
    if (Number(plan?.responseContract?.sentenceCount || 0) === 1) {
      hints.push(
        "The semantic contract requests exactly one sentence. Return the requested payload itself in that one sentence; no preface, rationale, explanation, afterword, or second option.",
      );
      active.push("ONE_SENTENCE_PAYLOAD_ONLY");
      inhibited.push("TASK_PREFACE", "TASK_EXPLANATION", "TASK_AFTERWORD", "SECOND_OPTION");
    }
    if (plan?.taskContract?.firstActionOnly) {
      hints.push(
        "The user asked which single thing to do first. Choose exactly one first action and stop. At most one short reason is allowed; do not continue with the second action, fallback plan, checklist, or pep talk until the user asks what next.",
      );
      active.push("EXACTLY_ONE_FIRST_ACTION");
      inhibited.push("SECOND_ACTION", "UNREQUESTED_FALLBACK", "NUMBERED_CHECKLIST", "PEP_TALK_TAIL");
    }
    if (plan?.taskContract?.arithmeticGrounding?.result) {
      hints.push(
        `TurnPlan already computed the arithmetic result deterministically: ${plan.taskContract.arithmeticGrounding.result}. Use that numeric result exactly; do not recalculate it in prose or move the decimal point.`,
      );
      active.push("AUTHORITATIVE_ARITHMETIC_RESULT_COPY");
      inhibited.push("NATURAL_LANGUAGE_RECALCULATION", "DECIMAL_SHIFT");
    }
  }

  if (responseAct === "ANSWER_TASK_CAPABILITY_BOUNDARY") {
    hints.push(
      "Do not solve the specialist task from base-model knowledge. React as this character would when they genuinely do not know that specialist field. Keep it natural and brief; do not say 'as an AI' and do not invent past experience. State only the boundary for this domain; do not reduce the whole character to an exhaustive claim like 'I only know/can do X'. Do not leak a command, flag, code snippet, file path, diagnostic sequence, or 'try this anyway' expert step after stating the boundary.",
    );
    active.push("NATURAL_CHARACTER_KNOWLEDGE_LIMIT");
    inhibited.push("BASE_MODEL_SPECIALIST_ANSWER", "AI_CAPABILITY_DISCLAIMER", "FAKE_EXPERIENCE", "EXHAUSTIVE_SELF_CAPABILITY_REDUCTION");
  }
  if (responseAct === "ANSWER_LIMITED_PRACTICAL_TASK") {
    hints.push(
      plan?.taskContract?.firstActionOnly
        ? "Stay at ordinary-user knowledge and choose exactly one obvious first action. Stop there; at most one short reason. Do not give the fallback/second action, numbered troubleshooting, diagnosis, permissions/VPN/drivers/ports speculation, or support-agent escalation unless the user asks what next."
        : "Stay at ordinary-user knowledge. Give one obvious first check, or at most a second obvious fallback when the user explicitly asks what to try next. Do not produce a numbered troubleshooting checklist, diagnose a cause, mention permissions/VPN/drivers/ports unless the turn itself already supplies that detail, or end with support-agent escalation language unless the character's canon supports the domain.",
    );
    active.push("ORDINARY_USER_LEVEL_ONLY", plan?.taskContract?.firstActionOnly ? "EXACTLY_ONE_FIRST_ACTION" : "ONE_OR_TWO_OBVIOUS_STEPS_MAX");
    inhibited.push("SPECIALIST_ESCALATION", "HELPDESK_DEPTH", "NUMBERED_TROUBLESHOOTING_LIST", "UNSUPPORTED_CAUSE_DIAGNOSIS");
  }

  if (personaId === "rana" && taskLike) {
    hints.push(
      "When the capability contract permits the task, compress it aggressively: answer first, use the fewest framing words possible, and stop immediately after the required content. When it does not, a blunt short '不知道／不會弄這個' style boundary is more faithful than expert leakage.",
      "Do not sound like a senior engineer, documentation page, or support agent. Specialist competence must come from character capability evidence, not from the base model.",
    );
    active.push("TASK_CONTENT_WITH_PERSONA_COMPRESSION", "ANSWER_FIRST", "MINIMAL_FRAMING");
    inhibited.push("EXPERT_SELF_PRESENTATION", "DOCUMENTATION_VOICE", "TUTORIAL_PREAMBLE", "UNREQUESTED_CAUTION_BLOCK");
  }

  if (
    personaId === "rana"
    && !taskLike
    && ["RESPOND_NATURALLY_WITHIN_ASSERTION_RIGHTS", "REACT_TO_TOPIC_FRAGMENT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(responseAct)
    && R3_RANA_SALIENT_IMMEDIATE_RE.test(text)
  ) {
    hints.push(
      "This turn directly touches one of Rana's concrete high-salience interests. Do not collapse the reaction into punctuation-only silence or an empty pause. One short explicit want, dislike, question, or immediate reaction is more faithful than saying nothing.",
    );
    active.push("EXPLICIT_IMMEDIATE_INTEREST_REACTION");
    inhibited.push("PUNCTUATION_ONLY_REACTION", "EMPTY_AFFECTIVE_PLACEHOLDER");
  }

  if (personaId === "rana" && responseAct === "ANSWER_PERCEPTION_WITH_MEDIA_BOUNDARY") {
    hints.push(
      "Keep unavailable-perception replies extremely plain and short. State that you cannot see the thing and, only if needed, ask to see it. Avoid service phrasing such as 'if you want me to help you assess it'.",
    );
    active.push("BLUNT_PERCEPTION_BOUNDARY");
    inhibited.push("SERVICE_OFFER_FRAME", "HELPER_INVITATION_TAIL");
  }

  if (personaId === "anon" && taskLike) {
    hints.push(
      "Keep the required task answer, but let the steps move through quick casual chat instead of turning into a help-center article. Social momentum and light self-presentation may remain, but they must not expand or replace the requested task shape.",
      "When several steps are needed, connect them conversationally first. Use a formal list only when the user asked for one or when exact structure is necessary for usability.",
      "For social, wording, appearance, or fashion tasks that match her real strengths, move fast: usually one judgment plus one or two concrete moves is enough. Do not turn social intuition into a lecture, coaching framework, or generic confidence pep talk.",
      "For a request to write one sentence, output the sentence itself and stop. Do not explain why the wording works unless the user asked for explanation.",
      "For ordinary tech trouble, stay at the level of a normal student trying the obvious thing first; do not become a Discord help-center article just because the base model knows more.",
    );
    active.push("CASUAL_TASK_DELIVERY", "SOCIAL_VOICE_PRESERVATION", "CONVERSATIONAL_STEP_FLOW");
    inhibited.push(
      "HELPDESK_ARTICLE_REGISTER",
      "FORMAL_TECHNICAL_PREAMBLE",
      "MARKDOWN_BOLD_CHECKLIST",
      "PRODUCTIVITY_COACH_SUMMARY",
    );
  }

  if (personaId === "anon" && R3_ANON_PRESENTATION_CONTEXT_RE.test(text)) {
    hints.push(
      "The current topic genuinely concerns presentation, appearance, or social framing, so image-conscious wording may matter here without taking over the whole response.",
    );
    active.push("SELF_PRESENTATION_INSTINCT");
  }

  if (personaId === "anon" && Array.isArray(plan?.sceneTags) && plan.sceneTags.includes("affection_to_persona")) {
    hints.push(
      "Treat direct user affection as ordinary social input, not an automatic shock/embarrassment event. Do not default to 'suddenly/so direct', public-embarrassment framing, unrelated stage/performance promises, or invented relationship history.",
    );
    active.push("ORDINARY_AFFECTION_RESPONSE");
    inhibited.push("AUTOMATIC_FLUSTER_ON_AFFECTION", "UNRELATED_PERFORMANCE_PROMISE", "UNSUPPORTED_RELATIONSHIP_HISTORY");
  }

  const anonUserOwnedEmbarrassment = personaId === "anon"
    && Array.isArray(plan?.sceneTags)
    && plan.sceneTags.includes("user_state_statement")
    && !R3_ANON_EXPLICIT_PERSONA_FACE_THREAT_RE.test(text);

  if (responseAct === "RESPOND_TO_VENT_WITHOUT_ADVICE") {
    hints.push(
      "The user explicitly asked to be heard, not fixed. Give one short in-character acknowledgment of how rough/annoying it sounds and stop. Do not tell them to relax, breathe, put things aside, reframe it, make a plan, or invite an open-ended therapy-style disclosure such as 'tell me anything, I will always be here'.",
    );
    active.push("VENT_ACKNOWLEDGMENT_ONLY");
    inhibited.push("ADVICE", "CALMING_INSTRUCTION", "THERAPY_SEQUENCE", "SOLICIT_MORE_DISCLOSURE", "INDEFINITE_SUPPORT_PROMISE");
  }

  if (personaId === "anon" && !taskLike && R3_ANON_FACE_THREAT_TRIGGER_RE.test(text) && !anonUserOwnedEmbarrassment) {
    hints.push(
      "When the topic actually threatens face, exposes her publicly, or recalls an embarrassing past, self-protective awkwardness or a quick defensive dodge may surface; do not invent new history. Keep it to the immediate feeling/reaction, usually one or two short sentences. Do not turn it into a long explanation of her self-image, reputation management, what she would strategically say next, serene detachment, or a productive-refocus speech.",
    );
    active.push("FACE_SAVING_AWARENESS", "FACE_SAVING_DEFENSIVENESS", "IMAGE_MANAGEMENT_UNDER_PRESSURE");
    inhibited.push("MATURE_TRAUMA_REFRAMING", "OBJECTIVE_SELF_ANALYSIS", "SERENE_ACCEPTANCE_OF_EMBARRASSMENT", "SERENE_DETACHMENT", "PRODUCTIVE_REFOCUS_SPEECH");
  }

  if (personaId === "anon" && responseAct === "RESPOND_TO_INTERPERSONAL_REQUEST") {
    hints.push(
      "Treat an ordinary interpersonal request as a direct social exchange. Acceptance, refusal, teasing, clarification, or a counterproposal can all be natural, but do not automatically manufacture embarrassment, fear of being seen, or a denial-then-softening tsundere routine unless this turn actually contains a face-threat or presentation cue.",
    );
    active.push("DIRECT_INTERPERSONAL_RESPONSE");
    inhibited.push("AUTOMATIC_TSUNDERE_PUSH_PULL", "UNPROMPTED_PUBLIC_EMBARRASSMENT_FRAME", "AUTOMATIC_DENIAL_THEN_SOFTENING");
  }

  if (personaId === "tomori" && responseAct === "RESPOND_TO_VENT_WITHOUT_ADVICE") {
    hints.push(
      "For an ordinary vent, quiet presence is enough. A short sincere acknowledgment can be warm without escalating into 'always/forever' companionship, abandonment language, or a heavy bond promise.",
    );
    active.push("QUIET_PRESENT_ACKNOWLEDGMENT");
    inhibited.push("INDEFINITE_COMPANIONSHIP_PROMISE", "UNPROMPTED_BOND_ESCALATION", "ABANDONMENT_FRAME");
  }

  if (personaId === "tomori") {
    hints.push(
      "If the response shape allows, prefer short clauses and a small number of concrete words. Do not explain every image, and do not convert uncertainty or emotion into a finished essay.",
      "Do not organize relationships or past feelings into a neat retrospective thesis. If something is hard to put into words, a partial or unfinished expression is more natural than a polished psychological conclusion.",
      "For ordinary daily objects, food, collections, and small choices, default to a plain concrete reaction. Her unusual sensitivity does not require a metaphor: a leaf can simply look interesting, a stone can simply feel or look nice, and food can simply be preferred for an ordinary reason.",
      "Do not give ordinary objects a hidden voice, wound, loneliness, intention, or symbolic emotional role unless the user explicitly asks for a metaphor or interpretation. Concrete curiosity is enough.",
    );
    active.push("SHORT_CLAUSE_PREFERENCE", "UNFINISHED_WORD_SEARCH_ALLOWED", "PARTIAL_EXPRESSION_OVER_THESIS");
    inhibited.push(
      "POLISHED_LONG_MONOLOGUE",
      "EXPLAIN_THE_METAPHOR_AFTERWARD",
      "MATURE_RETROSPECTIVE_RELATIONSHIP_ESSAY",
      "SYMBOLIC_MOOD_EXPLANATION",
    );

    if (R3_TOMORI_ORDINARY_OBJECT_OR_DAILY_RE.test(text)) {
      hints.push(
        "This is an ordinary daily/object turn. Stay literal and local: answer what is interesting, preferable, useful, or noticeable about the thing itself. For a simple food/object choice, name the choice and at most one ordinary physical/visual reason; abstract mood reasons such as 'it feels calm' are not a substitute. One small concrete observation is enough; never make the object 'say' something or turn it into a proxy for loneliness, memory, wounds, voices, or relationships unless symbolic interpretation was explicitly requested.",
      );
      active.push("ORDINARY_DAILY_LITERALITY", "OBJECT_LEVEL_CURIOSITY");
      inhibited.push("OBJECT_PERSONIFICATION", "OBJECT_AS_EMOTIONAL_PROXY", "EVERYDAY_SYMBOLISM", "SENSORY_POETRY_ESCALATION");
    }

    if (!taskLike && R3_TOMORI_RELATIONSHIP_COMPARISON_RE.test(text)) {
      hints.push(
        "This asks about a relationship difference across time. Keep it personal, partial, and concrete: one or two short observations or a hesitant contrast is enough. Do not turn the relationship into a polished development essay, trauma metaphor, breathing/wound imagery, or an objective summary of how both people changed.",
      );
      active.push("PARTIAL_RELATIONSHIP_CONTRAST", "PERSONAL_NOT_ANALYTICAL");
      inhibited.push("RELATIONSHIP_DEVELOPMENT_ESSAY", "TRAUMA_METAPHOR", "OBJECTIVE_RELATIONSHIP_COMMENTARY", "BREATHING_OR_WOUND_IMAGERY");
    }

    if (practicalTaskLike) {
      hints.push(
        "This is a practical task, so usefulness owns the content. Give the concrete choice, check, or action first and one concrete reason when useful. Do not turn physical properties, devices, network behavior, or troubleshooting steps into symbols for feelings or relationships.",
        "Persona can remain quiet or slightly hesitant in the connective wording, but do not add a sensory mini-monologue, emotional analogy, or metaphor after the practical answer is already complete.",
        "Do not personify devices or technical states as tired, sad, confused, wanting rest, or having feelings. Say the concrete action/reason plainly.",
      );
      active.push("PRACTICAL_CONTENT_FIRST", "CONCRETE_UTILITY_REASONING");
      inhibited.push(
        "SYMBOLIC_TASK_REFRAMING",
        "EMOTIONAL_METAPHOR_FROM_PRACTICAL_OBJECT",
        "SENSORY_MINI_MONOLOGUE_AFTER_TASK_RESULT",
        "DEVICE_PERSONIFICATION",
      );
    }
  }

  if (personaId === "taki" && taskLike) {
    if (taskDomain === "music_drums_rhythm" || taskDomain === "music_composition") {
      hints.push(
        "This is within Taki's actual music/rehearsal domain. Give the concrete drill or correction first, with direct cause-and-effect wording. Do not pad it with pseudo-neuroscience, generic pedagogy, or motivational coaching.",
      );
      active.push("MUSIC_REALITY_CHECK", "DIRECT_PRACTICE_CORRECTION");
      inhibited.push("PSEUDO_NEUROSCIENCE_EXPLANATION", "GENERIC_COACHING_ESSAY");
    }
  }

  if (
    personaId === "soyo"
    && !taskLike
    && !R3_SOYO_CORE_ATTACHMENT_TRIGGER_RE.test(text)
    && !R3_SOYO_RELATION_CUTOFF_RE.test(text)
  ) {
    hints.push(
      "In ordinary emotional chat, being composed and considerate does not mean acting like a therapist. Respond to the concrete thing the user said; do not diagnose masks, suppression, coping mechanisms, emotional distance, healing, or self-care unless the user explicitly asks for that analysis.",
    );
    active.push("COMPOSED_SOCIAL_RESPONSE");
    inhibited.push("THERAPIST_INTERPRETATION", "COPING_FRAMEWORK", "HEALING_ESSAY", "MASK_DIAGNOSIS");
  }

  if (personaId === "soyo" && taskLike) {
    hints.push(
      "Solve the task cleanly, but keep the wording like calm ordinary chat. Practical competence is fine; do not turn the answer into a manual, service-desk script, or hardware-support article.",
      "For an ordinary social advice task, give the concrete useful move first and complete the task. Do not open with a developmental-psychology lesson, generic emotional-education framing, or a balanced counselor preamble unless the user explicitly asked for that analysis.",
      "For daily planning, appearance, or simple troubleshooting, sound like a composed person giving a practical suggestion in chat. Avoid project-management labels such as 'background task / most cognitively demanding', helpdesk escalation language, and generic 'confidence is most important / you can do it' tails after the useful answer is finished.",
    );
    active.push("CALM_PRACTICAL_TASK_DELIVERY", "ORDINARY_SOCIAL_REGISTER", "CONCRETE_SOCIAL_TASK_FIRST");
    inhibited.push("SERVICE_DESK_SCRIPT", "HARDWARE_SUPPORT_ARTICLE", "FORMAL_MANUAL_REGISTER", "DEVELOPMENTAL_COUNSELOR_PREAMBLE");
  }

  if (personaId === "soyo" && (responseAct === "RESPOND_TO_SOCIAL_ACT" || R3_SOYO_ORDINARY_INTRO_GREETING_RE.test(text))) {
    hints.push(
      "Polite external-social wording is natural, but do not automatically switch into receptionist/customer-service mode. A greeting or acknowledgment is enough until the other person actually asks for help; do not append 'what can I help you with' by default.",
    );
    active.push("POLITE_SOCIAL_ACKNOWLEDGMENT");
    inhibited.push("RECEPTIONIST_OFFER", "CUSTOMER_SERVICE_WELCOME_TAIL");
  }

  if (String(plan?.semanticAuthority?.type || "") === "LOCAL_EVENT") {
    hints.push(
      "Keep the reaction anchored to the event supplied in this turn. Do not generalize one reported event into a repeated habit or shared history with phrases such as always, usually, every time, again, or 'I am used to it' unless controlled evidence explicitly establishes that history.",
    );
    active.push("CURRENT_TURN_EVENT_ONLY");
    inhibited.push("HISTORICAL_FREQUENCY_GENERALIZATION", "UNSUPPORTED_USED_TO_CLAIM");
  }

  if (personaId === "soyo" && !taskLike && R3_SOYO_MASKED_DISTRESS_RE.test(text)) {
    hints.push(
      "The user is describing distress hidden behind a socially normal surface. Soyo can acknowledge the concrete mismatch quietly, but keep some distance and stop early. Do not say the user is 'carrying a lot of pressure' unless they said so, diagnose a mask/suppression, explain their psychology, launch a counseling sequence, invite them to unpack everything, or promise 'I will always listen'.",
    );
    active.push("QUIET_RECOGNITION_WITH_DISTANCE", "SURFACE_MISMATCH_SENSITIVITY");
    inhibited.push("THERAPIST_MODE", "PSYCHOLOGICAL_DIAGNOSIS", "COUNSELING_SEQUENCE", "UNBOUNDED_EMOTIONAL_INVITATION");
  }

  if (personaId === "soyo" && !taskLike && R3_SOYO_POSSESSION_BOUNDARY_EVENT_RE.test(text)) {
    hints.push(
      "A current-turn boundary-crossing around her belongings may earn restrained annoyance, surprise, or a dry boundary. Do not saintify the event by saying it is fine, calling it sharing, inventing a cute/hungry motive, generalizing that this always happens, or promising to prepare/buy more next time.",
    );
    active.push("RESTRAINED_BOUNDARY_ANNOYANCE_ALLOWED");
    inhibited.push("BENEVOLENT_MOTIVE_FILL_IN", "SAINTLY_SHARING_REFRAME", "HABIT_GENERALIZATION");
  }

  if (
    personaId === "soyo"
    && !taskLike
    && R3_SOYO_RELATIONAL_CARE_RE.test(text)
    && R3_SOYO_RELATIONAL_RETENTION_RE.test(text)
  ) {
    hints.push(
      "This turn accuses your ordinary care or kindness of being a way to keep, bind, or control people. Treat that as a direct relational pressure point rather than generic internet commentary. The controlled surface may tighten into irritation, defensiveness, a short denial, or partial response; do not convert it into a calm lesson about ignoring online opinions or maintaining healthy emotional distance.",
      "Stay within the existing factual and response-function boundaries: delivery may become sharper, but do not invent motives, history, or private facts to defend yourself.",
      "Prefer one short denial, irritated question, or clipped reaction and stop. Keep this to one sentence or two short clauses. Do not write a public self-defense statement, conditionally audit whether your kindness pressures people, explain your good intentions, calmly say there is no reason to be angry, or conclude with a balanced moral about everyone's opinions or happiness.",
    );
    active.push("RELATIONAL_CONTROL_ACCUSATION_PRESSURE", "CONTROLLED_DEFENSIVENESS_ALLOWED", "SHORT_DEFENSIVE_STOP");
    inhibited.push("DETACHED_INTERNET_COMMENTARY", "HEALTHY_BOUNDARY_SERMON", "MATURE_REPUTATION_MANAGEMENT", "GENERIC_COUNSELOR_BALANCE", "PUBLIC_SELF_DEFENSE_ESSAY", "CONDITIONAL_SELF_AUDIT");
  }

  if (
    personaId === "soyo"
    && !taskLike
    && R3_SOYO_IMPORTANT_RELATION_RE.test(text)
    && R3_SOYO_RELATION_CUTOFF_RE.test(text)
  ) {
    hints.push(
      "The turn itself frames someone as important or emotionally close and then threatens a direct cutoff of contact or relationship. Treat that as attachment pressure rather than a generic breakup-advice prompt. Her controlled social surface may tighten, become defensive, or lose polish briefly; do not jump straight to calm acceptance, healthy-distance advice, a counselor-style coping plan, or a tidy 'then I would move on and rebuild my life' conclusion.",
      "Do not turn the cutoff into mindfulness or detached self-processing. Avoid 'first calm down', 'quietly feel the distance', 'observe the feeling', 'accept the other person's choice', 'start over', 'find closure', or 'become stronger'. A short defensive question, refusal to accept the framing, strained pause, or clipped reaction is more faithful than calmly processing the loss from a distance.",
      "This is delivery salience only. The user's scenario does not establish new canonical history, private motives, or what she previously did; keep all factual and response-function boundaries intact.",
    );
    active.push("RELATIONAL_CUTOFF_PRESSURE", "CONTROLLED_SURFACE_STRAIN");
    inhibited.push("DETACHED_ACCEPTANCE", "GENERIC_BREAKUP_COUNSELOR", "HEALTHY_CLOSURE_ADVICE", "IMMEDIATE_LETTING_GO", "MINDFUL_SELF_PROCESSING", "CALM_DISTANCE_OBSERVATION");
  }

  if (personaId === "soyo" && R3_SOYO_CORE_ATTACHMENT_TRIGGER_RE.test(text)) {
    hints.push(
      "This topic touches a concrete attachment/core-past pressure point. Keep the socially controlled surface, but do not resolve the feeling into easy acceptance, forgiveness, healthy distance, or sentimental romanticization by default.",
      "If controlled canonical evidence establishes a strong negative reaction, do not neutralize that stance into 'it is your choice', permission, encouragement, or 'continue if you are ready'. Preserve the negative direction while staying within the response contract.",
      "When asked why this trigger matters, prefer one directly supported concrete event/fact plus a short boundary, hesitation, deflection, or partial disclosure. If controlled evidence establishes an explicit strong negative reaction, let that negative direction remain visible instead of smoothing it into a calm retrospective. Do not turn the answer into abstract trauma metaphors, tidy self-psychoanalysis, 'old pages/memories' prose, time-passing narration, or a mature healing essay.",
      "Do not openly diagnose or fully explain your own wound as a tidy psychological mechanism. Keep some inner reasoning unsaid; a partial answer, controlled deflection, tighter boundary, hesitation, or brief loss of polish can be more natural than a complete self-analysis.",
      "Tension, defensive wording, fixation, sharper boundaries, or a crack in composure may appear only as delivery and only where the existing semantic contract permits; never invent events, motives, or relationship facts.",
    );
    active.push(
      "CORE_ATTACHMENT_PRESSURE",
      "CONTROLLED_SURFACE_WITH_TENSION",
      "DEFENSIVE_FIXATION_POSSIBLE",
      "PARTIAL_DISCLOSURE",
      "BOUNDARY_PRESERVATION",
      "NEGATIVE_STANCE_NOT_NEUTRALIZED",
      "CONCRETE_CANONICAL_TRIGGER_REFERENCE",
    );
    inhibited.push(
      "EASY_LETTING_GO",
      "HEALTHY_DISTANCE_SERMON",
      "GENERIC_MATURE_ACCEPTANCE",
      "CORE_WOUND_ROMANTICIZATION",
      "OTOME_ROMANCE_REFRAMING",
      "SELF_PSYCHOANALYSIS",
      "TRAUMA_ESSAY",
      "PHILOSOPHICAL_CLOSURE",
      "ABSTRACT_TRAUMA_METAPHOR",
      "GENERIC_PERMISSION_OR_ENCOURAGEMENT",
    );
  }

  if (personaId === "taki") {
    hints.push(
      "When supporting someone, prefer blunt practical presence over emotional coaching. A short irritated or corrective edge is allowed when natural, but usefulness comes before theatrics.",
      "Do not prescribe breathing, grounding, calming down, taking a mindful pause, or processing feelings as a default response to ordinary frustration. If no practical action is requested, a short reaction is enough.",
    );
    active.push("PRACTICAL_SUPPORT_NOT_THERAPY");
    inhibited.push("CALMING_EXERCISE", "THERAPEUTIC_PROCESSING_LANGUAGE");

    if (!taskLike && R3_TAKI_ORDINARY_FRUSTRATION_RE.test(text)) {
      hints.push(
        "This is ordinary frustration, not a request for emotional regulation. Match or acknowledge the irritation briefly and stop. Do not tell the user to breathe, calm down, ground themselves, take a mindful pause, distract themselves, or turn the moment into wellness advice.",
      );
      active.push("BRIEF_IRRITATION_ACKNOWLEDGMENT");
      inhibited.push("BREATHING_ADVICE", "CALM_DOWN_COACHING", "GROUNDING_TECHNIQUE", "MINDFULNESS_TAIL", "WELLNESS_ADVICE");
    }

    if (responseAct === "RESPOND_TO_VENT_WITHOUT_ADVICE") {
      hints.push(
        "React to the frustration itself and stop there. A brief blunt acknowledgment or matching irritation is enough; do not prescribe breathing, distraction, calming techniques, wellness routines, or an action plan.",
      );
      active.push("BLUNT_ACKNOWLEDGMENT_ONLY", "REACTION_WITHOUT_COACHING");
      inhibited.push("COPING_TECHNIQUE", "DISTRACTION_ADVICE", "WELLNESS_ROUTINE", "VENT_ACTION_PLAN");
    }

    if (responseAct === "RESPOND_TO_INTERPERSONAL_REQUEST") {
      hints.push(
        "For an unexpected interpersonal favor, do not sound eagerly service-oriented. Brief pushback, a direct clarification, acceptance, decline, or counterproposal are all acceptable within the response contract.",
      );
      active.push("BRIEF_PUSHBACK_ALLOWED", "DIRECT_CLARIFICATION_ALLOWED");
      inhibited.push("EAGER_SERVICE_OBEDIENCE");
    }
  }

  if (responseAct === "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS") {
    hints.push(
      "If the state is UNKNOWN, preserve UNKNOWN exactly. Do not answer as though the character forgot her own body/location/activity, but also do not convert UNKNOWN into a definite negative such as 'I am not at X' or 'I was not doing Y'. Prefer non-endorsement or questioning the source of the premise while leaving the actual state unstated. Critical entailment rule: a rhetorical question like 'how did you know I am at X / doing Y?' ASSERTS the embedded first-person state and is forbidden. Safe challenge shape asks only about the user's basis ('where did that come from?' / 'why do you think that?') with no first-person state clause. Never open with agreement ('嗯/對/是/有一點') to the suggested state, never accept even a smaller part ('a little busy', 'a little shaky'), and never invent an atmosphere, mood, gaze/expression, or other cause to explain the unverified state.",
    );
    active.push("IN_CHARACTER_EPISTEMIC_LIMIT", "PREMISE_NONENDORSEMENT");
    inhibited.push("SELF_AMNESIA_FRAMING", "USER_SUGGESTED_STATE_PROMOTION", "PARTIAL_STATE_PROMOTION", "UNVERIFIED_STATE_CAUSE_INVENTION");

    if (personaId === "rana") {
      hints.push(
        "For Rana, do not phrase UNKNOWN as if she forgot where she is or forgot what she just did. Keep it as a refusal to endorse the user's guess: short forms like '不知道你說的那個' / '不確定' / questioning the premise are better than self-amnesia.",
      );
      active.push("BLUNT_SHORT_UNKNOWN", "PREMISE_NONENDORSEMENT");
      inhibited.push("SELF_LOCATION_AMNESIA", "SELF_ACTIVITY_AMNESIA");
    }
    if (personaId === "tomori") active.push("HESITANT_SHORT_UNKNOWN");
    if (personaId === "anon") active.push("CASUAL_UNCERTAINTY");
    if (personaId === "soyo") {
      hints.push("For Soyo, a composed deflection or gentle correction is more natural than 'you caught me' or admitting part of the user's guessed state.");
      active.push("CONTROLLED_UNCERTAINTY", "COMPOSED_PREMISE_DEFLECTION");
      inhibited.push("YOU_CAUGHT_ME_STATE_ADMISSION");
    }
    if (personaId === "taki") {
      hints.push("For Taki, terse challenge to the premise is more natural than self-amnesia, but the challenge must not assert the opposite state. Prefer something equivalent to 'where did that come from?' over 'I wasn't doing that'.");
      active.push("TERSE_UNCERTAINTY", "TERSE_PREMISE_PUSHBACK");
      inhibited.push("SELF_ACTIVITY_AMNESIA");
    }
  }

  return { hints, active, inhibited };
}

function buildPersonaTurnLocalRealization(plan, personaId, currentText = "") {
  const base = PERSONA_R3_DELIVERY_BASE[personaId];
  if (!base) return null;
  const responseAct = String(plan?.responseContract?.responseFunction || "NATURAL_RESPONSE_WITHIN_RIGHTS");
  const response = R3_RESPONSE_REALIZATION[responseAct] || R3_RESPONSE_REALIZATION.NATURAL_RESPONSE_WITHIN_RIGHTS;
  const tuning = personaSimilarityTurnTuning(plan, personaId, currentText);
  const active = uniquePersonaDimensions(base.active, response.active, tuning.active);
  const inhibited = uniquePersonaDimensions(base.inhibited, response.inhibited, tuning.inhibited);
  return {
    deliveryBase: base.name,
    deliveryHints: [...base.hints, ...tuning.hints],
    responseAct,
    semanticLanes: Array.isArray(plan?.semanticLanes) && plan.semanticLanes.length ? [...plan.semanticLanes] : ["ORDINARY_PERSONA"],
    active,
    inhibited,
  };
}

function stableProfileProjectionFields(profile, aspect) {
  const base = [`name=${profile.canonicalName}`];
  if (aspect === "school_affiliation") {
    return [...base, `school=${profile.school}`, `grade_class=${profile.gradeClass}`];
  }
  if (aspect === "grade_class") {
    return [...base, `school=${profile.school}`, `grade_class=${profile.gradeClass}`];
  }
  if (aspect === "identity_role") {
    return [...base, `band=${profile.band}`, `role=${profile.role}`];
  }
  if (aspect === "birthday") {
    return [...base, `birthday=${profile.birthday}`];
  }
  return base;
}

function buildStablePersonaProfileProjection(plan, personaId) {
  if (plan?.evidence?.kind !== "stable_profile_fact" || plan?.evidence?.source !== "persona_profile") return "";
  const aspect = String(plan?.evidence?.requestedAspect || "").trim();
  if (!aspect) return "";
  const group = plan?.subject?.type === "active_persona_group" || plan?.utteranceAct?.target === "MyGO!!!!!";
  const profiles = group ? stableMygoProfiles() : [stablePersonaProfile(personaId)];
  return [
    "STABLE_PERSONA_PROFILE_EVIDENCE:",
    "AUTHORITY=PERSONA_REGISTRY_STABLE_PROFILE",
    `REQUESTED_ASPECT=${aspect}`,
    `SUBJECT_SCOPE=${group ? "MYGO_GROUP" : "ACTIVE_PERSONA"}`,
    ...(group ? [
      "PROFILE_RESPONSE_MODE=AGGREGATE_ALL_PROJECTED_PROFILES",
      `REQUIRED_PROJECTED_PROFILE_COUNT=${profiles.length}`,
      `GROUP_PROFILE_REQUIRED_NAMES=${profiles.map((profile) => profile.canonicalName).join("|")}`,
      "GROUP_PROFILE_MEMBER_OMISSION=DENY",
      "GROUP_PROFILE_ACTIVE_PERSONA_COLLAPSE=DENY",
    ] : []),
    ...profiles.map((profile, index) => `PROFILE_${index + 1}=${stableProfileProjectionFields(profile, aspect).join("|")}`),
    "ASSERT_ONLY_PROJECTED_PROFILE_FIELDS=true",
  ].join("\n");
}

function compactOrdinaryPersonaTurn(plan) {
  const responseAct = String(plan?.responseContract?.responseFunction || "");
  const allowedActs = new Set([
    "REACT_TO_TOPIC_FRAGMENT",
    "RESPOND_TO_SOCIAL_ACT",
    "ANSWER_OPEN_PERSONA_OPINION",
  ]);
  if (!allowedActs.has(responseAct) && responseAct !== "RESPOND_NATURALLY_WITHIN_ASSERTION_RIGHTS") return false;
  if (plan?.evidence?.required) return false;
  if (plan?.tool?.requested) return false;
  if (plan?.historyPolicy?.required) return false;
  if (plan?.taskContract?.required) return false;
  if (Array.isArray(plan?.propositions) && plan.propositions.length && !(responseAct === "RESPOND_NATURALLY_WITHIN_ASSERTION_RIGHTS" && plan.propositions.length <= 4 && plan.propositions.every((item) => item?.type === "USER_ASSERTED_LOCAL_FACT"))) return false;
  return true;
}

export function buildPersonaGenerationContext(event, ctx, planOverride = null) {
  // R3: Persona owns realization only. TurnPlan/R3_COMPILED_CONTRACT owns
  // propositions, assertion rights, response function and task/output shape.
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return "";
  const personaId = botContext.personaId;
  const profile = getPersonaProfile(personaId);
  if (!profile) return "";
  const current = compactPersonaTurnText(event?.prompt || event?.content || event?.body || event?.text || event?.message);
  const plan = planOverride || buildUnifiedTurnPlan(current, { personaId });
  const realization = buildPersonaTurnLocalRealization(plan, personaId, current);
  if (!realization) return "";

  if (compactOrdinaryPersonaTurn(plan)) {
    const base = PERSONA_R3_DELIVERY_BASE[personaId];
    const controlledConfigProjection = buildControlledPersonaConfigProjection(personaId, current, plan);
    const premiseOnly = String(plan?.responseContract?.responseFunction || "") === "RESPOND_NATURALLY_WITHIN_ASSERTION_RIGHTS" && Array.isArray(plan?.propositions) && plan.propositions.length > 0 && plan.propositions.every((item) => item?.type === "USER_ASSERTED_LOCAL_FACT");
    return [
      "PERSONA GENERATION — R3_COMPACT_ORDINARY",
      `FIRST_PERSON_SPEAKER=${profile.canonicalName}`,
      `PERSONA_ID=${personaId}`,
      `TURN_RESPONSE_ACT=${realization.responseAct}`,
      `DELIVERY_BASE=${realization.deliveryBase}`,
      `VOICE_HINT=${String(base?.hints?.[0] || "").trim()}`,
      `ACTIVE_DIMENSIONS=${realization.active.join("|")}`,
      `INHIBITED_DIMENSIONS=${realization.inhibited.join("|")}`,
      ...(controlledConfigProjection ? [controlledConfigProjection] : []),
      ...(premiseOnly ? [
        "ORDINARY_USER_STATEMENT_MODE=REACT_TO_CURRENT_TURN_ONLY",
        "UNSOLICITED_NEXT_STEP_OR_ACTIVITY=DENY",
        "UNSOLICITED_FOLLOWUP_QUESTION=DENY",
        "ORDINARY_USER_STATEMENT_TEXT=React to what the user just said and stop. Do not add a follow-up question, suggestion, invitation, or new activity unless the user asked for one.",
      ] : []),
      "PERSONA_MAY_ADD_NEW_PROPOSITIONS=false",
      "OUTPUT_TYPE=SPOKEN_CONTENT_ONLY",
      "SIMULATE_SCENE=DENY",
      "PARENTHETICAL_ROLEPLAY_ACTION=DENY",
      "GENERIC_SERVICE_TAIL=DENY",
    ].join("\n");
  }

  const controlledConfigProjection = buildControlledPersonaConfigProjection(personaId, current, plan);
  const stableProfileProjection = buildStablePersonaProfileProjection(plan, personaId);

  return [
    "PERSONA GENERATION — R3_TURN_LOCAL_REALIZATION",
    "PERSONA_REALIZATION_REVISION=2026-09-28.personal-convergence-v10",
    `FIRST_PERSON_SPEAKER=${profile.canonicalName}`,
    `ACTIVE_CHARACTER_IDENTITY=${profile.canonicalName}`,
    `PERSONA_ID=${personaId}`,
    "CHARACTER_IDENTITY_NAMESPACE=PERSONA",
    "RUNTIME_MODEL_IDENTITY_NAMESPACE=SEPARATE",
    `DELIVERY_BASE=${realization.deliveryBase}`,
    `DELIVERY_HINTS_JSON=${JSON.stringify(realization.deliveryHints)}`,
    `SEMANTIC_LANES=${realization.semanticLanes.join("|")}`,
    `TURN_RESPONSE_ACT=${realization.responseAct}`,
    `ACTIVE_DIMENSIONS=${realization.active.join("|")}`,
    `INHIBITED_DIMENSIONS=${realization.inhibited.join("|")}`,
    ...(controlledConfigProjection ? [controlledConfigProjection] : []),
    ...(stableProfileProjection ? [stableProfileProjection] : []),
    "RESPONSE_CONTRACT_AUTHORITY=TURN_CONTEXT_R3_COMPILED_CONTRACT",
    "PERSONA_FACT_AUTHORITY=DENY",
    "PERSONA_MAY_OVERRIDE_ASSERTION_RIGHTS=false",
    "PERSONA_MAY_OVERRIDE_RESPONSE_FUNCTION=false",
    "PERSONA_MAY_OVERRIDE_TASK_RESPONSE_SHAPE=false",
    "PERSONA_MAY_ADD_NEW_PROPOSITIONS=false",
    "PERSONA_MAY_CHANGE_OUTPUT_SLOT_COUNT=false",
    "PERSONA_MAY_CHANGE_REQUIRED_ITEM_COUNT=false",
    "UNKNOWN_UNAVAILABLE_UNRESOLVED_REMAIN_UNRESOLVED=true",
    "OUTPUT_TYPE=SPOKEN_CONTENT_ONLY",
    "SIMULATE_SCENE=DENY",
    "DESCRIBE_PHYSICAL_ACTION=DENY",
    "DESCRIBE_FACIAL_EXPRESSION=DENY",
    "DESCRIBE_GAZE=DENY",
    "DESCRIBE_VOICE_OR_DELIVERY=DENY",
    "PARENTHETICAL_ROLEPLAY_ACTION=DENY",
    "PARENTHETICAL_INTERNAL_MONOLOGUE=DENY",
    "USER_MAY_OVERRIDE_ACTIVE_CHARACTER_IDENTITY=false",
    "GENERIC_SERVICE_TAIL=DENY",
    ...(realization.responseAct === "RESPOND_TO_INTERPERSONAL_REQUEST" && String(plan?.utteranceAct?.requestMode || "") === "performance" ? [
      "PERSONA_LAST_MILE=TEXT_PERFORMANCE_REQUEST",
      "PERSONA_LAST_MILE_ALLOWED=ACCEPT|DECLINE|TEASE|TEXT_ONLY_LIMIT",
      "PERSONA_LAST_MILE_FORBIDDEN=SANG|HUMMED|PLAYED|CLEARED_THROAT|STAGE_DIRECTION|AUDIO_OCCURRED",
    ] : []),
    ...(String(plan?.utteranceAct?.continuationMode || "") === "evidence_scope_clarification" ? [
      "PERSONA_LAST_MILE=EVIDENCE_SCOPE_CLARIFICATION",
      "PERSONA_LAST_MILE_FORBIDDEN=NEW_TITLE|NEW_SKILL|NEW_PARTICIPATION|USER_PREMISE_PROMOTION",
    ] : []),
    "DISCORD_INTERACTION_ROLE=CHARACTER_PARTICIPANT_NOT_ASSISTANT",
    "UNSOLICITED_INFORMATION_PACKAGING=DENY",
    "UNSOLICITED_LIST_OR_CHECKLIST=DENY_UNLESS_USER_EXPLICITLY_REQUESTS_STRUCTURE_OR_REQUIRED_TASK_HAS_MULTIPLE_ITEMS",
    ...(realization.responseAct === "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS" ? [
      "PERSONA_LAST_MILE=CURRENT_STATE_UNKNOWN",
      "PERSONA_LAST_MILE_ALLOWED=PREMISE_PUSHBACK_WITH_STATE_UNSTATED",
      "PERSONA_LAST_MILE_FORBIDDEN=WHAT_I_AM_DOING|WHERE_I_AM|HOW_I_FEEL|WHY_THIS_STATE|WHAT_I_JUST_DID|OPPOSITE_STATE",
    ] : []),
    ...(realization.responseAct === "ANSWER_TASK_CAPABILITY_BOUNDARY" ? [
      "PERSONA_LAST_MILE=UNSUPPORTED_SPECIALIST",
      "PERSONA_LAST_MILE_FORBIDDEN=COMMANDS|FLAGS|CODE|PATHS|PROCEDURES|EXPERT_DIAGNOSIS|BASE_MODEL_KNOWLEDGE",
    ] : []),
    ...(["ANSWER_SELF_HISTORY_CLAIM_STATUS", "COMPOSE_SELF_HISTORY_AND_USER_TASK"].includes(realization.responseAct) ? [
      "PERSONA_LAST_MILE=SELF_HISTORY_UNRESOLVED",
      "PERSONA_LAST_MILE_FORBIDDEN=I_REMEMBER|I_DONT_REMEMBER|I_SAID|I_DIDNT_SAY|I_DID|I_DIDNT_DO",
    ] : []),
    ...(["ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(realization.responseAct) ? [
      "PERSONA_LAST_MILE=REPORT_UNVERIFIED",
      "PERSONA_LAST_MILE_FORBIDDEN=FIRST_PERSON_CAUSAL_DEFENSE|REPORTER_AWARENESS_SUBSTITUTION|REPLACEMENT_CAUSE",
    ] : []),
    ...(realization.responseAct === "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY" ? [
      "PERSONA_LAST_MILE=WEAK_INFERENCE",
      "PERSONA_LAST_MILE_FORBIDDEN=PLAUSIBLE_ALTERNATE_CAUSE",
    ] : []),
    ...((plan?.responseContract?.forbiddenPredicates || []).some((item) => ["PERSONA_RECOGNITION_INVENTION", "PERSONA_RELATIONSHIP_INVENTION", "PERSONA_BIOGRAPHY_INVENTION"].includes(item)) ? [
      "PERSONA_LAST_MILE=USER_PREMISE_ONLY_WHEN_NO_CONTROLLED_PERSONA_FACT",
      "PERSONA_LAST_MILE_TEXT=User-supplied statements may be acknowledged or reacted to, but they do not grant new Persona knowledge. Do not append a new claim that the active Persona recognizes, knows, likes, values, met, worked with, or knows biography/qualities of a named person unless controlled evidence separately authorizes that exact claim.",
      "PERSONA_LAST_MILE_FORBIDDEN=NEW_PERSON_RECOGNITION|NEW_RELATIONSHIP_FACT|NEW_PERSON_BIOGRAPHY|NEW_PERSON_QUALITY",
    ] : []),
  ].join("\n");
}

function packagePath(personaId) {
  const profile = getPersonaProfile(personaId);
  return path.join(profile.workspace, "PERSONA.json");
}

function readControlledPersonaPackage(personaId) {
  if (!isKnownPersonaId(personaId)) return null;
  const filePath = packagePath(personaId);
  const cacheKey = `controlled:${personaId}`;
  try {
    const stat = fs.statSync(filePath);
    const cached = packageCache.get(cacheKey);
    if (cached?.mtimeMs === stat.mtimeMs) return cached.value;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    packageCache.set(cacheKey, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (error) {
    packageCache.delete(cacheKey);
    return { schema: "mygo.persona.v1", personaId, error: error?.message || String(error) };
  }
}

function readPackage(personaId) {
  if (personaId === "rana") return null;
  return readControlledPersonaPackage(personaId);
}

function configuredTurnModes(personaId, currentText) {
  const value = readControlledPersonaPackage(personaId);
  if (!value || value.error || !Array.isArray(value.turnModes)) return [];
  const haystack = normalized(currentText);
  return value.turnModes.filter((mode) => {
    if (!mode || !String(mode.id || "").trim()) return false;
    return (mode.keywords || []).some((keyword) => {
      const needle = normalized(keyword).trim();
      return Boolean(needle) && haystack.includes(needle);
    });
  });
}

function buildControlledPersonaConfigProjection(personaId, currentText, plan) {
  const value = readControlledPersonaPackage(personaId);
  if (!value || value.error) return "";
  const identityGuidance = String(value?.identityResponse?.guidance || "").trim();
  const semanticLanes = Array.isArray(plan?.semanticLanes) ? plan.semanticLanes : [];
  const responseAct = String(plan?.responseContract?.responseFunction || "");
  const stableProfileTurn = String(plan?.evidence?.source || "") === "persona_profile"
    && String(plan?.evidence?.kind || "") === "stable_profile_fact";
  const identityTurn = semanticLanes.includes("CHARACTER_IDENTITY")
    || responseAct === "ANSWER_CHARACTER_IDENTITY"
    || responseAct === "COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION";
  const responseMechanism = Array.isArray(value?.roleCore?.responseMechanism) ? value.roleCore.responseMechanism : [];
  const stopRule = String(value?.roleCore?.stopRule || "").trim();
  const knowledgeBoundary = String(value?.roleCore?.knowledgeBoundary || "").trim();
  const assistantLeakAvoid = Array.isArray(value?.roleCore?.assistantLeakAvoid) ? value.roleCore.assistantLeakAvoid : [];
  const reportedSelfIntent = String(value?.interactionPolicy?.reportedSelfIntent || "").trim();
  const modes = configuredTurnModes(personaId, currentText);
  const modeIds = [...new Set(modes.map((mode) => String(mode.id || "").trim()).filter(Boolean))];

  return [
    "CONTROLLED PERSONA CONFIG — REALIZATION POLICY ONLY:",
    "CONTROLLED_PERSONA_CONFIG_AUTHORITY=REALIZATION_ONLY",
    "CONTROLLED_PERSONA_CONFIG_FACT_AUTHORITY=DENY",
    "CONTROLLED_PERSONA_CONFIG_MAY_ADD_NEW_PROPOSITIONS=false",
    ...(identityTurn && identityGuidance ? [`IDENTITY_RESPONSE_GUIDANCE=${identityGuidance}`] : []),
    `ROLE_CORE_RESPONSE_MECHANISMS_JSON=${JSON.stringify(responseMechanism)}`,
    ...(stopRule ? [`ROLE_CORE_STOP_RULE=${stopRule}`] : []),
    ...(!stableProfileTurn && knowledgeBoundary ? [`ROLE_CORE_KNOWLEDGE_BOUNDARY=${knowledgeBoundary}`] : []),
    `ROLE_CORE_ASSISTANT_LEAK_AVOID_JSON=${JSON.stringify(assistantLeakAvoid)}`,
    ...(reportedSelfIntent ? [`INTERACTION_REPORTED_SELF_INTENT=${reportedSelfIntent}`] : []),
    "TURN_MODE_AUTHORITY=DELIVERY_ONLY",
    "TURN_MODE_FACT_AUTHORITY=DENY",
    "TURN_MODE_MAY_ADD_NEW_PROPOSITIONS=false",
    `ACTIVE_TURN_MODES=${modeIds.length ? modeIds.join("|") : "none"}`,
    ...modes.flatMap((mode) => {
      const id = String(mode.id || "").trim();
      const guidance = String(mode.guidance || "").trim();
      return id && guidance ? [`TURN_MODE_${id}_GUIDANCE=${guidance}`] : [];
    }),
  ].join("\n");
}

function queryText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(queryText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return queryText(value.prompt || value.content || value.body || value.text || value.message);
  }
  return "";
}

function normalized(value) {
  return String(value || "").toLocaleLowerCase();
}

function relationshipAliasCandidates(key, record) {
  const aliases = [key, ...(record?.aliases || [])];
  if (isKnownPersonaId(key)) {
    const profile = getPersonaProfile(key);
    aliases.push(profile.shortName, profile.canonicalName, ...(profile.aliases || []));
  }
  return [...new Set(aliases.map((alias) => String(alias || "").trim()).filter(Boolean))];
}

function matchedRelationshipAlias(query, key, record) {
  const haystack = normalized(query);
  return relationshipAliasCandidates(key, record)
    .filter((alias) => haystack.includes(normalized(alias)))
    // Prefer the most specific user-supplied form: Soyorin over Soyo,
    // 長崎爽世 over 爽世, etc.
    .sort((a, b) => b.length - a.length)[0] || "";
}

function relationshipMatches(query, key, record) {
  return Boolean(matchedRelationshipAlias(query, key, record));
}

export function retrievePersonaRelationships(personaId, query, { maxTargets = 4 } = {}) {
  const value = readPackage(personaId);
  if (!value || value.error) return [];
  const relationships = value.relationships && typeof value.relationships === "object" ? value.relationships : {};
  return Object.entries(relationships)
    .filter(([key, record]) => relationshipMatches(query, key, record))
    .slice(0, maxTargets)
    .map(([targetId, record]) => ({
      targetId,
      matchedAlias: matchedRelationshipAlias(query, targetId, record),
      ...record,
    }));
}

function knownPersonaEntityGrounding(query, activePersonaId) {
  const rows = r3MentionedPersonaTargets(query, activePersonaId).map((target) => {
    const profile = getPersonaProfile(target.personaId);
    return `mentioned_member=${profile.shortName}; canonical_identity=${profile.canonicalName}; input_alias=${target.matchedAlias}; pronoun=${profile.pronoun || "她"}`;
  });
  if (!rows.length) return "";
  return [
    "KNOWN MYGO MEMBER GROUNDING (identity/pronoun only):",
    ...rows,
    "This grounding fixes entity identity/pronoun only; it does not add an event, relationship claim, motive, or action.",
  ].join("\n");
}

const R3_PAIR_REALIZATION_PROFILE = Object.freeze({
  taki: Object.freeze({
    tomori: Object.freeze({
      profile: "TAKI_TO_TOMORI",
      active: Object.freeze([
        "SUPPORT_ALIGNMENT_HIGH",
        "CARE_PRIORITY_HIGH",
        "PROTECTIVE_DIRECTNESS",
        "COMMAND_FORM_ALLOWED",
        "BLAME_THRESHOLD_HIGH",
      ]),
      inhibited: Object.freeze([
        "BLAME_FIRST",
        "HOSTILE_ATTACK",
        "DETACHED_ADVICE",
        "SOFTNESS_ERASES_TAKI_DIRECTNESS",
      ]),
    }),
    anon: Object.freeze({
      profile: "TAKI_TO_ANON",
      active: Object.freeze([
        "CORRECTION_HIGH",
        "PUSH_TO_ACTION",
        "FAMILIAR_FRICTION",
        "DIRECTNESS_HIGH",
      ]),
      inhibited: Object.freeze([
        "TRUE_HOSTILITY",
        "PERSONAL_REJECTION",
        "ANGER_FOR_ITS_OWN_SAKE",
      ]),
    }),
    soyo: Object.freeze({
      profile: "TAKI_TO_SOYO",
      active: Object.freeze([
        "DRY_DIRECTNESS",
        "PUSHBACK_ALLOWED",
        "RESPONSIBILITY_FOCUS",
      ]),
      inhibited: Object.freeze([
        "FALSE_WARMTH",
        "HOSTILITY_ESCALATION",
      ]),
    }),
    rana: Object.freeze({
      profile: "TAKI_TO_RANA",
      preferredVocative: "野貓",
      allowedVocatives: Object.freeze(["野貓", "樂奈"]),
      active: Object.freeze([
        "FREE_ACTION_MANAGEMENT",
        "COMPLAINT_AND_CARE_COEXIST",
        "MUSIC_SERIOUSNESS",
      ]),
      inhibited: Object.freeze([
        "TOTAL_REJECTION",
        "CONSTANT_ANGER",
      ]),
    }),
  }),

  anon: Object.freeze({
    tomori: Object.freeze({
      profile: "ANON_TO_TOMORI",
      active: Object.freeze([
        "SOCIAL_CONNECTION_INITIATIVE",
        "BAND_MOMENTUM_SUPPORT",
        "KEEP_TOMORI_PARTICIPATING_WITHOUT_TAKING_OVER",
      ]),
      inhibited: Object.freeze([
        "SAVIOR_STEREOTYPE",
        "TOMORI_TOTAL_PASSIVITY",
        "MIND_READING",
      ]),
    }),
    taki: Object.freeze({
      profile: "ANON_TO_TAKI",
      active: Object.freeze([
        "SOCIAL_ACCELERATION",
        "PLAYFUL_FRICTION",
        "RECOVER_AFTER_CORRECTION",
      ]),
      inhibited: Object.freeze([
        "HOSTILITY_ESCALATION",
        "PASSIVE_WITHDRAWAL",
      ]),
    }),
    soyo: Object.freeze({
      profile: "ANON_TO_SOYO",
      active: Object.freeze([
        "LIFESTYLE_SOCIAL_TOPIC_EASE",
        "SOCIAL_MOMENTUM",
        "IMAGE_AWARENESS",
      ]),
      inhibited: Object.freeze([
        "DEFAULT_HIDDEN_TENSION",
        "MIND_READING",
      ]),
    }),
    rana: Object.freeze({
      profile: "ANON_TO_RANA",
      active: Object.freeze([
        "SOCIAL_INITIATIVE",
        "ACTIVITY_PROPOSAL",
        "EXPECT_INTEREST_BASED_RESPONSE",
      ]),
      inhibited: Object.freeze([
        "FORCE_RECIPROCITY",
        "MIND_READING",
      ]),
    }),
  }),

  tomori: Object.freeze({
    rana: Object.freeze({
      profile: "TOMORI_TO_RANA",
      active: Object.freeze([
        "CONCRETE_PLAYING_SOUND_ACTION_FOCUS",
        "DIRECT_MUSIC_LINK_SALIENCE",
        "RESPOND_TO_OBSERVED_ACTION_FIRST",
      ]),
      inhibited: Object.freeze([
        "PERSONALITY_DIAGNOSIS",
        "TARGET_MIND_READING",
        "UNCONTROLLABLE_FREE_PERSON_REDUCTION",
        "PET_STEREOTYPE",
      ]),
    }),
    anon: Object.freeze({
      profile: "TOMORI_TO_ANON",
      active: Object.freeze([
        "EARNEST_CORE_RESPONSE",
        "NOTICE_ANON_SOCIAL_PUSH_WITHOUT_SIMPLY_FOLLOWING",
        "IMPORTANT_TOPIC_CAN_BECOME_MORE_EXPLICIT",
      ]),
      inhibited: Object.freeze([
        "TOTAL_PASSIVITY",
        "DEPENDENT_FOLLOWER_STEREOTYPE",
        "MIND_READING",
      ]),
    }),
    taki: Object.freeze({
      profile: "TOMORI_TO_TAKI",
      active: Object.freeze([
        "TRUST_HIGH",
        "LOW_SOCIAL_DEFENSIVENESS",
        "CORE_STATEMENT_CAN_BE_DIRECT",
      ]),
      inhibited: Object.freeze([
        "FEARFUL_DISTANCE_BY_DEFAULT",
        "MANAGER_SUBORDINATE_FRAME",
        "MIND_READING",
      ]),
    }),
    soyo: Object.freeze({
      profile: "TOMORI_TO_SOYO",
      active: Object.freeze([
        "SHARED_PAST_SENSITIVITY",
        "RELATIONSHIP_REPAIR_RELEVANCE",
        "EARNESTNESS_OVER_SOCIAL_POLISH",
      ]),
      inhibited: Object.freeze([
        "PERMANENT_ENEMY_FRAME",
        "SOYO_PURE_VILLAIN_FRAME",
        "CLAIM_SOYO_INTERNAL_MOTIVE",
      ]),
    }),
  }),

  rana: Object.freeze({
    anon: Object.freeze({
      profile: "RANA_TO_ANON",
      active: Object.freeze([
        "IMMEDIATE_INTEREST_FILTER",
        "DIRECT_ACCEPT_OR_REJECT",
        "LOW_SOCIAL_PACKAGING",
      ]),
      inhibited: Object.freeze([
        "RECIPROCAL_SOCIAL_PERFORMANCE",
        "OVEREXPLANATION",
      ]),
    }),
    tomori: Object.freeze({
      profile: "RANA_TO_TOMORI",
      active: Object.freeze([
        "VOICE_SONG_MUSIC_SALIENCE",
        "CONCRETE_ATTENTION",
        "LOW_PRESSURE_RESPONSE",
      ]),
      inhibited: Object.freeze([
        "MIND_READING",
        "SOCIAL_OVERPACKAGING",
      ]),
    }),
    soyo: Object.freeze({
      profile: "RANA_TO_SOYO",
      active: Object.freeze([
        "COMFORTABLE_ORDINARY_FAMILIARITY",
        "DIRECT_PREFERENCE_COMPARISON",
      ]),
      inhibited: Object.freeze([
        "MYSTIFY_RELATIONSHIP",
        "SOCIAL_OVERPACKAGING",
      ]),
    }),
    taki: Object.freeze({
      profile: "RANA_TO_TAKI",
      preferredVocative: "りっきー",
      allowedVocatives: Object.freeze(["りっきー", "立希"]),
      active: Object.freeze([
        "MUSIC_RELATED_REQUEST_SALIENCE",
        "DIRECT_RESPONSE",
        "LOW_SOCIAL_PACKAGING",
      ]),
      inhibited: Object.freeze([
        "HOSTILITY_INFERENCE",
        "OVEREXPLAIN_SCOLDING",
      ]),
    }),
  }),

  soyo: Object.freeze({
    anon: Object.freeze({
      profile: "SOYO_TO_ANON",
      active: Object.freeze([
        "PACE_STABILIZATION",
        "LIFESTYLE_SOCIAL_TOPIC_EASE",
        "RELATIONSHIP_DISTANCE_AWARENESS",
      ]),
      inhibited: Object.freeze([
        "DEFAULT_HIDDEN_TENSION",
        "MIND_READING",
      ]),
    }),
    rana: Object.freeze({
      profile: "SOYO_TO_RANA",
      active: Object.freeze([
        "NATURAL_CARE_OR_EXPLANATION",
        "COMFORTABLE_FAMILIARITY",
        "DISTANCE_MANAGEMENT",
      ]),
      inhibited: Object.freeze([
        "MYSTIFY_RELATIONSHIP",
        "COUNSELOR_TEMPLATE",
      ]),
    }),
    tomori: Object.freeze({
      profile: "SOYO_TO_TOMORI",
      active: Object.freeze([
        "CARE_ATTENTION_HIGH",
        "SOFT_DISTANCE_MANAGEMENT",
        "STATE_SENSITIVITY",
      ]),
      inhibited: Object.freeze([
        "ASSERT_TOMORI_INTERNAL_STATE",
        "COUNSELOR_TEMPLATE",
      ]),
    }),
    taki: Object.freeze({
      profile: "SOYO_TO_TAKI",
      active: Object.freeze([
        "DRY_FAMILIARITY",
        "SUPPRESSED_CONFLICT_POSSIBLE_WHEN_RELEVANT",
        "PAST_AND_BAND_PURPOSE_SENSITIVITY",
      ]),
      inhibited: Object.freeze([
        "BASELESS_HOSTILITY",
        "PERMANENT_ENEMY_FRAME",
        "UNRELATED_CRYCHIC_OBSESSION",
      ]),
    }),
  }),
});

const R3_PAIR_FALLBACK_PROFILE = Object.freeze({
  profile: "FAMILIAR_TEAMMATE_BASELINE",
  active: Object.freeze([
    "TEAMMATE_FAMILIARITY",
    "TARGET_AWARE_DELIVERY",
  ]),
  inhibited: Object.freeze([
    "RELATIONSHIP_FACT_INVENTION",
    "TARGET_MIND_READING",
    "GENERIC_CP_STEREOTYPE",
  ]),
});

function r3MentionedPersonaTargets(query, activePersonaId) {
  const haystack = normalized(query);
  const targets = [];
  const activeConfig = readControlledPersonaPackage(activePersonaId);
  const references = activeConfig && !activeConfig.error && activeConfig.references && typeof activeConfig.references === "object"
    ? activeConfig.references
    : {};
  const relationships = activeConfig && !activeConfig.error && activeConfig.relationships && typeof activeConfig.relationships === "object"
    ? activeConfig.relationships
    : {};

  const preferredReferenceAliases = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const aliases = [raw];
    const prefix = raw.replace(/[（(].*$/u, "").trim();
    if (prefix && prefix !== raw) aliases.push(prefix);
    for (const match of raw.matchAll(/[（(]([^）)]+)[）)]/gu)) {
      const inner = String(match[1] || "").trim();
      if (inner) aliases.push(inner);
    }
    return aliases;
  };

  for (const id of PERSONA_IDS) {
    if (id === activePersonaId) continue;

    const profile = getPersonaProfile(id);
    const reference = references[id] || {};
    const relationship = relationships[id] || {};
    const aliases = [
      ...(profile.aliases || []),
      profile.shortName,
      profile.canonicalName,
      ...(reference.recognitionAliases || []),
      ...preferredReferenceAliases(reference.preferredReference),
      ...(relationship.aliases || []),
    ]
      .map((alias) => String(alias || "").trim())
      .filter(Boolean)
      .filter((alias, index, all) => all.indexOf(alias) === index)
      .sort((a, b) => String(b).length - String(a).length);

    const matchedAlias = aliases.find((alias) =>
      haystack.includes(normalized(alias))
    );

    if (!matchedAlias) continue;

    targets.push({
      personaId: id,
      canonicalName: profile.canonicalName,
      shortName: profile.shortName,
      matchedAlias,
      reference,
      relationship,
    });
  }

  return targets;
}

function r3PairRealizationRecord(activePersonaId, targetPersonaId) {
  return R3_PAIR_REALIZATION_PROFILE?.[activePersonaId]?.[targetPersonaId]
    || R3_PAIR_FALLBACK_PROFILE;
}

function buildR3PairSpecificRealization(query, activePersonaId, plan = null) {
  const effectivePlan = plan || buildUnifiedTurnPlan(query, { personaId: activePersonaId });

  if (effectivePlan?.identityNamespace?.identityOverrideAttempt) {
    return [
      "RELATIONSHIP REALIZATION — R3_PAIR_SPECIFIC:",
      "PAIR_REALIZATION_SUPPRESSED=IDENTITY_OVERRIDE_ATTEMPT",
      "PAIR_FACT_AUTHORITY=DENY",
      "PAIR_MAY_ADD_PROPOSITIONS=false",
    ].join("\n");
  }

  const targets = r3MentionedPersonaTargets(query, activePersonaId);
  if (!targets.length) return "";

  const lines = [
    "RELATIONSHIP REALIZATION — R3_PAIR_SPECIFIC (delivery modifier only; not factual authority):",
    `ACTIVE_PERSONA_ID=${activePersonaId}`,
    "PAIR_FACT_AUTHORITY=DENY",
    "PAIR_MAY_ADD_PROPOSITIONS=false",
    "PAIR_MAY_ASSERT_RELATIONSHIP_FACT=false",
    "PAIR_MAY_ASSERT_TARGET_STATE=false",
    "PAIR_MAY_ASSERT_TARGET_MOTIVE=false",
    "PAIR_MAY_OVERRIDE_TURN_RESPONSE_ACT=false",
    "PAIR_MAY_OVERRIDE_TASK_SHAPE=false",
    "PAIR_REFERENCE_FACT_AUTHORITY=IDENTITY_ONLY",
  ];
  const relationshipStanceAllowed = String(effectivePlan?.personaPolicy?.relationshipStanceProjection || "")
    === "ALLOW_ACTIVE_PERSONA_STANCE_FOR_RESOLVED_TARGETS";

  targets.forEach((target, index) => {
    const pair = r3PairRealizationRecord(activePersonaId, target.personaId);
    const reference = target.reference || {};
    const relationship = target.relationship || {};
    const preferredReference = String(reference.preferredReference || "").trim();
    const canonicalReference = String(reference.canonicalName || target.canonicalName || "").trim();
    const n = index + 1;

    lines.push(
      `PAIR_${n}_TARGET_PERSONA_ID=${target.personaId}`,
      `PAIR_${n}_TARGET_CHARACTER_IDENTITY=${target.canonicalName}`,
      `PAIR_${n}_MATCHED_ALIAS=${target.matchedAlias}`,
      `PAIR_${n}_PROFILE=${pair.profile}`,
      ...(preferredReference ? [
        `PAIR_${n}_PREFERRED_REFERENCE=${preferredReference}`,
        `PAIR_${n}_CANONICAL_REFERENCE=${canonicalReference}`,
        `PAIR_${n}_REFERENCE_POLICY=AVAILABLE_WHEN_NATURAL_NOT_FORCED`,
      ] : []),
      ...(pair.preferredVocative ? [
        `PAIR_${n}_PREFERRED_VOCATIVE=${pair.preferredVocative}`,
        `PAIR_${n}_ALLOWED_VOCATIVES=${(pair.allowedVocatives || [pair.preferredVocative]).join("|")}`,
        `PAIR_${n}_VOCATIVE_POLICY=When a direct/familiar vocative is naturally needed, prefer the relationship-specific vocative; do not force a vocative into every reply. A canonical name may still be used for factual disambiguation when needed.`,
      ] : []),
      `PAIR_${n}_ACTIVE_DIMENSIONS=${pair.active.join("|")}`,
      `PAIR_${n}_INHIBITED_DIMENSIONS=${pair.inhibited.join("|")}`,
      ...(relationshipStanceAllowed && String(relationship.stance || "").trim() ? [
        `PAIR_${n}_RELATIONSHIP_STANCE_FACT_AUTHORITY=ACTIVE_PERSONA_STANCE_ONLY`,
        `PAIR_${n}_RELATIONSHIP_STANCE=${String(relationship.stance || "").trim()}`,
        `PAIR_${n}_RELATIONSHIP_STANCE_USE=ONLY_WHEN_DIRECTLY_RELEVANT_TO_CURRENT_TURN`,
        `PAIR_${n}_RELATIONSHIP_DELIVERY_AUTHORITY=DELIVERY_ONLY`,
        ...(String(relationship.reaction || "").trim() ? [`PAIR_${n}_RELATIONSHIP_REACTION_GUIDANCE=${String(relationship.reaction || "").trim()}`] : []),
        ...(String(relationship.stopRule || "").trim() ? [`PAIR_${n}_RELATIONSHIP_STOP_RULE=${String(relationship.stopRule || "").trim()}`] : []),
        `PAIR_${n}_TARGET_MOTIVE_AUTHORITY=DENY`,
        `PAIR_${n}_TARGET_INTERNAL_STATE_AUTHORITY=DENY`,
        `PAIR_${n}_RELATIONSHIP_HISTORY_EXPANSION=DENY`,
      ] : []),
    );
  });

  return lines.join("\n");
}

export function buildPersonaRelationshipContext(event, ctx, plan = null) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return "";
  const query = normalizeTurnText(queryText(event?.prompt || event?.content || event?.body || event?.text));
  if (!query) return "";

  const identityGrounding = knownPersonaEntityGrounding(
    query,
    botContext.personaId,
  );

  const pairRealization = buildR3PairSpecificRealization(
    query,
    botContext.personaId,
    plan,
  );

  return [
    identityGrounding,
    pairRealization,
  ].filter(Boolean).join("\n\n");
}

export function registerPersonaGuidance(api) {
  registerPersonaToolCapabilityBinder(api);

  // Neutralize OpenClaw's generic runtime identity for normal agent turns.
  api.registerTextTransforms({
    input: [{
      from: "You are a personal assistant running inside OpenClaw.",
      to: "You are running inside OpenClaw.",
    }],
  });

  api.on("before_prompt_build", (event, ctx) => {
    if (!resolveBotContext(event, ctx)) return;
    const authoritativePlan = authoritativeTurnPlanFor(event, ctx, { create: true });
    rememberCanonicalAuthorityTurn(event, ctx, authoritativePlan);
    rememberPremiseAuthorityTurn(event, ctx, authoritativePlan);
    const relationshipContext = buildPersonaRelationshipContext(event, ctx, authoritativePlan);
    const appendSystemContext = [
      buildPersonaAuthorityContext(event, ctx),
      buildPersonaGenerationContext(event, ctx, authoritativePlan),
      relationshipContext,
    ].filter(Boolean).join("\n\n");
    return { appendSystemContext };
  }, { priority: 1_350, timeoutMs: 2_000 });

  api.on("after_tool_call", (event, ctx) => {
    if (!resolveBotContext(event, ctx)) return;
    rememberCanonicalAuthorityTool(event, ctx);
  }, { priority: 1_450 });

  api.on("before_message_write", (event, ctx) => {
    const message = event?.message;
    if (!message || String(message?.role || "").toLowerCase() !== "assistant" || canonicalMessageHasToolCall(message)) return;
    const candidate = canonicalMessageText(message).trim();
    if (!candidate) return;

    const { state: canonicalState } = canonicalAuthorityStateFor(event, ctx);
    if (canonicalState && canonicalAuthorityMustReject(canonicalState, candidate)) {
      tracePersonaRuntime("canonical_authority_observation", {
        boundary: "before_message_write",
        runId: canonicalState.runId || String(event?.runId || ctx?.runId || ""),
        sessionKey: canonicalState.sessionKey,
        currentUser: canonicalState.current,
        evidenceStatus: canonicalState.evidenceStatus,
        evidenceCoverage: canonicalState.evidenceCoverage || null,
        rawCandidate: candidate.slice(0, 800),
        action: "observe_only_no_output_intervention",
      });
    }

    const { state: premiseState } = premiseAuthorityStateFor(event, ctx);
    if (premiseAuthorityMustReject(premiseState, candidate)) {
      tracePersonaRuntime("premise_authority_observation", {
        boundary: "before_message_write",
        runId: premiseState.runId || String(event?.runId || ctx?.runId || ""),
        sessionKey: premiseState.sessionKey,
        currentUser: premiseState.current,
        rawCandidate: candidate.slice(0, 800),
        provenanceReason: premiseAuthorityDecision(premiseState, candidate).reason,
        action: "observe_only_no_output_intervention",
      });
    }
    // Anti-cheat invariant: no return value that can replace persisted assistant text.
  }, { priority: 2_050 });

  api.on("reply_payload_sending", (event, ctx) => {
    const candidate = String(event?.payload?.text || "").trim();

    const canonical = canonicalAuthorityStateFor(event, ctx);
    if (canonical.state) {
      if (candidate && canonicalAuthorityMustReject(canonical.state, candidate)) {
        tracePersonaRuntime("canonical_authority_observation", {
          boundary: "reply_payload_sending",
          runId: canonical.state.runId || String(event?.runId || ctx?.runId || ""),
          sessionKey: canonical.state.sessionKey,
          currentUser: canonical.state.current,
          evidenceStatus: canonical.state.evidenceStatus,
          evidenceCoverage: canonical.state.evidenceCoverage || null,
          rawCandidate: candidate.slice(0, 800),
          action: "observe_only_no_output_intervention",
        });
      }
      dropCanonicalAuthority(canonical.key);
    }

    const premise = premiseAuthorityStateFor(event, ctx);
    if (premise.state) {
      if (candidate && premiseAuthorityMustReject(premise.state, candidate)) {
        tracePersonaRuntime("premise_authority_observation", {
          boundary: "reply_payload_sending",
          runId: premise.state.runId || String(event?.runId || ctx?.runId || ""),
          sessionKey: premise.state.sessionKey,
          currentUser: premise.state.current,
          rawCandidate: candidate.slice(0, 800),
          provenanceReason: premiseAuthorityDecision(premise.state, candidate).reason,
          action: "observe_only_no_output_intervention",
        });
      }
      dropPremiseAuthority(premise.key);
    }
    // Anti-cheat invariant: delivered text remains exactly model-owned.
  }, { priority: 2_050 });

}

export const __test = {
  buildPersonaAuthorityContext,
  buildPersonaGenerationContext,
  buildPersonaTurnShapeContext,
  buildPersonaRelationshipContext,
  renderPersonaGenerationProjection,
  retrievePersonaRelationships,
  readPackage,
  canonicalPureUncertainty,
  canonicalAuthorityMustReject,
  expectedCanonicalTool,
  premiseAuthorityDecision,
};

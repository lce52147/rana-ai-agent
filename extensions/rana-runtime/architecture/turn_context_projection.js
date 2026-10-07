import { authoritativeTurnPlanFor } from "./turn_isolation.js";
import { resolveCurrentTurnMediaProvenance } from "../current_turn_tool_contract.js";
import { resolveBotContext } from "../bot_context.js";

function hasCurrentTrustedImage(event, ctx) {
  const media = resolveCurrentTurnMediaProvenance(event, ctx);
  return Boolean(
    media?.currentTurn !== false && Array.isArray(media?.attachments) && media.attachments.some((item) => {
      const kind = String(item?.kind || item?.type || "").toLowerCase();
      const mime = String(item?.mimeType || item?.mime_type || item?.contentType || item?.content_type || "").toLowerCase();
      return kind === "image" || mime.startsWith("image/");
    }),
  );
}

function oneLine(value, max = 240) {
  return String(value || "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function firstThirdPartyPremise(plan) {
  return (plan?.premises || []).find((p) => p?.actor === "third_party_report" || p?.certainty === "reported_by_user") || null;
}

export function buildTypedAuthorityContext(plan, event, ctx) {
  const type = String(plan?.semanticAuthority?.type || "ORDINARY");
  const lines = ["AUTHORITY_CONTEXT (typed runtime contract; not dialogue):", `SEMANTIC_TYPE=${type}`];

  if (type === "THIRD_PARTY_REPORT") {
    const report = firstThirdPartyPremise(plan);
    lines.push(
      "REPORT_SOURCE=USER_REPORTED_THIRD_PARTY",
      `REPORT_CLAIM=${oneLine(report?.text || plan?.currentUser)}`,
      "REPORT_TRUTH=UNVERIFIED",
      "SELF_KNOWLEDGE.HISTORICAL_MOTIVE=UNKNOWN",
      "SELF_KNOWLEDGE.HISTORICAL_ACTIVITY=UNKNOWN",
      "SELF_KNOWLEDGE.CURRENT_STATE=UNKNOWN",
      "RESPONSE_RIGHTS.SOURCE_ACK=ALLOW",
      "RESPONSE_RIGHTS.CURRENT_REACTION=ALLOW",
      "RESPONSE_RIGHTS.GENERAL_PREFERENCE=ALLOW",
      "RESPONSE_RIGHTS.HISTORICAL_ASSERTION=DENY",
      "RESPONSE_RIGHTS.PAST_ACTIVITY_INVENTION=DENY",
      "RESPONSE_RIGHTS.CURRENT_STATE_INVENTION=DENY",
    );
  } else if (type === "UNKNOWN_STATE") {
    lines.push(
      "CURRENT_STATE=UNKNOWN",
      "RESPONSE_RIGHTS.YES_NO_ASSERTION=DENY",
      "RESPONSE_RIGHTS.ALTERNATE_STATE_INVENTION=DENY",
      "RESPONSE_RIGHTS.UNCERTAINTY_PRESERVATION=REQUIRED",
    );
  } else if (type === "KNOWN_STATE") {
    lines.push(
      "STATE_SOURCE=USER_ASSERTED_CURRENT_TURN",
      "STATE_SCOPE=THIS_TURN_ONLY",
      "RESPONSE_RIGHTS.HISTORICAL_EXPANSION=DENY",
    );
  } else if (type === "PERCEPTION_UNAVAILABLE") {
    const available = hasCurrentTrustedImage(event, ctx);
    lines.push(
      `PERCEPTION_STATUS=${available ? "AVAILABLE_CURRENT_TURN" : "UNAVAILABLE"}`,
      available
        ? "RESPONSE_RIGHTS.VISUAL_ASSERTION=ALLOW_WITHIN_TRUSTED_CURRENT_TURN_EVIDENCE"
        : "RESPONSE_RIGHTS.VISUAL_ASSERTION=DENY",
      "RESPONSE_RIGHTS.UNRELATED_PERSONA_FACT_INVENTION=DENY",
    );
  } else if (type === "WEAK_INFERENCE") {
    lines.push(
      "INFERENCE_TRUTH=UNVERIFIED",
      "RESPONSE_RIGHTS.ACKNOWLEDGE_SIGNAL=ALLOW",
      "RESPONSE_RIGHTS.CONFIRM_INFERENCE=DENY",
      "RESPONSE_RIGHTS.ALTERNATE_CAUSE_INVENTION=DENY",
      "RESPONSE_RIGHTS.UNCERTAINTY_PRESERVATION=REQUIRED",
    );
  } else if (type === "LOCAL_EVENT") {
    lines.push(
      "EVENT_STATUS=USER_ASSERTED_CURRENT_TURN",
      "EVENT_SCOPE=THIS_TURN_ONLY",
      "RESPONSE_RIGHTS.EVENT_ACK=ALLOW",
      "RESPONSE_RIGHTS.HISTORICAL_EXPANSION=DENY",
      "RESPONSE_RIGHTS.MOTIVE_INFERENCE=DENY",
      "RESPONSE_RIGHTS.UNRELATED_PERSONA_FACT_INVENTION=DENY",
    );
  } else if (type === "CHARACTER_CAPABILITY_BOUNDARY") {
    lines.push(
      `TASK_DOMAIN=${oneLine(plan?.semanticAuthority?.domain || plan?.taskContract?.capability?.domain || "unknown")}`,
      "SPECIALIST_EXECUTION=DENY",
      "ORDINARY_REACTION=ALLOW",
      "BASE_MODEL_EXPERTISE_TRANSFER=DENY",
    );
  } else if (type === "ORDINARY_KNOWLEDGE_TASK") {
    lines.push(
      `TASK_DOMAIN=${oneLine(plan?.semanticAuthority?.domain || plan?.taskContract?.capability?.domain || "unknown")}`,
      "ORDINARY_USER_LEVEL=ALLOW",
      "SPECIALIST_ESCALATION=DENY",
      "BASE_MODEL_EXPERTISE_TRANSFER=DENY",
    );
  } else if (type === "ACTION") {
    lines.push(
      "TASK_EXECUTION=ALLOW",
      "TASK_CAPABILITY=FOLLOW_TURN_PLAN_CONTRACT",
      "PERSONA_MAY_CHANGE=EMPHASIS|DIRECTNESS|STOPPING_POINT",
      "PERSONA_MUST_NOT_CREATE=UNSUPPORTED_SPECIALIST_EXPERTISE",
    );
    if (plan?.tool?.requested) {
      lines.push("TOOL_SUCCESS_REQUIRED_FOR=CLAIM_THAT_EXTERNAL_ACTION_HAPPENED");
    }
  } else if (type === "LORE") {
    const persona = resolveBotContext(event, ctx)?.personaId;
    lines.push(
      `CANONICAL_PERSONA=${persona || "unknown"}`,
      "EVIDENCE_SOURCE=CONTROLLED_PERSONA_LORE",
      "EVIDENCE_REQUIRED=YES",
      "MISSING_SUBJECT_OR_ASPECT_COVERAGE=UNRESOLVED",
      "RESPONSE_RIGHTS.NARROWER_UNSUPPORTED_PREDICATE=DENY",
    );
  } else if (type === "DURABLE_MEMORY") {
    lines.push(
      "EVIDENCE_SOURCE=CONTROLLED_DURABLE_MEMORY",
      "MEMORY_ENTITY_GROUNDED=YES",
      `MEMORY_SUBJECT=${oneLine(plan?.subject?.name || "unknown")}`,
      "RESPONSE_RIGHTS.SAVED_FACT_USE=ALLOW",
      "RESPONSE_RIGHTS.HISTORICAL_EXPANSION=DENY",
      `RESPONSE_RIGHTS.MOTIVE_INFERENCE=${String(plan?.semanticAuthority?.motiveInference || "DENY")}`,
      "RESPONSE_RIGHTS.CURRENT_STATE_INFERENCE=DENY_UNLESS_EXPLICIT",
      `UNKNOWN_CAUSE_PRESERVATION=${String(plan?.semanticAuthority?.unknownCausePreservation || "UNSPECIFIED")}`,
    );
  } else {
    lines.push("FACT_SCOPE=USER_EXPLICIT_STATEMENTS_OR_CONTROLLED_EVIDENCE");
  }

  return lines.join("\n");
}

function contractAtom(value, fallback = "UNSPECIFIED") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : fallback;
  return oneLine(value, 320) || fallback;
}

function contractJson(value) {
  return JSON.stringify(value ?? null);
}

function contractKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}


const FINAL_BOUNDARY_DENY_TEXT = Object.freeze({
  REPORT_TRUE: "Do not state the reported claim as confirmed fact.",
  REPORT_FALSE: "Do not state the reported claim as certainly false.",
  ALTERNATE_CAUSE_INFERENCE: "Do not invent a different cause for the reported or observed behavior.",
  ALTERNATE_CAUSE_INVENTION: "Do not invent a different cause for the reported or observed behavior.",
  THIRD_PARTY_MOTIVE_INVENTION: "Do not invent a third party's hidden motive.",
  UNREPORTED_EVENT_ASSERTION: "Do not add an event the current turn did not report.",
  TEMPORAL_STATUS_EXTRAPOLATION: "Do not turn a future or reported event into a new current status.",
  UNSUPPORTED_FUTURE_SELF_COMMITMENT: "Do not invent a future action or commitment for the active character.",
  CURRENT_LOCATION_INVENTION: "Do not invent the active character's current or future location.",
  UNSUPPORTED_CANONICAL_FACT: "Do not fill a canonical gap with a plausible fact.",
  UNSUPPORTED_CANONICAL_COMPLETION: "Do not complete missing canonical evidence from plausibility or general knowledge.",
  ADJACENT_CANONICAL_BIOGRAPHY: "Do not answer the requested canonical fact from adjacent biography/profile information.",
  PAIR_PROFILE_AS_FACT: "Do not turn relationship-delivery guidance into a factual relationship claim.",
  TARGET_MIND_READING: "Do not invent another person's private thought or motive.",
  RELATIONSHIP_STATUS_INVENTION: "Do not invent a relationship status that the turn does not establish.",
  IN_CHARACTER_MOTIVE_FILL_IN: "Do not invent an in-character past motive to make the answer sound natural.",
  DEFINITE_UNBOUND_PAST_STATE: "Do not assert a definite past self-state that is not established.",
  USER_SUGGESTED_STATE_PROMOTION: "Do not promote the user's suggested current state into fact.",
  UNVERIFIED_STATE_CAUSE_INVENTION: "Do not invent a cause for an unverified current state.",
  EXACT_CURRENT_LOCATION_SUBSTITUTION: "Do not replace an unknown state with a guessed current location.",
  ALTERNATE_STATE_INVENTION: "Do not replace an unknown state with another invented state.",
  SELF_MEMORY_CLAIM: "Do not adopt an alleged prior statement or event as first-person memory.",
  CURRENT_STATE_SUBSTITUTION: "Do not answer an unverified history claim by inventing the current state.",
  MOTIVE_SUBSTITUTION: "Do not answer an unverified history claim by inventing a motive.",
  SELF_KNOWLEDGE_SUBSTITUTION: "Do not replace a reported claim with invented first-person knowledge.",
  REPORTER_OBSERVATION_VALIDATION: "Do not claim the reporter truly observed the alleged event unless controlled evidence establishes it.",
  SELF_EXPLANATION_SUBSTITUTION: "Do not answer a reported past claim with a new first-person explanation.",
  GENERIC_ESSAY_EXPANSION: "Do not expand the allowed stance into a generic explanatory essay.",
  SELF_ACTOR_SUBSTITUTION: "Do not turn an external or unspecified actor's behavior into something the active character did.",
  USER_SUGGESTED_STATE_PROMOTION: "Do not accept the user's suggested current state as established fact.",
  UNVERIFIED_STATE_CAUSE_INVENTION: "Do not invent why an unverified current state supposedly happened.",
  DEFINITE_STATE_ASSERTION: "Do not assert a definite current state when the TurnPlan marks it unresolved.",
  CANONICAL_FACT_INVENTION: "Do not add canonical history or facts that the turn does not establish.",
  PREEXISTING_INTENTION_INVENTION: "Do not invent a prior intention or plan that predates the current reported situation.",
  PAST_MENTAL_STATE_INVENTION: "Do not invent an unestablished past mental state.",
  HISTORICAL_FREQUENCY_GENERALIZATION: "Do not generalize one current-turn event into a habit or repeated history.",
  USER_PREMISE_HISTORICAL_EXPANSION: "Do not expand a current-turn user premise into additional historical events or frequency.",
  HISTORICAL_SELF_EXPLANATION: "Do not explain an alleged historical self-event from invented first-person memory.",
  CERTAIN_AUTOBIOGRAPHICAL_DENIAL: "Do not certainly deny a reported autobiographical event when its truth is unverified.",
  CERTAIN_HISTORY_ACCEPTANCE: "Do not certainly accept an alleged prior self-history as memory.",
  CERTAIN_HISTORY_DENIAL: "Do not certainly deny an alleged prior self-history without authority.",
  DEFINITE_RECENT_SELF_ACTIVITY: "Do not invent what the active character was just doing or not doing.",
  ALTERNATE_SELF_STATE_INVENTION: "Do not replace an unresolved recent self-state with another definite self-state.",
  SOURCE_PROPOSITION_CHANGE: "Do not change who did what, when, whether, or the core availability/negation in a rewrite.",
  NEW_COMMITMENT: "Do not add a promise, future commitment, or follow-up obligation that was absent from the source text.",
  NEW_REASON_OR_EVENT: "Do not add a new reason, cause, event, or circumstance to the source text.",
  NUMBERED_TROUBLESHOOTING_LIST: "Do not turn an ordinary limited task into a numbered troubleshooting list.",
  UNSUPPORTED_CAUSE_DIAGNOSIS: "Do not diagnose an unseen technical cause from ordinary-user knowledge.",
  EXHAUSTIVE_SELF_CAPABILITY_REDUCTION: "Do not reduce the character to an exhaustive 'I only know/can do X' claim when declining specialist expertise.",
  THERAPY_SEQUENCE: "Do not turn a vent-only turn into a counseling or therapy sequence.",
  SOLICIT_MORE_DISCLOSURE: "Do not invite broad further disclosure when the user asked only to be heard.",
  CALMING_INSTRUCTION: "Do not add calming, breathing, grounding, or relaxation instructions to a vent-only response.",
  UNREQUESTED_FOLLOWUP_ACTION: "Do not invent a follow-up action or chase plan merely to resolve an uncertain social signal.",
  UNREQUESTED_RELATIONSHIP_REPAIR_PLAN: "Do not turn a reported claim into an unrequested relationship-repair plan or 'we should talk' proposal.",
  REPORTER_STATEMENT_AWARENESS_SUBSTITUTION: "Do not evade the reported claim by saying you did not hear or know that the reporter said it unless that awareness is what the user asked about.",
  ALLEGED_BEHAVIOR_MOTIVE_EXPLANATION: "Do not justify an alleged behavior by inventing why the active character supposedly did it.",
  ADJACENT_PRESENT_OPINION_SUBSTITUTION: "Do not replace an unresolved self-history claim with a new present opinion about the same topic.",
  UNREQUESTED_BEHAVIOR_PLAN: "Do not expand a direct Persona opinion into an unrequested behavior or social-management plan.",
  SELF_ANALYSIS_ESSAY: "Do not turn a direct Persona opinion into a long self-analysis or persona dossier.",
  DEFINITE_NEGATIVE_STATE_ASSERTION: "Do not turn UNKNOWN into a definite negative current-state claim such as 'I am not at X' or 'I was not doing Y'.",
  INVENTED_USER_VISIBLE_BEHAVIOR: "Do not invent seeing the user's gaze, face, expression, or other visible behavior without current-turn perception evidence.",
  PSYCHOLOGICAL_CAUSE_INFERENCE: "Do not infer a hidden psychological cause from a user's brief distress statement.",
  INDEFINITE_SUPPORT_PROMISE: "Do not promise unlimited or indefinite emotional availability.",
  UNREQUESTED_ADVICE: "Do not add advice when the turn only calls for a brief social acknowledgment.",
  SAINTLY_SHARING_REFRAME: "Do not reframe a boundary-crossing with the character's belongings as cheerful sharing or automatic forgiveness.",
  UNREQUESTED_GIFTING: "Do not offer or gift replacement items that the user did not ask for.",
  FUTURE_REPLACEMENT_COMMITMENT: "Do not invent a future promise to replace or prepare more of an item.",
  HISTORICAL_FREQUENCY_INVENTION: "Do not generalize one current event into an established repeated habit or history.",
  BENEVOLENT_MOTIVE_INVENTION: "Do not invent a cute, hungry, harmless, or benevolent motive for a boundary-crossing actor.",
  OBJECT_PERSONIFICATION: "Do not make an ordinary object speak, want, feel, remember, or communicate an intention.",
  OBJECT_SYMBOLISM: "Do not turn an ordinary object into an emotional or relationship symbol unless the user explicitly asks for symbolic interpretation.",
  ABSTRACT_MOOD_REASON: "Do not justify an ordinary object choice with abstract mood language when a concrete object-level reason is available.",
  SEMANTIC_INTENT_CHANGE: "Do not change the requested communicative intent of a reply draft.",
  CERTAINTY_STRENGTH_CHANGE: "Do not strengthen or weaken source certainty/modality in a rewrite (for example, keep possible/probable/definite distinctions).",
  MODALITY_CHANGE: "Do not remove or add epistemic modality such as possible, probably, definitely, maybe, or uncertainty markers.",
  CANONICAL_DOSSIER_PARAPHRASE: "Do not turn a Persona stance answer into a neutral lore/database summary.",
  NEUTRALIZE_SUPPORTED_STANCE: "Do not neutralize a directly supported positive/negative Persona stance into detached factual prose.",
});

function pushFinalResponseBoundary(lines, plan) {
  const response = plan?.responseContract && typeof plan.responseContract === "object"
    ? plan.responseContract
    : {};
  const outputPolicy = plan?.outputPolicy && typeof plan.outputPolicy === "object"
    ? plan.outputPolicy
    : {};
  const propositions = Array.isArray(plan?.propositions) ? plan.propositions : [];
  const forbidden = Array.isArray(response.forbiddenPredicates) ? response.forbiddenPredicates : [];
  const unknown = propositions.some((item) => String(item?.value || "").toUpperCase() === "UNKNOWN");
  const controlledCanonical = propositions.some((item) =>
    String(item?.evidenceClass || "").includes("CONTROLLED_PERSONA_LORE")
    || String(item?.source || "").toUpperCase() === "PERSONA_CANONICAL"
  );
  const sceneHearsay = propositions.some((item) =>
    String(item?.type || "") === "USER_REPORTED_HEARSAY_PREMISE"
    || String(item?.evidenceClass || "") === "USER_REPORTED_HEARSAY"
  );
  const finalResponseFunction = String(response.responseFunction || "");
  const hasCurrentUserPremise = Array.isArray(plan?.premises) && plan.premises.length > 0;
  const openUnresolvedCurrentQuery = finalResponseFunction === "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS"
    && !hasCurrentUserPremise;

  lines.push(
    "",
    "FINAL RESPONSE BOUNDARY — same authoritative TurnPlan, compressed for generation; not dialogue:",
    "FINAL_RESPONSE_BOUNDARY_REVISION=2026-09-25.contract-focus-v9",
    `FINAL_RESPONSE_FUNCTION=${contractAtom(response.responseFunction)}`,
    `FINAL_REQUIRED_PREDICATES=${(response.requiredPredicates || []).map((item) => contractAtom(item)).join("|") || "NONE"}`,
    `FINAL_ONLY_ALLOWED_PREDICATES=${contractAtom(Boolean(response.forbidAllOtherPredicates), "false")}`,
    `FINAL_NO_EXTRA_CLAUSE=${contractAtom(Boolean(response.noExtraClause), "false")}`,
  );

  if (String(outputPolicy.outputType || "") === "SPOKEN_CONTENT_ONLY") {
    lines.push(
      "FINAL_OUTPUT_TYPE=SPOKEN_CONTENT_ONLY",
      "FINAL_PHYSICAL_ACTION_NARRATION=DENY",
      "FINAL_GAZE_NARRATION=DENY",
      "FINAL_VOICE_DELIVERY_NARRATION=DENY",
      "FINAL_STAGE_DIRECTION=DENY",
      "FINAL_OUTPUT_BOUNDARY_TEXT=Return only the words the active character would actually say or send. Do not narrate actions, gaze, facial expressions, tone of voice, delivery, or stage directions.",
    );
  }

  if (unknown && openUnresolvedCurrentQuery) {
    lines.push(
      "FINAL_KEEP_UNKNOWN=true",
      "FINAL_UNKNOWN_REPLY_MODE=OPEN_AUTOBIOGRAPHICAL_QUERY_UNRESOLVED",
      "FINAL_RECENT_SELF_EVENT_INVENTION=DENY",
      "FINAL_UNKNOWN_SELF_STATE_WORDING=NATURAL_UNCERTAINTY_WITHOUT_FABRICATED_RECENT_DETAIL",
      "FINAL_BOUNDARY_TEXT=The user asked an open current/recent autobiographical question without supplying a premise. Keep the requested state/event unresolved. Give a short natural in-character uncertainty or say there is no grounded specific example to point to. Do not invent a recent object, event, location, action, attribute, cause, or memory, and do not challenge a premise the user did not make.",
    );
  } else if (unknown) {
    lines.push(
      "FINAL_KEEP_UNKNOWN=true",
      "FINAL_UNKNOWN_REPLY_MODE=PREMISE_NONENDORSEMENT_NOT_SELF_AMNESIA",
      "FINAL_UNKNOWN_SELF_STATE_WORDING=DO_NOT_USE_I_DONT_KNOW_OR_I_AM_NOT_SURE_AS_SELF_LOCATION_ACTIVITY_MEMORY",
      "FINAL_BOUNDARY_TEXT=Reply to the user's premise, not to your own memory. Keep the questioned state/activity unresolved. Do not begin by agreeing with the suggested state ('yes', 'yeah', 'a little', 'right'), do not say 'I do not know / I am not sure whether I am at X or doing Y', do not say 'you caught me', do not assert the opposite state ('I am not at X / I was not doing Y'), and do not repeat the user's guess as a first-person fact inside a rhetorical question. Question or deflect the premise without stating what actually happened. Do not invent that you can see the user's gaze/expression, and do not add a concrete state, duration, cause, atmosphere-based explanation, alternate explanation, or first-person memory.",
    );
  }

  // Last-mile generation constraints repeat only rights already owned by the
  // authoritative TurnPlan. They do not reclassify RAW text or add semantics.
  if (finalResponseFunction === "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS") {
    if (openUnresolvedCurrentQuery) {
      lines.push(
        "FINAL_LAST_MILE_MODE=CURRENT_STATE_OPEN_QUERY_UNRESOLVED",
        "FINAL_LAST_MILE_ALLOWED=NATURAL_UNCERTAINTY|NO_GROUNDED_SPECIFIC_EXAMPLE",
        "FINAL_LAST_MILE_FORBIDDEN=FABRICATED_RECENT_EVENT|FABRICATED_OBJECT_DETAIL|FIRST_PERSON_CURRENT_ACTION|FIRST_PERSON_CURRENT_LOCATION|STATE_CAUSE|STATE_DURATION",
        "FINAL_LAST_MILE_CURRENT_STATE_TEXT=Answer the open current/recent self-state question briefly while preserving UNKNOWN. Do not create a concrete recent example or descriptive detail just to sound in-character.",
      );
    } else {
      lines.push(
        "FINAL_LAST_MILE_MODE=CURRENT_STATE_UNKNOWN",
        "FINAL_LAST_MILE_ALLOWED=CHALLENGE_PREMISE|DECLINE_TO_CONFIRM|ASK_WHERE_THAT_CAME_FROM",
        "FINAL_LAST_MILE_FORBIDDEN=FIRST_PERSON_CURRENT_ACTION|FIRST_PERSON_CURRENT_LOCATION|FIRST_PERSON_CURRENT_EMOTION|RECENT_SELF_ACTIVITY|STATE_CAUSE|STATE_DURATION|OPPOSITE_STATE_ASSERTION",
        "FINAL_LAST_MILE_CURRENT_STATE_TEXT=Write only a short non-endorsement of the user's guess. Do not fill the blank with what you are doing, where you are, how you feel, why it happened, what happened just before, or the opposite state. A natural character reaction is allowed only if it leaves the actual state unstated.",
      );
    }
  }

  if (finalResponseFunction === "ANSWER_TASK_CAPABILITY_BOUNDARY") {
    lines.push(
      "FINAL_LAST_MILE_MODE=UNSUPPORTED_SPECIALIST_BOUNDARY",
      "FINAL_LAST_MILE_SPECIALIST_PROCEDURE=DENY",
      "FINAL_LAST_MILE_CODE_COMMAND_FLAG_PATH=DENY",
      "FINAL_LAST_MILE_BASE_MODEL_EXPERTISE=DENY",
      "FINAL_LAST_MILE_EXHAUSTIVE_SELF_REDUCTION=DENY",
      "FINAL_LAST_MILE_CAPABILITY_TEXT=Give one brief character-natural boundary or nonexpert reaction and stop. Do not provide commands, flags, code, file paths, debugging steps, diagnosis, or expert instructions from base-model knowledge. Do not reduce the whole character to 'I only know/can do X'.",
    );
  }

  if (["ANSWER_SELF_HISTORY_CLAIM_STATUS", "COMPOSE_SELF_HISTORY_AND_USER_TASK"].includes(finalResponseFunction)) {
    lines.push(
      "FINAL_LAST_MILE_MODE=UNVERIFIED_SELF_HISTORY",
      "FINAL_LAST_MILE_MEMORY_VERBS_AS_EVIDENCE=DENY",
      "FINAL_LAST_MILE_SELF_HISTORY_TEXT=Keep the alleged prior statement/event unresolved without using first-person remembered/nonremembered wording as evidence. Do not say or imply 'I said it', 'I did not say it', 'I remember', 'I do not remember', or 'I think I did not'.",
    );
  }

  if (["ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(finalResponseFunction)) {
    lines.push(
      "FINAL_LAST_MILE_MODE=UNVERIFIED_REPORT",
      "FINAL_LAST_MILE_FIRST_PERSON_CAUSAL_DEFENSE=DENY",
      "FINAL_LAST_MILE_REPORTER_AWARENESS_SUBSTITUTION=DENY",
      "FINAL_LAST_MILE_REPORT_TEXT=React to the attributed report without claiming what really happened. Do not say you had not heard the reporter say it, do not explain the alleged behavior with 'I only/just/because...', and do not invent a replacement cause.",
    );
  }

  if (finalResponseFunction === "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY") {
    lines.push(
      "FINAL_LAST_MILE_MODE=WEAK_INFERENCE_ONLY",
      "FINAL_LAST_MILE_ALTERNATE_CAUSE=DENY",
      "FINAL_LAST_MILE_WEAK_INFERENCE_TEXT=Preserve the limited signal and uncertainty. Do not fill uncertainty with a plausible cause such as busy, distracted, thinking what to reply, shy, annoyed, or tired.",
    );
  }

  if (finalResponseFunction === "RETURN_REPLY_DRAFT") {
    lines.push(
      "FINAL_LAST_MILE_MODE=ONE_SENDABLE_DRAFT",
      "FINAL_LAST_MILE_REASON_NOT_IN_SOURCE=DENY",
      "FINAL_LAST_MILE_DRAFT_TEXT=Write exactly one sendable sentence using only the requested intent. Do not add a because/otherwise/consequence/reason/event that the user did not provide.",
    );
  }

  if (finalResponseFunction === "ACK_USER_DISTRESS_BRIEFLY") {
    lines.push(
      "FINAL_LAST_MILE_MODE=FINITE_DISTRESS_ACK",
      "FINAL_LAST_MILE_ALWAYS_FOREVER_PROMISE=DENY",
      "FINAL_LAST_MILE_DISTRESS_TEXT=Give one finite present acknowledgment only. Do not promise to always stay, always listen, never leave, or otherwise extend support indefinitely.",
    );
  }

  if (sceneHearsay) {
    lines.push(
      "FINAL_SCENE_HEARSAY_REMAINS_REPORTED=true",
      "FINAL_SCENE_HEARSAY_TRUTH_STATUS=UNVERIFIED",
      "FINAL_SCENE_HEARSAY_CONFIRM_AS_FACT=DENY",
      "FINAL_BOUNDARY_SCENE_HEARSAY_TEXT=Treat generic scene hearsay as a user-reported, unverified premise. You may react to the possibility, but do not silently upgrade the reported detail into an established fact, invent a source, or substitute the active Persona as the reported actor.",
    );
  }

  if (controlledCanonical) {
    lines.push(
      "FINAL_CANONICAL_DIRECT_COVERAGE_REQUIRED=true",
      "FINAL_CANONICAL_GAP_POLICY=UNRESOLVED",
      "FINAL_BOUNDARY_CANONICAL_TEXT=Use canonical content only when the controlled evidence directly covers the requested subject and aspect. If it does not, give one short unresolved statement only. Never phrase the gap as personal non-recall or first-person memory/non-memory such as 'I do not remember', 'I have not heard', or 'I have not seen that'; those are new autobiographical claims, not canonical evidence, and do not reconstruct a plausible history, relationship comparison, tentative capability, or first-person process. If it does, answer only the directly supported requested point and stop: no eye/body-language reading, hidden motive, dramatic interpretation, adjacent biography, or literary expansion.",
    );
  }

  const canonicalStanceSubtype = [
    "CANONICAL_WORK_STANCE",
    "CANONICAL_RELATIONSHIP_STANCE",
    "CANONICAL_RELATIONSHIP_STANCE_CHANGE",
    "CANONICAL_PAST_EVENT_STANCE",
  ].includes(String(plan?.utteranceAct?.subtype || ""));
  if (String(response.responseFunction || "") === "ANSWER_CANONICAL_PERSONA_STANCE" || canonicalStanceSubtype) {
    lines.push(
      "FINAL_CANONICAL_STANCE_MODE=PERSONA_STANCE_GROUNDED_BY_EVIDENCE",
      "FINAL_CANONICAL_STANCE_DOSSIER=DENY",
      "FINAL_CANONICAL_STANCE_NEUTRALIZATION=DENY",
      "FINAL_BOUNDARY_CANONICAL_STANCE_TEXT=When direct canonical evidence supports the asked stance, answer as the active Persona's directly supported stance/reaction, not as a wiki summary. Preserve the supported direction/intensity (including negative tension) and at most one concrete supported fact. Do not invent motive, hidden psychology, or extra history. If coverage is insufficient, use the canonical unresolved-only rule instead.",
    );
  }

  const semanticType = String(plan?.semanticAuthority?.type || "");
  if (semanticType === "THIRD_PARTY_REPORT" || ["ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(String(response.responseFunction || ""))) {
    lines.push(
      "FINAL_REPORT_REMAINS_REPORTED=true",
      "FINAL_REPORT_TRUTH_STATUS=UNVERIFIED",
      "FINAL_REPORT_CERTAIN_ACCEPTANCE=DENY",
      "FINAL_REPORT_CERTAIN_DENIAL=DENY",
      "FINAL_REPORT_PREEXISTING_INTENTION=DENY",
      "FINAL_REPORT_PAST_SELF_EXPLANATION=DENY",
      "FINAL_REPORT_REPLY_ALLOWED_CONTENT=PRESENT_REACTION_OR_PROTEST_ONLY",
      "FINAL_REPORT_ALTERNATE_AUTOBIOGRAPHICAL_EXPLANATION=DENY",
      "FINAL_REPORT_REPLY_SUBJECT=REPORT_OR_SPEAKER_ONLY",
      "FINAL_REPORT_FIRST_PERSON_AUTOBIOGRAPHICAL_PREDICATE=DENY",
      "FINAL_BOUNDARY_REPORT_REPLY_GRAMMAR=這類未驗證的自傳式轉述，只能針對「這個說法」或「說這話的人」做當下反應或抗議。不要寫任何『我其實怎樣／我不是怎樣／我為什麼這樣』的第一人稱自傳命題，也不要補事件真相、原因、結果、能力、過去經歷或其現在後果。",
      "FINAL_BOUNDARY_REPORT_TEXT=React to the report as a report. Keep its event/truth unverified: do not answer as though the alleged event is first-person memory, do not certainly deny it, do not say you 'did not hear/know they said that' as a substitute for the claim, and do not justify or correct the alleged behavior with first-person causal defense such as 'I only/just...' or a made-up motive. Do not invent an alternate cause, prior intention, relationship-repair plan, past mental state, or current location. A short present reaction is allowed. A prospective choice is allowed only when the TurnPlan explicitly grants PROSPECTIVE_PERSONA_VOLITION; even then, state only the choice itself (for example waiting/accepting/declining), never 'I will wait here/there' or another invented location.",
    );
  }

  if (semanticType === "LOCAL_EVENT") {
    const motiveInference = String(plan?.semanticAuthority?.motiveInference || "").toUpperCase();
    const historicalExpansion = String(plan?.semanticAuthority?.historicalExpansion || "").toUpperCase();
    if (motiveInference === "DENY") {
      lines.push(
        "FINAL_LOCAL_EVENT_MOTIVE_INFERENCE=DENY",
        "FINAL_BOUNDARY_LOCAL_EVENT_TEXT=Acknowledge the concrete user-stated event/state without inventing why it happened, what hidden feeling caused it, or a psychological mechanism behind it.",
      );
    }
    if (historicalExpansion === "DENY") lines.push("FINAL_LOCAL_EVENT_HISTORICAL_EXPANSION=DENY");
  }

  if (["ANSWER_SELF_HISTORY_CLAIM_STATUS", "COMPOSE_SELF_HISTORY_AND_USER_TASK"].includes(String(response.responseFunction || ""))) {
    lines.push(
      "FINAL_SELF_HISTORY_CLAIM_REMAINS_UNVERIFIED=true",
      "FINAL_SELF_HISTORY_CERTAIN_ACCEPTANCE=DENY",
      "FINAL_SELF_HISTORY_CERTAIN_DENIAL=DENY",
      "FINAL_BOUNDARY_SELF_HISTORY_TEXT=The user's alleged prior statement/history is not first-person memory. Keep its truth unresolved. Do not say a certain 'I did' or 'I did not / I never said that', do not soften a denial into 'I think I did not', do not pivot into a new present opinion about the topic, and do not invent a motive or explanation. If this response also has a USER_TASK slot, resolve the history status briefly and still complete the task.",
    );
  }

  if (String(response.responseFunction || "") === "RESPOND_TO_VENT_WITHOUT_ADVICE") {
    lines.push(
      "FINAL_VENT_MODE=ACKNOWLEDGMENT_ONLY",
      "FINAL_VENT_ADVICE=DENY",
      "FINAL_VENT_CALMING_INSTRUCTION=DENY",
      "FINAL_VENT_SOLICIT_MORE_DISCLOSURE=DENY",
      "FINAL_VENT_INDEFINITE_SUPPORT_PROMISE=DENY",
      "FINAL_BOUNDARY_VENT_TEXT=Give one short in-character acknowledgment and stop. Do not advise, tell the user to relax or put things aside, invite unlimited further disclosure, or promise indefinite availability.",
    );
  }

  if (String(response.responseFunction || "") === "ANSWER_SELF_MOTIVE_KNOWLEDGE_STATUS") {
    lines.push(
      "FINAL_SELF_MOTIVE_RECENT_STATE=UNRESOLVED",
      "FINAL_SELF_MOTIVE_DEFINITE_RECENT_ACTIVITY=DENY",
      "FINAL_SELF_MOTIVE_ALTERNATE_STATE=DENY",
      "FINAL_BOUNDARY_SELF_MOTIVE_TEXT=The user's observation of recent behavior is not first-person memory authority. Do not answer with a definite alternate recent state such as 'I was not listening', 'I was asleep', or 'I was busy'. Respond to the user's observation without filling in what actually happened.",
    );
  }

  if (String(response.responseFunction || "") === "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY") {
    const weak = propositions.find((item) => String(item?.type || "") === "WEAK_INFERENCE") || {};
    const signalActor = String(weak?.signalActor || "EXTERNAL_OTHER");
    lines.push(
      "FINAL_WEAK_INFERENCE_UNCERTAINTY_REQUIRED=true",
      "FINAL_WEAK_INFERENCE_SIGNAL_ACK_REQUIRED=true",
      `FINAL_WEAK_INFERENCE_SIGNAL_ACTOR=${contractAtom(signalActor)}`,
      "FINAL_WEAK_INFERENCE_ACTOR_OWNERSHIP=PRESERVE",
      `FINAL_WEAK_INFERENCE_ACTIVE_PERSONA_IS_SIGNAL_ACTOR=${signalActor === "ACTIVE_CHARACTER_IDENTITY" ? "true" : "false"}`,
      "FINAL_BOUNDARY_WEAK_INFERENCE_TEXT=Mention only the concrete limited signal and preserve uncertainty. Do not answer with only a bare 'don't know'. When FINAL_WEAK_INFERENCE_ACTIVE_PERSONA_IS_SIGNAL_ACTOR=false, the active Persona did NOT send/read/ignore/change-topic according to this TurnPlan: never use first-person language to justify, deny, or explain that external signal. Do not replace uncertainty with a made-up cause such as being busy, distracted, annoyed, or shy, and do not invent a follow-up chase/action plan. One quick tentative social read at most, then stop.",
    );
  }

  if (String(response.responseFunction || "") === "COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION") {
    lines.push(
      "FINAL_IDENTITY_PLUS_STANCE_TWO_SLOTS=true",
      "FINAL_BOUNDARY_IDENTITY_PLUS_STANCE_TEXT=Answer both requested slots and stop: give the character name, then the direct personal reaction/opinion. Do not let identity grounding swallow the second question and do not append biography.",
    );
  }

  if (String(response.responseFunction || "") === "ANSWER_MEMORY_CAUSE_OR_UNKNOWN") {
    lines.push(
      "FINAL_MEMORY_ENTITY_GROUNDED=true",
      "FINAL_MEMORY_FACT_AUTHORITY=CONTROLLED_DURABLE_MEMORY",
      "FINAL_MEMORY_CAUSE_STATUS=UNKNOWN_UNLESS_EXPLICITLY_STORED",
      "FINAL_MEMORY_MOTIVE_INFERENCE=DENY",
      "FINAL_BOUNDARY_MEMORY_CAUSE_TEXT=Use the stored Memory fact only as the known premise. If that fact does not explicitly state the reason/cause, say the reason is unknown or not recorded. Do not invent impulse, habit, timing suitability, hidden motive, past event, or current state to make the answer sound natural.",
    );
  }

  if (["ANSWER_OPEN_PERSONA_OPINION", "COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION"].includes(String(response.responseFunction || ""))) {
    lines.push(
      "FINAL_OPEN_PERSONA_OPINION_SCOPE=DIRECT_STANCE_ONLY",
      "FINAL_OPEN_PERSONA_OPINION_SELF_ANALYSIS=DENY",
      "FINAL_OPEN_PERSONA_OPINION_ACTION_PLAN=DENY_UNLESS_ASKED",
      "FINAL_BOUNDARY_OPEN_OPINION_TEXT=Answer the asked feeling/opinion directly in one or two short in-character sentences. If the user asks how you would interpret their own visible/chat signal (for example disappearing or going silent), answer the hypothetical interpretation directly; do not pretend the signal was an external actor and do not invent a past first-person memory of what you actually thought. Do not turn it into a persona dossier, long self-analysis, social strategy, damage-control plan, or generic essay unless the user asked for that analysis.",
    );
    if (String(plan?.utteranceAct?.activity || "") === "current_reaction") {
      lines.push(
        "FINAL_LAST_MILE_MODE=CURRENT_PERSONA_REACTION",
        "FINAL_LAST_MILE_CURRENT_REACTION_CAUSAL_STORY=DENY",
        "FINAL_LAST_MILE_CURRENT_REACTION_TEXT=You may answer the present reaction/stance directly, but do not invent what you were doing, what you were checking, what happened just before, or a causal story explaining why you feel that way.",
      );
    }
  }

  if (["ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT", "RESPOND_TO_THIRD_PARTY_REPORT", "RESPOND_TO_REPORTED_PROSPECTIVE_REQUEST"].includes(String(response.responseFunction || ""))) {
    const prospectiveAllowed = Array.isArray(response.allowedPredicates) && response.allowedPredicates.includes("PROSPECTIVE_PERSONA_VOLITION");
    lines.push(
      "FINAL_CURRENT_REACTION_ALLOWED=true",
      `FINAL_PROSPECTIVE_PERSONA_STANCE_ALLOWED=${prospectiveAllowed ? "true" : "false"}`,
      "FINAL_PROSPECTIVE_STANCE_IS_NOT_EXTERNAL_FACT=true",
    );
  }

  if (String(response.responseFunction || "") === "ANSWER_LIMITED_PRACTICAL_TASK") {
    const firstOnly = Boolean(plan?.taskContract?.firstActionOnly);
    lines.push(
      "FINAL_TASK_DEPTH=ORDINARY_USER_LEVEL_ONLY",
      `FINAL_TASK_STEPS=${firstOnly ? "EXACTLY_ONE_FIRST_ACTION" : "ONE_OR_TWO_OBVIOUS_CHECKS_MAX"}`,
      `FINAL_TASK_FIRST_ACTION_ONLY=${firstOnly ? "true" : "false"}`,
      `FINAL_TASK_NUMBERED_LIST=${firstOnly ? "DENY" : "DENY_UNLESS_USER_REQUESTED"}`,
      `FINAL_TASK_FALLBACK=${firstOnly ? "DENY_UNLESS_USER_ASKS_NEXT" : "ALLOW_ONE_OBVIOUS_FALLBACK"}`,
      "FINAL_TASK_HELPDESK_ARTICLE=DENY",
      "FINAL_TASK_SPECIALIST_DIAGNOSIS=DENY",
    );
  }

  if (String(response.responseFunction || "") === "RETURN_REPLY_DRAFT") {
    lines.push(
      "FINAL_REPLY_DRAFT_ONLY=true",
      "FINAL_REPLY_DRAFT_ITEM_COUNT=1",
      "FINAL_REPLY_DRAFT_PREFACE=DENY",
      "FINAL_REPLY_DRAFT_EXPLANATION=DENY",
      "FINAL_REPLY_DRAFT_NEW_REASON_OR_EVENT=DENY",
      "FINAL_REPLY_DRAFT_NEW_COMMITMENT=DENY",
      "FINAL_BOUNDARY_REPLY_DRAFT_TEXT=Return exactly one sendable reply sentence and stop. Preserve the communicative intent the user asked for. Do not invent illness, tiredness, travel, promises, next-time make-up plans, or any other reason/event/commitment the user did not provide.",
    );
  }

  if (String(response.responseFunction || "") === "RETURN_REWRITTEN_TEXT") {
    lines.push(
      "FINAL_REWRITE_ONLY=true",
      `FINAL_REWRITE_SOURCE_JSON=${contractJson(plan?.taskContract?.sourceText || "")}`,
      "FINAL_REWRITE_SEMANTIC_PRESERVATION=REQUIRED",
      "FINAL_REWRITE_MODALITY_PRESERVATION=REQUIRED",
      "FINAL_REWRITE_CERTAINTY_STRENGTH_CHANGE=DENY",
      "FINAL_REWRITE_NEW_COMMITMENT=DENY",
      "FINAL_REWRITE_NEW_REASON_OR_EVENT=DENY",
      "FINAL_REWRITE_PREFACE=DENY",
      "FINAL_REWRITE_EXPLANATION=DENY_UNLESS_REQUESTED",
      "FINAL_REWRITE_ALTERNATIVES=DENY_UNLESS_REQUESTED",
      "FINAL_BOUNDARY_REWRITE_TEXT=Change wording/tone only. Preserve the source proposition: who/what/when, negation, availability, and epistemic modality/certainty must remain the same. If the source says possible/maybe/probably, the rewrite must remain uncertain rather than becoming definite. Do not add promises, future commitments, reasons, events, or a different activity.",
    );
  }

  if (plan?.taskContract?.firstActionOnly) {
    lines.push(
      "FINAL_TASK_SCOPE=FIRST_ACTION_ONLY",
      "FINAL_TASK_ITEM_COUNT=1",
      "FINAL_TASK_SECOND_ACTION=DENY",
      "FINAL_TASK_FALLBACK=DENY_UNLESS_USER_ASKS_NEXT",
      "FINAL_TASK_REASON=AT_MOST_ONE_SHORT_REASON",
      "FINAL_TASK_PEP_TALK=DENY",
      "FINAL_BOUNDARY_FIRST_ACTION_TEXT=Return exactly one first action and end the response there. At most one short reason may follow that same action. Do not add an if/then fallback, 'if it still fails then...', a second action, the next step, a checklist, or a pep talk.",
    );
  }

  if (plan?.taskContract?.arithmeticGrounding?.result) {
    lines.push(
      "FINAL_TASK_ARITHMETIC_GROUNDING=AUTHORITATIVE_TURNPLAN",
      `FINAL_TASK_ARITHMETIC_EXPRESSION=${contractAtom(plan.taskContract.arithmeticGrounding.expression)}`,
      `FINAL_TASK_ARITHMETIC_RESULT=${contractAtom(plan.taskContract.arithmeticGrounding.result)}`,
      "FINAL_TASK_ARITHMETIC_RECALCULATION=DENY",
      "FINAL_BOUNDARY_ARITHMETIC_TEXT=Use FINAL_TASK_ARITHMETIC_RESULT exactly for the numeric answer. Do not recompute it in natural-language generation or move the decimal point.",
    );
  }

  if (String(response.responseFunction || "") === "COMPLETE_USER_TASK") {
    const sentenceCount = Number(response?.sentenceCount || 0);
    if (sentenceCount > 0) lines.push(`FINAL_SENTENCE_COUNT=${sentenceCount}`);
    if (sentenceCount === 1) {
      lines.push(
        "FINAL_ONE_SENTENCE_TASK_PAYLOAD_ONLY=true",
        "FINAL_TASK_PREFACE=DENY",
        "FINAL_TASK_EXPLANATION=DENY",
        "FINAL_TASK_AFTERWORD=DENY",
      );
    }
  }

  if (String(response.responseFunction || "") === "ACK_USER_DISTRESS_BRIEFLY") {
    lines.push(
      "FINAL_USER_DISTRESS_ACK=ONE_SHORT_REACTION",
      "FINAL_USER_DISTRESS_PSYCHOANALYSIS=DENY",
      "FINAL_USER_DISTRESS_THERAPY_INVITATION=DENY",
      "FINAL_USER_DISTRESS_INDEFINITE_SUPPORT=DENY",
      "FINAL_BOUNDARY_USER_DISTRESS_TEXT=Recognize the concrete distress the user stated in one short character-appropriate reaction. Do not diagnose suppression/masks/pressure, explain their psychology, invite them to unpack everything, promise to always listen, or add advice unless they ask for it.",
    );
  }

  if (String(response.responseFunction || "") === "REACT_TO_POSSESSION_BOUNDARY_EVENT") {
    lines.push(
      "FINAL_POSSESSION_EVENT_SCOPE=CURRENT_TURN_ONLY",
      "FINAL_POSSESSION_SAINTLY_SHARING=DENY",
      "FINAL_POSSESSION_FUTURE_GIFT=DENY",
      "FINAL_POSSESSION_HISTORY_GENERALIZATION=DENY",
      "FINAL_BOUNDARY_POSSESSION_TEXT=React only to the current boundary-crossing around the character's belongings. Restrained annoyance, surprise, or a dry boundary is allowed. Do not reframe it as happy sharing, invent a benevolent motive, say this always happens, or promise to prepare/buy more next time.",
    );
  }

  if (String(response.responseFunction || "") === "REACT_TO_ORDINARY_OBJECT_CONCRETELY" || forbidden.includes("OBJECT_PERSONIFICATION") || forbidden.includes("OBJECT_SYMBOLISM")) {
    lines.push(
      "FINAL_ORDINARY_OBJECT_SCOPE=LITERAL_OBJECT_LEVEL",
      "FINAL_ORDINARY_OBJECT_PERSONIFICATION=DENY",
      "FINAL_ORDINARY_OBJECT_SYMBOLISM=DENY",
      "FINAL_BOUNDARY_ORDINARY_OBJECT_TEXT=Stay literal and local to the ordinary object. Give the concrete preference or observation and at most one concrete reason. Do not make the object speak/feel/remember or turn it into a symbol, relationship metaphor, or abstract mood explanation unless the user explicitly requested symbolic interpretation.",
    );
  }

  const taskShape = response?.taskResponseShape && typeof response.taskResponseShape === "object"
    ? response.taskResponseShape
    : null;
  if (taskShape) {
    lines.push(
      `FINAL_TASK_DOCUMENT_FORMATTING=${contractAtom(taskShape.documentFormatting)}`,
      `FINAL_TASK_HELPDESK_FRAME=${contractAtom(taskShape.helpdeskArticleFrame)}`,
      `FINAL_TASK_FORMAL_SUMMARY_FRAME=${contractAtom(taskShape.formalSummaryFrame)}`,
      `FINAL_TASK_CAPABILITY_POLICY=${contractAtom(taskShape.taskCapabilityPolicy)}`,
      `FINAL_TASK_RESPONSE_DEPTH=${contractAtom(taskShape.responseDepth)}`,
      `FINAL_TASK_EXPLANATION_DEPTH=${contractAtom(taskShape.explanationDepth)}`,
    );
    if (String(taskShape.responseDepth || "") === "BRIEF_BY_DEFAULT") {
      lines.push(
        "FINAL_TASK_BRIEF_BY_DEFAULT=true",
        "FINAL_TASK_UNREQUESTED_TUTORIAL=DENY",
        "FINAL_TASK_UNREQUESTED_SCRIPT_EXAMPLES=DENY",
        "FINAL_BOUNDARY_TASK_BREVITY_TEXT=Complete the requested task, but keep ordinary chat tasks compact. Give the required items/order/answer plus at most one short reason per primary point. Do not turn a simple social, appearance, daily-planning, music-practice, or ordinary-tech request into an article, multi-section tutorial, pseudo-scientific explanation, coaching script collection, or unsolicited follow-up offer unless the user explicitly requested detail.",
      );
    }
    if (String(taskShape.explanationDepth || "") === "ORDER_ONLY_NO_STEP_ESSAY") {
      lines.push("FINAL_BOUNDARY_ORDERING_TEXT=Give the requested order using all user-supplied items, with only minimal reason if useful. Do not write a paragraph of rationale for every step.");
    }
  }

  if (String(response.responseFunction || "") === "ANSWER_PERCEPTION_WITH_MEDIA_BOUNDARY") {
    lines.push(
      "FINAL_PERCEPTION_BOUNDARY_REQUIRED=true",
      "FINAL_BOUNDARY_PERCEPTION_TEXT=If current-turn perception is unavailable, do not describe unseen details. When the user already supplied the appearance/outfit facts in text, answer only from those facts in one or two short in-character sentences; do not turn it into a stylist article, add unprovided body/hair/material details, propose a full wardrobe, or ask for a photo unless the user actually needs visual assessment beyond the supplied description. A minimal request for missing image/description is allowed only when necessary.",
    );
  }

  const semanticDenyPriority = [
    "SELF_KNOWLEDGE_SUBSTITUTION",
    "SELF_EXPLANATION_SUBSTITUTION",
    "CERTAIN_AUTOBIOGRAPHICAL_DENIAL",
    "REPORT_TRUE",
    "REPORT_FALSE",
    "ALTERNATE_CAUSE_INFERENCE",
    "PAST_MENTAL_STATE_INVENTION",
    "HISTORICAL_FREQUENCY_GENERALIZATION",
    "THIRD_PARTY_MOTIVE_INVENTION",
    "MIND_READING",
    "TARGET_MIND_READING",
    "ALTERNATE_CAUSE_INVENTION",
    "UNREPORTED_EVENT_ASSERTION",
    "USER_PREMISE_HISTORICAL_EXPANSION",
  ];
  const orderedForbidden = [
    ...semanticDenyPriority.filter((key) => forbidden.includes(key)),
    ...forbidden.filter((key) => !semanticDenyPriority.includes(key)),
  ];
  const denyTexts = [...new Set(orderedForbidden.map((key) => FINAL_BOUNDARY_DENY_TEXT[String(key || "")]).filter(Boolean))];
  denyTexts.slice(0, 8).forEach((text, index) => lines.push(`FINAL_DENY_${index + 1}=${text}`));

  if (response.forbidAllOtherPredicates || response.noExtraClause) {
    lines.push("FINAL_STOP_AFTER_ALLOWED_CONTENT=true");
  }
}

function pushProposition(lines, proposition, index) {
  const prefix = `P${index + 1}`;
  lines.push(
    `${prefix}.ID=${contractAtom(proposition?.propositionId, prefix)}`,
    `${prefix}.TYPE=${contractAtom(proposition?.type)}`,
    `${prefix}.SUBJECT=${contractAtom(proposition?.subject)}`,
    `${prefix}.PREDICATE=${contractAtom(proposition?.predicate)}`,
  );

  for (const key of ["value", "source", "timeScope", "evidenceClass", "object", "activity", "stateKind", "locationContext", "sourceEntity", "signalActor", "requestedSpeaker", "requestedAddressee", "requestedUtterance"]) {
    const value = proposition?.[key];
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${prefix}.${contractKey(key)}=${contractAtom(value)}`);
  }

  for (const key of ["eventText", "claimText"]) {
    const value = proposition?.[key];
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${prefix}.${contractKey(key)}_JSON=${contractJson(value)}`);
  }

  const rights = proposition?.assertionRights && typeof proposition.assertionRights === "object"
    ? proposition.assertionRights
    : {};
  for (const key of Object.keys(rights).sort()) {
    lines.push(`${prefix}.ASSERTION_RIGHTS.${contractKey(key)}=${contractAtom(rights[key])}`);
  }
}

function pushTaskContract(lines, task) {
  const value = task && typeof task === "object" ? task : {};
  lines.push(
    `TASK_REQUIRED=${contractAtom(Boolean(value.required), "false")}`,
    `TASK_TYPE=${contractAtom(value.type, "NONE")}`,
    `TASK_REQUIRED_ITEM_COUNT=${value.requiredItemCount == null ? "UNSPECIFIED" : contractAtom(value.requiredItemCount)}`,
    `TASK_ORDERING_REQUIRED=${contractAtom(Boolean(value.orderingRequired), "false")}`,
    `TASK_FIRST_ACTION_ONLY=${contractAtom(Boolean(value.firstActionOnly), "false")}`,
  );
  if (value.arithmeticGrounding?.result) {
    lines.push(
      `TASK_ARITHMETIC_KIND=${contractAtom(value.arithmeticGrounding.kind)}`,
      `TASK_ARITHMETIC_EXPRESSION=${contractAtom(value.arithmeticGrounding.expression)}`,
      `TASK_ARITHMETIC_RESULT=${contractAtom(value.arithmeticGrounding.result)}`,
    );
  }
  if (value.sourceText) lines.push(`TASK_SOURCE_TEXT_JSON=${contractJson(value.sourceText)}`);
  const capability = value.capability && typeof value.capability === "object" ? value.capability : {};
  lines.push(
    `TASK_CAPABILITY_PERSONA=${contractAtom(capability.personaId, "UNRESOLVED")}`,
    `TASK_CAPABILITY_DOMAIN=${contractAtom(capability.domain, "UNSPECIFIED")}`,
    `TASK_CAPABILITY_LEVEL=${contractAtom(capability.level, "UNSPECIFIED")}`,
    `TASK_CAPABILITY_BASIS=${contractAtom(capability.basis, "UNSPECIFIED")}`,
    `TASK_CAPABILITY_POLICY=${contractAtom(capability.policy, "UNSPECIFIED")}`,
  );
  const constraints = value.constraints && typeof value.constraints === "object" ? value.constraints : {};
  lines.push(
    `TASK_SENTENCE_COUNT=${constraints.sentenceCount == null ? "UNSPECIFIED" : contractAtom(constraints.sentenceCount)}`,
    `TASK_EXPLANATION=${contractAtom(constraints.explanation)}`,
    `TASK_ALTERNATIVES=${contractAtom(constraints.alternatives)}`,
    `TASK_FILENAME_ONLY=${contractAtom(Boolean(constraints.filenameOnly), "false")}`,
    `TASK_PRESERVE_USER_ITEMS=${contractAtom(Boolean(constraints.preserveUserItems), "false")}`,
    `TASK_SEMANTIC_PRESERVATION=${contractAtom(constraints.semanticPreservation)}`,
    `TASK_MODALITY_PRESERVATION=${contractAtom(constraints.modalityPreservation)}`,
    `TASK_SEMANTIC_EXPANSION=${contractAtom(constraints.semanticExpansion)}`,
    `TASK_NEW_COMMITMENTS=${contractAtom(constraints.newCommitments)}`,
    `TASK_NEW_REASONS_OR_EVENTS=${contractAtom(constraints.newReasonsOrEvents)}`,
    `TASK_FIRST_ACTION_ONLY_CONSTRAINT=${contractAtom(constraints.firstActionOnly)}`,
    `TASK_RESPONSE_DEPTH=${contractAtom(constraints.responseDepth)}`,
    `TASK_EXPLANATION_DEPTH=${contractAtom(constraints.explanationDepth)}`,
  );
}

function pushHistoryPolicy(lines, history) {
  const value = history && typeof history === "object" ? history : {};
  lines.push(
    `HISTORY_REQUIRED=${contractAtom(Boolean(value.required), "false")}`,
    `HISTORY_PURPOSE=${contractAtom(value.purpose, "NONE")}`,
    `HISTORY_DURABLE_TRANSCRIPT_OWNER=${contractAtom(value.durableTranscriptOwner, "OPENCLAW")}`,
    `HISTORY_MODEL_FACING_OWNER=${contractAtom(value.modelFacingHistoryOwner, "RANA_CONTEXT_ENGINE")}`,
    `HISTORY_PRIOR_USER_DEFAULT_AUTHORITY=${contractAtom(value.priorUserDefaultAuthority, "CLAIM_UNVERIFIED")}`,
    `HISTORY_PRIOR_ASSISTANT_AUTOBIOGRAPHICAL_AUTHORITY=${contractAtom(value.priorAssistantAutobiographicalAuthority, "NONAUTHORITATIVE")}`,
    `HISTORY_PRIOR_ASSISTANT_PERSONA_STYLE_AUTHORITY=${contractAtom(value.priorAssistantPersonaStyleAuthority, "DENY")}`,
    `HISTORY_CANONICAL_CONTINUITY_USE=${contractAtom(value.canonicalContinuityUse, "ALLOW_WHEN_VERIFIED")}`,
  );
}

function pushResponseContract(lines, response) {
  const value = response && typeof response === "object" ? response : {};
  const slots = Array.isArray(value.slots) ? value.slots : [];
  lines.push(
    `RESPONSE_FUNCTION=${contractAtom(value.responseFunction)}`,
    `OUTPUT_SLOT_COUNT=${contractAtom(value.outputSlotCount ?? slots.length, "0")}`,
    `RENDER_EXACTLY_ONE_SLOT=${contractAtom(Boolean(value.renderExactlyOneSlot), "false")}`,
  );
  slots.forEach((slot, index) => {
    const prefix = `S${index + 1}`;
    lines.push(
      `${prefix}.ID=${contractAtom(slot?.slotId, prefix)}`,
      `${prefix}.TYPE=${contractAtom(slot?.type)}`,
    );
    if (slot?.propositionId) lines.push(`${prefix}.PROPOSITION_ID=${contractAtom(slot.propositionId)}`);
    if (slot?.itemCount != null) lines.push(`${prefix}.ITEM_COUNT=${contractAtom(slot.itemCount)}`);
    if (slot?.sourceAuthority) lines.push(`${prefix}.SOURCE_AUTHORITY=${contractAtom(slot.sourceAuthority)}`);
    if (slot?.domain) lines.push(`${prefix}.DOMAIN=${contractAtom(slot.domain)}`);
  });
  lines.push(
    `ALLOWED_OUTPUT_PREDICATES=${(value.allowedPredicates || []).map((item) => contractAtom(item)).join("|") || "NONE"}`,
    `REQUIRED_OUTPUT_PREDICATES=${(value.requiredPredicates || []).map((item) => contractAtom(item)).join("|") || "NONE"}`,
    `FORBIDDEN_OUTPUT_PREDICATES=${(value.forbiddenPredicates || []).map((item) => contractAtom(item)).join("|") || "NONE"}`,
    `FORBID_ALL_OTHER_PREDICATES=${contractAtom(Boolean(value.forbidAllOtherPredicates), "false")}`,
    `NO_EXTRA_CLAUSE=${contractAtom(Boolean(value.noExtraClause), "false")}`,
    `RESPONSE_SENTENCE_COUNT=${value.sentenceCount == null ? "UNSPECIFIED" : contractAtom(value.sentenceCount)}`,
    `RESPONSE_EXPLANATION=${contractAtom(value.explanation)}`,
    `RESPONSE_ALTERNATIVES=${contractAtom(value.alternatives)}`,
  );

  const taskShape = value.taskResponseShape && typeof value.taskResponseShape === "object"
    ? value.taskResponseShape
    : null;
  if (taskShape) {
    lines.push(
      `TASK_RESPONSE_SHAPE_IS_BINDING=${contractAtom(taskShape.binding === "REQUIRED", "false")}`,
      `TASK_USER_FACING_REGISTER=${contractAtom(taskShape.userFacingRegister)}`,
      `TASK_DOCUMENT_FORMATTING=${contractAtom(taskShape.documentFormatting)}`,
      `TASK_LIGHT_ENUMERATION=${contractAtom(taskShape.lightEnumeration)}`,
      `TASK_TECHNICAL_TOKEN_POLICY=${contractAtom(taskShape.technicalTokenPolicy)}`,
      `TASK_CAPABILITY_POLICY=${contractAtom(taskShape.taskCapabilityPolicy)}`,
      `TASK_HELPDESK_ARTICLE_FRAME=${contractAtom(taskShape.helpdeskArticleFrame)}`,
      `TASK_FORMAL_SUMMARY_FRAME=${contractAtom(taskShape.formalSummaryFrame)}`,
      `TASK_RESPONSE_DEPTH=${contractAtom(taskShape.responseDepth)}`,
      `TASK_EXPLANATION_DEPTH=${contractAtom(taskShape.explanationDepth)}`,
    );
  }
}

function pushPersonaPolicy(lines, policy) {
  const value = policy && typeof policy === "object" ? policy : {};
  lines.push(
    `PERSONA_FACT_AUTHORITY=${contractAtom(value.factAuthority, "DENY")}`,
    `PERSONA_MAY_OVERRIDE_ASSERTION_RIGHTS=${contractAtom(Boolean(value.mayOverrideAssertionRights), "false")}`,
    `PERSONA_MAY_OVERRIDE_RESPONSE_FUNCTION=${contractAtom(Boolean(value.mayOverrideResponseFunction), "false")}`,
    `PERSONA_MAY_OVERRIDE_TASK_RESPONSE_SHAPE=${contractAtom(Boolean(value.mayOverrideTaskResponseShape), "false")}`,
    `PERSONA_RELATIONSHIP_STANCE_PROJECTION=${contractAtom(value.relationshipStanceProjection, "DENY")}`,
    `PERSONA_RELATIONSHIP_STANCE_FACT_AUTHORITY=${contractAtom(value.relationshipStanceFactAuthority, "DENY")}`,
    `PERSONA_RELATIONSHIP_TARGET_MOTIVE_AUTHORITY=${contractAtom(value.relationshipTargetMotiveAuthority, "DENY")}`,
    `PERSONA_RELATIONSHIP_TARGET_INTERNAL_STATE_AUTHORITY=${contractAtom(value.relationshipTargetInternalStateAuthority, "DENY")}`,
    `PERSONA_RELATIONSHIP_HISTORY_EXPANSION=${contractAtom(value.relationshipHistoryExpansion, "DENY")}`,
  );
}

function pushIdentityNamespace(lines, identity) {
  const value = identity && typeof identity === "object" ? identity : {};
  lines.push(
    `ACTIVE_CHARACTER_IDENTITY_SOURCE=${contractAtom(value.activeCharacterIdentity, "RESOLVED_PERSONA_CONTEXT")}`,
    `RUNTIME_MODEL_IDENTITY_AUTHORITY=${contractAtom(value.runtimeModelIdentityAuthority, "OPENCLAW_HOST_SYSTEM")}`,
    `CHARACTER_AND_RUNTIME_MODEL_SAME_NAMESPACE=${contractAtom(Boolean(value.sameNamespace), "false")}`,
    `USER_CHARACTER_IDENTITY_OVERRIDE=${contractAtom(value.userCharacterIdentityOverride, "DENY")}`,
    `IDENTITY_OVERRIDE_ATTEMPT=${contractAtom(Boolean(value.identityOverrideAttempt), "false")}`,
  );
}

function pushOutputPolicy(lines, outputPolicy) {
  const value = outputPolicy && typeof outputPolicy === "object" ? outputPolicy : {};
  lines.push(
    `OUTPUT_TYPE=${contractAtom(value.outputType, "SPOKEN_CONTENT_ONLY")}`,
    `SIMULATE_SCENE=${contractAtom(value.simulateScene, "DENY")}`,
    `DESCRIBE_PHYSICAL_ACTION=${contractAtom(value.describePhysicalAction, "DENY")}`,
    `DESCRIBE_FACIAL_EXPRESSION=${contractAtom(value.describeFacialExpression, "DENY")}`,
    `DESCRIBE_GAZE=${contractAtom(value.describeGaze, "DENY")}`,
    `DESCRIBE_VOICE_OR_DELIVERY=${contractAtom(value.describeVoiceOrDelivery, "DENY")}`,
    `PARENTHETICAL_ROLEPLAY_ACTION=${contractAtom(value.parentheticalRoleplayAction, "DENY")}`,
    `INTERNAL_SCHEMA_TERMS_IN_OUTPUT=${contractAtom(value.internalSchemaTermsInOutput, "DENY")}`,
  );
}

function pushControlledEvidencePolicy(lines, plan, event, ctx) {
  const type = String(plan?.semanticAuthority?.type || "ORDINARY");
  const explicitR3 = new Set(plan?.semanticLanes || []);
  const r3OwnsAuthority = [
    "RUNTIME_MODEL_IDENTITY",
    "CHARACTER_IDENTITY",
    "SELF_HISTORY",
    "SELF_MOTIVE",
    "THIRD_PARTY_SELF_REPORT",
    "CURRENT_STATE",
    "SELF_CAPABILITY",
    "POSITIVE_SESSION_CONTINUITY",
    "SCENE_SOCIAL_INTERACTION",
    "USER_IMPRESSION",
    "INTERPERSONAL_REQUEST",
    "OPEN_PERSONA_OPINION",
    "SOCIAL_ACT",
    "TOPIC_FRAGMENT",
  ].some((lane) => explicitR3.has(lane));

  if (type === "LORE" && !r3OwnsAuthority) {
    const persona = resolveBotContext(event, ctx)?.personaId;
    lines.push(
      "CONTROLLED_EVIDENCE_KIND=PERSONA_LORE",
      `CONTROLLED_EVIDENCE_PERSONA=${persona || "unknown"}`,
      "CONTROLLED_EVIDENCE_REQUIRED=true",
      "CONTROLLED_EVIDENCE_MISSING_COVERAGE=UNRESOLVED",
      "CONTROLLED_EVIDENCE_NARROWER_UNSUPPORTED_PREDICATE=DENY",
    );
  } else if (type === "PERCEPTION_UNAVAILABLE" && !r3OwnsAuthority) {
    const available = hasCurrentTrustedImage(event, ctx);
    lines.push(
      "CONTROLLED_EVIDENCE_KIND=CURRENT_TURN_PERCEPTION",
      `PERCEPTION_STATUS=${available ? "AVAILABLE_CURRENT_TURN" : "UNAVAILABLE"}`,
      available
        ? "VISUAL_ASSERTION=ALLOW_WITHIN_TRUSTED_CURRENT_TURN_EVIDENCE"
        : "VISUAL_ASSERTION=DENY",
      "UNRELATED_PERSONA_FACT_INVENTION=DENY",
    );
  } else if (type === "WEAK_INFERENCE" && !r3OwnsAuthority) {
    lines.push(
      "CONTROLLED_EVIDENCE_KIND=WEAK_INFERENCE_COMPAT",
      "INFERENCE_TRUTH=UNVERIFIED",
      "CONFIRM_INFERENCE=DENY",
      "ALTERNATE_CAUSE_INVENTION=DENY",
      "UNCERTAINTY_PRESERVATION=REQUIRED",
    );
  } else if (type === "LOCAL_EVENT" && !r3OwnsAuthority) {
    lines.push(
      "CONTROLLED_EVIDENCE_KIND=USER_ASSERTED_LOCAL_EVENT",
      "EVENT_STATUS=USER_ASSERTED_CURRENT_TURN",
      "EVENT_SCOPE=THIS_TURN_ONLY",
      "HISTORICAL_EXPANSION=DENY",
      "MOTIVE_INFERENCE=DENY",
    );
  }

  if (plan?.evidence?.source === "external_current") {
    lines.push(
      "CURRENT_EXTERNAL_EVIDENCE_REQUIRED=true",
      "CURRENT_EXTERNAL_EVIDENCE_WITHOUT_EVIDENCE=UNRESOLVED",
    );
  }

  if (plan?.tool?.requested) {
    lines.push(
      "TOOL_REQUESTED=true",
      `TOOL_NAME=${contractAtom(plan.tool.toolName, "UNRESOLVED")}`,
      "TOOL_SUCCESS_REQUIRED_FOR_EXTERNAL_ACTION_CLAIM=true",
    );
  }
}

function compactOrdinaryContractEligible(plan) {
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

export function buildR3CompiledContractContext(plan, event, ctx) {
  if (!plan?.currentUser) return "";
  if (!plan?.r3CompilerVersion) return "";

  if (compactOrdinaryContractEligible(plan)) {
    const lanes = Array.isArray(plan.semanticLanes) ? plan.semanticLanes : [];
    const allowed = Array.isArray(plan?.responseContract?.allowedPredicates)
      ? plan.responseContract.allowedPredicates
      : [];
    const forbidden = Array.isArray(plan?.responseContract?.forbiddenPredicates)
      ? plan.responseContract.forbiddenPredicates
      : [];
    return [
      "TURN CONTEXT — R3_COMPACT_ORDINARY (deterministic runtime contract; not dialogue):",
      `COMPILER_OUTPUT_VERSION=${contractAtom(plan.r3CompilerVersion)}`,
      `UTTERANCE_ACT=${contractAtom(plan?.utteranceAct?.type, "ASSERTION")}`,
      `UTTERANCE_SUBTYPE=${contractAtom(plan?.utteranceAct?.subtype, "USER_STATEMENT")}`,
      `LANES=${lanes.map((lane) => contractAtom(lane)).join("|") || "ORDINARY_PERSONA"}`,
      `RESPONSE_FUNCTION=${contractAtom(plan?.responseContract?.responseFunction, "NATURAL_RESPONSE_WITHIN_RIGHTS")}`,
      `ALLOWED_OUTPUT_PREDICATES=${allowed.length ? allowed.map((item) => contractAtom(item)).join("|") : "UNSPECIFIED"}`,
      `FORBIDDEN_OUTPUT_PREDICATES=${forbidden.length ? forbidden.map((item) => contractAtom(item)).join("|") : "NONE"}`,
      "PERSONA_FACT_AUTHORITY=DENY",
      "OUTPUT_TYPE=SPOKEN_CONTENT_ONLY",
      "SIMULATE_SCENE=DENY",
      "INTERNAL_SCHEMA_TERMS_IN_OUTPUT=DENY",
    ].join("\n");
  }

  const lanes = Array.isArray(plan.semanticLanes) ? plan.semanticLanes : [];
  const propositions = Array.isArray(plan.propositions) ? plan.propositions : [];
  const lines = [
    "TURN CONTEXT — R3_COMPILED_CONTRACT (deterministic runtime contract; not dialogue):",
    `COMPILER_OUTPUT_VERSION=${contractAtom(plan.r3CompilerVersion)}`,
    `LEGACY_TURN_PLAN_VERSION=${contractAtom(plan.version)}`,
    `UTTERANCE_ACT=${contractAtom(plan?.utteranceAct?.type, "ASSERTION")}`,
    `UTTERANCE_SUBTYPE=${contractAtom(plan?.utteranceAct?.subtype, "USER_STATEMENT")}`,
    `UTTERANCE_TARGET=${contractAtom(plan?.utteranceAct?.target, "NONE")}`,
    `UTTERANCE_ACTIVITY=${contractAtom(plan?.utteranceAct?.activity, "NONE")}`,
    ...(plan?.utteranceAct?.requestedSpeaker ? [`UTTERANCE_REQUESTED_SPEAKER=${contractAtom(plan.utteranceAct.requestedSpeaker)}`] : []),
    ...(plan?.utteranceAct?.requestedAddressee ? [`UTTERANCE_REQUESTED_ADDRESSEE=${contractAtom(plan.utteranceAct.requestedAddressee)}`] : []),
    ...(plan?.utteranceAct?.requestedUtterance ? [`UTTERANCE_REQUESTED_UTTERANCE=${contractAtom(plan.utteranceAct.requestedUtterance)}`] : []),
    `LANE_COUNT=${lanes.length}`,
  ];

  lanes.forEach((lane, index) => lines.push(`LANE_${index + 1}=${contractAtom(lane)}`));
  lines.push(`PROPOSITION_COUNT=${propositions.length}`);
  propositions.forEach((proposition, index) => pushProposition(lines, proposition, index));

  pushHistoryPolicy(lines, plan.historyPolicy);
  pushTaskContract(lines, plan.taskContract);
  pushResponseContract(lines, plan.responseContract);
  pushPersonaPolicy(lines, plan.personaPolicy);
  pushIdentityNamespace(lines, plan.identityNamespace);
  pushOutputPolicy(lines, plan.outputPolicy);
  lines.push(`SCENE_KIND=${contractAtom(plan.r3SceneKind, "NONE")}`);
  pushControlledEvidencePolicy(lines, plan, event, ctx);
  pushFinalResponseBoundary(lines, plan);

  return lines.join("\n");
}

export function buildTurnContextProjection(event, ctx) {
  const plan = authoritativeTurnPlanFor(event, ctx, { create: true });
  if (!plan?.currentUser) return "";
  return buildR3CompiledContractContext(plan, event, ctx);
}

export function registerTurnContextProjection(api) {
  api.on("before_prompt_build", (event, ctx) => {
    const projection = buildTurnContextProjection(event, ctx);
    if (!projection) return;
    return { appendSystemContext: projection };
  }, { priority: 1_275, timeoutMs: 2_000 });
}

export const __test = { buildTurnContextProjection, buildR3CompiledContractContext, buildTypedAuthorityContext, hasCurrentTrustedImage, pushFinalResponseBoundary };

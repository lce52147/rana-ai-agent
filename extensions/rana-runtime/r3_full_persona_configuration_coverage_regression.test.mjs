import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { PERSONA_IDS, getPersonaProfile, stablePersonaProfile } from "./persona_registry.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { __test as turnContextProjectionTest } from "./architecture/turn_context_projection.js";
import {
  buildPersonaGenerationContext,
  buildPersonaRelationshipContext,
} from "./persona_context.js";

function personaCtx(id) {
  return {
    accountId: id === "rana" ? "default" : id,
    agentId: id === "rana" ? "main" : id,
    sessionKey: `agent:${id === "rana" ? "main" : id}:discord:channel:r3-full-persona-audit`,
  };
}

function loadConfig(id) {
  const profile = getPersonaProfile(id);
  return JSON.parse(fs.readFileSync(`${profile.workspace}\\PERSONA.json`, "utf8").replace(/^\uFEFF/u, ""));
}

const CONFIGS = Object.fromEntries(PERSONA_IDS.map((id) => [id, loadConfig(id)]));
const CONTROLLED_TOP_LEVEL_KEYS = Object.freeze([
  "schema",
  "revision",
  "personaId",
  "botId",
  "canonicalName",
  "recognitionAliases",
  "lorePolicy",
  "identityResponse",
  "roleCore",
  "interactionPolicy",
  "turnModes",
  "references",
  "relationships",
].sort());
const LORE_AUTHORITY_FILES = Object.freeze({
  rana: "C:\\Users\\Administrator\\.openclaw\\workspace\\LORE\\runtime\\06_Rana_Character_Impressions.json",
  tomori: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\tomori\\LORE\\runtime\\06_Tomori_Character_Impressions.json",
  anon: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\anon\\LORE\\runtime\\06_Anon_Character_Impressions.json",
  soyo: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\soyo\\LORE\\runtime\\06_Soyo_Character_Impressions.json",
  taki: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\taki\\LORE\\runtime\\06_Taki_Character_Impressions.json",
});

function otherPersonaIds(activeId) {
  return PERSONA_IDS.filter((id) => id !== activeId);
}

function activeModeIds(out) {
  const match = out.match(/^ACTIVE_TURN_MODES=(.*)$/mu);
  if (!match || !match[1] || match[1] === "none") return [];
  return match[1].split("|");
}

test("controlled Persona source inventory is complete for all five Personas and all 20 directed pairs", () => {
  assert.equal(PERSONA_IDS.length, 5);

  for (const personaId of PERSONA_IDS) {
    const config = CONFIGS[personaId];
    assert.deepEqual(Object.keys(config).sort(), CONTROLLED_TOP_LEVEL_KEYS, `${personaId} has no unaudited top-level controlled key`);
    assert.equal(typeof config.schema, "string", `${personaId} schema`);
    assert.equal(typeof config.revision, "string", `${personaId} revision`);
    assert.equal(config.personaId, personaId, `${personaId} personaId`);
    assert.ok(config.botId, `${personaId} botId`);
    assert.equal(typeof config.canonicalName, "string", `${personaId} canonicalName`);
    assert.ok(Array.isArray(config.recognitionAliases) && config.recognitionAliases.length > 0, `${personaId} recognitionAliases`);
    assert.ok(config.lorePolicy && typeof config.lorePolicy === "object" && Object.keys(config.lorePolicy).length > 0, `${personaId} lorePolicy`);
    assert.equal(typeof config.identityResponse?.guidance, "string", `${personaId} identityResponse.guidance`);
    assert.ok(Array.isArray(config.roleCore?.responseMechanism), `${personaId} roleCore.responseMechanism`);
    assert.ok(config.roleCore.responseMechanism.length > 0, `${personaId} responseMechanism non-empty`);
    assert.equal(typeof config.roleCore?.stopRule, "string", `${personaId} roleCore.stopRule`);
    assert.equal(typeof config.roleCore?.knowledgeBoundary, "string", `${personaId} roleCore.knowledgeBoundary`);
    assert.ok(Array.isArray(config.roleCore?.assistantLeakAvoid), `${personaId} assistantLeakAvoid`);
    assert.ok(config.roleCore.assistantLeakAvoid.length > 0, `${personaId} assistantLeakAvoid non-empty`);
    assert.equal(typeof config.interactionPolicy?.reportedSelfIntent, "string", `${personaId} interactionPolicy.reportedSelfIntent`);
    assert.ok(Array.isArray(config.turnModes), `${personaId} turnModes`);

    const expectedTargets = otherPersonaIds(personaId).sort();
    assert.deepEqual(Object.keys(config.references || {}).sort(), expectedTargets, `${personaId} references must cover the other four members`);
    assert.deepEqual(Object.keys(config.relationships || {}).sort(), expectedTargets, `${personaId} relationships must cover the other four members`);

    for (const targetId of expectedTargets) {
      const reference = config.references[targetId];
      const relationship = config.relationships[targetId];
      assert.equal(typeof reference.canonicalName, "string", `${personaId}->${targetId} canonicalName`);
      assert.ok(Array.isArray(reference.recognitionAliases) && reference.recognitionAliases.length > 0, `${personaId}->${targetId} recognitionAliases`);
      assert.equal(typeof reference.preferredReference, "string", `${personaId}->${targetId} preferredReference`);
      assert.equal(typeof reference.canonicalNameUsage, "string", `${personaId}->${targetId} canonicalNameUsage`);
      assert.equal(typeof relationship.stance, "string", `${personaId}->${targetId} relationship.stance`);
      assert.equal(typeof relationship.reaction, "string", `${personaId}->${targetId} relationship.reaction`);
      assert.equal(typeof relationship.stopRule, "string", `${personaId}->${targetId} relationship.stopRule`);
    }
  }
});

test("stable identity inventory is complete and agrees with the active Persona package identity", () => {
  for (const personaId of PERSONA_IDS) {
    const profile = stablePersonaProfile(personaId);
    assert.equal(profile.canonicalName, CONFIGS[personaId].canonicalName, `${personaId} canonicalName`);
    assert.equal(profile.band, "MyGO!!!!!", `${personaId} band`);
    assert.ok(profile.role, `${personaId} role`);
    assert.ok(profile.school, `${personaId} school`);
    assert.ok(profile.gradeClass, `${personaId} gradeClass`);
    assert.ok(profile.birthday, `${personaId} birthday`);
    assert.ok(getPersonaProfile(personaId).aliases.length > 0, `${personaId} registry aliases`);
  }
});

test("all 20 directed factual relationship authorities are present independently from delivery profiles", () => {
  let pairCount = 0;
  for (const activeId of PERSONA_IDS) {
    const lore = JSON.parse(fs.readFileSync(LORE_AUTHORITY_FILES[activeId], "utf8").replace(/^\uFEFF/u, ""));
    const characters = Array.isArray(lore.characters) ? lore.characters : [];
    for (const targetId of otherPersonaIds(activeId)) {
      pairCount += 1;
      const targetName = getPersonaProfile(targetId).canonicalName;
      const authority = characters.find((entry) => entry?.canonicalName === targetName);
      assert.ok(authority, `${activeId}->${targetId} factual relationship authority`);
      assert.equal(authority.recognitionLevel, "core", `${activeId}->${targetId} recognitionLevel`);
      assert.ok(Array.isArray(authority.memoryAnchors) && authority.memoryAnchors.length > 0, `${activeId}->${targetId} memoryAnchors`);
      assert.ok(Array.isArray(authority.allowedKnowledge) && authority.allowedKnowledge.length > 0, `${activeId}->${targetId} allowedKnowledge`);
      assert.ok(Array.isArray(authority.forbiddenExpansion) && authority.forbiddenExpansion.length > 0, `${activeId}->${targetId} forbiddenExpansion`);
      assert.equal(stablePersonaProfile(targetId).band, "MyGO!!!!!", `${activeId}->${targetId} group membership`);
    }
  }
  assert.equal(pairCount, 20);
});

test("active Persona controlled roleCore and interactionPolicy reach the generation contract without fact authority", () => {
  for (const personaId of PERSONA_IDS) {
    const config = CONFIGS[personaId];
    const out = buildPersonaGenerationContext({ prompt: "今天隨便聊聊。" }, personaCtx(personaId));

    assert.match(out, /CONTROLLED_PERSONA_CONFIG_AUTHORITY=REALIZATION_ONLY/u, personaId);
    assert.match(out, /CONTROLLED_PERSONA_CONFIG_FACT_AUTHORITY=DENY/u, personaId);
    assert.doesNotMatch(out, /IDENTITY_RESPONSE_GUIDANCE=/u, `${personaId} identityResponse must stay scoped to identity turns`);
    assert.ok(out.includes(`ROLE_CORE_RESPONSE_MECHANISMS_JSON=${JSON.stringify(config.roleCore.responseMechanism)}`), `${personaId} responseMechanism`);
    assert.ok(out.includes(`ROLE_CORE_STOP_RULE=${config.roleCore.stopRule}`), `${personaId} stopRule`);
    assert.ok(out.includes(`ROLE_CORE_KNOWLEDGE_BOUNDARY=${config.roleCore.knowledgeBoundary}`), `${personaId} knowledgeBoundary`);
    assert.ok(out.includes(`ROLE_CORE_ASSISTANT_LEAK_AVOID_JSON=${JSON.stringify(config.roleCore.assistantLeakAvoid)}`), `${personaId} assistantLeakAvoid`);
    assert.ok(out.includes(`INTERACTION_REPORTED_SELF_INTENT=${config.interactionPolicy.reportedSelfIntent}`), `${personaId} interactionPolicy`);
  }
});

test("identityResponse guidance is projected only when the turn actually asks character identity", () => {
  for (const personaId of PERSONA_IDS) {
    const config = CONFIGS[personaId];
    const identity = buildPersonaGenerationContext({ prompt: "妳是誰？" }, personaCtx(personaId));
    assert.ok(identity.includes(`IDENTITY_RESPONSE_GUIDANCE=${config.identityResponse.guidance}`), `${personaId} identityResponse`);
    assert.match(identity, /TURN_RESPONSE_ACT=ANSWER_CHARACTER_IDENTITY/u, `${personaId} pure identity response act`);
    assert.doesNotMatch(identity, /COMPOSE_CHARACTER_IDENTITY_AND_PERSONA_OPINION/u, `${personaId} pure identity must not gain an opinion slot`);

    const unrelated = buildPersonaGenerationContext({ prompt: "今天想吃什麼？" }, personaCtx(personaId));
    assert.doesNotMatch(unrelated, /IDENTITY_RESPONSE_GUIDANCE=/u, `${personaId} unrelated turn`);
  }
});

test("third-party inner-state guessing uses weak-inference authority instead of open Persona opinion", () => {
  const turnPlan = buildUnifiedTurnPlan("爽世剛沉默了，妳覺得她心裡一定在想什麼？", { personaId: "tomori" });
  assert.deepEqual(turnPlan.semanticLanes, ["WEAK_INFERENCE"]);
  assert.equal(turnPlan.responseContract.responseFunction, "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY");
  assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("MIND_READING"));
});

test("recent autobiographical object query keeps unresolved current-state authority above object-delivery mode", () => {
  const turnPlan = buildUnifiedTurnPlan("妳最近看到什麼有趣的石頭？形狀哪裡特別？", { personaId: "tomori" });
  assert.ok(turnPlan.semanticLanes.includes("CURRENT_STATE"));
  assert.ok(turnPlan.semanticLanes.includes("ORDINARY_OBJECT_REACTION"));
  assert.equal(turnPlan.evidence.kind, "current_state");
  assert.equal(turnPlan.responseContract.responseFunction, "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS");
  assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("ALTERNATE_STATE_INVENTION"));
});

test("open unresolved autobiographical query gets an open-query final boundary instead of premise challenge", () => {
  const turnPlan = buildUnifiedTurnPlan("妳最近看到什麼有趣的石頭？形狀哪裡特別？", { personaId: "tomori" });
  const lines = [];
  turnContextProjectionTest.pushFinalResponseBoundary(lines, turnPlan);
  const out = lines.join("\n");
  assert.match(out, /FINAL_UNKNOWN_REPLY_MODE=OPEN_AUTOBIOGRAPHICAL_QUERY_UNRESOLVED/u);
  assert.match(out, /FINAL_LAST_MILE_MODE=CURRENT_STATE_OPEN_QUERY_UNRESOLVED/u);
  assert.match(out, /FINAL_RECENT_SELF_EVENT_INVENTION=DENY/u);
  assert.doesNotMatch(out, /FINAL_LAST_MILE_ALLOWED=CHALLENGE_PREMISE/u);
});

test("final response boundary restates spoken-only output ownership and prioritizes semantic denies", () => {
  const turnPlan = buildUnifiedTurnPlan("燈ちゃん提到以前的事後沉默了，妳會怎麼回？", { personaId: "soyo" });
  const lines = [];
  turnContextProjectionTest.pushFinalResponseBoundary(lines, turnPlan);
  const out = lines.join("\n");
  assert.match(out, /FINAL_OUTPUT_TYPE=SPOKEN_CONTENT_ONLY/u);
  assert.match(out, /FINAL_PHYSICAL_ACTION_NARRATION=DENY/u);
  assert.match(out, /FINAL_GAZE_NARRATION=DENY/u);
  assert.match(out, /FINAL_VOICE_DELIVERY_NARRATION=DENY/u);
  assert.match(out, /FINAL_STAGE_DIRECTION=DENY/u);
  assert.match(out, /Do not invent an unestablished past mental state\./u);
  assert.match(out, /Do not generalize one current-turn event into a habit or repeated history\./u);
});

test("anonymous criticism remains attributed speech rather than autobiographical truth", () => {
  const turnPlan = buildUnifiedTurnPlan("有人酸妳留學失敗才逃回來，妳會怎麼回？", { personaId: "anon" });
  assert.ok(turnPlan.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
  assert.ok(turnPlan.semanticLanes.includes("USER_TASK"));
  assert.ok(turnPlan.premises.some((premise) => ["reported_hearsay", "reported_by_user"].includes(premise.certainty)));
  assert.equal(turnPlan.responseContract.responseFunction, "RETURN_REPLY_DRAFT");
  assert.equal(turnPlan.responseContract.slots[0]?.type, "REPORT_OR_SPEAKER_PRESENT_REACTION");
  assert.deepEqual(turnPlan.responseContract.allowedPredicates, ["REPORT_OR_SPEAKER_PRESENT_REACTION"]);
  assert.deepEqual(turnPlan.responseContract.requiredPredicates, ["REPORT_OR_SPEAKER_PRESENT_REACTION"]);
  for (const predicate of [
    "REPORT_TRUE",
    "REPORT_FALSE",
    "SELF_KNOWLEDGE_SUBSTITUTION",
    "SELF_EXPLANATION_SUBSTITUTION",
    "CERTAIN_AUTOBIOGRAPHICAL_DENIAL",
    "ALTERNATE_CAUSE_INFERENCE",
    "THIRD_PARTY_MOTIVE_INVENTION",
  ]) {
    assert.ok(turnPlan.responseContract.forbiddenPredicates.includes(predicate), predicate);
  }

  const lines = [];
  turnContextProjectionTest.pushFinalResponseBoundary(lines, turnPlan);
  const out = lines.join("\n");
  assert.match(out, /FINAL_REPORT_REPLY_ALLOWED_CONTENT=PRESENT_REACTION_OR_PROTEST_ONLY/u);
  assert.match(out, /FINAL_REPORT_ALTERNATE_AUTOBIOGRAPHICAL_EXPLANATION=DENY/u);
  assert.match(out, /FINAL_REPORT_REPLY_SUBJECT=REPORT_OR_SPEAKER_ONLY/u);
  assert.match(out, /FINAL_REPORT_FIRST_PERSON_AUTOBIOGRAPHICAL_PREDICATE=DENY/u);
  assert.match(out, /只能針對「這個說法」或「說這話的人」做當下反應或抗議/u);
  assert.match(out, /Do not replace a reported claim with invented first-person knowledge\./u);
  assert.match(out, /Do not answer a reported past claim with a new first-person explanation\./u);
  assert.match(out, /Do not certainly deny a reported autobiographical event when its truth is unverified\./u);
});

test("anonymous ridicule verbs preserve report authority without swallowing ordinary smiling actions", () => {
  for (const prompt of [
    "有人笑妳吉他很差，妳會怎麼回？",
    "有人嘲笑妳能力不足，妳會怎麼接？",
    "有人取笑妳吉他很差，妳會怎麼回？",
  ]) {
    const turnPlan = buildUnifiedTurnPlan(prompt, { personaId: "anon" });
    assert.ok(turnPlan.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"), prompt);
    assert.equal(turnPlan.responseContract.slots[0]?.type, "REPORT_OR_SPEAKER_PRESENT_REACTION", prompt);
    assert.deepEqual(turnPlan.responseContract.allowedPredicates, ["REPORT_OR_SPEAKER_PRESENT_REACTION"], prompt);
  }

  const ordinarySmile = buildUnifiedTurnPlan("有人笑著跟妳打招呼，妳會怎麼回？", { personaId: "anon" });
  assert.ok(!ordinarySmile.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
});
test("Anon embarrassment-defense delivery guidance cannot widen unverified report authority", () => {
  const prompt = "有人酸妳留學失敗才逃回來，妳會怎麼回？";
  const turnPlan = buildUnifiedTurnPlan(prompt, { personaId: "anon" });
  assert.equal(turnPlan.semanticAuthority.type, "THIRD_PARTY_REPORT");

  const out = buildPersonaGenerationContext({ prompt }, personaCtx("anon"), turnPlan);
  const guidance = CONFIGS.anon.turnModes.find((mode) => mode.id === "embarrassment-defense")?.guidance || "";

  assert.match(out, /TURN_MODE_embarrassment-defense_GUIDANCE=/u);
  assert.ok(guidance.includes("TurnPlan"), guidance);
  assert.ok(guidance.includes("不得補新的第一人稱原因、動機或經歷"), guidance);
  assert.doesNotMatch(guidance, /之後可能承認一部分/u);
});

test("directed member reply wording owns social reply shape before music capability", () => {
  const socialReply = buildUnifiedTurnPlan("立希ちゃん直接說這段編曲有問題，妳會怎麼接？", { personaId: "soyo" });
  assert.equal(socialReply.taskContract.type, "REPLY_DRAFT");
  assert.equal(socialReply.taskContract.capability.domain, "social_communication");
  assert.equal(socialReply.responseContract.responseFunction, "RETURN_REPLY_DRAFT");
  assert.notEqual(socialReply.semanticAuthority.type, "ORDINARY_KNOWLEDGE_TASK");

  const compositionTask = buildUnifiedTurnPlan("幫我分析這段編曲怎麼改比較好？", { personaId: "soyo" });
  assert.notEqual(compositionTask.taskContract.type, "REPLY_DRAFT");
  assert.equal(compositionTask.taskContract.capability.domain, "music_composition");
});

test("current-turn event premises cannot be expanded into historical frequency", () => {
  for (const [personaId, text] of [
    ["soyo", "團練時愛音又拖到最後才到，妳會怎麼講？"],
    ["soyo", "樂奈ちゃん又把外套忘在椅子上，妳會怎麼處理？"],
  ]) {
    const turnPlan = buildUnifiedTurnPlan(text, { personaId });
    assert.ok(turnPlan.premises.some((premise) => premise.certainty === "asserted_by_user"), text);
    assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("HISTORICAL_FREQUENCY_GENERALIZATION"), text);
    assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("USER_PREMISE_HISTORICAL_EXPANSION"), text);
  }
});

test("current relationship stance wording with 現在的妳 remains canonical relationship authority", () => {
  const turnPlan = buildUnifiedTurnPlan("現在的妳怎麼看爽世ちゃん？", { personaId: "tomori" });
  assert.equal(turnPlan.utteranceAct.subtype, "CANONICAL_RELATIONSHIP_STANCE");
  assert.equal(turnPlan.utteranceAct.target, "爽世ちゃん");
  assert.deepEqual(turnPlan.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(turnPlan.evidence.kind, "canonical_relationship_stance");
  assert.equal(turnPlan.evidence.source, "persona_canonical");
  assert.equal(turnPlan.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");
});

test("reported-member reply tasks keep report motive and history boundaries", () => {
  const turnPlan = buildUnifiedTurnPlan("愛音ちゃん又叫妳 Soyorin，妳會怎麼回？", { personaId: "soyo" });
  assert.ok(turnPlan.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
  assert.ok(turnPlan.semanticLanes.includes("USER_TASK"));
  assert.equal(turnPlan.responseContract.responseFunction, "RETURN_REPLY_DRAFT");
  for (const predicate of [
    "THIRD_PARTY_MOTIVE_INVENTION",
    "PAST_MENTAL_STATE_INVENTION",
    "ALTERNATE_CAUSE_INFERENCE",
    "UNREPORTED_EVENT_ASSERTION",
    "HISTORICAL_FREQUENCY_GENERALIZATION",
  ]) {
    assert.ok(turnPlan.responseContract.forbiddenPredicates.includes(predicate), predicate);
  }
});

test("reported prospective reply tasks keep current choice available without report fact escalation", () => {
  const turnPlan = buildUnifiedTurnPlan("有人說明天想找妳聊，妳會怎麼回？", { personaId: "anon" });
  assert.ok(turnPlan.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
  assert.ok(turnPlan.semanticLanes.includes("USER_TASK"));
  assert.equal(turnPlan.responseContract.responseFunction, "RETURN_REPLY_DRAFT");
  assert.equal(turnPlan.responseContract.slots[0]?.type, "REPORT_OR_SPEAKER_PRESENT_REACTION");
  assert.deepEqual(turnPlan.responseContract.allowedPredicates, ["REPORT_OR_SPEAKER_PRESENT_REACTION", "PROSPECTIVE_PERSONA_VOLITION"]);
  assert.deepEqual(turnPlan.responseContract.requiredPredicates, ["REPORT_OR_SPEAKER_PRESENT_REACTION"]);
  assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("REPORT_TRUE"));
  assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("REPORT_FALSE"));
  assert.ok(turnPlan.responseContract.forbiddenPredicates.includes("SELF_KNOWLEDGE_SUBSTITUTION"));
  assert.ok(!turnPlan.responseContract.forbiddenPredicates.includes("UNSUPPORTED_FUTURE_SELF_COMMITMENT"));
});

test("directed reply tasks may project only the active Persona's controlled relationship stance for resolved targets", () => {
  const prompt = "愛音ちゃん又叫妳 Soyorin，妳會怎麼回？";
  const turnPlan = buildUnifiedTurnPlan(prompt, { personaId: "soyo" });
  assert.equal(turnPlan.personaPolicy.relationshipStanceProjection, "ALLOW_ACTIVE_PERSONA_STANCE_FOR_RESOLVED_TARGETS");

  const out = buildPersonaRelationshipContext({ prompt }, personaCtx("soyo"), turnPlan);
  const relationship = CONFIGS.soyo.relationships.anon;
  assert.ok(out.includes(`PAIR_1_RELATIONSHIP_STANCE=${relationship.stance}`));
  assert.ok(out.includes(`PAIR_1_RELATIONSHIP_REACTION_GUIDANCE=${relationship.reaction}`));
  assert.ok(out.includes(`PAIR_1_RELATIONSHIP_STOP_RULE=${relationship.stopRule}`));
  assert.match(out, /PAIR_1_RELATIONSHIP_STANCE_FACT_AUTHORITY=ACTIVE_PERSONA_STANCE_ONLY/u);
  assert.match(out, /PAIR_1_RELATIONSHIP_DELIVERY_AUTHORITY=DELIVERY_ONLY/u);
  assert.match(out, /PAIR_1_TARGET_MOTIVE_AUTHORITY=DENY/u);
  assert.match(out, /PAIR_1_TARGET_INTERNAL_STATE_AUTHORITY=DENY/u);
  assert.match(out, /PAIR_1_RELATIONSHIP_HISTORY_EXPANSION=DENY/u);

  const unrelatedPrompt = "愛音ちゃん讀哪間學校？";
  const unrelatedPlan = buildUnifiedTurnPlan(unrelatedPrompt, { personaId: "soyo" });
  assert.equal(unrelatedPlan.personaPolicy.relationshipStanceProjection, "DENY");
  const unrelated = buildPersonaRelationshipContext({ prompt: unrelatedPrompt }, personaCtx("soyo"), unrelatedPlan);
  assert.doesNotMatch(unrelated, /RELATIONSHIP_STANCE=/u);
  assert.doesNotMatch(unrelated, /RELATIONSHIP_REACTION_GUIDANCE=/u);
});

test("Persona realization enforces spoken-content-only delivery for reply tasks", () => {
  const out = buildPersonaGenerationContext({ prompt: "立希ちゃん在照顧妳時，妳通常怎麼回她？" }, personaCtx("tomori"));
  assert.match(out, /ACTIVE_DIMENSIONS=.*SPOKEN_CONTENT_ONLY_DISCIPLINE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*PHYSICAL_ACTION_NARRATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*GAZE_NARRATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*VOICE_DELIVERY_NARRATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*STAGE_DIRECTION/u);
});

test("every configured turnMode activates from its own keyword and stays delivery-only", () => {
  let modeCount = 0;
  for (const personaId of PERSONA_IDS) {
    const config = CONFIGS[personaId];
    for (const mode of config.turnModes) {
      modeCount += 1;
      const keyword = mode.keywords[0];
      const out = buildPersonaGenerationContext({ prompt: `${keyword}，妳怎麼看？` }, personaCtx(personaId));
      assert.ok(activeModeIds(out).includes(mode.id), `${personaId}:${mode.id} should activate from ${keyword}`);
      assert.ok(out.includes(`TURN_MODE_${mode.id}_GUIDANCE=${mode.guidance}`), `${personaId}:${mode.id} guidance reaches realization`);
      assert.match(out, /TURN_MODE_AUTHORITY=DELIVERY_ONLY/u, `${personaId}:${mode.id}`);
      assert.match(out, /TURN_MODE_FACT_AUTHORITY=DENY/u, `${personaId}:${mode.id}`);
      assert.match(out, /TURN_MODE_MAY_ADD_NEW_PROPOSITIONS=false/u, `${personaId}:${mode.id}`);
    }
  }
  assert.equal(modeCount, 14);
});

test("turnModes do not activate on a neighboring unrelated turn and multiple matched modes stay separately indexed", () => {
  for (const personaId of PERSONA_IDS) {
    const config = CONFIGS[personaId];
    const negative = buildPersonaGenerationContext({ prompt: "今天只是普通打招呼。" }, personaCtx(personaId));
    assert.deepEqual(activeModeIds(negative), [], `${personaId} unrelated negative`);

    for (let index = 0; index < config.turnModes.length; index += 1) {
      const mode = config.turnModes[index];
      const neighbor = config.turnModes[(index + 1) % config.turnModes.length];
      if (!neighbor || neighbor.id === mode.id) continue;
      const neighborPrompt = `${neighbor.keywords[0]}，妳怎麼看？`;
      const neighborOut = buildPersonaGenerationContext({ prompt: neighborPrompt }, personaCtx(personaId));
      assert.ok(!activeModeIds(neighborOut).includes(mode.id), `${personaId}:${mode.id} neighboring negative via ${neighbor.id}`);
    }

    if (config.turnModes.length >= 2) {
      const first = config.turnModes[0];
      const second = config.turnModes[1];
      const collision = buildPersonaGenerationContext(
        { prompt: `${first.keywords[0]}，還有${second.keywords[0]}。` },
        personaCtx(personaId),
      );
      const ids = activeModeIds(collision);
      assert.ok(ids.includes(first.id), `${personaId} first collided mode`);
      assert.ok(ids.includes(second.id), `${personaId} second collided mode`);
      assert.equal(new Set(ids).size, ids.length, `${personaId} collided modes must not duplicate`);
    }
  }
});

test("every configured recognitionAlias resolves to the correct target without granting relationship facts", () => {
  let aliasCount = 0;
  for (const activeId of PERSONA_IDS) {
    for (const targetId of otherPersonaIds(activeId)) {
      const reference = CONFIGS[activeId].references[targetId];
      for (const alias of reference.recognitionAliases) {
        aliasCount += 1;
        const out = buildPersonaRelationshipContext({ prompt: `${alias}呢？` }, personaCtx(activeId));
        assert.match(out, new RegExp(`PAIR_1_TARGET_PERSONA_ID=${targetId}`), `${activeId}->${targetId} alias ${alias}`);
        assert.match(out, /PAIR_FACT_AUTHORITY=DENY/u, `${activeId}->${targetId} alias ${alias}`);
        assert.match(out, /PAIR_MAY_ASSERT_RELATIONSHIP_FACT=false/u, `${activeId}->${targetId} alias ${alias}`);
      }
    }
  }
  assert.ok(aliasCount >= 80, `expected exhaustive alias exercise, got ${aliasCount}`);
});

test("every relationship-only alias resolves to its own directed target without granting relationship facts", () => {
  let aliasCount = 0;
  for (const activeId of PERSONA_IDS) {
    for (const targetId of otherPersonaIds(activeId)) {
      const relationship = CONFIGS[activeId].relationships[targetId];
      for (const alias of relationship.aliases || []) {
        aliasCount += 1;
        const out = buildPersonaRelationshipContext({ prompt: `${alias}呢？` }, personaCtx(activeId));
        assert.match(out, new RegExp(`PAIR_1_TARGET_PERSONA_ID=${targetId}`), `${activeId}->${targetId} relationship alias ${alias}`);
        assert.match(out, /PAIR_FACT_AUTHORITY=DENY/u, `${activeId}->${targetId} relationship alias ${alias}`);
        assert.match(out, /PAIR_MAY_ASSERT_RELATIONSHIP_FACT=false/u, `${activeId}->${targetId} relationship alias ${alias}`);
        assert.doesNotMatch(out, /PAIR_2_TARGET_PERSONA_ID=/u, `${activeId}->${targetId} relationship alias ${alias} must stay target-indexed`);
      }
    }
  }
  assert.ok(aliasCount > 0, "expected at least one relationship-only alias in controlled Persona config");
});

test("all 20 directed reference records expose preferredReference as optional delivery metadata", () => {
  let pairCount = 0;
  for (const activeId of PERSONA_IDS) {
    for (const targetId of otherPersonaIds(activeId)) {
      pairCount += 1;
      const reference = CONFIGS[activeId].references[targetId];
      const out = buildPersonaRelationshipContext(
        { prompt: `${reference.canonicalName}呢？` },
        personaCtx(activeId),
      );
      assert.ok(out.includes(`PAIR_1_PREFERRED_REFERENCE=${reference.preferredReference}`), `${activeId}->${targetId} preferredReference`);
      assert.ok(out.includes(`PAIR_1_CANONICAL_REFERENCE=${reference.canonicalName}`), `${activeId}->${targetId} canonicalName`);
      assert.match(out, /PAIR_1_REFERENCE_POLICY=AVAILABLE_WHEN_NATURAL_NOT_FORCED/u, `${activeId}->${targetId}`);
      assert.match(out, /PAIR_REFERENCE_FACT_AUTHORITY=IDENTITY_ONLY/u, `${activeId}->${targetId}`);
    }
  }
  assert.equal(pairCount, 20);
});

test("all 20 directed pair realization rows are explicit and retain fact-authority denial", () => {
  let pairCount = 0;
  for (const activeId of PERSONA_IDS) {
    for (const targetId of otherPersonaIds(activeId)) {
      pairCount += 1;
      const target = CONFIGS[activeId].references[targetId];
      const out = buildPersonaRelationshipContext({ prompt: `${target.canonicalName}呢？` }, personaCtx(activeId));
      assert.match(out, new RegExp(`PAIR_1_TARGET_PERSONA_ID=${targetId}`), `${activeId}->${targetId}`);
      assert.doesNotMatch(out, /PAIR_1_PROFILE=FAMILIAR_TEAMMATE_BASELINE/u, `${activeId}->${targetId} must not fall back`);
      assert.match(out, /PAIR_FACT_AUTHORITY=DENY/u, `${activeId}->${targetId}`);
      assert.match(out, /PAIR_MAY_ASSERT_RELATIONSHIP_FACT=false/u, `${activeId}->${targetId}`);
      assert.match(out, /PAIR_MAY_ASSERT_TARGET_STATE=false/u, `${activeId}->${targetId}`);
    }
  }
  assert.equal(pairCount, 20);
});

test("Tomori to Rana uses the controlled concrete music/action relation profile instead of generic fallback", () => {
  const out = buildPersonaRelationshipContext({ prompt: "樂奈剛彈完這段，燈會怎麼回她？" }, personaCtx("tomori"));
  assert.match(out, /PAIR_1_PROFILE=TOMORI_TO_RANA/u);
  assert.match(out, /PAIR_1_ACTIVE_DIMENSIONS=.*CONCRETE_PLAYING_SOUND_ACTION_FOCUS/u);
  assert.match(out, /PAIR_1_ACTIVE_DIMENSIONS=.*DIRECT_MUSIC_LINK_SALIENCE/u);
  assert.match(out, /PAIR_1_INHIBITED_DIMENSIONS=.*PERSONALITY_DIAGNOSIS/u);
  assert.match(out, /PAIR_1_INHIBITED_DIMENSIONS=.*TARGET_MIND_READING/u);
  assert.match(out, /PAIR_FACT_AUTHORITY=DENY/u);
});

test("pair-specific nicknames resolve only to their own target and canonical plus nickname does not duplicate the target", () => {
  const cases = [
    ["taki", "野貓", "rana"],
    ["rana", "りっきー", "taki"],
    ["anon", "Soyorin", "soyo"],
    ["tomori", "あのちゃん", "anon"],
  ];

  for (const [activeId, alias, targetId] of cases) {
    const out = buildPersonaRelationshipContext({ prompt: `${alias}呢？` }, personaCtx(activeId));
    assert.match(out, new RegExp(`PAIR_1_TARGET_PERSONA_ID=${targetId}`), `${activeId}:${alias}`);
    assert.doesNotMatch(out, /PAIR_2_TARGET_PERSONA_ID=/u, `${activeId}:${alias} must not leak to another target`);
  }

  const collision = buildPersonaRelationshipContext({ prompt: "爽世跟Soyorin都在。" }, personaCtx("anon"));
  assert.match(collision, /PAIR_1_TARGET_PERSONA_ID=soyo/u);
  assert.doesNotMatch(collision, /PAIR_2_TARGET_PERSONA_ID=soyo/u);
});

test("multi-target turns preserve separate target-indexed pair metadata for two and four mentioned members", () => {
  for (const activeId of PERSONA_IDS) {
    const targets = otherPersonaIds(activeId);
    const two = targets.slice(0, 2);
    const twoPrompt = two.map((id) => CONFIGS[activeId].references[id].canonicalName).join("、");
    const twoOut = buildPersonaRelationshipContext({ prompt: `${twoPrompt}都到了。` }, personaCtx(activeId));
    for (const targetId of two) {
      assert.match(twoOut, new RegExp(`PAIR_\\d+_TARGET_PERSONA_ID=${targetId}`), `${activeId} two-target ${targetId}`);
    }

    const fourPrompt = targets.map((id) => CONFIGS[activeId].references[id].canonicalName).join("、");
    const fourOut = buildPersonaRelationshipContext({ prompt: `${fourPrompt}都到了。` }, personaCtx(activeId));
    for (const targetId of targets) {
      assert.match(fourOut, new RegExp(`PAIR_\\d+_TARGET_PERSONA_ID=${targetId}`), `${activeId} four-target ${targetId}`);
      const preferred = CONFIGS[activeId].references[targetId].preferredReference;
      assert.ok(fourOut.includes(`PREFERRED_REFERENCE=${preferred}`), `${activeId} four-target preferred reference ${targetId}`);
    }
  }
});

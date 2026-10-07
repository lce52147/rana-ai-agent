import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEvidenceCoverage } from "./architecture/evidence_coverage.js";
import { buildUnifiedTurnPlan, turnPlanNeedsLore } from "./architecture/turn_plan.js";
import { buildPersonaGenerationContext } from "./persona_context.js";
import { buildPersonaLoreEvidenceProjection } from "./persona_lore.js";
import { buildLoreEvidencePack } from "./lore/retrieval.js";

const plan = (text, personaId = "rana") => buildUnifiedTurnPlan(text, { personaId });
const ctx = (personaId = "rana") => ({
  accountId: personaId === "rana" ? "default" : personaId,
  agentId: personaId,
  sessionKey: `agent:${personaId}:discord:channel:test`,
});

test("stable self-profile school/grade/role use deterministic profile authority", () => {
  for (const [personaId, text, aspect] of [
    ["rana", "你讀什麼學校？", "school_affiliation"],
    ["taki", "你讀什麼學校？", "school_affiliation"],
    ["tomori", "妳幾年級？", "grade_class"],
    ["anon", "妳在樂團負責什麼？", "identity_role"],
  ]) {
    const value = plan(text, personaId);
    assert.deepEqual(value.semanticLanes, ["CANONICAL_CHARACTER_QUERY"], text);
    assert.equal(value.evidence.kind, "stable_profile_fact", text);
    assert.equal(value.evidence.source, "persona_profile", text);
    assert.equal(value.evidence.requestedAspect, aspect, text);
    assert.equal(turnPlanNeedsLore(value), false, text);
  }
});

test("combined school and grade query remains deterministic stable profile authority", () => {
  for (const [personaId, text, group] of [
    ["rana", "妳讀哪間學校、幾年級？", false],
    ["tomori", "妳讀哪所學校，幾年級？", false],
    ["soyo", "你們讀哪間學校、幾年級？", true],
  ]) {
    const value = plan(text, personaId);
    assert.deepEqual(value.semanticLanes, ["CANONICAL_CHARACTER_QUERY"], text);
    assert.equal(value.evidence.kind, "stable_profile_fact", text);
    assert.equal(value.evidence.source, "persona_profile", text);
    assert.equal(value.evidence.requestedAspect, "school_affiliation", text);
    assert.deepEqual(value.evidence.predicateAnchors, ["學校", "年級", "班級"], text);
    assert.equal(value.subject.type, group ? "active_persona_group" : "active_persona", text);
    assert.equal(turnPlanNeedsLore(value), false, text);
  }
});

test("plural school query targets the canonical group instead of self_group retrieval", () => {
  const value = plan("你們讀什麼學校", "soyo");
  assert.deepEqual(value.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(value.utteranceAct.target, "MyGO!!!!!");
  assert.equal(value.subject.type, "active_persona_group");
  assert.equal(value.evidence.kind, "stable_profile_fact");
  assert.equal(value.evidence.source, "persona_profile");
  assert.equal(value.evidence.requestedAspect, "school_affiliation");
  assert.equal(turnPlanNeedsLore(value), false);
});

test("named entity place definitions stay entity facts", () => {
  for (const text of ["SPACE是什麼？", "live house SPACE是什麼？", "RiNG是什麼？"]) {
    const value = plan(text);
    assert.equal(value.evidence.kind, "canonical_fact", text);
    assert.equal(value.utteranceAct.activity, "named_entity_fact", text);
    assert.equal(value.evidence.requestedAspect, "entity_definition", text);
    assert.equal(evaluateEvidenceCoverage(value, `${value.utteranceAct.target} 是 live house。`, text).supported, true, text);
    assert.equal(evaluateEvidenceCoverage(value, `我常去 ${value.utteranceAct.target}。`, text).supported, false, text);
  }
});

test("group place activity is canonical relation evidence, not current Persona state", () => {
  const namedPlace = plan("你們在SPACE練習嗎？");
  assert.deepEqual(namedPlace.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(namedPlace.evidence.kind, "group_place_relation");
  assert.equal(namedPlace.evidence.source, "persona_canonical");
  assert.equal(namedPlace.evidence.requestedAspect, "group_place_activity");
  assert.deepEqual(namedPlace.evidence.anchors, ["MyGO!!!!!", "SPACE"]);

  const currentBase = plan("MyGO!!!!!平常在哪裡活動？");
  assert.deepEqual(currentBase.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(currentBase.evidence.kind, "group_place_relation");
  assert.equal(currentBase.evidence.requestedAspect, "current_activity_place");
  assert.deepEqual(currentBase.evidence.anchors, ["MyGO!!!!!"]);
});

test("historical Persona-place relation carries actor and place together", () => {
  const rana = plan("樂奈以前常去SPACE嗎？", "rana");
  assert.deepEqual(rana.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(rana.evidence.kind, "persona_place_relation");
  assert.equal(rana.evidence.requestedAspect, "historical_place_relation");
  assert.deepEqual(rana.evidence.anchors, ["樂奈", "SPACE"]);

  const tomori = plan("燈去過SPACE嗎？", "tomori");
  assert.equal(tomori.evidence.kind, "persona_place_relation");
  assert.equal(tomori.evidence.requestedAspect, "historical_place_relation");
  assert.deepEqual(tomori.evidence.anchors, ["燈", "SPACE"]);
});

test("active Persona current location does not collapse into historical place relation", () => {
  for (const text of ["妳現在還在 RiNG 嗎？", "妳在 RiNG 嗎？"]) {
    const value = plan(text, "rana");
    assert.equal(value.semanticLanes.includes("CURRENT_STATE"), true, text);
    assert.notEqual(value.evidence.kind, "persona_place_relation", text);
    assert.notEqual(value.evidence.requestedAspect, "historical_place_relation", text);
  }
});

test("place mention cannot authorize Persona or group experience", () => {
  const group = plan("你們在SPACE練習嗎？");
  assert.equal(evaluateEvidenceCoverage(group, "SPACE 是已關閉的 live house。", group.currentUser).supported, false);
  assert.equal(evaluateEvidenceCoverage(group, "MyGO!!!!! 的資料索引提到 SPACE。", group.currentUser).supported, false);

  const person = plan("燈去過SPACE嗎？", "tomori");
  assert.equal(evaluateEvidenceCoverage(person, "高松燈的故事索引提到 SPACE。", person.currentUser).supported, false);
  assert.equal(evaluateEvidenceCoverage(person, "SPACE 是以前的 live house。", person.currentUser).supported, false);
});

test("direct co-located place relations satisfy only the matching relation", () => {
  const group = plan("MyGO!!!!!平常在哪裡活動？");
  assert.equal(evaluateEvidenceCoverage(group, "MyGO!!!!! 現在主要在 RiNG 排練與演出。", group.currentUser).supported, true);

  const person = plan("燈去過SPACE嗎？", "tomori");
  assert.equal(evaluateEvidenceCoverage(person, "高松燈以前去過 SPACE。", person.currentUser).supported, true);
  assert.equal(evaluateEvidenceCoverage(person, "MyGO!!!!! 現在主要在 RiNG 排練與演出。", person.currentUser).supported, false);
  assert.equal(evaluateEvidenceCoverage(group, "高松燈以前去過 SPACE。", group.currentUser).supported, false);
});

test("stable profile projection exposes only the requested active Persona facts", () => {
  const turnPlan = plan("妳幾年級？", "taki");
  const out = buildPersonaGenerationContext({ prompt: "妳幾年級？" }, ctx("taki"), turnPlan);
  assert.match(out, /STABLE_PERSONA_PROFILE_EVIDENCE/u);
  assert.match(out, /椎名立希/u);
  assert.match(out, /花咲川女子學園 高中/u);
  assert.match(out, /一年 B 班/u);
  assert.doesNotMatch(out, /高松燈|千早愛音|長崎爽世/u);
  assert.doesNotMatch(out, /鼓手|8 月 9 日/u);
  assert.doesNotMatch(out, /LORE|BM25|retriev/iu);
});

test("stable profile projection stays aspect-scoped for school, role, and birthday", () => {
  for (const [personaId, text, expected, excluded] of [
    ["rana", "你讀什麼學校？", /要樂奈.*花咲川女子學園 中學部.*三年 A 班/u, /吉他手|2 月 22 日/u],
    ["anon", "妳在樂團負責什麼？", /千早愛音.*MyGO!!!!!.*吉他手/u, /羽丘女子學園|一年 A 班|9 月 8 日/u],
    ["tomori", "妳的生日是幾月幾號？", /高松燈.*11 月 22 日/u, /主唱|羽丘女子學園|一年 A 班/u],
  ]) {
    const turnPlan = plan(text, personaId);
    const out = buildPersonaGenerationContext({ prompt: text }, ctx(personaId), turnPlan);
    assert.match(out, /STABLE_PERSONA_PROFILE_EVIDENCE/u, text);
    assert.match(out, expected, text);
    assert.doesNotMatch(out, excluded, text);
    assert.doesNotMatch(out, /LORE|BM25|retriev/iu, text);
  }
});

test("stable group profile projection aggregates all five MyGO profiles deterministically", () => {
  const turnPlan = plan("你們讀什麼學校", "soyo");
  const out = buildPersonaGenerationContext({ prompt: "你們讀什麼學校" }, ctx("soyo"), turnPlan);
  for (const expected of [
    "要樂奈|花咲川女子學園 中學部|三年 A 班",
    "椎名立希|花咲川女子學園 高中|一年 B 班",
    "高松燈|羽丘女子學園 高中|一年 A 班",
    "千早愛音|羽丘女子學園 高中|一年 A 班",
    "長崎爽世|月之森女子學園 高中|一年 A 班",
  ]) assert.match(out, new RegExp(expected.replaceAll("|", ".*"), "u"));
  assert.doesNotMatch(out, /吉他手|鼓手|主唱|貝斯手|2 月 22 日|8 月 9 日|11 月 22 日|9 月 8 日|5 月 27 日/u);
  assert.doesNotMatch(out, /self_group|LORE|BM25|retriev/iu);
});

test("stable group profile projection requires group-wide realization instead of active-Persona collapse", () => {
  const turnPlan = plan("你們讀什麼學校", "soyo");
  const out = buildPersonaGenerationContext({ prompt: "你們讀什麼學校" }, ctx("soyo"), turnPlan);
  assert.match(out, /SUBJECT_SCOPE=MYGO_GROUP/u);
  assert.match(out, /PROFILE_RESPONSE_MODE=AGGREGATE_ALL_PROJECTED_PROFILES/u);
  assert.match(out, /REQUIRED_PROJECTED_PROFILE_COUNT=5/u);
  assert.match(out, /GROUP_PROFILE_REQUIRED_NAMES=要樂奈\|椎名立希\|高松燈\|千早愛音\|長崎爽世/u);
  assert.match(out, /GROUP_PROFILE_MEMBER_OMISSION=DENY/u);
  assert.match(out, /GROUP_PROFILE_ACTIVE_PERSONA_COLLAPSE=DENY/u);
});

test("Rana production lore pack resolves canonical self entity id for historical place evidence", async () => {
  const query = "樂奈以前常去SPACE嗎？";
  const turnPlan = plan(query, "rana");
  const pack = await buildLoreEvidencePack(query, { turnPlan });
  assert.equal(pack.evidence_coverage.supported, true);
  assert.equal(pack.knowledge_contract, "known");
  assert.equal(pack.structured_facts.some((fact) => fact.subject === "bangdream.character.rana_kaname"
    && fact.predicate === "frequented"
    && fact.object === "SPACE"), true);
});

test("Rana production lore pack uses direct structured place definitions", async () => {
  for (const [query, place] of [["SPACE是什麼？", "SPACE"], ["RiNG是什麼？", "RiNG"]]) {
    const turnPlan = plan(query, "rana");
    const pack = await buildLoreEvidencePack(query, { turnPlan });
    assert.equal(pack.evidence_coverage.supported, true, query);
    assert.equal(pack.structured_facts.some((fact) => fact.predicate === "entity_type"
      && fact.object === "live_house"
      && String(fact.subject).endsWith(place)), true, query);
    assert.equal(pack.structured_facts.every((fact) => fact.predicate === "entity_type"
      && String(fact.subject).endsWith(place)), true, `${query}: definition evidence must stay definition-scoped`);
    assert.deepEqual(pack.supporting_evidence, [], `${query}: direct definition facts must not expose adjacent dossier text`);
  }
});

test("Rana production lore pack carries direct MyGO current-place relation instead of mention-only co-location", async () => {
  const currentQuery = "MyGO!!!!!平常在哪裡活動？";
  const currentPlan = plan(currentQuery, "rana");
  const currentPack = await buildLoreEvidencePack(currentQuery, { turnPlan: currentPlan });
  assert.equal(currentPack.evidence_coverage.supported, true);
  assert.equal(currentPack.structured_facts.some((fact) => fact.subject === "MyGO!!!!!"
    && fact.predicate === "current_activity_place"
    && fact.object === "RiNG"
    && fact.qualifiers?.polarity === "positive"), true);

  const spaceQuery = "你們在SPACE練習嗎？";
  const spacePlan = plan(spaceQuery, "rana");
  const spacePack = await buildLoreEvidencePack(spaceQuery, { turnPlan: spacePlan });
  assert.equal(spacePack.evidence_coverage.supported, true);
  assert.equal(spacePack.structured_facts.some((fact) => fact.subject === "MyGO!!!!!"
    && fact.predicate === "current_activity_place"
    && fact.object === "SPACE"
    && fact.qualifiers?.polarity === "negative"), true);
});

test("unsupported non-Rana place relation projection denies both positive and negative completion", () => {
  const query = "燈去過SPACE嗎？";
  const turnPlan = plan(query, "tomori");
  const projected = buildPersonaLoreEvidenceProjection(
    { query },
    ctx("tomori"),
    turnPlan,
  );
  assert.equal(projected.coverage?.supported, false);
  assert.match(projected.context, /CANONICAL_ANSWER_MODE=UNRESOLVED_ONLY/u);
  assert.match(projected.context, /CANONICAL_POSITIVE_COMPLETION=DENY/u);
  assert.match(projected.context, /CANONICAL_NEGATIVE_COMPLETION=DENY/u);
});

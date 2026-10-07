import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEvidenceCoverage } from "./architecture/evidence_coverage.js";
import { buildUnifiedTurnPlan, turnPlanNeedsLore } from "./architecture/turn_plan.js";
import { buildLoreEvidencePack, loreEvidenceContext } from "./lore/retrieval.js";
import { buildPersonaGenerationContext } from "./persona_context.js";
import { buildPersonaLoreEvidenceProjection } from "./persona_lore.js";

const ctx = (personaId = "rana") => ({
  accountId: personaId === "rana" ? "default" : personaId,
  agentId: personaId,
  sessionKey: `agent:${personaId}:discord:channel:test`,
});

test("named entity fact does not accept an index-only SPACE mention", () => {
  const plan = buildUnifiedTurnPlan("live house space是什麼?", { personaId: "taki" });
  const evidence = "| 2233 | 意想不到的關係 | story_tw MyGO_椎名立希 意想不到的關係.txt | 與樂奈的追問、貓、訊息與SPACE／CRYCHIC。 | INDEXED |";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("named entity fact does not accept a place-list-only SPACE mention", () => {
  const plan = buildUnifiedTurnPlan("SPACE是什麼?", { personaId: "tomori" });
  const evidence = "## 8. 場所與反覆脈絡\n- 羽丘女子學園\n- RiNG\n- SPACE\n- 星象館";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("named entity definition rejects a direct textual SPACE state assertion", () => {
  const plan = buildUnifiedTurnPlan("SPACE是什麼?", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "SPACE 關閉後成為停車場。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("named entity definition rejects a structured SPACE state predicate", () => {
  const plan = buildUnifiedTurnPlan("SPACE是什麼?", { personaId: "rana" });
  const evidence = {
    structured_facts: [
      { subject: "place:SPACE", predicate: "status", object: "closed", topics: ["SPACE", "關閉"] },
    ],
  };
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("active-persona school uses deterministic profile authority for the speaker", () => {
  const plan = buildUnifiedTurnPlan("你讀什麼學校?", { personaId: "taki" });
  assert.equal(plan.evidence.source, "persona_profile");
  assert.equal(turnPlanNeedsLore(plan), false);
  const out = buildPersonaGenerationContext({ prompt: plan.currentUser }, ctx("taki"), plan);
  assert.match(out, /椎名立希.*花咲川女子學園 高中.*一年 B 班/u);
  assert.doesNotMatch(out, /高松燈|羽丘女子學園/u);
});

for (const personaId of ["anon", "soyo", "taki", "tomori"]) {
  test(`${personaId} plural school query bypasses Persona LORE and projects the five controlled profiles`, () => {
    const query = "你們讀什麼學校";
    const plan = buildUnifiedTurnPlan(query, { personaId });
    assert.equal(plan.evidence.source, "persona_profile");
    assert.equal(turnPlanNeedsLore(plan), false);
    const out = buildPersonaGenerationContext({ prompt: query }, ctx(personaId), plan);
    for (const name of ["要樂奈", "椎名立希", "高松燈", "千早愛音", "長崎爽世"]) assert.match(out, new RegExp(name, "u"));
    assert.doesNotMatch(out, /LORE|BM25|retriev/iu);
  });
}


test("practice duration rejects a practice-only mention", () => {
  const plan = buildUnifiedTurnPlan("你平常練習多久？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈平常會練吉他。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("practice duration accepts a direct two-hour assertion", () => {
  const plan = buildUnifiedTurnPlan("你平常練習多久？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈每天練習吉他兩小時。", plan.currentUser);
  assert.equal(coverage.supported, true);
});

test("favorite performer rejects role-only evidence", () => {
  const plan = buildUnifiedTurnPlan("你最喜歡哪位吉他手？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈是 MyGO!!!!! 的吉他手。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("favorite performer accepts a direct preference assertion", () => {
  const plan = buildUnifiedTurnPlan("你最喜歡哪位吉他手？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈最喜歡的吉他手是花園多惠。", plan.currentUser);
  assert.equal(coverage.supported, true);
});

test("guitar brand preference rejects equipment-use evidence", () => {
  const plan = buildUnifiedTurnPlan("你最喜歡哪牌吉他？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈使用 ESP 吉他。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("guitar brand preference accepts a direct preference assertion", () => {
  const plan = buildUnifiedTurnPlan("你最喜歡哪牌吉他？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "要樂奈喜歡的吉他品牌是 ESP。", plan.currentUser);
  assert.equal(coverage.supported, true);
});

test("named performer opinion rejects role-only evidence", () => {
  const plan = buildUnifiedTurnPlan("花園多惠的吉他厲害嗎？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "花園多惠是吉他手。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("named performer opinion accepts a direct skill assertion", () => {
  const plan = buildUnifiedTurnPlan("花園多惠的吉他厲害嗎？", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "花園多惠的吉他很厲害。", plan.currentUser);
  assert.equal(coverage.supported, true);
});

test("Rana plural school query uses controlled profile evidence without generic retrieval", () => {
  const query = "你們讀什麼學校";
  const plan = buildUnifiedTurnPlan(query, { personaId: "rana" });
  assert.equal(plan.evidence.source, "persona_profile");
  assert.equal(turnPlanNeedsLore(plan), false);
  const out = buildPersonaGenerationContext({ prompt: query }, ctx("rana"), plan);
  assert.match(out, /STABLE_PERSONA_PROFILE_EVIDENCE/u);
  assert.match(out, /要樂奈.*花咲川女子學園 中學部.*三年 A 班/u);
  assert.doesNotMatch(out, /LORE|BM25|retriev/iu);
});

test("relationship stance rejects behavior-only relationship evidence", () => {
  const plan = buildUnifiedTurnPlan("你怎麼看爽世", { personaId: "anon" });
  const evidence = "愛音叫她Soyorin。爽世想含糊帶過的時候，愛音會看穿；她也會用過度樂觀的方式，把爽世從CRYCHIC留下的陰影拉回MyGO!!!!!。";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(plan.evidence.requestedAspect, "relationship_stance");
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.aspectCoverage, false);
  assert.equal(coverage.supported, false);
});

test("relationship stance accepts direct evaluative evidence", () => {
  const plan = buildUnifiedTurnPlan("你怎麼看爽世", { personaId: "anon" });
  const coverage = evaluateEvidenceCoverage(plan, "愛音覺得爽世很可靠。", plan.currentUser);
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.aspectCoverage, true);
  assert.equal(coverage.supported, true);
});

test("relationship facts may use bounded relationship behavior evidence", () => {
  const plan = buildUnifiedTurnPlan("你和爽世的關係是什麼", { personaId: "anon" });
  const evidence = "愛音叫她Soyorin。爽世想含糊帶過的時候，愛音會看穿；她也會用過度樂觀的方式，把爽世從CRYCHIC留下的陰影拉回MyGO!!!!!。";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(plan.evidence.requestedAspect, "relationship");
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.aspectCoverage, true);
  assert.equal(coverage.supported, true);
});

test("character profile rejects behavior-only evidence", () => {
  const plan = buildUnifiedTurnPlan("你覺得爽世是什麼樣的人", { personaId: "anon" });
  const evidence = "愛音叫她Soyorin。爽世想含糊帶過的時候，愛音會看穿。";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(plan.evidence.requestedAspect, "character_profile");
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.aspectCoverage, false);
  assert.equal(coverage.supported, false);
});

test("character profile accepts direct characterization evidence", () => {
  const plan = buildUnifiedTurnPlan("你覺得愛音是什麼樣的人", { personaId: "taki" });
  const evidence = "立希嫌愛音練習不夠、太在意外表又愛拖。";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.aspectCoverage, true);
  assert.equal(coverage.supported, true);
});

test("relationship stance rejects an unrelated single event", () => {
  const plan = buildUnifiedTurnPlan("你怎麼看爽世", { personaId: "anon" });
  const coverage = evaluateEvidenceCoverage(plan, "爽世昨天去了便利商店。", plan.currentUser);
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.supported, false);
});

test("identity comparison keeps both canonical entities anchored for coverage", () => {
  const plan = buildUnifiedTurnPlan("睦跟 Mortis 一樣嗎", { personaId: "rana" });
  const evidence = "若葉睦｜identity link｜Mortis（relation: linked_identity_distinct_state_or_persona）";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);

  assert.equal(plan.evidence.required, true);
  assert.equal(plan.evidence.source, "persona_canonical");
  assert.deepEqual(plan.evidence.anchors, ["睦", "Mortis"]);
  assert.equal(plan.evidence.requestedAspect, "identity_relation");
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.supported, true);
});

test("identity comparison rejects mere co-mention without identity relation evidence", () => {
  const plan = buildUnifiedTurnPlan("睦跟 Mortis 一樣嗎", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "睦和 Mortis 都出現在同一段角色索引。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

test("anonymous teaching question anchors the taught object for canonical coverage", () => {
  const plan = buildUnifiedTurnPlan("誰教你看聊天軟體", { personaId: "rana" });
  const evidence = "爽世親自教樂奈打開聊天軟體、看群組、叫出鍵盤並傳送訊息。";
  const coverage = evaluateEvidenceCoverage(plan, evidence, plan.currentUser);

  assert.equal(plan.evidence.required, true);
  assert.equal(plan.evidence.source, "persona_canonical");
  assert.deepEqual(plan.evidence.anchors, ["聊天軟體"]);
  assert.equal(coverage.subjectCoverage, true);
  assert.equal(coverage.supported, true);
});

test("anonymous teaching question does not accept unrelated teaching evidence", () => {
  const plan = buildUnifiedTurnPlan("誰教你看聊天軟體", { personaId: "rana" });
  const coverage = evaluateEvidenceCoverage(plan, "立希教愛音練吉他。", plan.currentUser);
  assert.equal(coverage.supported, false);
});

for (const [personaId, query] of [
  ["anon", "你覺得立希是什麼樣的人"],
  ["taki", "你覺得愛音是什麼樣的人"],
  ["anon", "你怎麼看爽世"],
  ["tomori", "你和樂奈的關係是什麼"],
  ["anon", "你和樂奈的關係是什麼"],
  ["soyo", "你和樂奈的關係是什麼"],
  ["taki", "你和樂奈的關係是什麼"],
  ["rana", "睦跟 Mortis 一樣嗎"],
  ["rana", "你跟睦交換過名字嗎"],
  ["rana", "是 Mortis 帶你去 SPACE 嗎"],
  ["rana", "你和 Mortis 是怎麼到 SPACE 舊址附近的？"],
  ["rana", "誰教你看聊天軟體"],
  ["rana", "你會彈琴嗎"],
  ["rana", "你會彈吉他嗎"],
]) {
  test(`${personaId} actual Persona LORE supports: ${query}`, () => {
    const plan = buildUnifiedTurnPlan(query, { personaId });
    const projected = buildPersonaLoreEvidenceProjection({ prompt: query }, ctx(personaId), plan);
    assert.equal(projected.coverage?.supported, true, `${personaId}: ${query}\n${projected.context}`);
    assert.match(projected.context, /EVIDENCE_COVERAGE=SUPPORTED/u);
  });
}

test("Rana Persona LORE keeps Mortis fingertip question on Mutsumi ownership", () => {
  const query = "Mortis 的指尖很硬嗎";
  const plan = buildUnifiedTurnPlan(query, { personaId: "rana" });
  const projected = buildPersonaLoreEvidenceProjection({ prompt: query }, ctx("rana"), plan);
  assert.equal(projected.coverage?.supported, true, projected.context);
  assert.match(projected.evidenceResult, /指尖/u);
  assert.match(projected.evidenceResult, /睦/u);
});

test("Rana wellbeing question uses the existing current-reaction guard instead of generic open opinion", () => {
  const query = "你今天過得怎麼樣";
  const plan = buildUnifiedTurnPlan(query, { personaId: "rana" });
  assert.equal(plan.utteranceAct?.subtype, "OPEN_PERSONA_OPINION");
  assert.equal(plan.utteranceAct?.activity, "current_reaction");
  assert.equal(plan.responseContract?.responseFunction, "ANSWER_OPEN_PERSONA_OPINION");
  const context = buildPersonaGenerationContext({ prompt: query }, ctx("rana"), plan);
  assert.match(context, /CURRENT_REACTION_DIRECT_ONLY/u);
  assert.match(context, /RECENT_ACTIVITY_JUSTIFICATION/u);
});

test("Rana model-facing Mortis fingertip evidence makes linked-state ownership explicit", async () => {
  const query = "Mortis 的指尖很硬嗎";
  const plan = buildUnifiedTurnPlan(query, { personaId: "rana" });
  const pack = await buildLoreEvidencePack(query, { turnPlan: plan });
  const context = loreEvidenceContext(pack);
  assert.match(context, /這筆內容直接屬於若葉睦/u);
  assert.match(context, /不可轉移成 Mortis 的事件／屬性/u);
});

for (const query of ["是 Mortis 帶你去 SPACE 嗎", "你和 Mortis 是怎麼到 SPACE 舊址附近的？"]) {
  test(`Rana model-facing SPACE evidence preserves follower direction: ${query}`, async () => {
    const plan = buildUnifiedTurnPlan(query, { personaId: "rana" });
    const pack = await buildLoreEvidencePack(query, { turnPlan: plan });
    const context = loreEvidenceContext(pack);
    assert.match(context, /Mortis 跟著要樂奈前往 SPACE舊址附近/u);
    assert.match(context, /跟隨者=Mortis/u);
  });
}

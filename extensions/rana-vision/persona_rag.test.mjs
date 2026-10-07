import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildVisionPersonaEvidence, __test } from "./guidance.js";
import { __test as debugTest } from "./debug.js";

const RANA = "bangdream.character.rana_kaname";
const TOMORI = "bangdream.character.tomori";
const ANON = "bangdream.character.anon";
const SOYO = "bangdream.character.soyo";
const MUTSUMI = "bangdream.character.mutsumi_wakaba";
const SAKIKO = "bangdream.character.sakiko_togawa";

function externalPayload(name, work = "") {
  return {
    canonicalIdentity: { status: "known", entity_id: null, canonical_id: null, confidence: "high" },
    imageUnderstanding: {
      analysisStatus: "known",
      identityDecision: "external_verified",
      visibleText: [],
      externalIdentity: { name, work, confidence: "high", confidenceScore: 0.95 },
      primaryCharacter: null,
      rewardCue: null,
    },
    ranaCharacterImpression: null,
  };
}

function canonicalPayload(entityId, canonicalId, canonicalName) {
  return {
    canonicalIdentity: {
      status: "known",
      entity_id: entityId,
      canonical_id: canonicalId,
      confidence: "high",
    },
    imageUnderstanding: {
      analysisStatus: "known",
      identityDecision: "catalog_known",
      visibleText: [],
      externalIdentity: null,
      primaryCharacter: {
        entityId,
        canonicalId,
        canonicalName,
        confidence: "high",
        confidenceScore: 0.99,
        evidence: [{ source: "official_visual_comparison" }],
      },
      rewardCue: null,
    },
    ranaCharacterImpression: null,
  };
}

function unresolvedPayload(status) {
  return {
    canonicalIdentity: { status, entity_id: null, canonical_id: null, confidence: "unknown" },
    imageUnderstanding: {
      analysisStatus: status,
      identityDecision: "unresolved",
      visibleText: [],
      externalIdentity: null,
      primaryCharacter: null,
      rewardCue: null,
    },
    ranaCharacterImpression: null,
  };
}

function assertPersonaContract(persona) {
  assert.equal(persona.speaker.entityId, RANA);
  assert.equal(persona.speaker.perspective, "first_person");
  assert.equal(persona.speaker.personallySpeaking, true);
  assert.equal(persona.speaker.neverExternalNarrator, true);
  assert.equal(persona.queryPlan.persona_query, true);
  assert.ok(Array.isArray(persona.retrievedFacts));
  assert.ok(Array.isArray(persona.rejectedFacts));
  assert.ok(Array.isArray(persona.boundaries));
  assert.equal(persona.evidenceBudget.hardLimitEnforced, true);
  assert.ok(persona.evidenceBudget.serializedChars <= persona.evidenceBudget.maxChars);
  const serialized = JSON.stringify(persona);
  assert.doesNotMatch(serialized, /rawVisibleText|reverse_image|AniList|CLIP targets|debug trace|targetIds|view_scores/i);
}

test("Case A: Core self identity answers only the current name", () => {
  const soul = fs.readFileSync(new URL("../../workspace/SOUL.md", import.meta.url), "utf8");
  assert.match(soul, /沒有第二個目的就停/);
  assert.match(soul, /不要為延續聊天追加邀請、反問、安慰或服務/);
  const context = __test.directSelfIdentityContext("@Rana 你是誰？");
  assert.match(context, /直接用第一人稱自然回答目前姓名/);
  assert.match(context, /不得主動補充作品、MyGO!!!!!、樂團、吉他手/);
  assert.match(context, /最終文字由 OOGG 自己生成/);
  assert.doesNotMatch(context, /我是要樂奈。/);
});

test("Case B: a verified Rana image binds speaker and subject to self", async () => {
  const payload = canonicalPayload(RANA, "rana", "要樂奈");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.subject.entity_id, RANA);
  assert.equal(persona.resolvedSubject.self, true);
  assert.equal(persona.resolvedSubject.verifiedName, "我");
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
  const context = __test.ooggContext(null, "這是誰？", { ...payload, userQuestion: "這是誰？", personaEvidence: persona });
  assert.match(context, /永遠用第一人稱/);
  assert.match(context, /禁止輸出『這是 Rana／要樂奈』/);
});

test("Case C: verified Tomori maps to canonical lore and Rana's preferred name", async () => {
  const payload = externalPayload("高松燈", "BanG Dream! It's MyGO!!!!!");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.intent, "identity");
  assert.equal(persona.queryPlan.speaker.entity_id, RANA);
  assert.equal(persona.queryPlan.subject.entity_id, TOMORI);
  assert.equal(persona.resolvedSubject.verifiedName, "燈");
  assert.equal(persona.resolvedSubject.workMetadata, null);
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
  assert.deepEqual(persona.retrievedFacts, []);
});

test("Case D: verified Anon maps to canonical lore and the Chinese preferred name", async () => {
  const payload = externalPayload("千早愛音", "BanG Dream! It's MyGO!!!!!");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.subject.entity_id, ANON);
  assert.equal(persona.resolvedSubject.verifiedName, "あのん");
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
});

test("Case E: subtitle text cannot replace the verified Tomori RAG subject", async () => {
  const payload = externalPayload("高松燈", "BanG Dream! It's MyGO!!!!!");
  payload.imageUnderstanding.visibleText = ["我需要愛音！"];
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.subject.entity_id, TOMORI);
  assert.equal(persona.resolvedSubject.verifiedName, "燈");
  assert.doesNotMatch(JSON.stringify(persona), /我需要愛音/);
});

test("Case F: Anon relationship follow-up retrieves more than recognizes", async () => {
  const payload = externalPayload("千早愛音", "BanG Dream! It's MyGO!!!!!");
  const persona = await buildVisionPersonaEvidence(payload, "你和她什麼關係？", { sessionKey: "persona-case-f" });
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.intent, "relationship");
  assert.equal(persona.queryPlan.speaker.entity_id, RANA);
  assert.equal(persona.queryPlan.subject.entity_id, ANON);
  const predicates = new Set(persona.ranaRecognition.positiveRelationshipFacts.map((fact) => fact.predicate));
  assert.equal(persona.resolvedSubject.verifiedName, "あのん");
  assert.equal(Object.hasOwn(persona.ranaRecognition, "preferredName"), false);
  assert.equal(Object.hasOwn(persona.ranaRecognition, "ranaCallsThem"), false);
  assert.ok(predicates.has("recognizes"));
  assert.ok([...predicates].some((predicate) => !["recognizes", "has_seen", "knows_of"].includes(predicate)));
  assert.ok(predicates.size > 1);
  assert.ok(persona.ranaRecognition.specificMemoryAnchors.some((fact) =>
    !["recognizes", "has_seen", "knows_of"].includes(fact.predicate)));
  assert.ok(persona.ranaRecognition.relationshipBoundaries.length > 0);
  assert.ok(persona.ranaRecognition.relationshipBoundaries.every((boundary) => boundary.polarity === "boundary"));
  assert.equal(persona.ranaRecognition.negativeRelationshipFacts.some((fact) => fact.polarity === "boundary"), false);
  assert.match(persona.responseContract.relationship, /boundaries are not claims/);
  assert.equal(persona.responseContract.preferredAddressWhenNamingSubject, "resolvedSubject.verifiedName");
  assert.equal(persona.responseContract.speakerSubjectBinding, "distinct_entities");
  assert.equal(persona.responseContract.avoidUnnecessaryCanonicalFullName, true);
  assert.equal(persona.responseContract.pronounAllowedWhenReferentIsClear, true);
  assert.equal(persona.responseContract.relationshipLabelsMustBeExplicitlySupported, true);
  assert.equal(persona.ranaRecognition.explicitRelationshipLabels.length, 0);
  assert.match(persona.queryPlan.answer_focus, /relationship/);
  const context = __test.ooggContext(null, "你和她什麼關係？", {
    ...payload,
    userQuestion: "你和她什麼關係？",
    personaEvidence: persona,
  });
  assert.match(context, /保持各陣列與 sourceRefs 的來源順序/);
  assert.match(context, /resolvedSubject\.verifiedName 屬於對方，不是 speaker 的名字/);
  assert.match(context, /speaker 是第一人稱「我」的唯一身分/);
  assert.match(context, /只有 explicitRelationshipLabels 或 negativeRelationshipFacts 明確支持時/);
  assert.match(context, /直接用一至兩項來源支持的具體互動回答/);
  assert.match(context, /不新增 fact 外的動作、物件或情節/);
  assert.doesNotMatch(context, /必須自然包含稱呼「愛音」/);
});

test("all characters share one relationship pipeline while source-backed facts remain character-specific", async () => {
  const fixtures = [
    {
      name: "高松燈",
      entityId: TOMORI,
      required: [{ predicate: "performed_live_with", object: TOMORI }],
      forbidden: [
        { predicate: "role", object: "bassist" },
        { predicate: "member_of_or_associated_with", object: "CRYCHIC" },
        { predicate: "member_of_or_associated_with", object: "Ave Mujica" },
      ],
    },
    {
      name: "長崎爽世",
      entityId: SOYO,
      required: [{ predicate: "role", object: "bassist" }],
      forbidden: [
        { predicate: "performed_live_with", object: SOYO },
        { predicate: "member_of_or_associated_with", object: "CRYCHIC" },
        { predicate: "member_of_or_associated_with", object: "Ave Mujica" },
      ],
    },
    {
      name: "若葉睦",
      entityId: MUTSUMI,
      required: [
        { predicate: "member_of_or_associated_with", object: "CRYCHIC" },
        { predicate: "member_of_or_associated_with", object: "Ave Mujica" },
      ],
      forbidden: [
        { predicate: "performed_live_with", object: MUTSUMI },
        { predicate: "role", object: "bassist" },
        { predicate: "member_of_or_associated_with", object: "MyGO!!!!!" },
      ],
    },
  ];
  for (const fixture of fixtures) {
    const persona = await buildVisionPersonaEvidence(externalPayload(fixture.name), "你和她什麼關係？");
    assertPersonaContract(persona);
    assert.equal(persona.queryPlan.subject.entity_id, fixture.entityId);
    const subjectFacts = persona.ranaRecognition.positiveRelationshipFacts.filter((fact) =>
      fact.subject === fixture.entityId || fact.object === fixture.entityId);
    assert.ok(subjectFacts.length > 0, `${fixture.name}: no source-backed pairwise facts`);
    assert.ok(subjectFacts.every((fact) => fact.sourceRefs.length > 0), `${fixture.name}: missing source refs`);
    for (const expected of fixture.required) {
      assert.ok(subjectFacts.some((fact) => fact.predicate === expected.predicate && fact.object === expected.object),
        `${fixture.name}: missing ${expected.predicate} -> ${expected.object}`);
    }
    for (const forbidden of fixture.forbidden) {
      assert.equal(subjectFacts.some((fact) => fact.predicate === forbidden.predicate && fact.object === forbidden.object), false,
        `${fixture.name}: cross-character leak ${forbidden.predicate} -> ${forbidden.object}`);
    }
    assert.deepEqual(persona.ranaRecognition.negativeRelationshipFacts, []);
  }
});

test("positive, negative, and boundary evidence remain separate", async () => {
  const persona = await buildVisionPersonaEvidence(externalPayload("豐川祥子"), "你和她什麼關係？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.subject.entity_id, SAKIKO);
  assert.ok(persona.ranaRecognition.positiveRelationshipFacts.some((fact) => fact.predicate === "has_seen"));
  assert.ok(persona.ranaRecognition.negativeRelationshipFacts.some((fact) =>
    fact.predicate === "recognition_level" && fact.polarity === "negative"));
  assert.ok(persona.ranaRecognition.relationshipBoundaries.every((fact) => fact.polarity === "boundary"));
  assert.equal(persona.ranaRecognition.negativeRelationshipFacts.some((fact) =>
    String(fact.factId || "").startsWith("forbidden_expansion.")), false);
});

test("absence of pairwise evidence does not synthesize a negative relationship", async () => {
  const persona = await buildVisionPersonaEvidence(externalPayload("三角初華"), "你和她什麼關係？");
  assertPersonaContract(persona);
  assert.equal(persona.ranaRecognition.personallyKnown, false);
  assert.deepEqual(persona.ranaRecognition.negativeRelationshipFacts, []);
  assert.equal(persona.ranaRecognition.positiveRelationshipFacts.some((fact) =>
    ["recognizes", "has_seen", "direct_interaction", "recurring_interaction"].includes(fact.predicate)), false);
  assert.ok(persona.ranaRecognition.relationshipBoundaries.length > 0);
});

test("verified external identity remains objective identity without personal relationship claims", async () => {
  const persona = await buildVisionPersonaEvidence(externalPayload("クトリ・ノタ・セニオリス"), "你和她什麼關係？");
  assertPersonaContract(persona);
  assert.equal(persona.resolvedSubject.pipelineStatus, "known");
  assert.equal(persona.ranaRecognition.personallyKnown, false);
  assert.deepEqual(persona.ranaRecognition.positiveRelationshipFacts, []);
  assert.deepEqual(persona.ranaRecognition.negativeRelationshipFacts, []);
});

test("relationship support is data-driven and contains no character-specific production branch", () => {
  const sources = [
    fs.readFileSync(new URL("./guidance.js", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../rana-runtime/lore/retrieval.js", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(sources, /canonical(?:Id|_id)\s*===\s*["'](?:anon|tomori|soyo|taki|sakiko|mutsumi|layer)["']/u);
  assert.doesNotMatch(sources, /(?:anon|tomori|soyo|taki|sakiko|mutsumi|layer).*(?:fixed|hardcode|special[_ -]?case)/iu);
});

test("explicit synthetic conflict is negative while a boundary remains non-negative", () => {
  const negative = __test.compactRelationshipFact({
    factId: "fixture.conflict",
    subject: RANA,
    predicate: "conflict",
    object: "fixture.character",
    polarity: "negative",
    confidence: "high",
    sourceRefs: ["fixture:canonical-event"],
  });
  assert.equal(negative.polarity, "negative");
  const boundary = {
    boundaryId: "fixture.no_romance",
    predicate: "relationship_boundary",
    polarity: "boundary",
    status: "romance_not_supported",
  };
  assert.notEqual(boundary.polarity, negative.polarity);
});

test("Case G: verified external Chtholly stays outside Rana's personal memory", async () => {
  const payload = externalPayload("クトリ・ノタ・セニオリス", "終末なにしてますか? 忙しいですか? 救ってもらっていいですか?");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.resolvedSubject.entityId, null);
  assert.equal(persona.resolvedSubject.workMetadata, null);
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
});

test("identity-only Vision evidence is compact and excludes relationship payloads", async () => {
  const payload = externalPayload("椎名立希", "BanG Dream! It's MyGO!!!!!");
  const persona = await buildVisionPersonaEvidence(payload, "");
  const context = __test.ooggContext(null, "", { ...payload, userQuestion: "", personaEvidence: persona });
  const serialized = JSON.stringify(persona);

  assert.equal(persona.queryPlan.intent, "identity");
  assert.equal(persona.resolvedSubject.verifiedName, "りっきー");
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
  assert.match(serialized, /known/);
  assert.match(serialized, /りっきー/);
  assert.equal(persona.retrievedFacts.length, 0);
  assert.equal(Object.hasOwn(persona, "sourceRefs"), false);
  assert.equal(Object.hasOwn(persona, "forbiddenExpansion"), false);
  assert.doesNotMatch(serialized, /positiveRelationshipFacts|negativeRelationshipFacts|memoryAnchors|allowedKnowledge|sourceRefs|forbiddenExpansion|friendship|朋友/u);
  assert.ok(context.length < 3000, `identity context remained ${context.length} chars`);
  assert.doesNotMatch(context, /朋友|friendship|relationshipBoundaries/u);
});

test("relationship evidence preserves source order and semantic separation without scoring", async () => {
  const facts = [
    { factId: "first", predicate: "recognizes", polarity: "positive" },
    { factId: "second", predicate: "bought_for", polarity: "positive" },
    { factId: "third", predicate: "conflict", polarity: "negative" },
  ];
  assert.deepEqual(
    __test.querySpecificRelationshipFacts(facts, "relationship").map((fact) => fact.factId),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    __test.querySpecificRelationshipFacts(facts, "recognition").map((fact) => fact.factId),
    ["first"],
  );
  assert.deepEqual(__test.querySpecificRelationshipFacts(facts, "identity"), []);

  const persona = await buildVisionPersonaEvidence(externalPayload("千早愛音"), "你和她什麼關係？");
  assert.ok(persona.ranaRecognition.positiveRelationshipFacts.length > 0);
  assert.ok(persona.ranaRecognition.negativeRelationshipFacts.every((fact) => fact.polarity === "negative"));
  assert.ok(persona.ranaRecognition.relationshipBoundaries.every((fact) => fact.polarity === "boundary"));
  assert.equal(persona.ranaRecognition.negativeRelationshipFacts.some((fact) => fact.polarity === "boundary"), false);
});

test("Case H: work metadata is exposed only when the follow-up asks for it", async () => {
  const payload = externalPayload("クトリ・ノタ・セニオリス", "終末なにしてますか? 忙しいですか? 救ってもらっていいですか?");
  const persona = await buildVisionPersonaEvidence(payload, "哪部作品？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.intent, "work_metadata");
  assert.equal(persona.queryPlan.answer_focus, "requested_work_only");
  assert.match(persona.resolvedSubject.workMetadata, /終末/);
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
});

test("Case I: verified external Usagi is identity-first and not fake personal lore", async () => {
  const payload = externalPayload("うさぎ", "ちいかわ");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.queryPlan.intent, "identity");
  assert.equal(persona.resolvedSubject.verifiedName, "うさぎ");
  assert.equal(persona.resolvedSubject.workMetadata, null);
  assert.equal(Object.hasOwn(persona, "ranaRecognition"), false);
});

test("Case J: unknown identity has a boundary and no guessed facts", async () => {
  const persona = await buildVisionPersonaEvidence(unresolvedPayload("unknown"), "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.resolvedSubject.pipelineStatus, "unknown");
  assert.equal(persona.resolvedSubject.verifiedName, "");
  assert.deepEqual(persona.retrievedFacts, []);
  assert.ok(persona.boundaries.some((boundary) => boundary.status === "vision_unknown"));
});

test("Case K: pipeline error has a boundary without provider or trace leakage", async () => {
  const persona = await buildVisionPersonaEvidence(unresolvedPayload("error"), "這是誰？");
  assertPersonaContract(persona);
  assert.equal(persona.resolvedSubject.pipelineStatus, "error");
  assert.deepEqual(persona.retrievedFacts, []);
  assert.ok(persona.boundaries.some((boundary) => boundary.status === "vision_error"));
  const context = __test.ooggContext(null, "這是誰？", {
    ...unresolvedPayload("error"),
    userQuestion: "這是誰？",
    personaEvidence: persona,
  });
  assert.match(context, /自然說我現在看不了/);
  assert.doesNotMatch(JSON.stringify(persona), /provider|trace|GGUF|mmproj/i);
});

test("Persona generation context preserves OOGG authority and bans encyclopedia defaults", async () => {
  const payload = externalPayload("高松燈", "BanG Dream! It's MyGO!!!!!");
  const persona = await buildVisionPersonaEvidence(payload, "這是誰？");
  const context = __test.ooggContext(null, "這是誰？", { ...payload, userQuestion: "這是誰？", personaEvidence: persona });
  assert.match(context, /最終文字由 OOGG 自己決定，不得由外部程式改寫/);
  assert.match(context, /問是誰就只答稱呼，不補關係、記憶或作品履歷/);
  assert.match(context, /需要稱呼 subject 時優先使用 responseContract\.preferredAddressWhenNamingSubject/);
  assert.doesNotMatch(context, /mustMentionRequiredAddress/);
  assert.doesNotMatch(context, /explicitRelationshipLabels|unsupportedRelationshipLabels|relationshipBoundaries|forbiddenExpansion/);
  assert.match(context, /不要輸出.*括號式動作/);
  assert.doesNotMatch(context, /targetIds|view_scores|ranaCharacterImpression/);
  assert.doesNotMatch(context, /可以回答姓名與作品/);
});

test("production identity and core traces retain Persona Evidence stages", () => {
  for (const stage of ["vision_persona_evidence", "vision_persona_followup", "oogg_persona_prepend_context"]) {
    assert.ok(debugTest.IDENTITY_TRACE_STAGES.has(stage));
    assert.ok(debugTest.CORE_TRACE_STAGES.has(stage));
  }
});

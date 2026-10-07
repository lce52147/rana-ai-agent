import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { clearResolvedEntities, resolveEntityMentions } from "./entity_resolver.js";
import {
  buildLoreEvidencePack,
  loreEvidenceContext,
  safeEvidencePack,
  shouldRetrieveLore,
} from "./retrieval.js";
import { compactLoreSystemPrompt, formatLoreOutgoing, registerLoreGuidance, __test as guidanceTest } from "./guidance.js";
import { buildUnifiedTurnPlan } from "../architecture/turn_plan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STORE_PATH = path.join(ROOT, "workspace", "LORE", "runtime", "06_Rana_Character_Impressions.json");
const RANA = "bangdream.character.rana_kaname";

function payload(pack) {
  return JSON.parse(loreEvidenceContext(pack).split("\n").slice(1).join("\n"));
}

function factTriples(pack) {
  return (pack.structured_facts || []).map((item) => [item.subject, item.predicate, item.object]);
}

test("structured store is the single runtime fact authority", () => {
  const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  assert.equal(store.authority.role, "single_runtime_character_fact_store");
  assert.ok(store.facts.length > 80);
  assert.ok(store.boundaries.length >= 6);
  assert.ok(store.descriptors.length >= 4);
  assert.match(store.policies.groupMembershipDoesNotImply, /pairwise_recognition/u);
});

test("retrieval source contains no character-specific fact branches or shared-group recognition inference", () => {
  const source = fs.readFileSync(new URL("./retrieval.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /canonical_id\s*===\s*["'](?:sakiko|anon|nyamu|mutsumi|mortis)["']/u);
  assert.doesNotMatch(source, /shared_group/u);
  assert.doesNotMatch(source, /memoryAnchors.*descript|howRanaKnowsThem.*descript/iu);
});

test("canonical aliases resolve while Mutsumi and Mortis remain distinct", () => {
  const entities = resolveEntityMentions("若葉睦跟 Mortis");
  assert.deepEqual(new Set(entities.map((item) => item.canonical_id)), new Set(["mutsumi", "mortis"]));
});

test("ordinary mentions and current observations do not trigger LORE", () => {
  for (const text of ["是愛音", "我看到爽世了", "今天會想做什麼？", "Read HEARTBEAT.md if it exists"]) {
    assert.equal(shouldRetrieveLore(text), false, text);
  }
  for (const text of ["愛音是誰？", "妳認識愛音嗎？", "睦和 Mortis 有什麼不同？", "妳以前常去 SPACE 嗎？"]) {
    assert.equal(shouldRetrieveLore(text), true, text);
  }
});

test("assistant self-identity variants stay in Core while third-party identity remains retrievable", async () => {
  for (const text of ["@Rana 你是誰？", "你是誰？", "妳是誰？", "你叫什麼？", "妳叫什麼名字？", "你是哪位？"]) {
    assert.equal(shouldRetrieveLore(text), false, text);
  }

  assert.equal(shouldRetrieveLore("愛音是誰？"), true);
  const anon = await buildLoreEvidencePack("愛音是誰？", { forceIndexUnavailable: true });
  assert.equal(anon.intent, "identity");
  assert.deepEqual(anon.query_plan.subject.entity_ids, ["bangdream.character.anon"]);

  const sessionKey = "test:pronoun:identity";
  clearResolvedEntities(sessionKey);
  await buildLoreEvidencePack("愛音是誰？", { sessionKey, forceIndexUnavailable: true });
  const pronoun = await buildLoreEvidencePack("她是誰？", { sessionKey, forceIndexUnavailable: true });
  assert.equal(pronoun.intent, "identity");
  assert.deepEqual(pronoun.query_plan.subject.entity_ids, ["bangdream.character.anon"]);

  assert.equal(shouldRetrieveLore("要樂奈是誰？"), true);
  const namedRana = await buildLoreEvidencePack("要樂奈是誰？", { forceIndexUnavailable: true });
  assert.equal(namedRana.intent, "identity");
  assert.deepEqual(namedRana.query_plan.subject.entity_ids, [RANA]);
  assert.ok(namedRana.structured_facts.some((item) => item.factId === "rana.identity"));
});

test("heartbeat context is rejected before retrieval", async () => {
  let handler;
  const api = {
    on(name, fn) { if (name === "before_prompt_build") handler = fn; },
    registerTool() {},
    logger: { warn() {} },
  };
  registerLoreGuidance(api);
  const result = await handler(
    { prompt: "Read HEARTBEAT.md if it exists (workspace context).", provider: "heartbeat" },
    { channel: "heartbeat", provider: "heartbeat" },
  );
  assert.equal(result, undefined);
  assert.equal(guidanceTest.isInternalPrompt("anything", { channel: "heartbeat" }), true);
});

test("known people inventory first round stays in the core MyGO social set", async () => {
  const pack = await buildLoreEvidencePack("你認識誰", { forceIndexUnavailable: true });
  const triples = factTriples(pack);
  const objects = new Set(triples.filter(([, predicate]) => ["recognizes", "has_seen"].includes(predicate)).map(([, , object]) => object));
  assert.equal(pack.intent, "known_people_inventory");
  assert.deepEqual(objects, new Set([
    "bangdream.character.tomori",
    "bangdream.character.taki",
    "bangdream.character.anon",
    "bangdream.character.soyo",
  ]));
});

test("known people inventory follow-up inherits the inventory and expands only remembered people", async () => {
  const turnPlan = buildUnifiedTurnPlan("還有誰", { personaId: "rana", previousUserText: "你認識誰" });
  assert.equal(turnPlan.utteranceAct?.continuationMode, "known_people_inventory_followup");
  assert.equal(turnPlan.evidence?.required, true);
  assert.equal(turnPlan.evidence?.source, "persona_canonical");

  const pack = await buildLoreEvidencePack("還有誰", { turnPlan, forceIndexUnavailable: true });
  const triples = factTriples(pack);
  const objects = new Set(triples.filter(([, predicate]) => ["recognizes", "has_seen"].includes(predicate)).map(([, , object]) => object));
  assert.equal(pack.intent, "known_people_inventory");
  for (const expected of [
    "bangdream.character.mutsumi_wakaba",
    "bangdream.character.mortis",
    "bangdream.character.nyamu_yutenji",
    "bangdream.character.layer",
    "bangdream.character.kokoro",
    "bangdream.character.masking",
    "bangdream.character.tsugumi",
    "bangdream.character.hagumi",
    "bangdream.character.chu2",
  ]) assert.ok(objects.has(expected), expected);
  for (const forbidden of [
    "bangdream.character.tomori",
    "bangdream.character.taki",
    "bangdream.character.anon",
    "bangdream.character.soyo",
    "bangdream.character.shifune",
    "bangdream.character.ririko",
    "bangdream.character.sakiko_togawa",
    "bangdream.character.uika",
    "bangdream.character.umiri",
    "bangdream.character.kasumi_toyama",
  ]) assert.equal(objects.has(forbidden), false, forbidden);
});

test("exact known-people inventory query is covered by speaker recognition facts", async () => {
  const query = "你認識誰";
  const turnPlan = buildUnifiedTurnPlan(query, { personaId: "rana" });
  const pack = await buildLoreEvidencePack(query, { turnPlan, forceIndexUnavailable: true });
  const context = loreEvidenceContext(pack);

  assert.equal(pack.intent, "known_people_inventory");
  assert.equal(pack.evidence_coverage?.supported, true);
  assert.equal(pack.knowledge_contract, "known");
  assert.match(context, /證據覆蓋: relationship 已有直接支持/u);
  assert.doesNotMatch(context, /subject not covered/u);
});

test("unknown inventory is separate from recognized people", async () => {
  const pack = await buildLoreEvidencePack("妳不認識哪些人？", { forceIndexUnavailable: true });
  assert.equal(pack.intent, "unknown_people_inventory");
  const objects = new Set(pack.structured_facts.map((item) => item.object));
  assert.ok(objects.has("bangdream.character.uika"));
  assert.ok(objects.has("bangdream.character.kasumi_toyama"));
  assert.equal(objects.has("bangdream.character.anon"), false);
});

test("person recognition uses only pairwise recognition facts", async () => {
  const pack = await buildLoreEvidencePack("妳認識愛音嗎？", { forceIndexUnavailable: true });
  assert.equal(pack.intent, "person_recognition_check");
  assert.ok(pack.structured_facts.some((item) => item.subject === RANA && item.predicate === "recognizes" && item.object === "bangdream.character.anon"));
  assert.ok(pack.knowledge_boundaries.some((item) => item.predicate === "friendship"));
  assert.equal(pack.structured_facts.some((item) => item.predicate === "worked_with"), false);
});

test("Rana-target relationship questions use explicit pairwise, membership, and role facts", async () => {
  for (const text of ["你和愛音是什麼關係？", "妳跟愛音熟嗎？", "愛音和你是團員嗎？"]) {
    const pack = await buildLoreEvidencePack(text, { forceIndexUnavailable: true });
    assert.equal(pack.intent, "relationship", text);
    assert.equal(pack.query_plan.predicate, "recognizes", text);
    assert.equal(pack.query_plan.scope, "explicit_pairwise_relationship", text);
    assert.deepEqual(pack.query_plan.subject.entity_ids, [RANA], text);
    assert.deepEqual(pack.query_plan.object.entity_ids, ["bangdream.character.anon"], text);

    const factIds = new Set(pack.structured_facts.map((item) => item.factId));
    for (const expected of [
      "rana.recognizes.anon",
      "anon.recognizes.rana",
      "anon.social",
      "rana.member.mygo",
      "rana.role.guitar",
      "anon.group.0",
      "anon.role",
    ]) {
      assert.ok(factIds.has(expected), `${text}: ${expected}`);
    }
    assert.ok(pack.knowledge_boundaries.some((item) => item.boundaryId === "recognition_does_not_imply.friendship"), text);
  }
});

test("subjective impression remains distinct from objective relationship planning", async () => {
  const pack = await buildLoreEvidencePack("你怎麼看愛音？", { forceIndexUnavailable: true });
  assert.equal(pack.intent, "entity_or_event");
  assert.equal(pack.query_plan.predicate, "identity_or_attribute");
});

test("speaker recognition question does not inject the reverse relationship", async () => {
  const pack = await buildLoreEvidencePack("妳認識愛音嗎？", { forceIndexUnavailable: true });
  assert.ok(pack.structured_facts.some((item) => item.subject === RANA && item.object === "bangdream.character.anon"));
  assert.equal(pack.structured_facts.some((item) => item.subject === "bangdream.character.anon" && item.object === RANA), false);

  const frontedObject = await buildLoreEvidencePack("愛音妳認識嗎？", { forceIndexUnavailable: true });
  assert.equal(frontedObject.intent, "person_recognition_check");
  assert.ok(frontedObject.structured_facts.some((item) => item.subject === RANA && item.object === "bangdream.character.anon"));
});

test("third-party relationship direction is explicit and not generated from a shared group", async () => {
  const pack = await buildLoreEvidencePack("愛音認識誰？", { forceIndexUnavailable: true });
  assert.equal(pack.intent, "third_party_relationship_inventory");
  assert.ok(pack.structured_facts.every((item) => item.subject === "bangdream.character.anon"));
  assert.ok(pack.structured_facts.some((item) => item.object === RANA));
  assert.ok(pack.structured_facts.some((item) => item.object === "bangdream.character.tomori"));
  assert.ok(pack.knowledge_boundaries.some((item) => item.status === "incomplete"));
});

test("Ave Mujica interaction inventory comes from explicit event ownership", async () => {
  const pack = await buildLoreEvidencePack("妳跟 Ave Mujica 的哪些人有互動？", { forceIndexUnavailable: true });
  const objects = new Set(pack.structured_facts.map((item) => item.object));
  assert.deepEqual(objects, new Set([
    "bangdream.character.mutsumi_wakaba",
    "bangdream.character.mortis",
    "bangdream.character.nyamu_yutenji",
  ]));
  assert.equal(objects.has("bangdream.character.uika"), false);
  assert.equal(objects.has("bangdream.character.umiri"), false);
});

test("Mutsumi and Mortis preserve linked identity and separate event ownership", async () => {
  const comparison = await buildLoreEvidencePack("睦和 Mortis 是同一個人嗎？", { forceIndexUnavailable: true });
  assert.equal(comparison.intent, "entity_comparison");
  assert.ok(comparison.structured_facts.every((item) => item.predicate === "identity_link"));
  assert.ok(comparison.knowledge_boundaries.some((item) => item.boundaryId === "mutsumi.no_mortis_events"));
  assert.ok(comparison.knowledge_boundaries.some((item) => item.boundaryId === "mortis.no_mutsumi_events"));
  assert.match(loreEvidenceContext(comparison), /若葉睦.*Mortis.*同一個人的兩個狀態/u);

  const mutsumi = await buildLoreEvidencePack("妳跟睦談過什麼？", { forceIndexUnavailable: true });
  assert.ok(mutsumi.structured_facts.some((item) => item.factId === "mutsumi.guitar"));
  assert.equal(mutsumi.structured_facts.some((item) => item.factId?.startsWith("mortis.")), false);

  const mortis = await buildLoreEvidencePack("妳跟 Mortis 去過哪裡？", { forceIndexUnavailable: true });
  assert.ok(mortis.structured_facts.some((item) => item.factId === "mortis.space"));
  assert.equal(mortis.structured_facts.some((item) => item.factId?.startsWith("mutsumi.")), false);

  const linkedExchange = await buildLoreEvidencePack("你跟睦交換過名字嗎", { forceIndexUnavailable: true });
  assert.equal(linkedExchange.knowledge_contract, "known");
  assert.ok(linkedExchange.structured_facts.some((item) => item.factId === "mortis.name_exchange"));
  assert.ok(linkedExchange.structured_facts.some((item) => item.predicate === "linked_identity_event_ownership"
    && item.subject === "bangdream.character.mutsumi_wakaba"
    && item.object === "bangdream.character.mortis"));
  assert.ok(linkedExchange.knowledge_boundaries.some((item) => item.boundaryId === "mutsumi.no_mortis_events"));
});

test("Nyamu name sequence is known while her internal motivation remains bounded", async () => {
  const event = await buildLoreEvidencePack("妳和にゃむ交換名字時發生了什麼？", { forceIndexUnavailable: true });
  assert.equal(event.knowledge_contract, "known");
  assert.ok(event.structured_facts.some((item) => item.factId === "nyamu.name_part"));
  assert.ok(event.structured_facts.some((item) => item.factId === "nyamu.full_pronunciation"));

  const reason = await buildLoreEvidencePack("祐天寺にゃむ為什麼要妳念完整名字？", { forceIndexUnavailable: true });
  assert.equal(reason.knowledge_contract, "boundary");
  assert.ok(reason.structured_facts.some((item) => item.factId === "nyamu.full_pronunciation"));
  assert.ok(reason.knowledge_boundaries.some((item) => item.boundaryId === "nyamu.reason_full_name"));
});

test("Rana instrument capability uses controlled Persona core evidence", async () => {
  const guitar = await buildLoreEvidencePack("你會彈吉他嗎", { forceIndexUnavailable: true });
  assert.equal(guitar.knowledge_contract, "known");
  assert.equal(guitar.evidence_coverage?.supported, true);
  assert.ok(guitar.structured_facts.some((item) => item.factId === "rana.role.guitar"));

  const piano = await buildLoreEvidencePack("你會彈琴嗎", { forceIndexUnavailable: true });
  assert.equal(piano.knowledge_contract, "known");
  assert.equal(piano.evidence_coverage?.supported, true);
  assert.ok(piano.supporting_evidence.some((item) => /不會彈琴/u.test(String(item.content || ""))));
});

test("Sakiko keeps seen-not-close outer fact and financial boundary", async () => {
  const pack = await buildLoreEvidencePack("妳知道祥子家的財務內情嗎？", { forceIndexUnavailable: true });
  assert.equal(pack.knowledge_contract, "boundary");
  assert.ok(pack.structured_facts.some((item) => item.factId === "rana.has_seen.sakiko"));
  assert.ok(pack.knowledge_boundaries.some((item) => item.boundaryId === "sakiko.family_finances"));
});

test("unsupported specific events fail closed", async () => {
  const pack = await buildLoreEvidencePack("妳跟愛音去過火星嗎？", { forceIndexUnavailable: true });
  assert.equal(pack.knowledge_contract, "unknown");
  assert.equal(pack.structured_facts.length, 0);
  assert.ok(pack.knowledge_boundaries.some((item) => item.boundaryId === "requested_event.unsupported"));
});

test("SPACE and RiNG temporal facts cannot become a current SPACE visit", async () => {
  const pack = await buildLoreEvidencePack("妳以前去過 SPACE，現在還常去嗎？", { forceIndexUnavailable: true });
  assert.ok(pack.structured_facts.some((item) => item.factId === "rana.place.space.past"));
  assert.ok(pack.structured_facts.some((item) => item.factId === "place.space.closed"));
  assert.ok(pack.structured_facts.some((item) => item.factId === "rana.place.ring.current"));
  assert.ok(pack.knowledge_boundaries.some((item) => item.boundaryId === "space.current_visit"));
});

test("descriptive identity uses controlled descriptors and unique margin", async () => {
  const resolved = await buildLoreEvidencePack("紫色長髮、跟 CRYCHIC 有關的人是誰？", { forceIndexUnavailable: true });
  assert.deepEqual(resolved.resolved_entities.map((item) => item.canonical_id), ["mutsumi"]);
  assert.equal(resolved.resolved_entities[0].source, "structured_descriptor");

  const vague = await buildLoreEvidencePack("那個 CRYCHIC 成員是誰？", { forceIndexUnavailable: true });
  assert.equal(vague.resolved_entities.length, 0);
  assert.equal(vague.knowledge_contract, "unknown");
});

test("source questions expose sourceRefs without turning provenance prose into normal facts", async () => {
  const pack = await buildLoreEvidencePack("妳和にゃむ互動的來源是哪個活動？", { forceIndexUnavailable: true });
  assert.equal(pack.knowledge_contract, "source");
  const context = payload(pack);
  assert.ok(context.facts.some((item) => (item.source_refs || []).some((ref) => /event307/u.test(ref))));
});

test("Evidence Pack is factual JSON without answer scripts", async () => {
  const pack = await buildLoreEvidencePack("妳認識愛音嗎？", { forceIndexUnavailable: true });
  const context = loreEvidenceContext(pack);
  assert.match(context, /"facts"/u);
  assert.match(context, /"knowledge_boundaries"/u);
  assert.doesNotMatch(context, /必須先說|逐字列出|不可漏掉|最後必須|required_subjects|minimum_subject_count|answer_shape/u);
  assert.deepEqual(safeEvidencePack(pack).structured_facts, pack.structured_facts);
});

test("system guidance separates persona from facts without an override war", () => {
  const prompt = compactLoreSystemPrompt();
  assert.match(prompt, /Core 只決定 Rana 的人格/u);
  assert.match(prompt, /facts 與 knowledge boundaries/u);
  assert.doesNotMatch(prompt, /Core.*優先|RAG.*優先|覆蓋/u);
});

test("LORE outgoing path does not rewrite model semantics", () => {
  const raw = "我認識愛音。";
  assert.equal(formatLoreOutgoing(raw), raw);
});

test("pronoun memory remains session-scoped", async () => {
  const session = "test:pronoun:single-authority";
  clearResolvedEntities(session);
  await buildLoreEvidencePack("妳認識愛音嗎？", { sessionKey: session, forceIndexUnavailable: true });
  const pack = await buildLoreEvidencePack("她買過什麼給妳？", { sessionKey: session, forceIndexUnavailable: true });
  assert.deepEqual(pack.resolved_entities.map((item) => item.canonical_id), ["anon"]);
  assert.ok(pack.structured_facts.some((item) => item.factId === "anon.drink"));
});

test("vision unknown and error never gain character facts", async () => {
  for (const visionStatus of ["unknown", "error"]) {
    const pack = await buildLoreEvidencePack("這是誰？", { visionStatus });
    assert.equal(pack.resolved_entities.length, 0);
    assert.equal(pack.structured_facts.length, 0);
    assert.equal(pack.knowledge_contract, "unknown");
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { allPersonaIds, hardRuleForTest, retrieveTurnContext, __test as retrievalTest } from "./turn_retrieval.js";
import { searchPersonaLore } from "../persona_lore.js";

test("memory candidates use the same no-entity threshold as LORE", () => {
  const config = retrievalTest.retrievalConfig();
  assert.equal(config.noEntityEmbeddingThreshold, 0.62);
  assert.equal(config.noEntityFallbackThreshold, 0.7);
});

test("turn retrieval uses entity ownership before legacy question types", async () => {
  assert.deepEqual(allPersonaIds().sort(), ["anon", "rana", "soyo", "taki", "tomori"]);
  const result = await retrieveTurnContext({ personaId: "rana", query: "妳覺得あのちゃん是怎樣的人？", sessionKey: "arch-test" });
  assert.equal(result.trace.rule, "entity_scoped_cosine_relevance");
  assert.equal(result.resolvedEntities[0].canonical_id, "anon");
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.some((entry) => /^(?:fact|relation):rana:千早愛音:/u.test(entry.id)));
  assert.ok(result.entries.every((entry) => /(?:千早愛音|愛音|あのちゃん)/u.test(`${entry.title}\n${entry.content}`)));
});

test("hard boundaries avoid lore injection for verbatim, music, and current requests", async () => {
  assert.equal(hardRuleForTest("請逐字回答").reason, "verbatim_payload");
  assert.equal(hardRuleForTest("播放一首歌").reason, "music_tool_command");
  const current = await retrieveTurnContext({ personaId: "rana", query: "最近和爽世做了什麼？" });
  assert.equal(current.trace.rule, "recent_time_boundary");
  assert.equal(current.entries.length, 0);
  assert.match(current.text, /recent or current time/u);
});

test("ordinary conversation stays outside the retrieval pool", async () => {
  const result = await retrieveTurnContext({ personaId: "soyo", query: "嗯，我知道了。" });
  assert.equal(result.entries.length, 0);
  assert.equal(result.trace.rule, "ordinary_no_entity_statement");
});

test("recent or current questions expose only the time boundary", async () => {
  const result = await retrieveTurnContext({ personaId: "rana", query: "請說說最近的練習。" });
  assert.equal(result.entries.length, 0);
  assert.match(result.text, /recent or current time/u);
  assert.equal(result.trace.rule, "recent_time_boundary");
});

test("all personas keep unresolved controls and relation evidence out of model-facing text", async () => {
  const questions = [
    "妳和愛音以前發生過什麼事？",
    "最近的練習怎麼樣？",
    "請說說天氣和貓。",
  ];
  for (const personaId of allPersonaIds()) {
    for (const query of questions) {
      const result = await retrieveTurnContext({ personaId, query, sessionKey: `arch3-${personaId}` });
      assert.doesNotMatch(result.text, /^[A-Z][A-Z0-9_]*=.*$/mu, `${personaId}: ${query}`);
      assert.doesNotMatch(result.text, /\bADV\s*[:#\[]/iu, `${personaId}: ${query}`);
    }
  }
});

test("the twenty directed MyGO relation directions stay owned by the requested speaker and target", async () => {
  const directions = {
    rana: [["tomori", "燈", "高松燈"], ["anon", "愛音", "千早愛音"], ["soyo", "爽世", "長崎爽世"], ["taki", "立希", "椎名立希"]],
    tomori: [["rana", "樂奈", "要樂奈"], ["anon", "愛音", "千早愛音"], ["soyo", "爽世", "長崎爽世"], ["taki", "立希", "椎名立希"]],
    anon: [["rana", "樂奈", "要樂奈"], ["tomori", "燈", "高松燈"], ["soyo", "爽世", "長崎爽世"], ["taki", "立希", "椎名立希"]],
    soyo: [["rana", "樂奈", "要樂奈"], ["tomori", "燈", "高松燈"], ["anon", "愛音", "千早愛音"], ["taki", "立希", "椎名立希"]],
    taki: [["rana", "樂奈", "要樂奈"], ["tomori", "燈", "高松燈"], ["anon", "愛音", "千早愛音"], ["soyo", "爽世", "長崎爽世"]],
  };
  for (const [speaker, pairs] of Object.entries(directions)) {
    for (const [targetId, alias, targetName] of pairs) {
      const result = await retrieveTurnContext({ personaId: speaker, query: `我和${alias}以前發生過什麼事？`, sessionKey: `arch3-direction-${speaker}` });
      assert.equal(result.resolvedEntities[0]?.canonical_id, targetId, `${speaker}->${targetId}`);
      assert.ok(result.entries.length >= 3, `${speaker}->${targetId}`);
      assert.ok(result.entries.every((entry) => entry.kind === "relation_event"), `${speaker}->${targetId}`);
      assert.ok(result.entries.every((entry) => entry.entity === targetName), `${speaker}->${targetId}`);
    }
  }
});

test("R-2 grounds 燈 in relation-object continuation and excludes index chunks", async () => {
  const result = await retrieveTurnContext({ personaId: "soyo", query: "妳買飲料給燈後，最後弄清楚自己先前誤會了哪件事？" });
  assert.deepEqual(result.resolvedEntities.map((item) => item.canonical_id), ["tomori"]);
  assert.ok(result.entries.length > 0);
  assert.equal(result.entries.some((entry) => /(?:索引|目前讀過|怎麼找的)/u.test(`${entry.title}\n${entry.content}`)), false);

  const rawHits = searchPersonaLore("soyo", "妳買飲料給燈後，最後弄清楚自己先前誤會了哪件事？", { maxResults: 30 });
  assert.equal(rawHits.some((entry) => /(?:索引|目前讀過|怎麼找的)/u.test(`${entry.title}\n${entry.content}`)), false);
});

test("retrieval renderer puts the language instruction last", async () => {
  const result = await retrieveTurnContext({ personaId: "rana", query: "にゃむ在 Ave Mujica 裡演奏哪一種樂器？" });
  assert.match(result.text, /本題用使用者的語言回答/u);
  assert.equal(result.text.trim().split("\n").at(-1), "本題用使用者的語言回答");
});

test("related remembered people remain isolated and role facts are retrievable", async () => {
  const mutsumi = await retrieveTurnContext({ personaId: "rana", query: "我和睦以前發生過什麼事？" });
  const mortis = await retrieveTurnContext({ personaId: "rana", query: "我和 Mortis 以前發生過什麼事？" });
  assert.ok(mutsumi.entries.length > 0);
  assert.ok(mortis.entries.length > 0);
  assert.ok(mutsumi.entries.every((entry) => entry.entity === "若葉睦"));
  assert.ok(mortis.entries.every((entry) => entry.entity === "Mortis"));

  const nyamu = await retrieveTurnContext({ personaId: "rana", query: "にゃむ是什麼角色？" });
  const layer = await retrieveTurnContext({ personaId: "rana", query: "LAYER 是什麼角色？" });
  assert.match(nyamu.text, /Ave Mujica 的鼓手/u);
  assert.match(layer.text, /RAISE A SUILEN 的主唱兼貝斯手/u);
});

test("non-person light, weather, cat, and ordinary phrases stay outside LORE", async () => {
  for (const query of ["燈光太暗了", "今天天氣好嗎？", "貓在睡覺", "今天好累"]) {
    const result = await retrieveTurnContext({ personaId: "rana", query });
    assert.equal(result.entries.length, 0, query);
    assert.equal(result.trace.rule, "ordinary_no_entity_statement", query);
    assert.equal(result.text, "", query);
  }
});

test("a third-party pairing does not add the active speaker's own directional events", async () => {
  const result = await retrieveTurnContext({ personaId: "rana", query: "愛音和燈以前有什麼互動？" });
  assert.equal(result.entries.some((entry) => entry.kind === "relation_event"), false);
  assert.equal(result.entries.some((entry) => entry.entity === "要樂奈"), false);
});

test("remembered interaction fragments render the canonical speaker and target", async () => {
  const result = await retrieveTurnContext({ personaId: "rana", query: "妳記得在 LAYER 腿上睡過嗎？" });
  assert.match(result.text, /要樂奈在 LAYER 腿上睡過/u);
});

test("relation rendering deduplicates identical content and states the expansion boundary", async () => {
  const result = await retrieveTurnContext({ personaId: "tomori", query: "爽世給妳那杯飲料時，後來妳們之間發生了什麼？", sessionKey: "arch5-render-dedupe" });
  const event = "爽世買了以為燈喜歡的摩卡咖啡；燈說自己以前在 CRYCHIC 聚會點摩卡，是因為不知道該點什麼、想到之前看爽世點過才跟著點；爽世後來說自己自以為很懂燈。";
  assert.equal(result.text.split(event).length - 1, 1);
  assert.match(result.text, /Only repeat the event sequence and details present in the entries; do not add motives, emotions, dialogue or details absent from the entries\./u);
  assert.match(result.text, /If the user asks about an omitted part, say you do not remember it or are unclear\./u);
});

test("fact-backed relation prompts also state the expansion boundary", async () => {
  const result = await retrieveTurnContext({ personaId: "soyo", query: "那次燈撿完石頭離開前，爽世最後做了什麼？", sessionKey: "arch6-fact-boundary" });
  assert.match(result.text, /Only repeat the event sequence and details present in the entries; do not add motives, emotions, dialogue or details absent from the entries\./u);
});

test("role questions ground the entity outside the three ranked entries", async () => {
  for (const question of ["做什麼的", "負責什麼", "是誰", "是哪團的", "哪個團", "什麼樂團", "擔任什麼", "位置", "part"]) {
    const result = await retrieveTurnContext({ personaId: "rana", query: `LAYER ${question}？` });
    assert.match(result.text, /Entity grounding:\n- LAYER：RAISE A SUILEN 的主唱兼貝斯手/u, question);
    assert.match(result.text, /For a role question, state the supplied role in the user's language; source-language role terms are evidence and must be translated rather than copied\./u, question);
    assert.match(result.text, /Reply in the user's language; Japanese names, aliases and source wording do not require a Japanese reply/u, question);
    assert.ok(result.entries.length <= 3, question);
    assert.equal(result.trace.k, result.entries.length, question);
  }
  const ordinary = await retrieveTurnContext({ personaId: "rana", query: "妳記得在 LAYER 腿上睡過嗎？" });
  assert.doesNotMatch(ordinary.text, /- LAYER：RAISE A SUILEN/u);
});

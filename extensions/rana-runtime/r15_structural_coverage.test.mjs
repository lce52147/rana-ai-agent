import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedTurnPlan, turnPlanNeedsLore } from "./architecture/turn_plan.js";
import { buildLoreEvidencePack, loreEvidenceContext } from "./lore/retrieval.js";
import { __test as isolation } from "./architecture/turn_isolation.js";

const sister = { modelProviderId: "llama-cpp-sister", modelId: "GGO-G12B-thinkoff" };
const local = { modelProviderId: "llama-cpp", modelId: "OOGG" };
const plan = (prompt, previousUserText = "") =>
  buildUnifiedTurnPlan(prompt, { personaId: "rana", previousUserText });
const grammar = (q, model = local) => Boolean(
  isolation.resolveParentheticalGrammarExtraBody(plan(q), model));
const evidenceFor = async (q, previousUserText = "") => {
  const p = plan(q, previousUserText);
  const pack = await buildLoreEvidencePack(q, { turnPlan: p, sessionKey: "worker08:structural" });
  return { p, pack, projected: loreEvidenceContext(pack) };
};

test("R15 literal payload uses contiguous bracket-plus-ASCII/path structure, not copy verbs", () => {
  for (const q of [
    "這個存檔請用 ref[22]（正式）.json",
    "本機清單 t(a)[b].csv",
    "留著這段 7（備用）",
    "把標籤 M{2}留著",
    "對照 my/folder(name)/a",
    "看這字樣: alpha(beta)_p3",
    "版本是（修）v2",
    "確認稿子【甲】x.txt",
    "檢查這個行程 step(A)-3",
  ]) {
    assert.equal(grammar(q), false, q);
    assert.equal(grammar(q, sister), false, q);
  }
  for (const q of ["（揉揉頭）", "(摸摸頭)", "（抱抱）", "摸摸頭", "給我一個擁抱"]) {
    assert.equal(grammar(q), true, q);
  }
  assert.equal(grammar("今天有點冷。"), true);
});

test("R15 known reviewed entity references project related typed evidence without rewritten answers", async () => {
  for (const q of [
    "SPACE 舊址回程當天，你們的位置如何？",
    "當時 Mortis 在車站外做了什麼？",
    "路過 SPACE 原址有什麼值得記的事？",
    "Mortis 現在的手掌狀態如何？",
  ]) {
    const { p, projected } = await evidenceFor(q);
    assert.equal(turnPlanNeedsLore(p), true, q);
    assert.match(projected, /方向事實/u, q);
  }
  for (const q of [
    "Mortis 這個人是誰？",
    "你會如何形容睦的身份？",
    "若葉睦的身分能說清楚嗎？",
  ]) {
    const { p, projected } = await evidenceFor(q);
    assert.equal(turnPlanNeedsLore(p), true, q);
    assert.match(projected, /同一個人的兩個狀態/u, q);
  }
  for (const q of [
    "Mortis 那次彈奏留下的手指感覺呢？",
    "若葉睦手指的情況你怎麼想？",
  ]) {
    const { projected } = await evidenceFor(q);
    assert.match(projected, /歸屬約束|observed｜若葉睦（attribute: hardened_fingertips）/u, q);
  }
  for (const q of ["昨天聽音樂很開心", "早餐是吐司", "我的滑鼠好像壞了"]) {
    const p = plan(q);
    assert.equal(p.utteranceAct?.requestedRelation, undefined, q);
  }
});

test("R15 inventory is conditioned on speaker/person referent and preceding inventory", async () => {
  const firstTurns = [
    "妳有沒有其他朋友？",
    "你身邊的人有哪些？",
    "列出你知道的人",
    "平常跟你一起出現的都是誰？",
    "你都和哪些人來往？",
    "你認識的朋友都有哪些？",
    "你有幾位認識的人？",
    "你熟悉哪些人？",
  ];
  const followUps = [
    "就沒有了？",
    "那還有呢？",
    "再加幾個人呢？",
    "除了那些還有誰？",
    "多說幾個名字？",
    "別的人呢？",
    "再補一些人？",
    "那幾位之外還有嗎？",
  ];
  for (let i = 0; i < firstTurns.length; i++) {
    const first = await evidenceFor(firstTurns[i]);
    assert.equal(first.pack.intent, "known_people_inventory", firstTurns[i]);
    assert.equal(first.pack.structured_facts.length, 4, firstTurns[i]);
    const next = await evidenceFor(followUps[i], firstTurns[i]);
    assert.equal(next.p.utteranceAct?.continuationMode, "known_people_inventory_followup", followUps[i]);
    assert.equal(next.pack.intent, "known_people_inventory", followUps[i]);
    assert.ok(next.pack.structured_facts.length >= 9, followUps[i]);
    const wrong = plan(followUps[i], "剛才在想我的電腦。");
    assert.notEqual(wrong.utteranceAct?.continuationMode, "known_people_inventory_followup");
  }
  for (const q of ["你是誰？", "誰教你看群組？", "這首曲子是誰寫的？", "你最喜歡哪位吉他手？"]) {
    const p = plan(q);
    assert.notEqual(p.evidence?.predicateAnchors?.includes("認識"), true,
      "not a people inventory: " + q);
  }
});

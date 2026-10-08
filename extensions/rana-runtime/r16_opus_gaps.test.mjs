import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedTurnPlan, turnPlanNeedsLore } from "./architecture/turn_plan.js";
import { __test as isolation } from "./architecture/turn_isolation.js";
import { buildLoreEvidencePack, loreEvidenceContext } from "./lore/retrieval.js";

const plan = (text, previousUserText = "") =>
  buildUnifiedTurnPlan(text, { personaId: "rana", previousUserText });
const projected = async (text, previousUserText = "") => {
  const p = plan(text, previousUserText);
  const pack = await buildLoreEvidencePack(text, {
    turnPlan: p,
    sessionKey: "opus-10-regression",
  });
  return { p, pack, context: loreEvidenceContext(pack) };
};

test("G1: balanced brackets require literal syntax outside the pair in the same token", () => {
  for (const value of [
    "setlist_v2(final).txt",
    "f(x)=g[y]",
    "D:\\music\\live(2025)\\take1.wav",
    "v1.2.3(beta)",
    "デモ(仮)_01.mp3",
  ]) {
    assert.equal(isolation.hasBracketedLiteralPayload(value), true, value);
  }
  for (const value of [
    "（抱住 Rikki）",
    "(hug) 抱抱",
    "[R2-A01] 妳是誰",
    "（拍拍 Tomorin 的頭）",
    "(戳戳)",
    "【抱緊】",
  ]) {
    assert.equal(isolation.hasBracketedLiteralPayload(value), false, value);
  }
  for (const value of ["（抱住 Rikki）", "(hug) 抱抱", "[R2-A01] 妳是誰", "（拍拍 Tomorin 的頭）"]) {
    const grammar = isolation.resolveParentheticalGrammarExtraBody(plan(value), {
      modelProviderId: "llama-cpp",
      modelId: "OOGG",
    });
    // Guard remains enabled only for eligible conversational acts.
    if (["USER_STATEMENT", "OPEN_PERSONA_OPINION", "BARE_TOPIC_REACTION", "INTERPERSONAL_REQUEST"]
      .includes(plan(value).utteranceAct?.subtype) && plan(value).taskContract?.required === false) {
      assert.ok(grammar, value);
    }
  }
});

test("G2: entity facts accompany statements and memory tasks without reclassifying acts", async () => {
  const cases = [
    ["Mortis 那天怎麼會出現在 SPACE 舊址", "USER_STATEMENT", /方向事實/u],
    ["睦的手為什麼那麼粗", "USER_STATEMENT", /hardened_fingertips/u],
    ["你還記得 SPACE 舊址那天的事嗎", "USER_TASK", /方向事實/u],
    ["妳有注意過睦的手指嗎", null, /hardened_fingertips/u],
    ["是睦", null, /hardened_fingertips/u],
    ["若葉睦今天想去哪", null, /hardened_fingertips/u],
    ["Mortis", null, /同一個人的兩個狀態/u],
    ["SPACE 舊址", null, /方向事實/u],
  ];
  for (const [value, subtype, re] of cases) {
    const { p, context } = await projected(value);
    if (subtype) assert.equal(p.utteranceAct?.subtype, subtype, value);
    assert.equal(turnPlanNeedsLore(p), true, value);
    assert.ok(p.evidence?.reviewedEntityFocus, value);
    assert.match(context, re, value);
  }
  const mutsumiOnly = await projected("妳跟睦談過什麼？");
  assert.equal(mutsumiOnly.pack.structured_facts.some((fact) =>
    String(fact.factId || "").startsWith("mortis.") && fact.predicate !== "identity_link"), false,
    "Mutsumi-only facts must not promote Mortis-owned events");
  assert.match(mutsumiOnly.context, /hardened_fingertips/u);
  for (const value of ["早餐是吐司", "我的滑鼠好像壞了", "昨天聽音樂很開心"]) {
    const p = plan(value);
    assert.equal(p.evidence?.reviewedEntityFocus, undefined, value);
  }
});

test("G3: relation-based plural inventory and discourse-conditioned elliptical followups", async () => {
  const firsts = [
    "妳身邊都是些什麼人",
    "平常跟妳比較好的是哪幾個",
    "妳認識的人有哪些？",
  ];
  for (const value of firsts) {
    const { p, pack } = await projected(value);
    assert.equal(pack.intent, "known_people_inventory", value);
    assert.equal(pack.structured_facts.length, 4, value);
    assert.equal(p.evidence?.source, "persona_canonical", value);
  }
  for (const value of ["嗯？就她們喔", "就這些嗎？", "只有她們？", "就這幾個啊"]) {
    const previous = firsts[0];
    const { p, pack } = await projected(value, previous);
    assert.equal(p.utteranceAct?.continuationMode, "known_people_inventory_followup", value);
    assert.equal(pack.intent, "known_people_inventory", value);
    assert.ok(pack.structured_facts.length >= 9, value);
    assert.notEqual(plan(value, "剛才在想電腦").utteranceAct?.continuationMode,
      "known_people_inventory_followup", value + " must not attach to unrelated history");
  }
  for (const value of ["你們樂團有誰", "誰教妳彈吉他的", "你會選哪幾個顏色"]) {
    const { pack } = await projected(value);
    assert.notEqual(pack.intent, "known_people_inventory", value);
  }
});

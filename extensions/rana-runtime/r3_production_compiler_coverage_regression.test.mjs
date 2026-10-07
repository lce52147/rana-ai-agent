import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";

const p = (text) => buildUnifiedTurnPlan(text);

test("reported characterization requesting self stance stays OPEN_PERSONA_OPINION without canonical-query proposition", () => {
  const x = p("有人說妳對人好其實都只是想控制對方，妳會認喔？");
  assert.deepEqual(x.semanticLanes, ["OPEN_PERSONA_OPINION"]);
  assert.equal(x.responseContract.responseFunction, "ANSWER_OPEN_PERSONA_OPINION");
  assert.equal(x.propositions.some((v) => v.type === "CANONICAL_CHARACTER_QUERY"), false);
});

test("false self-history does not acquire an extra canonical-query proposition", () => {
  const x = p("妳上次不是還說愛音其實滿會看氣氛的？");
  assert.deepEqual(x.semanticLanes, ["SELF_HISTORY"]);
  assert.equal(x.propositions.some((v) => v.type === "CANONICAL_CHARACTER_QUERY"), false);
});

test("first guitar acquisition is canonical autobiographical history", () => {
  const x = p("妳第一把吉他到底是怎麼拿到的？");
  assert.equal(x.action.requested, false);
  assert.equal(x.utteranceAct.subtype, "CANONICAL_AUTOBIOGRAPHICAL_EVENT");
  assert.equal(x.evidence.kind, "autobiographical_experience");
  assert.equal(x.evidence.source, "persona_canonical");
  assert.deepEqual(x.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
});

test("natural relationship change wording reaches canonical relationship evidence", () => {
  const x = p("妳跟爽世現在相處，跟以前差最多的是哪裡？");
  assert.equal(x.evidence.kind, "relationship_fact");
  assert.equal(x.evidence.source, "persona_canonical");
  assert.deepEqual(x.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
});

test("first composition history is not a task, current-state, or self-capability turn", () => {
  const x = p("妳第一次幫燈寫曲到底是在什麼時候、什麼情況啊？");
  assert.equal(x.action.requested, false);
  assert.equal(x.utteranceAct.subtype, "CANONICAL_AUTOBIOGRAPHICAL_EVENT");
  assert.equal(x.evidence.kind, "autobiographical_experience");
  assert.deepEqual(x.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(x.semanticLanes.includes("CURRENT_STATE"), false);
  assert.equal(x.semanticLanes.includes("SELF_CAPABILITY"), false);
});

test("natural priority planning question is USER_TASK", () => {
  const x = p("我明天七點半要出門，現在還要洗澡、收證件、充耳機，先弄哪個？");
  assert.equal(x.action.requested, true);
  assert.ok(x.semanticLanes.includes("USER_TASK"));
  assert.equal(x.responseContract.responseFunction, "COMPLETE_USER_TASK");
});

test("natural Bluetooth troubleshooting question is USER_TASK", () => {
  const x = p("Windows 更新完藍牙整個消失了，先從最基本的查什麼？");
  assert.equal(x.action.requested, true);
  assert.ok(x.semanticLanes.includes("USER_TASK"));
});

test("natural monitor troubleshooting question is USER_TASK", () => {
  const x = p("我第二顆螢幕突然整個抓不到，先從哪個最基本的查？");
  assert.equal(x.action.requested, true);
  assert.ok(x.semanticLanes.includes("USER_TASK"));
});

test("read-receipt motive guess is WEAK_INFERENCE, not third-party report", () => {
  const x = p("他已讀五分鐘了還不回，我怎麼覺得是故意的啊？");
  assert.deepEqual(x.semanticLanes, ["WEAK_INFERENCE"]);
  assert.equal(x.responseContract.responseFunction, "ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY");
});

test("attributed user-emotion guess is WEAK_INFERENCE", () => {
  const x = p("我就回一句「知道了」，妳就覺得我在不爽喔？");
  assert.equal(x.evidence.kind, "weak_inference");
  assert.deepEqual(x.semanticLanes, ["WEAK_INFERENCE"]);
});

test("ordinary first-person user state is not a third-party report", () => {
  const x = p("我今天整個人超煩，但我也不太想講為什麼。");
  assert.equal(x.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"), false);
});

test("real open opinion remains OPEN_PERSONA_OPINION", () => {
  const x = p("幸福是什麼");
  assert.deepEqual(x.semanticLanes, ["OPEN_PERSONA_OPINION"]);
});

test("existing canonical-work fact remains canonical", () => {
  const x = p("春日影本來是哪個團的歌？");
  assert.equal(x.utteranceAct.subtype, "CANONICAL_WORK_FACT");
  assert.deepEqual(x.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
});
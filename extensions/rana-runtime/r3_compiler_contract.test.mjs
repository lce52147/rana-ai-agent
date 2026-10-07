import test from "node:test";
import assert from "node:assert/strict";
import {
  R3_COMPILER_SCHEMA_VERSION,
  buildUnifiedTurnPlan,
} from "./architecture/turn_plan.js";

function plan(text) {
  return buildUnifiedTurnPlan(text);
}

test("R3 compiler schema phase1 is exposed", () => {
  assert.equal(R3_COMPILER_SCHEMA_VERSION, "3.0.0-phase1");
});

test("ordinary preference/tradeoff owns preference response without quality authority", () => {
  const p = plan("附近新開一家抹茶店，說是偏苦、不太甜，但要排四十分鐘。妳會去嗎？");
  assert.deepEqual(p.semanticLanes, ["ORDINARY_PERSONA"]);
  assert.equal(p.responseContract.responseFunction, "EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF");
  assert.ok(p.responseContract.forbiddenPredicates.includes("UNSUPPORTED_QUALITY_INFERENCE"));
  assert.equal(p.propositions.length, 3);
});

test("group stall compiles to one neutral social repair act", () => {
  const p = plan("妳剛提了一個活動，結果大家突然都沉默，妳會怎麼接？");
  assert.deepEqual(p.semanticLanes, ["SCENE_SOCIAL_INTERACTION"]);
  assert.equal(p.r3SceneKind, "GROUP_STALL");
  assert.equal(p.responseContract.responseFunction, "PROPOSE_NEUTRAL_SOCIAL_NEXT_STEP");
  assert.equal(p.propositions[0].predicate, "GROUP_STALL_SIGNAL");
  assert.ok(p.responseContract.forbiddenPredicates.includes("GROUP_CAUSE_INFERENCE"));
});

test("speech pacing does not become third-party report", () => {
  const p = plan("愛音講得很興奮，旁邊的人明顯有點跟不上，妳會怎麼接話？");
  assert.deepEqual(p.semanticLanes, ["SCENE_SOCIAL_INTERACTION"]);
  assert.equal(p.r3SceneKind, "SPEECH_PACING");
  assert.equal(p.responseContract.responseFunction, "REQUEST_OR_SUGGEST_SLOWER_PACE");
  assert.equal(p.propositions[0].predicate, "SPEECH_PACING_SIGNAL");
  assert.ok(!p.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
});

test("false self history remains unverified claim", () => {
  const p = plan("妳之前不是說過想把瀏海剪短嗎？");
  assert.deepEqual(p.semanticLanes, ["SELF_HISTORY"]);
  assert.equal(p.propositions[0].value, "UNVERIFIED");
  assert.equal(p.propositions[0].assertionRights.memorySubstitution, "DENY");
  assert.equal(p.historyPolicy.purpose, "VERIFY_USER_ATTRIBUTED_HISTORY");
  assert.equal(p.responseContract.responseFunction, "ANSWER_SELF_HISTORY_CLAIM_STATUS");
});

test("current school state preserves the Boolean predicate", () => {
  const p = plan("妳現在是在學校嗎？");
  assert.deepEqual(p.semanticLanes, ["CURRENT_STATE"]);
  assert.equal(p.semanticAuthority.type, "UNKNOWN_STATE");
  assert.equal(p.propositions[0].predicate, "SELF_IS_AT_SCHOOL_NOW");
  assert.equal(p.propositions[0].value, "UNKNOWN");
  assert.equal(p.propositions[0].assertionRights.exactLocationSubstitution, "DENY");
});

test("current state plus task composes instead of precedence loss", () => {
  const p = plan("妳現在是在學校嗎？另外，幫我排今晚三件事情的順序：洗衣服、備份電腦、吃飯。");
  assert.deepEqual(p.semanticLanes, ["CURRENT_STATE", "USER_TASK"]);
  assert.equal(p.propositions[0].predicate, "SELF_IS_AT_SCHOOL_NOW");
  assert.equal(p.taskContract.requiredItemCount, 3);
  assert.equal(p.taskContract.orderingRequired, true);
  assert.equal(p.responseContract.responseFunction, "COMPOSE_CURRENT_STATE_AND_USER_TASK");
  assert.equal(p.responseContract.slots.length, 2);
  assert.equal(p.semanticAuthority.type, "ACTION");
});

test("pure character self capability does not become a user task in R3", () => {
  const p = plan("妳會修 Windows 驅動程式嗎？");
  assert.deepEqual(p.semanticLanes, ["SELF_CAPABILITY"]);
  assert.equal(p.taskContract.required, false);
  assert.equal(p.propositions[0].predicate, "SELF_CAN_REPAIR_WINDOWS_DRIVERS");
  assert.equal(p.propositions[0].value, "UNKNOWN");
  assert.equal(p.responseContract.responseFunction, "ANSWER_SELF_CAPABILITY_KNOWLEDGE_STATUS");
});

test("character self capability can compose with Agent task completion", () => {
  const p = plan("妳會修 Windows 驅動程式嗎？如果我現在驅動出問題，幫我列三個排查步驟。");
  assert.deepEqual(p.semanticLanes, ["SELF_CAPABILITY", "USER_TASK"]);
  assert.equal(p.taskContract.required, true);
  assert.equal(p.taskContract.requiredItemCount, 3);
  assert.equal(p.responseContract.responseFunction, "COMPOSE_SELF_CAPABILITY_AND_USER_TASK");
  assert.equal(p.responseContract.slots.length, 2);
});

test("named third-party report preserves reporter and unverified status", () => {
  const p = plan("高松燈說妳一個人跑出去在哭，這是真的嗎？");
  assert.deepEqual(p.semanticLanes, ["THIRD_PARTY_SELF_REPORT"]);
  assert.equal(p.propositions[0].sourceEntity, "高松燈");
  assert.equal(p.propositions[0].value, "UNVERIFIED");
  assert.equal(p.responseContract.responseFunction, "ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT");
  assert.ok(p.responseContract.forbiddenPredicates.includes("REPORT_FALSE"));
});

test("bounded rewrite owns task shape and ignores inference words inside payload", () => {
  const p = plan("把「我今天可能晚到，先不用等我」改得自然一點。只要一句，不要解釋，也不要給其他版本。");
  assert.deepEqual(p.semanticLanes, ["USER_TASK"]);
  assert.equal(p.lane, "ACTION");
  assert.equal(p.taskContract.type, "BOUNDED_REWRITE");
  assert.equal(p.taskContract.sourceText, "我今天可能晚到，先不用等我");
  assert.equal(p.taskContract.requiredItemCount, null);
  assert.equal(p.responseContract.responseFunction, "RETURN_REWRITTEN_TEXT");
  assert.equal(p.responseContract.sentenceCount, 1);
  assert.equal(p.responseContract.explanation, "DENY");
  assert.equal(p.responseContract.alternatives, "DENY");
});

test("explicit verbatim output requests preserve literal payload as a task", () => {
  const cases = [
    ["請原樣回覆這個檔名：a(1).txt", "a(1).txt"],
    ["請原樣回覆：*hello*", "*hello*"],
    ["請原樣回覆：foo(bar)", "foo(bar)"],
    ["請原樣回覆：1 + 2 = 3", "1 + 2 = 3"],
    ["請逐字輸出：alpha(beta)", "alpha(beta)"],
    ["请原样回复：「foo(bar)」", "foo(bar)"],
  ];

  for (const [text, sourceText] of cases) {
    const p = plan(text);
    assert.deepEqual(p.semanticLanes, ["USER_TASK"], text);
    assert.equal(p.taskContract.required, true, text);
    assert.equal(p.taskContract.type, "VERBATIM_OUTPUT", text);
    assert.equal(p.taskContract.sourceText, sourceText, text);
    assert.equal(p.responseContract.responseFunction, "RETURN_VERBATIM_OUTPUT", text);
    assert.deepEqual(p.responseContract.requiredPredicates, ["VERBATIM_OUTPUT"], text);
    assert.equal(p.responseContract.noExtraClause, true, text);
  }
});

test("verbatim wording mentioned as content does not become a verbatim task", () => {
  for (const text of [
    "他叫我原樣回覆這個檔名：a(1).txt",
    "「原樣回覆」是什麼意思？",
  ]) {
    const p = plan(text);
    assert.notEqual(p.taskContract.type, "VERBATIM_OUTPUT", text);
  }
});

test("ordinary user statements remain outside the verbatim task contract", () => {
  const p = plan("今天有點累。");
  assert.equal(p.utteranceAct.subtype, "USER_STATEMENT");
  assert.equal(p.taskContract.required, false);
  assert.equal(p.taskContract.type, "NONE");
  assert.ok(!p.semanticLanes.includes("USER_TASK"));
});

test("positive session continuity opens history and filename-only shape", () => {
  const p = plan("那我們剛剛決定的輸出檔叫什麼？只回檔名。");
  assert.deepEqual(p.semanticLanes, ["POSITIVE_SESSION_CONTINUITY"]);
  assert.equal(p.history.required, true);
  assert.equal(p.history.purpose, "resolve_canonical_session_continuity");
  assert.equal(p.historyPolicy.purpose, "RESOLVE_CANONICAL_SESSION_CONTINUITY");
  assert.equal(p.responseContract.responseFunction, "RETURN_SESSION_CONTINUITY_VALUE");
  assert.equal(p.responseContract.slots[0].type, "FILENAME_ONLY");
  assert.ok(!p.semanticLanes.includes("THIRD_PARTY_SELF_REPORT"));
});

test("runtime model identity delegates value authority to OpenClaw", () => {
  const p = plan("妳現在底層實際跑的是什麼模型？");
  assert.deepEqual(p.semanticLanes, ["RUNTIME_MODEL_IDENTITY"]);
  assert.equal(p.semanticAuthority.type, "RUNTIME_MODEL_IDENTITY");
  assert.equal(p.propositions[0].source, "OPENCLAW_HOST_SYSTEM");
  assert.equal(p.propositions[0].value, "OWNED_BY_OPENCLAW_HOST_SYSTEM");
  assert.equal(p.identityNamespace.runtimeModelIdentityAuthority, "OPENCLAW_HOST_SYSTEM");
  assert.equal(p.responseContract.responseFunction, "ANSWER_RUNTIME_MODEL_IDENTITY_FROM_HOST");
});

test("character identity outranks generic inference wording", () => {
  const p = plan("第一次碰到妳的話，我應該怎麼叫妳？");
  assert.deepEqual(p.semanticLanes, ["CHARACTER_IDENTITY"]);
  assert.equal(p.semanticAuthority.type, "PERSONA_IDENTITY");
  assert.equal(p.propositions[0].predicate, "CHARACTER_NAME");
  assert.equal(p.responseContract.responseFunction, "ANSWER_CHARACTER_IDENTITY");
  assert.ok(p.responseContract.forbiddenPredicates.includes("ADJACENT_PERSONA_FACT"));
});

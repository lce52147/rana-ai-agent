import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnContextProjection } from "./architecture/turn_context_projection.js";

function projection(text, ctx = {}) {
  return buildTurnContextProjection({ prompt: text }, ctx);
}

function hasLine(output, line) {
  return output.split("\n").includes(line);
}

test("Phase 2 emits one R3 compiled contract surface", () => {
  const out = projection("妳現在是在學校嗎？");
  assert.match(out, /^TURN CONTEXT — R3_COMPILED_CONTRACT/mu);
  assert.ok(!out.includes("AUTHORITY_CONTEXT"));
  assert.ok(!out.includes("HISTORY_CONTEXT:"));
  assert.ok(!out.includes("IDENTITY_CONTEXT:"));
  assert.ok(!out.includes("CURRENT_EXTERNAL_EVIDENCE:"));
});

test("ordinary preference serializes user premises and quality forbids", () => {
  const out = projection("附近新開一家抹茶店，說是偏苦、不太甜，但要排四十分鐘。妳會去嗎？");
  assert.ok(hasLine(out, "LANE_1=ORDINARY_PERSONA"));
  assert.ok(hasLine(out, "PROPOSITION_COUNT=3"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF"));
  assert.match(out, /FORBIDDEN_OUTPUT_PREDICATES=.*UNSUPPORTED_QUALITY_INFERENCE/u);
});

test("group stall serializes exactly one neutral social repair semantic space", () => {
  const out = projection("妳剛提了一個活動，結果大家突然都沉默，妳會怎麼接？");
  assert.ok(hasLine(out, "LANE_1=SCENE_SOCIAL_INTERACTION"));
  assert.ok(hasLine(out, "P1.PREDICATE=GROUP_STALL_SIGNAL"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=PROPOSE_NEUTRAL_SOCIAL_NEXT_STEP"));
  assert.ok(hasLine(out, "FORBID_ALL_OTHER_PREDICATES=true"));
  assert.ok(hasLine(out, "NO_EXTRA_CLAUSE=true"));
});

test("speech pacing serializes pacing-only response function", () => {
  const out = projection("愛音講得很興奮，旁邊的人明顯有點跟不上，妳會怎麼接話？");
  assert.ok(hasLine(out, "P1.PREDICATE=SPEECH_PACING_SIGNAL"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=REQUEST_OR_SUGGEST_SLOWER_PACE"));
  assert.match(out, /FORBIDDEN_OUTPUT_PREDICATES=.*AUDIBILITY_INFERENCE.*COMPREHENSION_INFERENCE/u);
});

test("false self history serializes unverified truth-status slot", () => {
  const out = projection("妳之前不是說過想把瀏海剪短嗎？");
  assert.ok(hasLine(out, "LANE_1=SELF_HISTORY"));
  assert.ok(hasLine(out, "P1.VALUE=UNVERIFIED"));
  assert.ok(hasLine(out, "P1.ASSERTION_RIGHTS.MEMORY_SUBSTITUTION=DENY"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=ANSWER_SELF_HISTORY_CLAIM_STATUS"));
  assert.ok(hasLine(out, "S1.TYPE=CLAIM_TRUTH_STATUS"));
});

test("current state preserves Boolean predicate and forbids exact-location substitution", () => {
  const out = projection("妳現在是在學校嗎？");
  assert.ok(hasLine(out, "LANE_1=CURRENT_STATE"));
  assert.ok(hasLine(out, "P1.PREDICATE=SELF_IS_AT_SCHOOL_NOW"));
  assert.ok(hasLine(out, "P1.VALUE=UNKNOWN"));
  assert.ok(hasLine(out, "P1.ASSERTION_RIGHTS.EXACT_LOCATION_SUBSTITUTION=DENY"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS"));
});

test("current state plus user task serializes two lanes and two slots", () => {
  const out = projection("妳現在是在學校嗎？另外，幫我排今晚三件事情的順序：洗衣服、備份電腦、吃飯。");
  assert.ok(hasLine(out, "LANE_COUNT=2"));
  assert.ok(hasLine(out, "LANE_1=CURRENT_STATE"));
  assert.ok(hasLine(out, "LANE_2=USER_TASK"));
  assert.ok(hasLine(out, "TASK_REQUIRED_ITEM_COUNT=3"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=COMPOSE_CURRENT_STATE_AND_USER_TASK"));
  assert.ok(hasLine(out, "OUTPUT_SLOT_COUNT=2"));
  assert.ok(hasLine(out, "S2.ITEM_COUNT=3"));
});

test("pure self capability serializes character epistemic unknown", () => {
  const out = projection("妳會修 Windows 驅動程式嗎？");
  assert.ok(hasLine(out, "LANE_1=SELF_CAPABILITY"));
  assert.ok(hasLine(out, "P1.PREDICATE=SELF_CAN_REPAIR_WINDOWS_DRIVERS"));
  assert.ok(hasLine(out, "P1.VALUE=UNKNOWN"));
  assert.ok(hasLine(out, "P1.ASSERTION_RIGHTS.ASSERT_CAPABLE=DENY"));
  assert.ok(hasLine(out, "P1.ASSERTION_RIGHTS.ASSERT_INCAPABLE=DENY"));
});

test("self capability plus task preserves Agent task completion", () => {
  const out = projection("妳會修 Windows 驅動程式嗎？如果我現在驅動出問題，幫我列三個排查步驟。");
  assert.ok(hasLine(out, "LANE_1=SELF_CAPABILITY"));
  assert.ok(hasLine(out, "LANE_2=USER_TASK"));
  assert.ok(hasLine(out, "TASK_REQUIRED=true"));
  assert.ok(hasLine(out, "TASK_REQUIRED_ITEM_COUNT=3"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=COMPOSE_SELF_CAPABILITY_AND_USER_TASK"));
});

test("named third-party report preserves reporter and unverified status", () => {
  const out = projection("高松燈說妳一個人跑出去在哭，這是真的嗎？");
  assert.ok(hasLine(out, "LANE_1=THIRD_PARTY_SELF_REPORT"));
  assert.ok(hasLine(out, "P1.SOURCE_ENTITY=高松燈"));
  assert.ok(hasLine(out, "P1.VALUE=UNVERIFIED"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT"));
  assert.match(out, /FORBIDDEN_OUTPUT_PREDICATES=.*REPORT_TRUE.*REPORT_FALSE/u);
});

test("bounded rewrite serializes source payload and exact response shape", () => {
  const out = projection("把「我今天可能晚到，先不用等我」改得自然一點。只要一句，不要解釋，也不要給其他版本。");
  assert.ok(hasLine(out, "LANE_1=USER_TASK"));
  assert.ok(hasLine(out, "TASK_TYPE=BOUNDED_REWRITE"));
  assert.ok(hasLine(out, 'TASK_SOURCE_TEXT_JSON="我今天可能晚到，先不用等我"'));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=RETURN_REWRITTEN_TEXT"));
  assert.ok(hasLine(out, "RESPONSE_SENTENCE_COUNT=1"));
  assert.ok(hasLine(out, "RESPONSE_EXPLANATION=DENY"));
  assert.ok(hasLine(out, "RESPONSE_ALTERNATIVES=DENY"));
});

test("positive continuity serializes canonical history use and filename-only slot", () => {
  const out = projection("那我們剛剛決定的輸出檔叫什麼？只回檔名。");
  assert.ok(hasLine(out, "LANE_1=POSITIVE_SESSION_CONTINUITY"));
  assert.ok(hasLine(out, "HISTORY_REQUIRED=true"));
  assert.ok(hasLine(out, "HISTORY_PURPOSE=RESOLVE_CANONICAL_SESSION_CONTINUITY"));
  assert.ok(hasLine(out, "HISTORY_CANONICAL_CONTINUITY_USE=ALLOW"));
  assert.ok(hasLine(out, "S1.TYPE=FILENAME_ONLY"));
  assert.ok(!out.includes("CONTROLLED_EVIDENCE_KIND=USER_ASSERTED_LOCAL_EVENT"));
});

test("runtime model identity delegates value authority to OpenClaw without a Rana model value", () => {
  const out = projection("妳現在底層實際跑的是什麼模型？");
  assert.ok(hasLine(out, "LANE_1=RUNTIME_MODEL_IDENTITY"));
  assert.ok(hasLine(out, "P1.VALUE=OWNED_BY_OPENCLAW_HOST_SYSTEM"));
  assert.ok(hasLine(out, "RUNTIME_MODEL_IDENTITY_AUTHORITY=OPENCLAW_HOST_SYSTEM"));
  assert.ok(hasLine(out, "S1.SOURCE_AUTHORITY=OPENCLAW_HOST_SYSTEM"));
  assert.ok(hasLine(out, "RESPONSE_FUNCTION=ANSWER_RUNTIME_MODEL_IDENTITY_FROM_HOST"));
  assert.ok(!/RUNTIME_MODEL_IDENTITY=(?!AUTHORITY)/u.test(out));
});

test("character identity serializes active character namespace and no adjacent Persona facts", () => {
  const out = projection("第一次碰到妳的話，我應該怎麼叫妳？");
  assert.ok(hasLine(out, "LANE_1=CHARACTER_IDENTITY"));
  assert.ok(hasLine(out, "P1.PREDICATE=CHARACTER_NAME"));
  assert.ok(hasLine(out, "P1.VALUE=RESOLVED_BY_ACTIVE_PERSONA_CONTEXT"));
  assert.ok(hasLine(out, "ACTIVE_CHARACTER_IDENTITY_SOURCE=RESOLVED_PERSONA_CONTEXT"));
  assert.ok(hasLine(out, "CHARACTER_AND_RUNTIME_MODEL_SAME_NAMESPACE=false"));
  assert.match(out, /FORBIDDEN_OUTPUT_PREDICATES=.*ADJACENT_PERSONA_FACT/u);
});

test("controlled lore evidence is preserved inside the one R3 surface", () => {
  const out = projection("碧天伴走是什麼歌？");
  assert.ok(hasLine(out, "CONTROLLED_EVIDENCE_KIND=PERSONA_LORE"));
  assert.ok(hasLine(out, "CONTROLLED_EVIDENCE_REQUIRED=true"));
  assert.ok(!out.includes("AUTHORITY_CONTEXT"));
});

test("current external evidence requirement is preserved inside the one R3 surface", () => {
  const out = projection("今天台北天氣怎麼樣？");
  assert.ok(hasLine(out, "CURRENT_EXTERNAL_EVIDENCE_REQUIRED=true"));
  assert.ok(hasLine(out, "CURRENT_EXTERNAL_EVIDENCE_WITHOUT_EVIDENCE=UNRESOLVED"));
  assert.ok(!out.includes("CURRENT_EXTERNAL_EVIDENCE:"));
});

test("perception unavailability is preserved inside the one R3 surface", () => {
  const out = projection("我頭髮妳覺得怎麼樣？");
  assert.ok(hasLine(out, "CONTROLLED_EVIDENCE_KIND=CURRENT_TURN_PERCEPTION"));
  assert.ok(hasLine(out, "PERCEPTION_STATUS=UNAVAILABLE"));
  assert.ok(hasLine(out, "VISUAL_ASSERTION=DENY"));
});

test("tool requests preserve success-before-claim contract", () => {
  const out = projection("幫我播放春日影");
  assert.ok(hasLine(out, "TOOL_REQUESTED=true"));
  assert.ok(hasLine(out, "TOOL_NAME=rana_play_music"));
  assert.ok(hasLine(out, "TOOL_SUCCESS_REQUIRED_FOR_EXTERNAL_ACTION_CLAIM=true"));
});
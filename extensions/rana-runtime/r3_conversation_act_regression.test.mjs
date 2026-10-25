import test from "node:test";
import assert from "node:assert/strict";

import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { buildTurnContextProjection } from "./architecture/turn_context_projection.js";
import { buildPersonaGenerationContext } from "./persona_context.js";

function plan(text) {
  return buildUnifiedTurnPlan(text);
}

let projectionSequence = 0;
function projection(text) {
  projectionSequence += 1;
  const runId = `r3-conversation-act-${projectionSequence}`;
  const sessionKey = "agent:main:discord:channel:r3-conversation-act";
  const context = { runId, sessionKey, agentId: "main", accountId: "default" };
  return buildTurnContextProjection({ prompt: text, runId, sessionKey }, context);
}

function ctx(id) {
  return {
    accountId: id === "rana" ? "default" : id,
    agentId: id === "rana" ? "main" : id,
    sessionKey: `agent:${id === "rana" ? "main" : id}:discord:channel:r3-conversation-act`,
  };
}

test("frozen preference/tradeoff remains ORDINARY_PERSONA and keeps its dedicated response function", () => {
  const text = "附近新開一家抹茶店，說是偏苦、不太甜，但要排四十分鐘。妳會去嗎？";
  const p = plan(text);

  assert.equal(p.utteranceAct.type, "QUESTION");
  assert.equal(p.utteranceAct.subtype, "OPEN_PERSONA_OPINION");
  assert.deepEqual(p.semanticLanes, ["ORDINARY_PERSONA"]);
  assert.equal(p.responseContract.responseFunction, "EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF");
  assert.ok(p.responseContract.forbiddenPredicates.includes("UNSUPPORTED_QUALITY_INFERENCE"));

  const out = projection(text);
  assert.match(out, /UTTERANCE_ACT=QUESTION/u);
  assert.match(out, /UTTERANCE_SUBTYPE=OPEN_PERSONA_OPINION/u);
  assert.match(out, /LANE_1=ORDINARY_PERSONA/u);
  assert.match(out, /RESPONSE_FUNCTION=EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF/u);
});

test("natural open question without punctuation is not a user assertion", () => {
  const p = plan("幸福是什麼");

  assert.equal(p.utteranceAct.type, "QUESTION");
  assert.equal(p.utteranceAct.subtype, "OPEN_PERSONA_OPINION");
  assert.deepEqual(p.semanticLanes, ["OPEN_PERSONA_OPINION"]);
  assert.equal(p.propositions.length, 0);
  assert.equal(p.responseContract.responseFunction, "ANSWER_OPEN_PERSONA_OPINION");

  const out = projection("幸福是什麼");
  assert.match(out, /UTTERANCE_ACT=QUESTION/u);
  assert.match(out, /UTTERANCE_SUBTYPE=OPEN_PERSONA_OPINION/u);
  assert.doesNotMatch(out, /P1\.TYPE=USER_ASSERTED_LOCAL_FACT/u);
});

test("canonical profile question opens controlled Persona LORE", () => {
  const p = plan("燈是什麼樣的女生");

  assert.equal(p.utteranceAct.type, "QUESTION");
  assert.equal(p.utteranceAct.subtype, "CANONICAL_CHARACTER_PROFILE");
  assert.equal(p.utteranceAct.target, "燈");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.equal(p.evidence.kind, "canonical_character_profile");
  assert.ok(p.evidence.anchors.includes("燈"));
  assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");

  const out = projection("燈是什麼樣的女生");
  assert.match(out, /UTTERANCE_SUBTYPE=CANONICAL_CHARACTER_PROFILE/u);
  assert.match(out, /CONTROLLED_EVIDENCE_KIND=PERSONA_LORE/u);
  assert.match(out, /CONTROLLED_EVIDENCE_REQUIRED=true/u);
  assert.match(out, /PAIR_PROFILE_AS_FACT/u);
});

test("canonical relationship stance question opens LORE instead of free pair-fact generation", () => {
  const p = plan("你怎麼看待樂奈的");

  assert.equal(p.utteranceAct.subtype, "CANONICAL_RELATIONSHIP_STANCE");
  assert.equal(p.utteranceAct.target, "樂奈");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.equal(p.evidence.kind, "canonical_relationship_stance");
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");
});

test("third-party capability question opens controlled canonical evidence", () => {
  const p = plan("你覺得燈會煮牛肉麵嗎");

  assert.equal(p.utteranceAct.subtype, "CANONICAL_CHARACTER_CAPABILITY");
  assert.equal(p.utteranceAct.target, "燈");
  assert.equal(p.utteranceAct.activity, "煮牛肉麵");
  assert.equal(p.evidence.kind, "canonical_character_capability");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.equal(p.predicate, "character_capability");
});

test("user self-impression question opens bounded history and forbids personality truth", () => {
  const p = plan("我是甚麼樣的男生");

  assert.equal(p.utteranceAct.type, "QUESTION");
  assert.equal(p.utteranceAct.subtype, "USER_SELF_IMPRESSION");
  assert.deepEqual(p.semanticLanes, ["USER_IMPRESSION"]);
  assert.equal(p.history.required, true);
  assert.equal(p.history.purpose, "derive_bounded_user_impression");
  assert.equal(p.historyPolicy.purpose, "DERIVE_BOUNDED_USER_IMPRESSION");
  assert.equal(p.historyPolicy.priorUserDefaultAuthority, "OBSERVATIONAL_INPUT");
  assert.equal(p.responseContract.responseFunction, "ANSWER_BOUNDED_USER_IMPRESSION");
  assert.ok(p.responseContract.forbiddenPredicates.includes("PERSONALITY_TRUTH_ASSERTION"));
});

test("interpersonal imperative is a character-agency request, not a user fact", () => {
  for (const text of [
    "爽世，去煮牛肉麵",
    "爽世，妳餵我吃",
    "給我一個擁抱",
  ]) {
    const p = plan(text);

    assert.equal(p.utteranceAct.type, "DIRECTIVE");
    assert.equal(p.utteranceAct.subtype, "INTERPERSONAL_REQUEST");
    assert.deepEqual(p.semanticLanes, ["INTERPERSONAL_REQUEST"]);
    assert.equal(p.taskContract.required, false);
    assert.equal(p.propositions.length, 1);
    assert.equal(p.propositions[0].type, "INTERPERSONAL_REQUEST");
    assert.equal(p.responseContract.responseFunction, "RESPOND_TO_INTERPERSONAL_REQUEST");
    assert.ok(p.responseContract.forbiddenPredicates.includes("PHYSICAL_ACTION_ALREADY_OCCURRED"));
  }
});

test("address request is distinct from task completion", () => {
  const p = plan("叫我爸爸");

  assert.equal(p.utteranceAct.type, "DIRECTIVE");
  assert.equal(p.utteranceAct.subtype, "ADDRESS_REQUEST");
  assert.deepEqual(p.semanticLanes, ["INTERPERSONAL_REQUEST"]);
  assert.equal(p.taskContract.required, false);
  assert.equal(p.responseContract.responseFunction, "RESPOND_TO_INTERPERSONAL_REQUEST");
});

test("social congratulation is not a factual assertion", () => {
  const p = plan("生日快樂");

  assert.equal(p.utteranceAct.type, "SOCIAL_ACT");
  assert.equal(p.utteranceAct.subtype, "CONGRATULATION");
  assert.deepEqual(p.semanticLanes, ["SOCIAL_ACT"]);
  assert.equal(p.propositions.length, 0);
  assert.equal(p.responseContract.responseFunction, "RESPOND_TO_SOCIAL_ACT");
});

test("bare topic fragment gets a bounded reaction slot", () => {
  const p = plan("noodles");

  assert.equal(p.utteranceAct.type, "FRAGMENT");
  assert.equal(p.utteranceAct.subtype, "BARE_TOPIC_REACTION");
  assert.deepEqual(p.semanticLanes, ["TOPIC_FRAGMENT"]);
  assert.equal(p.responseContract.responseFunction, "REACT_TO_TOPIC_FRAGMENT");
  assert.ok(p.responseContract.forbiddenPredicates.includes("UNMOTIVATED_METAPHOR"));
  assert.ok(p.responseContract.forbiddenPredicates.includes("FORCED_SENSORY_POETRY"));
});

test("Tomori bare-topic realization is interest-gated rather than poetry-triggered", () => {
  const out = buildPersonaGenerationContext(
    { prompt: "noodles" },
    ctx("tomori"),
  );

  assert.match(out, /DELIVERY_BASE=CONCRETE_SENSORY_HESITANT/u);
  assert.match(out, /TURN_RESPONSE_ACT=REACT_TO_TOPIC_FRAGMENT/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*INTEREST_GATED_SPECIFICITY/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*UNMOTIVATED_METAPHOR/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*FORCED_SENSORY_POETRY/u);
  assert.doesNotMatch(out, /ACTIVE_DIMENSIONS=.*CONCRETE_NOTICE/u);
});

test("normal substantive task remains USER_TASK and does not become interpersonal request", () => {
  const p = plan("幫我列三個排查步驟。");

  assert.equal(p.utteranceAct.type, "DIRECTIVE");
  assert.equal(p.utteranceAct.subtype, "USER_TASK");
  assert.ok(p.semanticLanes.includes("USER_TASK"));
  assert.equal(p.responseContract.responseFunction, "COMPLETE_USER_TASK");
  assert.equal(p.taskContract.requiredItemCount, 3);
});

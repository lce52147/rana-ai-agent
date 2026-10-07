import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPersonaGenerationContext } from './persona_context.js';

function ctx(accountId, agentId = accountId === 'default' ? 'main' : accountId) {
  return {
    accountId,
    agentId,
    sessionKey: `agent:${agentId}:discord:channel:r3-phase4`,
  };
}

const personas = [
  ['default', '要樂奈', 'rana', 'CONCRETE_SELF_DIRECTED'],
  ['anon', '千早愛音', 'anon', 'SOCIAL_MOMENTUM_AWARE'],
  ['tomori', '高松燈', 'tomori', 'CONCRETE_SENSORY_HESITANT'],
  ['soyo', '長崎爽世', 'soyo', 'SOFT_DISTANCE_MANAGING'],
  ['taki', '椎名立希', 'taki', 'DIRECT_RESPONSIBILITY_FOCUSED'],
];

for (const [accountId, name, personaId, deliveryBase] of personas) {
  test(`R3 Persona identity and delivery base are routed for ${personaId}`, () => {
    const out = buildPersonaGenerationContext({ prompt: '今天想吃什麼？' }, ctx(accountId));
    assert.match(out, /PERSONA GENERATION — R3_TURN_LOCAL_REALIZATION/u);
    assert.match(out, new RegExp(`FIRST_PERSON_SPEAKER=${name}`, 'u'));
    assert.match(out, new RegExp(`ACTIVE_CHARACTER_IDENTITY=${name}`, 'u'));
    assert.match(out, new RegExp(`PERSONA_ID=${personaId}`, 'u'));
    assert.match(out, new RegExp(`DELIVERY_BASE=${deliveryBase}`, 'u'));
    assert.match(out, /CHARACTER_IDENTITY_NAMESPACE=PERSONA/u);
    assert.match(out, /RUNTIME_MODEL_IDENTITY_NAMESPACE=SEPARATE/u);
  });
}

test('Persona is explicitly subordinate to R3 assertion/task/response ownership', () => {
  const out = buildPersonaGenerationContext({ prompt: '幫我列三個排查步驟。' }, ctx('taki'));
  assert.match(out, /PERSONA_FACT_AUTHORITY=DENY/u);
  assert.match(out, /PERSONA_MAY_OVERRIDE_ASSERTION_RIGHTS=false/u);
  assert.match(out, /PERSONA_MAY_OVERRIDE_RESPONSE_FUNCTION=false/u);
  assert.match(out, /PERSONA_MAY_OVERRIDE_TASK_RESPONSE_SHAPE=false/u);
  assert.match(out, /PERSONA_MAY_ADD_NEW_PROPOSITIONS=false/u);
  assert.match(out, /PERSONA_MAY_CHANGE_OUTPUT_SLOT_COUNT=false/u);
  assert.match(out, /PERSONA_MAY_CHANGE_REQUIRED_ITEM_COUNT=false/u);
  assert.match(out, /RESPONSE_CONTRACT_AUTHORITY=TURN_CONTEXT_R3_COMPILED_CONTRACT/u);
});

test('Anon group-stall scene gets turn-local social repair dimensions only', () => {
  const out = buildPersonaGenerationContext({ prompt: '妳剛提了一個活動，結果大家突然都沉默，妳會怎麼接？' }, ctx('anon'));
  assert.match(out, /TURN_RESPONSE_ACT=PROPOSE_NEUTRAL_SOCIAL_NEXT_STEP/u);
  assert.match(out, /SEMANTIC_LANES=SCENE_SOCIAL_INTERACTION/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*SOCIAL_INITIATIVE/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*ONE_CONCRETE_SOCIAL_MOVE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*GROUP_CAUSE_INFERENCE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*GROUP_JUDGMENT/u);
});

test('Soyo speech pacing preserves pacing-only semantic space', () => {
  const out = buildPersonaGenerationContext({ prompt: '愛音講得很興奮，旁邊的人明顯有點跟不上，妳會怎麼接話？' }, ctx('soyo'));
  assert.match(out, /TURN_RESPONSE_ACT=REQUEST_OR_SUGGEST_SLOWER_PACE/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*PACING_ADJUSTMENT_ONLY/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*AUDIBILITY_INFERENCE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*COMPREHENSION_INFERENCE/u);
});

test('bounded rewrite keeps task format above Persona garnish', () => {
  const out = buildPersonaGenerationContext({ prompt: '把「我今天可能晚到，先不用等我」改得自然一點。只要一句，不要解釋，也不要給其他版本。' }, ctx('anon'));
  assert.match(out, /TURN_RESPONSE_ACT=RETURN_REWRITTEN_TEXT/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*FORMAT_DISCIPLINE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*EXPLANATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*ALTERNATIVES/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*PERSONA_GARNISH/u);
});

test('runtime model identity keeps character/model namespaces separate', () => {
  const out = buildPersonaGenerationContext({ prompt: '妳現在底層實際跑的是什麼模型？' }, ctx('default'));
  assert.match(out, /TURN_RESPONSE_ACT=ANSWER_RUNTIME_MODEL_IDENTITY_FROM_HOST/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*HOST_AUTHORITY_DEFERENCE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*RUNTIME_MODEL_VALUE_INVENTION/u);
  assert.match(out, /RUNTIME_MODEL_IDENTITY_NAMESPACE=SEPARATE/u);
});

test('character identity stops at requested identity level', () => {
  const out = buildPersonaGenerationContext({ prompt: '第一次碰到妳的話，我應該怎麼叫妳？' }, ctx('anon'));
  assert.match(out, /TURN_RESPONSE_ACT=ANSWER_CHARACTER_IDENTITY/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*STOP_AT_REQUESTED_IDENTITY_LEVEL/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*ADJACENT_PERSONA_FACTS/u);
});

test('SELF_CAPABILITY remains epistemic and cannot become skill biography', () => {
  const out = buildPersonaGenerationContext({ prompt: '妳會修 Windows 驅動程式嗎？' }, ctx('taki'));
  assert.match(out, /TURN_RESPONSE_ACT=ANSWER_SELF_CAPABILITY_KNOWLEDGE_STATUS/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*CAPABILITY_PREDICATE_PRESERVATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*ASSERT_CAPABLE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*ASSERT_INCAPABLE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*SKILL_SUBSTITUTION/u);
});

test('SELF_CAPABILITY plus task preserves task completion independent of Persona', () => {
  const out = buildPersonaGenerationContext({ prompt: '妳會修 Windows 驅動程式嗎？如果現在出問題，幫我列三個排查步驟。' }, ctx('taki'));
  assert.match(out, /TURN_RESPONSE_ACT=COMPOSE_SELF_CAPABILITY_AND_USER_TASK/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*TASK_COMPLETION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*PERSONALITY_BASED_REFUSAL/u);
  assert.match(out, /PERSONA_MAY_CHANGE_REQUIRED_ITEM_COUNT=false/u);
});

test('third-party report preserves attribution and uncertainty', () => {
  const out = buildPersonaGenerationContext({ prompt: '高松燈說妳一個人跑出去在哭，這是真的嗎？' }, ctx('anon'));
  assert.match(out, /TURN_RESPONSE_ACT=ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*SOURCE_ATTRIBUTION/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*UNVERIFIED_STATUS_PRESERVATION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*REPORT_PROMOTION_TO_TRUE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*REPORT_PROMOTION_TO_FALSE/u);
});

test('ordinary preference allows Persona preference projection but blocks quality invention', () => {
  const out = buildPersonaGenerationContext({ prompt: '附近新開一家抹茶店，說是偏苦、不太甜，但要排四十分鐘。妳會去嗎？' }, ctx('default'));
  assert.match(out, /TURN_RESPONSE_ACT=EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF/u);
  assert.match(out, /ACTIVE_DIMENSIONS=.*PERSONAL_PREFERENCE_PROJECTION/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*UNSUPPORTED_QUALITY_INFERENCE/u);
  assert.match(out, /INHIBITED_DIMENSIONS=.*AUTHENTICITY_INFERENCE/u);
});

test('Persona output no longer uses the old generic realization header', () => {
  const out = buildPersonaGenerationContext({ prompt: '今天想吃什麼？' }, ctx('default'));
  assert.doesNotMatch(out, /PERSONA GENERATION \(REALIZATION_ONLY/u);
  assert.match(out, /UNKNOWN_UNAVAILABLE_UNRESOLVED_REMAIN_UNRESOLVED=true/u);
  assert.match(out, /GENERIC_SERVICE_TAIL=DENY/u);
});
import test from "node:test";
import assert from "node:assert/strict";

import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { buildTurnContextProjection } from "./architecture/turn_context_projection.js";

function plan(text) {
  return buildUnifiedTurnPlan(text);
}

let projectionSequence = 0;
function projection(text) {
  projectionSequence += 1;
  const runId = `r3-canonical-query-${projectionSequence}`;
  const sessionKey = "agent:main:discord:channel:r3-canonical-query";
  const context = { runId, sessionKey, agentId: "main", accountId: "default" };
  return buildTurnContextProjection({ prompt: text, runId, sessionKey }, context);
}

test("unbracketed canonical song-origin question is not OPEN_PERSONA_OPINION", () => {
  const p = plan("春日影本來是哪個團的歌？");

  assert.equal(p.utteranceAct.type, "QUESTION");
  assert.equal(p.utteranceAct.subtype, "CANONICAL_WORK_FACT");
  assert.equal(p.utteranceAct.target, "春日影");
  assert.equal(p.utteranceAct.activity, "origin_group");
  assert.equal(p.evidence.required, true);
  assert.equal(p.evidence.kind, "canonical_work");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.deepEqual(p.evidence.anchors, ["春日影"]);
  assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");

  const out = projection("春日影本來是哪個團的歌？");
  assert.match(out, /UTTERANCE_SUBTYPE=CANONICAL_WORK_FACT/u);
  assert.match(out, /LANE_1=CANONICAL_CHARACTER_QUERY/u);
  assert.match(out, /RESPONSE_FUNCTION=ANSWER_CANONICAL_CHARACTER_QUERY/u);
  assert.match(out, /CONTROLLED_EVIDENCE_KIND=PERSONA_LORE/u);
  assert.match(out, /CONTROLLED_EVIDENCE_REQUIRED=true/u);
  assert.doesNotMatch(out, /RESPONSE_FUNCTION=ANSWER_OPEN_PERSONA_OPINION/u);
});

test("canonical-work routing is structural, not 春日影-specific", () => {
  for (const text of [
    "碧天伴走原本是哪個團的歌？",
    "《碧天伴走》是哪個團的歌？",
    "碧天伴走是誰作曲的？",
  ]) {
    const p = plan(text);
    assert.equal(p.utteranceAct.subtype, "CANONICAL_WORK_FACT");
    assert.equal(p.utteranceAct.target, "碧天伴走");
    assert.equal(p.evidence.kind, "canonical_work");
    assert.equal(p.evidence.source, "persona_canonical");
    assert.ok(p.evidence.anchors.includes("碧天伴走"));
    assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  }
});

test("existing persona_canonical evidence outranks generic open-opinion classification", () => {
  const p = plan("你外婆跟 SPACE 到底有什麼關係？");

  assert.equal(p.evidence.required, true);
  assert.equal(p.evidence.kind, "relationship_fact");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.deepEqual(p.evidence.anchors, ["外婆", "SPACE"]);
  assert.equal(p.utteranceAct.subtype, "CANONICAL_EVIDENCE_QUERY");
  assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");

  const out = projection("你外婆跟 SPACE 到底有什麼關係？");
  assert.match(out, /UTTERANCE_SUBTYPE=CANONICAL_EVIDENCE_QUERY/u);
  assert.match(out, /LANE_1=CANONICAL_CHARACTER_QUERY/u);
  assert.match(out, /RESPONSE_FUNCTION=ANSWER_CANONICAL_CHARACTER_QUERY/u);
  assert.match(out, /CONTROLLED_EVIDENCE_KIND=PERSONA_LORE/u);
});

test("canonical work stance found by existing evidence also cannot remain OPEN_PERSONA_OPINION", () => {
  const p = plan("春日影對妳來說為什麼會那麼刺？");

  assert.equal(p.evidence.source, "persona_canonical");
  assert.equal(p.evidence.kind, "canonical_work");
  assert.equal(p.utteranceAct.subtype, "CANONICAL_WORK_STANCE");
  assert.equal(p.utteranceAct.activity, "canonical_work_reaction");
  assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_PERSONA_STANCE");
  assert.deepEqual(p.responseContract.allowedPredicates, ["SUPPORTED_CANONICAL_STANCE_OR_UNRESOLVED"]);
  assert.ok(p.responseContract.forbiddenPredicates.includes("CANONICAL_DOSSIER_PARAPHRASE"));
  assert.ok(p.responseContract.forbiddenPredicates.includes("NEUTRALIZE_SUPPORTED_STANCE"));
});

test("real open Persona opinion remains open Persona opinion", () => {
  const p = plan("幸福是什麼");

  assert.equal(p.evidence.required, false);
  assert.equal(p.evidence.source, "none");
  assert.equal(p.utteranceAct.subtype, "OPEN_PERSONA_OPINION");
  assert.deepEqual(p.semanticLanes, ["OPEN_PERSONA_OPINION"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_OPEN_PERSONA_OPINION");
});

test("named character-profile opinion normalizes the canonical subject", () => {
  for (const [text, expected] of [
    ["你覺得立希是什麼樣的人", "立希"],
    ["你覺得愛音是什麼樣的人", "愛音"],
  ]) {
    const p = plan(text);
    assert.equal(p.utteranceAct.subtype, "CANONICAL_CHARACTER_PROFILE");
    assert.equal(p.utteranceAct.target, expected);
    assert.equal(p.evidence.required, true);
    assert.equal(p.evidence.source, "persona_canonical");
    assert.deepEqual(p.evidence.anchors, [expected]);
    assert.equal(p.subject.name, expected);
    assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  }
});

test("direct relationship wording routes through canonical relationship evidence", () => {
  const p = plan("你和樂奈的關係是什麼");

  assert.equal(p.evidence.required, true);
  assert.equal(p.evidence.kind, "relationship_fact");
  assert.equal(p.evidence.source, "persona_canonical");
  assert.deepEqual(p.evidence.anchors, ["樂奈"]);
  assert.equal(p.utteranceAct.subtype, "CANONICAL_EVIDENCE_QUERY");
  assert.deepEqual(p.semanticLanes, ["CANONICAL_CHARACTER_QUERY"]);
  assert.equal(p.responseContract.responseFunction, "ANSWER_CANONICAL_CHARACTER_QUERY");
  assert.equal(p.subject.name, "樂奈");
});

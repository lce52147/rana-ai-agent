import assert from "node:assert/strict";
import test from "node:test";
import { __test as guidanceTest } from "./guidance.js";

function unknownIdentityEvidence(sceneLookup) {
  return {
    request_id: "persona-scene",
    vision: { status: "ok", observation: null },
    local_ocr: { status: "ok", normalized_lines: [] },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null, externalIdentity: null },
    search_policy: { mode: "standard", rewardCue: null },
    deep_search: { status: "skipped" },
    external_identity: null,
    conflicts: [],
    scene_lookup: sceneLookup,
  };
}

test("persona context carries an exact DCTEST scene line even when identity is unknown", () => {
  const evidence = unknownIdentityEvidence({
    status: "ok",
    accepted: true,
    tier: "exact",
    match: { series: "mygo", line: "不好意思，現在是私人時間吧", line_source: "nearest_frame", wordless: false, labels: [], similarity: 0.99 },
  });
  const payload = guidanceTest.ooggPayload(evidence, "這是誰？");
  payload.personaEvidence = { queryPlan: { intent: "identity" }, resolvedSubject: { pipelineStatus: "unknown" } };
  const context = guidanceTest.ooggContext(evidence, "這是誰？", payload);
  assert.match(context, /不好意思，現在是私人時間吧/u);
  assert.match(context, /不得從台詞或劇情記憶推人名/u);
});

test("persona context names every labelled character and marks Rana as self", () => {
  const evidence = unknownIdentityEvidence({
    status: "ok",
    accepted: true,
    tier: "exact",
    match: { series: "ave-mujica", line: "樂奈握住立希的手", line_source: "wordless_frame", wordless: true, labels: ["taki", "rana"], similarity: 1 },
  });
  const payload = guidanceTest.ooggPayload(evidence, "這是誰？");
  payload.personaEvidence = { queryPlan: { intent: "identity" }, resolvedSubject: { pipelineStatus: "known" } };
  const context = guidanceTest.ooggContext(evidence, "這是誰？", payload);
  const json = JSON.parse(context.slice(context.indexOf("{\"userQuestion\"")));
  assert.deepEqual(json.sceneMatch.characters.map((item) => item.self), [false, true]);
  assert.equal(json.sceneMatch.characters[1].name, "我");
  assert.ok(json.sceneMatch.characters[0].name);
  assert.match(json.personaEvidence.resolvedSubject.everyoneInFrame, /^我和.+/u);
  assert.match(context, /不要只說一個/u);
});

test("persona context has no scene block without an accepted scene match", () => {
  const evidence = unknownIdentityEvidence({ status: "ok", accepted: false, tier: null, match: null });
  const payload = guidanceTest.ooggPayload(evidence, "這是誰？");
  payload.personaEvidence = { queryPlan: { intent: "identity" }, resolvedSubject: { pipelineStatus: "unknown" } };
  const context = guidanceTest.ooggContext(evidence, "這是誰？", payload);
  assert.doesNotMatch(context, /sceneMatch/u);
});

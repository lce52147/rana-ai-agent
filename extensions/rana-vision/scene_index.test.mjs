import assert from "node:assert/strict";
import test from "node:test";
import { buildVisionEvidence } from "./evidence.js";
import { resolveImageCharacters } from "./character_catalog.js";
import { ooggPayload } from "./guidance.js";
import {
  SCENE_THRESHOLDS,
  decideSceneMatch,
  decodeSceneIndex,
  diceSimilarity,
  lookupDctestScene,
  resolveSceneLine,
  sceneModelMismatch,
  searchSceneIndex,
} from "./scene_index.js";

const noTrace = async () => {};

function encode(values) {
  return Buffer.from(new Float32Array(values).buffer).toString("base64");
}

// Four frames in 3-d: two frames of one shot (different subtitles), one wordless labeled frame, one generic frame.
const fixture = decodeSceneIndex({
  schema: "rana.vision.dctest-index.v1",
  items: [
    { path: "mygo/又來了一個新人.jpg", series: "mygo", line: "又來了一個新人", wordless: false, scene: "mygo/又來了一個新人", label_ids: [], hub: 0.7, embedding_f32_b64: encode([1, 0, 0]) },
    { path: "mygo/妳在說什麼.jpg", series: "mygo", line: "妳在說什麼", wordless: false, scene: "mygo/妳在說什麼", label_ids: [], hub: 0.7, embedding_f32_b64: encode([0.999, 0.04, 0]) },
    { path: "mygo/[無詞]樂奈吃糖果表情.jpg", series: "mygo", line: "樂奈吃糖果表情", wordless: true, scene: "mygo/[無詞]樂奈吃糖果表情", label_ids: ["rana"], hub: 0.72, embedding_f32_b64: encode([0, 1, 0]) },
    { path: "ave-mujica/[無詞]哭哭小祥.jpg", series: "ave-mujica", line: "哭哭小祥", wordless: true, scene: "ave-mujica/[無詞]哭哭小祥", label_ids: ["sakiko"], hub: 0.86, embedding_f32_b64: encode([0, 0, 1]) },
  ],
});

function towards(target, similarity) {
  // unit vector with the requested cosine to a unit axis vector
  const other = Math.sqrt(1 - similarity * similarity);
  return target === 1 ? [other, similarity, 0] : target === 2 ? [0, other, similarity] : [similarity, 0, other];
}

test("decodeSceneIndex normalizes vectors and keeps canonical label ids and hub", () => {
  assert.equal(fixture.dim, 3);
  assert.equal(fixture.items.length, 4);
  assert.deepEqual(fixture.items[2].labels, ["rana"]);
  assert.equal(fixture.items[3].hub, 0.86);
  const norm = Math.hypot(...fixture.matrix.slice(3, 6));
  assert.ok(Math.abs(norm - 1) < 1e-6);
});

test("an exact copy is accepted as the exact tier and lists same-shot subtitles", () => {
  const search = searchSceneIndex(fixture, [1, 0.001, 0]);
  assert.equal(search.top.path, "mygo/又來了一個新人.jpg");
  assert.deepEqual(search.sameShot.map((item) => item.line), ["又來了一個新人", "妳在說什麼"]);
  assert.deepEqual(decideSceneMatch(search), { accepted: true, tier: "exact", reason: "near_duplicate_frame" });
});

test("a below-exact match needs a clear lead over the frame's hubness", () => {
  const likely = searchSceneIndex(fixture, towards(1, 0.9));
  assert.equal(likely.top.labels[0], "rana");
  assert.equal(decideSceneMatch(likely).tier, "likely");
  const generic = searchSceneIndex(fixture, towards(2, 0.9));
  assert.equal(generic.top.labels[0], "sakiko");
  assert.deepEqual(decideSceneMatch(generic), { accepted: false, tier: null, reason: "generic_frame_match" });
  assert.equal(decideSceneMatch(searchSceneIndex(fixture, towards(1, 0.8))).reason, "below_similarity");
});

test("an index without hub scores only accepts the exact tier", () => {
  const search = { ...searchSceneIndex(fixture, towards(1, 0.9)), hubLead: null };
  assert.equal(decideSceneMatch(search).accepted, false);
});

test("OCR text picks the subtitle among same-shot frames", () => {
  const lookup = {
    accepted: true,
    tier: "exact",
    match: { line: "又來了一個新人", wordless: false },
    shot_lines: [{ line: "又來了一個新人", path: "a" }, { line: "妳在說什麼", path: "b" }],
  };
  const confirmed = resolveSceneLine(lookup, { lines: ["妳在說什麼？"] });
  assert.equal(confirmed.match.line, "妳在說什麼");
  assert.equal(confirmed.match.line_source, "ocr_confirmed");
  const ambiguous = resolveSceneLine(lookup, { lines: [] });
  assert.equal(ambiguous.match.line, "又來了一個新人");
  assert.equal(ambiguous.match.line_source, "nearest_frame_ambiguous");
  assert.ok(diceSimilarity("又來了一個新人", "又來了一個新人!") > 0.9);
  assert.equal(diceSimilarity("", "abc"), 0);
});

test("lookupDctestScene returns a public match and never throws when the sidecar is down", async () => {
  const hit = await lookupDctestScene({ image: Buffer.from("x"), mimeType: "image/png", dependencies: { index: fixture, embedding: [0, 1, 0.001], trace: noTrace } });
  assert.equal(hit.status, "ok");
  assert.equal(hit.accepted, true);
  assert.deepEqual(hit.match.labels, ["rana"]);
  assert.equal(hit.match.series, "mygo");
  const down = await lookupDctestScene({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      index: fixture,
      sidecar: { config: { endpoint: "http://127.0.0.1:9", apiKey: "k", timeoutMs: 1000 } },
      fetch: async () => { throw new Error("connect ECONNREFUSED"); },
      trace: noTrace,
    },
  });
  assert.equal(down.status, "unavailable");
  assert.equal(down.accepted, false);
  assert.match(down.error, /ECONNREFUSED/);
});

test("the embedding request sends one full view with bearer auth", async () => {
  let request = null;
  const result = await lookupDctestScene({
    image: Buffer.from("png-bytes"),
    mimeType: "image/png",
    dependencies: {
      index: fixture,
      sidecar: { config: { endpoint: "http://sidecar.test:6971/", apiKey: "secret", timeoutMs: 1000 } },
      fetch: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ items: [{ status: "ok", embedding: [0, 0, 1] }] }), { status: 200 });
      },
      trace: noTrace,
    },
  });
  assert.equal(request.url, "http://sidecar.test:6971/v1/embeddings/batch");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(request.body.items.length, 1);
  assert.equal(request.body.items[0].view_type, "full");
  assert.equal(request.body.items[0].data_base64, Buffer.from("png-bytes").toString("base64"));
  assert.equal(result.tier, "exact");
});

function baseEvidence(sceneLookup) {
  return {
    scene_lookup: sceneLookup,
    local_identity_retrieval: { accepted: [] },
    official_reference_match: { matches: [] },
    local_ocr: {},
    reverse_image: { accepted: [] },
  };
}

test("a labeled scene match resolves the character; tier sets confidence", () => {
  const exact = resolveImageCharacters(baseEvidence({ accepted: true, tier: "exact", hub_lead: 0.2, match: { labels: ["rana"], similarity: 0.97, series: "mygo", scene: "s" } }), "這是誰");
  assert.equal(exact.primaryCharacter.canonicalId, "rana");
  assert.equal(exact.primaryCharacter.confidence, "high");
  assert.equal(exact.primaryCharacter.evidence[0].reason, "dctest_scene_match");
  const likely = resolveImageCharacters(baseEvidence({ accepted: true, tier: "likely", hub_lead: 0.1, match: { labels: ["rana"], similarity: 0.9 } }), "這是誰");
  assert.equal(likely.primaryCharacter.confidence, "medium");
  const rejected = resolveImageCharacters(baseEvidence({ accepted: false, match: null }), "這是誰");
  assert.equal(rejected.primaryCharacter, null);
});

const vision = {
  status: "ok",
  source: "ToriiGate",
  raw: "{}",
  observation: { medium: "anime", subject_type: "character", people_count: 1, visible_text: [], distinctive_features: [], targets: [], summary: "角色特寫" },
};

function pipeline(sceneLookup, deepSearchCounter) {
  return {
    trace: noTrace,
    analyze: async () => vision,
    ocr: async () => ({ status: "ok", normalized_lines: ["妳在說什麼"], lines: ["妳在說什麼"], text: "妳在說什麼", normalized_text: "妳在說什麼" }),
    reverse: async () => ({ status: "ok", attempts: [], results: [] }),
    verify: async () => ({ status: "skipped", results: [] }),
    searchPolicy: () => ({ asksIdentity: true, mode: "standard", rewardCue: null }),
    localIdentity: async () => ({ status: "ok", accepted: [], primary: null, targets: [] }),
    sceneLookup: async () => sceneLookup,
    deepSearch: async () => { deepSearchCounter.calls += 1; return { status: "empty", searchMode: "standard", searchExhausted: true, resolvedIdentity: null }; },
  };
}

const loaded = async () => ({ image: Buffer.from("image"), mimeType: "image/png", source: "test", media: {} });

test("pipeline: exact labeled scene locks identity locally and reaches the payload with the OCR-confirmed line", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-test", pipeline({
    status: "ok",
    accepted: true,
    tier: "exact",
    similarity: 0.97,
    hub_lead: 0.2,
    match: { series: "mygo", line: "又來了一個新人", wordless: false, scene: "s", path: "p", labels: ["rana"], similarity: 0.97 },
    shot_lines: [{ line: "又來了一個新人", path: "a" }, { line: "妳在說什麼", path: "b" }],
  }, counter));
  assert.equal(result.identity_decision, "local_embedding_verified");
  assert.equal(result.final_identity.canonicalId, "rana");
  assert.equal(counter.calls, 0);
  assert.equal(result.scene_lookup.match.line, "妳在說什麼");
  assert.equal(result.standardized.scene_match.line_source, "ocr_confirmed");
  const payload = ooggPayload(result, "這是誰");
  assert.equal(payload.imageUnderstanding.sceneMatch.line, "妳在說什麼");
  assert.equal(payload.imageUnderstanding.sceneMatch.confidence, "high");
});

function faceAccepted(id) {
  return async () => ({
    status: "ok",
    source: "ccip_face_sidecar",
    primary: null,
    targets: [],
    accepted: [{ id, confidence: "high", confidence_score: 0.94, evidence: "ccip_face_open_set_accept", instance_count: 1, target_ids: ["F1"] }],
  });
}

const likelyUmiri = {
  status: "ok",
  accepted: true,
  tier: "likely",
  similarity: 0.889,
  hub_lead: 0.08,
  match: { series: "ave-mujica", line: "海玲咬牙", wordless: true, scene: "s", path: "p", labels: ["umiri"], similarity: 0.889 },
  shot_lines: [],
};

test("pipeline: a likely scene whose people the matched face contradicts is dropped (LIVE22 W10)", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-face-conflict", {
    ...pipeline(likelyUmiri, counter),
    localIdentity: faceAccepted("mutsumi"),
  });
  assert.equal(result.final_identity.canonicalId, "mutsumi");
  assert.equal(result.scene_lookup.accepted, false);
  assert.equal(result.scene_lookup.reason, "face_identity_conflict");
  assert.equal(result.standardized.scene_match, null);
  assert.equal(ooggPayload(result, "這是誰").imageUnderstanding.sceneMatch, null);
});

test("pipeline: a likely scene that agrees with the matched face is kept", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-face-agree", {
    ...pipeline(likelyUmiri, counter),
    localIdentity: faceAccepted("umiri"),
  });
  assert.equal(result.scene_lookup.accepted, true);
  assert.equal(result.standardized.scene_match.tier, "likely");
});

test("pipeline: a likely scene may not add people the faces did not confirm (LIVE24 V01)", async () => {
  const counter = { calls: 0 };
  const twoPeople = { ...likelyUmiri, match: { ...likelyUmiri.match, line: "小祥與小睦拍手", labels: ["mutsumi", "sakiko"] } };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-face-partial", {
    ...pipeline(twoPeople, counter),
    localIdentity: faceAccepted("mutsumi"),
  });
  assert.equal(result.final_identity.canonicalId, "mutsumi");
  assert.equal(result.scene_lookup.accepted, false);
  assert.equal(result.scene_lookup.reason, "face_identity_partial");
  assert.deepEqual(result.identity_resolution.detectedCharacters.map((c) => c.canonicalId), ["mutsumi"]);
});

function faceSeenNobodyNamed() {
  return async () => ({
    status: "ok",
    source: "ccip_face_sidecar",
    primary: null,
    accepted: [],
    targets: [{ face_id: "F1", kind: "face", box: [0, 0, 10, 10] }],
  });
}

test("pipeline: a likely scene may not name people when a face was seen but nobody was confirmed", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-face-unconfirmed", {
    ...pipeline(likelyUmiri, counter),
    localIdentity: faceSeenNobodyNamed(),
  });
  assert.equal(result.scene_lookup.accepted, false);
  assert.equal(result.scene_lookup.reason, "face_identity_unconfirmed");
  assert.notEqual(result.final_identity?.canonicalId, "umiri");
});

test("pipeline: a likely scene still names people when no face was found at all", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-no-face", pipeline(likelyUmiri, counter));
  assert.equal(result.scene_lookup.accepted, true);
  assert.equal(result.final_identity.canonicalId, "umiri");
});

test("pipeline: unavailable scene lookup changes nothing", async () => {
  const counter = { calls: 0 };
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "scene-down", pipeline({
    status: "unavailable", accepted: false, match: null, shot_lines: [], error: "down",
  }, counter));
  assert.equal(result.final_identity, null);
  assert.equal(result.standardized.scene_match, null);
  assert.equal(ooggPayload(result, "這是誰").imageUnderstanding.sceneMatch, null);
  assert.equal(counter.calls, 1);
});

test("a sidecar running a different model is refused instead of matched", async () => {
  const built = { id: "Xenova/clip-vit-base-patch32", dtype: "q4", dimension: 512 };
  assert.equal(sceneModelMismatch(built, { ...built }), null);
  assert.equal(sceneModelMismatch(built, null), null);
  assert.match(sceneModelMismatch(built, { ...built, dtype: "fp32" }), /dtype/);
  const result = await lookupDctestScene({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      index: { ...fixture, model: built },
      sidecar: { config: { endpoint: "http://sidecar.test", apiKey: "k", timeoutMs: 1000 } },
      fetch: async () => new Response(JSON.stringify({ model: { ...built, id: "other/model" }, items: [{ status: "ok", embedding: [1, 0, 0] }] }), { status: 200 }),
      trace: noTrace,
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.accepted, false);
  assert.match(result.error, /model mismatch/);
});

test("thresholds stay in the calibrated order", () => {
  assert.ok(SCENE_THRESHOLDS.minSimilarity < SCENE_THRESHOLDS.exactSimilarity);
  assert.ok(SCENE_THRESHOLDS.sameShot > SCENE_THRESHOLDS.exactSimilarity);
});

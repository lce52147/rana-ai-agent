import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const TEST_APP_DIR = path.dirname(fileURLToPath(import.meta.url));
import {
  aggregateMultiViewRankings,
  decideOpenSet,
  rankCharacterBank,
  testExports,
} from "./identity-engine.mjs";

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

assert.deepEqual(testExports.normalizeVector([3, 4]).map((x) => Number(x.toFixed(3))), [0.6, 0.8]);
passed += 1;
assert.equal(Number(testExports.cosineSimilarity([1, 0], [1, 0]).toFixed(3)), 1);
passed += 1;
assert.equal(testExports.referenceKind({ path: "references/source/faces/rana.png" }), "face");
passed += 1;
assert.equal(testExports.viewKind("fallback_face"), "face");
passed += 1;

const ranked = rankCharacterBank([1, 0], [
  { id: "rana", name: "要樂奈", embedding: [1, 0], path: "references/source/faces/rana.png" },
  { id: "rana", name: "要樂奈", embedding: [0.99, 0.01], path: "references/source/rana.png" },
  { id: "mutsumi", name: "若葉睦", embedding: [0.5, 0.5], path: "references/source/faces/mutsumi.png" },
  { id: "mutsumi", name: "若葉睦", embedding: [0.45, 0.55], path: "references/source/mutsumi.png" },
], { targetType: "fallback_face" });
assert.equal(ranked[0].id, "rana");
passed += 1;
assert.equal(ranked[0].references[0].reference_kind, "face");
passed += 1;

const decision = decideOpenSet(ranked, {
  minTop: 0.8,
  minConsensus: 0.75,
  minMargin: 0.1,
  minSupport: 2,
  supportFloor: 0.7,
  candidateTop: 0.6,
  candidateMargin: 0.02,
});
assert.equal(decision.accepted, true);
passed += 1;
const ambiguousRanked = rankCharacterBank([1, 0], [
  { id: "mutsumi", name: "Mutsumi", source_group_id: "source-same", embedding: [1, 0], path: "references/source/faces/mutsumi.png" },
  { id: "mortis", name: "Mortis", source_group_id: "source-same", embedding: [0.99, 0.01], path: "references/source/faces/mortis.png" },
], { targetType: "fallback_face" });
const ambiguousDecision = decideOpenSet(ambiguousRanked, {
  minTop: 0.8,
  minConsensus: 0.75,
  minMargin: 0.01,
  minSupport: 1,
  supportFloor: 0.7,
  candidateTop: 0.6,
  candidateMargin: 0.01,
});
assert.equal(ambiguousDecision.accepted, false);
passed += 1;
assert.equal(ambiguousDecision.state, "unknown");
passed += 1;
assert.equal(ambiguousDecision.reason, "ambiguous_reference_group");
passed += 1;

const view = (target_id, type, ranaScore, mutsumiScore, hash) => ({
  target_id,
  parent_target_id: "T1",
  view_id: target_id,
  type,
  image_sha256: hash,
  ranked: [
    { id: "rana", name: "要樂奈", top_similarity: ranaScore + 0.02, consensus_score: ranaScore },
    { id: "mutsumi", name: "若葉睦", top_similarity: mutsumiScore + 0.02, consensus_score: mutsumiScore },
  ].sort((a, b) => b.consensus_score - a.consensus_score),
});

const multiAccept = aggregateMultiViewRankings([
  view("F1", "fallback_face", 0.79, 0.75, "a"),
  view("F2", "fallback_upper", 0.78, 0.755, "b"),
  view("F3", "fallback_full", 0.76, 0.752, "c"),
], { multiView: { minTop: 0.78, minConsensus: 0.755, minMargin: 0.012 } });
assert.equal(multiAccept.accepted, true);
passed += 1;
assert.equal(multiAccept.top.id, "rana");
passed += 1;
assert.equal(multiAccept.top.winner_votes, 3);
passed += 1;

const multiRejectNearTie = aggregateMultiViewRankings([
  view("F1", "fallback_face", 0.759, 0.756, "d"),
  view("F2", "fallback_upper", 0.758, 0.756, "e"),
  view("F3", "fallback_full", 0.754, 0.753, "f"),
], { multiView: { minTop: 0.78, minConsensus: 0.755, minMargin: 0.012 } });
assert.equal(multiRejectNearTie.accepted, false);
passed += 1;
ok(multiRejectNearTie.reason === "multi_view_top_similarity_below_accept" || multiRejectNearTie.reason === "multi_view_margin_too_small", "near tie must reject");

const duplicateView = aggregateMultiViewRankings([
  view("F1", "fallback_face", 0.81, 0.74, "same"),
  view("F2", "fallback_upper", 0.81, 0.74, "same"),
], {});
assert.equal(duplicateView.accepted, false);
passed += 1;

const ambiguousMulti = aggregateMultiViewRankings([
  {
    target_id: "A1",
    parent_target_id: "A",
    view_id: "A1",
    type: "fallback_face",
    image_sha256: "ambiguous-a",
    ranked: [
      { id: "mutsumi", name: "Mutsumi", top_similarity: 0.90, consensus_score: 0.90, ambiguity_group_ids: ["source-same"], ambiguity_identity_ids: ["mortis", "mutsumi"] },
      { id: "mortis", name: "Mortis", top_similarity: 0.89, consensus_score: 0.89, ambiguity_group_ids: ["source-same"], ambiguity_identity_ids: ["mortis", "mutsumi"] },
    ],
  },
  {
    target_id: "A2",
    parent_target_id: "A",
    view_id: "A2",
    type: "fallback_upper",
    image_sha256: "ambiguous-b",
    ranked: [
      { id: "mutsumi", name: "Mutsumi", top_similarity: 0.90, consensus_score: 0.90, ambiguity_group_ids: ["source-same"], ambiguity_identity_ids: ["mortis", "mutsumi"] },
      { id: "mortis", name: "Mortis", top_similarity: 0.89, consensus_score: 0.89, ambiguity_group_ids: ["source-same"], ambiguity_identity_ids: ["mortis", "mutsumi"] },
    ],
  },
], { multiView: { minViews: 2, minWinnerVotes: 2, minSupportViews: 2, supportFloor: 0.7, minTop: 0.8, minConsensus: 0.75, minMargin: 0.01 } });
assert.equal(ambiguousMulti.accepted, false);
passed += 1;
assert.equal(ambiguousMulti.state, "unknown");
passed += 1;
assert.equal(ambiguousMulti.reason, "ambiguous_reference_group");
passed += 1;
assert.equal(duplicateView.reason, "multi_view_not_available");
passed += 1;


const calibrated = aggregateMultiViewRankings([
  view("F1", "fallback_face", 0.766, 0.73, "g"),
  view("F2", "fallback_upper", 0.791, 0.74, "h"),
  view("F3", "fallback_full", 0.776, 0.73, "i"),
], { multiView: { minViews: 2, minWinnerVotes: 2, minSupportViews: 2, supportFloor: 0.72, minTop: 0.78, minConsensus: 0.755, minMargin: 0.012 } });
assert.equal(calibrated.accepted, true);
passed += 1;
assert.deepEqual(calibrated.top.parent_target_ids, ["T1"]);
passed += 1;

assert.equal(testExports.referenceKind({ path: "references/source/upper/anon/scene-1.png" }), "upper");
passed += 1;
assert.equal(testExports.referenceKind({ path: "references/source/full/taki/stage.webp" }), "full");
passed += 1;
assert.equal(testExports.referenceCharacterId(path.join(TEST_APP_DIR, "..", "references", "source", "faces", "anon", "profile.png"), new Set(["anon", "taki"])), "anon");
passed += 1;

const multiReferenceRanked = rankCharacterBank([1, 0], [
  { id: "anon", name: "千早愛音", embedding: [0.99, 0.01], path: "references/source/faces/anon/front.png" },
  { id: "anon", name: "千早愛音", embedding: [0.96, 0.04], path: "references/source/upper/anon/glasses.png" },
  { id: "anon", name: "千早愛音", embedding: [0.75, 0.25], path: "references/source/full/anon/stage.png" },
  { id: "mutsumi", name: "若葉睦", embedding: [0.89, 0.11], path: "references/source/faces/mutsumi/front.png" },
  { id: "mutsumi", name: "若葉睦", embedding: [0.50, 0.50], path: "references/source/full/mutsumi/stage.png" },
], { targetType: "fallback_face" });
assert.equal(multiReferenceRanked[0].id, "anon");
passed += 1;
ok(multiReferenceRanked[0].top_three_mean > multiReferenceRanked[1].top_three_mean, "multi-reference support should preserve the correct candidate");

let activeWorkers = 0;
let peakWorkers = 0;
const started = Date.now();
const mapped = await testExports.mapLimit([1, 2, 3, 4], 2, async (value) => {
  activeWorkers += 1;
  peakWorkers = Math.max(peakWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 60));
  activeWorkers -= 1;
  return value * 2;
});
assert.deepEqual(mapped, [2, 4, 6, 8]);
passed += 1;
assert.equal(peakWorkers, 2);
passed += 1;
ok(Date.now() - started < 210, "mapLimit should run two embedding workers concurrently");

process.stdout.write(`unit tests: ${passed}/${passed} passed\n`);

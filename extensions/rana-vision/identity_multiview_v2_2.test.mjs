import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { identityFallbackTargets, shouldUseIdentityFallbackTargets } from "./client.js";
import { mapSidecarResult } from "./identity_sidecar_client.js";

test("missing ToriiGate targets create three deterministic identity views", () => {
  const targets = identityFallbackTargets();
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.map((item) => item.target_id), ["F1", "F2", "F3"]);
  assert.deepEqual(targets.map((item) => item.type), ["fallback_face", "fallback_upper", "fallback_full"]);
  assert.equal(new Set(targets.map((item) => JSON.stringify(item.bbox))).size, 3);
});

test("a single full-frame ToriiGate target is treated as unlocalized", () => {
  assert.equal(shouldUseIdentityFallbackTargets([]), true);
  assert.equal(shouldUseIdentityFallbackTargets([
    { target_id: "1", bbox: [0, 0, 1, 1], type: "screen_character" },
  ]), true);
  assert.equal(shouldUseIdentityFallbackTargets([
    { target_id: "1", bbox: [0.18, 0.08, 0.62, 0.78], type: "character" },
  ]), false);
});

test("ToriiGate prompt forbids empty targets for obvious characters", () => {
  const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(source, /Never return an empty t for an obvious character close-up/);
  assert.match(source, /fallbackMultiView: true/);
});

test("multi-view acceptance is exposed but a near-tie rejection is not", () => {
  const accepted = mapSidecarResult({
    aggregate_decision: {
      accepted: true,
      margin: 0.02,
      top: {
        id: "rana",
        aggregate_score: 0.78,
        max_similarity: 0.82,
        winner_votes: 2,
        support_views: 3,
        target_ids: ["F1", "F2", "F3"],
      },
    },
    targets: [],
  });
  assert.equal(accepted.primary.id, "rana");

  const rejected = mapSidecarResult({
    aggregate_decision: {
      accepted: false,
      margin: 0.003,
      top: { id: "mutsumi", aggregate_score: 0.76, max_similarity: 0.79, winner_votes: 2, support_views: 3 },
    },
    targets: [],
  });
  assert.equal(rejected.primary, null);
});

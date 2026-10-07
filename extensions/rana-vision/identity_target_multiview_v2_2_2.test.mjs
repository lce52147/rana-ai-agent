import assert from "node:assert/strict";
import test from "node:test";
import {
  identityLikeTarget,
  identityTargetMultiViewTargets,
  shouldUseIdentityFallbackTargets,
} from "./identity_target_multiview.js";

test("single ToriiGate character target expands to three target-relative identity views", () => {
  const source = {
    target_id: "1",
    type: "screen_character",
    bbox: [0.06268, 0, 0.87464, 1],
    foreground: true,
    visibility: 1,
    stable_features: ["粉紅長髮", "藍色眼睛"],
  };
  assert.equal(identityLikeTarget(source), true);
  const targets = identityTargetMultiViewTargets(source);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.map((item) => item.target_id), ["F1", "F2", "F3"]);
  assert.deepEqual(targets.map((item) => item.type), ["target_face", "target_upper", "target_full"]);
  assert.deepEqual(targets.map((item) => item.source_target_id), ["1", "1", "1"]);
  assert.equal(new Set(targets.map((item) => JSON.stringify(item.bbox))).size, 3);
  assert.deepEqual(targets[2].bbox, source.bbox);
  for (const target of targets) {
    const [x, y, width, height] = target.bbox;
    assert.ok(x >= source.bbox[0]);
    assert.ok(y >= source.bbox[1]);
    assert.ok(x + width <= source.bbox[0] + source.bbox[2] + 1e-9);
    assert.ok(y + height <= source.bbox[1] + source.bbox[3] + 1e-9);
  }
});

test("full-frame target still chooses deterministic whole-image fallback views", () => {
  assert.equal(shouldUseIdentityFallbackTargets([{ bbox: [0, 0, 1, 1] }]), true);
  assert.equal(shouldUseIdentityFallbackTargets([{ bbox: [0.1, 0, 0.8, 1] }]), false);
});

test("invalid target boxes do not produce unsafe crops", () => {
  assert.deepEqual(identityTargetMultiViewTargets({ type: "screen_character", bbox: [0.9, 0, 0.2, 1] }), []);
  assert.deepEqual(identityTargetMultiViewTargets({ type: "screen_character", bbox: null }), []);
});

test("non-identity targets are not expanded", () => {
  assert.equal(identityLikeTarget({ type: "object" }), false);
  assert.equal(identityLikeTarget({ type: "screen_character" }), true);
});

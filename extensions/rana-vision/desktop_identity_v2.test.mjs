import assert from "node:assert/strict";
import test from "node:test";
import { buildVisionEvidence } from "./evidence.js";
import { resolveImageCharacters } from "./character_catalog.js";

const noTrace = async () => {};
const loaded = async () => ({ image: Buffer.from("image"), mimeType: "image/png", source: "test", media: {} });
const vision = {
  status: "ok",
  source: "ToriiGate",
  raw: "{}",
  observation: {
    medium: "anime",
    subject_type: "character",
    people_count: 1,
    visible_text: [],
    distinctive_features: ["灰白短髮", "異色瞳"],
    targets: [{ target_id: "A", type: "character", bbox: [0.1, 0.1, 0.8, 0.8], visibility: 1 }],
    summary: "角色特寫",
  },
};
const emptyOcr = { status: "ok", normalized_lines: [], lines: [], text: "", normalized_text: "" };
const emptyReverse = { status: "ok", attempts: [], results: [] };
const searchPolicy = () => ({ asksIdentity: true, mode: "standard", rewardCue: null });

function common(localIdentity, deepSearch) {
  return {
    trace: noTrace,
    analyze: async () => vision,
    ocr: async () => emptyOcr,
    reverse: async () => emptyReverse,
    verify: async () => ({ status: "skipped", results: [] }),
    searchPolicy,
    localIdentity: async () => localIdentity,
    deepSearch: deepSearch || (async () => ({ status: "empty", searchMode: "standard", searchExhausted: true, resolvedIdentity: null })),
  };
}

test("sidecar accepted identity is the only local visual identity source", () => {
  const resolved = resolveImageCharacters({
    local_identity_retrieval: {
      accepted: [{ id: "rana", confidence_score: 0.94, confidence: "high", instance_count: 1, target_ids: ["A"], evidence: "remote_clip_embedding_open_set_accept" }],
    },
    official_reference_match: { matches: [] },
    local_ocr: {},
    reverse_image: { accepted: [] },
  }, "這是誰");
  assert.equal(resolved.primaryCharacter.canonicalId, "rana");
});

test("sidecar rejected top candidate cannot create canonical identity", () => {
  const resolved = resolveImageCharacters({
    local_identity_retrieval: {
      accepted: [],
      targets: [{ decision: { accepted: false, top: { id: "mutsumi" } } }],
    },
    official_reference_match: { matches: [] },
    local_ocr: {},
    reverse_image: { accepted: [] },
  }, "這是誰");
  assert.equal(resolved.primaryCharacter, null);
  assert.deepEqual(resolved.detectedCharacters, []);
});

test("accepted high-confidence sidecar identity locks local result", async () => {
  let deepSearchCalls = 0;
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "accepted-test", common({
    status: "ok",
    source: "clip_cpu_sidecar",
    accepted: [{ id: "rana", confidence_score: 0.94, confidence: "high", instance_count: 1, target_ids: ["A"], instances: [], evidence: "remote_clip_embedding_open_set_accept" }],
    primary: { id: "rana" },
    targets: [],
  }, async () => { deepSearchCalls += 1; return { status: "empty", resolvedIdentity: null }; }));
  assert.equal(result.identity_decision, "local_embedding_verified");
  assert.equal(result.final_identity.canonicalId, "rana");
  assert.equal(deepSearchCalls, 0);
});

test("rejected sidecar result remains unknown and uses open-world fallback", async () => {
  let deepSearchCalls = 0;
  const result = await buildVisionEvidence(loaded, "這是誰", undefined, "rejected-test", common({
    status: "ok",
    source: "clip_cpu_sidecar",
    accepted: [],
    primary: null,
    targets: [{ decision: { accepted: false, top: { id: "mutsumi" } } }],
  }, async () => {
    deepSearchCalls += 1;
    return { status: "empty", searchMode: "standard", searchExhausted: true, resolvedIdentity: null, reason: "no_verified_external_identity" };
  }));
  assert.equal(result.identity_decision, "unresolved");
  assert.equal(result.final_identity, null);
  assert.equal(result.identity_status, "unknown");
  assert.equal(deepSearchCalls, 1);
});


test("rejected sidecar top candidate remains non-authoritative even when its score is high", () => {
  const resolved = resolveImageCharacters({
    local_identity_retrieval: {
      accepted: [],
      primary: null,
      targets: [{
        decision: {
          accepted: false,
          top: { id: "mutsumi", consensus_score: 0.99 },
        },
      }],
    },
    official_reference_match: { matches: [] },
    local_ocr: {},
    reverse_image: { accepted: [] },
  }, "這是誰");
  assert.equal(resolved.primaryCharacter, null);
});

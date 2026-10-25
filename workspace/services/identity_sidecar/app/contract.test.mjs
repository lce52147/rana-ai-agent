import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configure,
  embedBatch,
  expiredRetrieve,
  identityIndexSnapshot,
  retrieve,
  testExports,
  versions,
} from "./identity-engine.mjs";
import { createJobPool } from "./job-pool.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (value) => Buffer.from(value, "utf8").toString("base64");
const vector = (first, second = (first + 1) % 512) => {
  const output = new Array(512).fill(0);
  output[first] = 3;
  output[second] = 4;
  return output;
};
const norm = (values) => Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));
const indexDescriptor = {
  version: "idx_contract_fixture",
  schema: "rana.identity.reference-bank.v3.1.0",
  generated_at: "2026-08-01T00:00:00.000Z",
  exemplar_count: 2,
  identity_count: 2,
};

configure({
  model: "Xenova/clip-vit-base-patch32",
  modelVersion: "clip-vit-base-patch32@transformers-3.7.2",
  dtype: "q4",
  threads: 8,
  embeddingConcurrency: 3,
  maxImageBytes: 1024 * 1024,
  thresholds: {
    minTop: 0.7,
    minConsensus: 0.7,
    minMargin: 0.01,
    minSupport: 1,
    supportFloor: 0.6,
    candidateTop: 0.6,
    candidateMargin: 0.01,
  },
});

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const orderedItems = [
  { target_id: "T2", parent_target_id: "T2", view_id: "T2:face", view_type: "face", data_base64: bytes("two") },
  { target_id: "T1", parent_target_id: "T1", view_id: "T1:upper", view_type: "upper", data_base64: bytes("one") },
  { target_id: "T3", parent_target_id: "T3", view_id: "T3:full", view_type: "full", data_base64: bytes("three") },
];
const delays = new Map([["T2:face", 35], ["T1:upper", 5], ["T3:full", 15]]);
const ordered = await embedBatch(orderedItems, {
  indexDescriptor,
  concurrency: 3,
  embed: async (_buffer, _mime, item) => {
    await wait(delays.get(item.view_id));
    return vector(orderedItems.findIndex((entry) => entry.view_id === item.view_id) * 2);
  },
});
assert.deepEqual(ordered.items.map((item) => item.view_id), orderedItems.map((item) => item.view_id));
passed += 1;
check(ordered.items.every((item) => Math.abs(norm(item.embedding) - 1) < 1e-9), "batch embeddings must be L2-normalized");
assert.deepEqual(ordered.items.map((item) => item.input_index), [0, 1, 2]);
passed += 1;
assert.equal(ordered.status, "ok");
passed += 1;
assert.equal(ordered.model.dimension, 512);
passed += 1;
assert.equal(ordered.index.version, indexDescriptor.version);
passed += 1;
check(!("accepted" in ordered.items[0]) && !("known" in ordered.items[0]), "embedding API must not make identity decisions");

const partial = await embedBatch([
  orderedItems[0],
  orderedItems[1],
  { target_id: "T4", parent_target_id: "T4", view_type: "face", data_base64: bytes("missing-view-id") },
], {
  indexDescriptor,
  concurrency: 2,
  embed: async (_buffer, _mime, item) => {
    if (item.view_id === "T1:upper") throw Object.assign(new Error("fixture failure"), { code: "fixture_failure" });
    return vector(10);
  },
});
assert.deepEqual(partial.items.map((item) => item.status), ["ok", "error", "error"]);
passed += 1;
assert.equal(partial.status, "partial");
passed += 1;
assert.equal(partial.partial_errors.length, 2);
passed += 1;

let inferenceCalls = 0;
const deadline = await embedBatch(orderedItems, {
  indexDescriptor,
  concurrency: 1,
  deadlineAt: Date.now() + 15,
  embed: async () => {
    inferenceCalls += 1;
    await wait(35);
    return vector(20);
  },
});
assert.equal(inferenceCalls, 1);
passed += 1;
assert.deepEqual(deadline.items.map((item) => item.status), ["timeout", "timeout", "timeout"]);
passed += 1;
check(deadline.partial_errors.every((item) => item.error.code === "deadline_exceeded"), "deadline errors must be typed");

const sha = "a".repeat(64);
const firstReference = testExports.enrichReference({
  id: "rana",
  name: "Rana",
  path: "references/source/faces/rana/front.png",
  sha256: sha,
  embedding: vector(30),
});
const repeatedReference = testExports.enrichReference({
  id: "rana",
  name: "Rana",
  path: "references/source/faces/rana/front.png",
  sha256: sha,
  embedding: vector(30),
});
const duplicateSourceReference = testExports.enrichReference({
  id: "other",
  name: "Other",
  path: "references/source/faces/other/front.png",
  sha256: sha,
  embedding: vector(32),
});
assert.equal(firstReference.exemplar_id, repeatedReference.exemplar_id);
passed += 1;
assert.equal(firstReference.source_group_id, duplicateSourceReference.source_group_id);
passed += 1;
assert.notEqual(firstReference.exemplar_id, duplicateSourceReference.exemplar_id);
passed += 1;
assert.equal(
  testExports.computeIndexVersion([firstReference, duplicateSourceReference]),
  testExports.computeIndexVersion([duplicateSourceReference, firstReference]),
);
passed += 1;
const explicitMetadataReference = testExports.enrichReference(firstReference, {
  exemplar_id: "exm_explicit",
  source_group_id: "source_group_explicit",
  view_type: "upper",
  media_domain: "game_cg",
  eligibility: { retrieval: true, calibration: true, evaluation: false },
});
assert.equal(explicitMetadataReference.exemplar_id, "exm_explicit");
passed += 1;
assert.deepEqual(explicitMetadataReference.eligibility, { retrieval: true, calibration: true, evaluation: false });
passed += 1;

const snapshot = await identityIndexSnapshot({
  bank: {
    schema: "rana.identity.reference-bank.v3.1.0",
    model: "Xenova/clip-vit-base-patch32",
    generatedAt: "2026-08-01T00:00:00.000Z",
    errors: [{ path: "bad.png", code: "fixture", message: "fixture" }],
    references: [duplicateSourceReference, firstReference],
  },
});
assert.equal(snapshot.status, "partial");
passed += 1;
assert.equal(snapshot.exemplars.length, 2);
passed += 1;
check(snapshot.exemplars.every((item) => Math.abs(norm(item.embedding) - 1) < 1e-9), "snapshot embeddings must be normalized");
assert.equal(snapshot.exemplars[0].eligibility.calibration, false);
passed += 1;
check(snapshot.exemplars.every((item) => item.exemplar_id && item.source_group_id), "snapshot must expose stable IDs");
assert.equal(snapshot.integrity.ambiguous_reference_group_count, 1);
passed += 1;
check(snapshot.exemplars.every((item) => item.ambiguity_group_id === firstReference.source_group_id), "snapshot must expose ambiguous source groups");

let expiredJobRan = false;
const pool = createJobPool({ concurrency: 1, maxQueuedJobs: 3 });
const blocker = pool.enqueue(async () => {
  await wait(30);
  return "blocker";
});
const expired = pool.enqueue(async () => {
  expiredJobRan = true;
  return "unexpected";
}, { deadlineAt: Date.now() + 5, onExpired: () => "expired" });
assert.equal(await blocker, "blocker");
passed += 1;
assert.equal(await expired, "expired");
passed += 1;
assert.equal(expiredJobRan, false);
passed += 1;

const legacyBank = {
  references: [
    { id: "rana", name: "Rana", path: "references/source/faces/rana.png", embedding: vector(40) },
    { id: "other", name: "Other", path: "references/source/faces/other.png", embedding: vector(42) },
  ],
};
const legacy = await retrieve([{
  target_id: "legacy-face",
  parent_target_id: "legacy-parent",
  view_id: "legacy-face",
  type: "fallback_face",
  data_base64: bytes("legacy"),
}], { bank: legacyBank, embed: async () => vector(40), concurrency: 1 });
assert.equal(legacy.status, "ok");
passed += 1;
assert.equal(legacy.targets.length, 1);
passed += 1;
check("decision" in legacy.targets[0] && "top_candidates" in legacy.targets[0], "legacy retrieve response shape must remain intact");
assert.equal(legacy.targets[0].decision.state, "known");
passed += 1;
const legacyPartial = await retrieve([
  {
    target_id: "legacy-good",
    parent_target_id: "legacy-parent",
    view_id: "legacy-good",
    type: "fallback_face",
    data_base64: bytes("legacy"),
  },
  {
    target_id: "legacy-empty",
    parent_target_id: "legacy-parent",
    view_id: "legacy-empty",
    type: "fallback_face",
    data_base64: "",
  },
], { bank: legacyBank, embed: async () => vector(40), concurrency: 1 });
assert.equal(legacyPartial.status, "partial");
passed += 1;
assert.equal(legacyPartial.targets[1].decision.state, "error");
passed += 1;
assert.equal(legacyPartial.targets[1].error.code, "empty_image");
passed += 1;
const expiredLegacy = expiredRetrieve(orderedItems, { receivedAt: Date.now() - 20, startedAt: Date.now() - 5 });
assert.equal(expiredLegacy.status, "error");
passed += 1;
check(expiredLegacy.targets.every((item) => item.decision.state === "error" && item.error.code === "deadline_exceeded"), "expired legacy retrieve must preserve typed errors");
check("aggregate_decision" in legacy && "thresholds_used" in legacy, "legacy aggregate response shape must remain intact");

const serverSource = await readFile(path.join(APP_DIR, "server.mjs"), "utf8");
check(serverSource.includes('/v1/identity/retrieve'), "legacy retrieve route must remain registered");
check(serverSource.includes('/v1/embeddings/batch'), "batch embedding route must be registered");
check(serverSource.includes('/v1/identity/index/snapshot'), "index snapshot route must be registered");
check(serverSource.includes('expiredRetrieve'), "legacy retrieve route must expose deadline errors");
check(serverSource.includes('currentIndexDescriptor'), "health must expose the current index descriptor");
assert.equal(versions.service, "3.1.0");
passed += 1;

process.stdout.write(`contract tests: ${passed}/${passed} passed\n`);

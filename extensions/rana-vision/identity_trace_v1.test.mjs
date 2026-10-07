import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { __test as debugTest } from "./debug.js";
import { __test as sidecarTest, mapSidecarResult } from "./identity_sidecar_client.js";

test("identity trace mode records only the identity chain", () => {
  const env = { RANA_VISION_TRACE_MODE: "identity" };
  for (const stage of [
    "toriigate_identity_observation",
    "identity_crop_batch",
    "identity_sidecar_request",
    "identity_sidecar_response",
    "reverse_search_summary",
    "identity_resolver_input",
    "identity_resolver_output",
    "final_identity_payload",
  ]) {
    assert.equal(debugTest.shouldTraceStage(stage, env), true, stage);
  }
  for (const stage of ["deep_search_web_query", "model_6970_http_response_raw", "oogg_prepend_context"]) {
    assert.equal(debugTest.shouldTraceStage(stage, env), false, stage);
  }
});

test("identity trace has a separate bounded output directory", () => {
  const env = { RANA_VISION_TRACE_MODE: "identity" };
  assert.match(debugTest.traceDirectory(env), /rana-vision-identity-trace$/i);
  assert.equal(debugTest.IDENTITY_TRACE_KEEP_FILES, 12);
});

test("sidecar trace sanitizer strips secrets and image base64", () => {
  const sanitized = sidecarTest.sanitizeSidecarTrace({
    apiKey: "secret",
    authorization: "Bearer secret",
    images: [{ data_base64: "AAA", decision: { accepted: false } }],
  });
  assert.equal(sanitized.apiKey, "[omitted]");
  assert.equal(sanitized.authorization, "[omitted]");
  assert.equal(sanitized.images[0].data_base64, "[omitted]");
  assert.equal(sanitized.images[0].decision.accepted, false);
});

test("rejected sidecar top candidate remains diagnostic only", () => {
  const mapped = mapSidecarResult({
    status: "ok",
    targets: [{
      target_id: "T1",
      decision: {
        accepted: false,
        candidate: false,
        reason: "embedding_open_set_reject",
        margin: 0.01,
        supportCount: 2,
        top: { id: "mutsumi", top_similarity: 0.74, consensus_score: 0.73 },
      },
      top_candidates: [{ id: "mutsumi", consensus_score: 0.73 }],
    }],
  });
  assert.equal(mapped.primary, null);
  assert.deepEqual(mapped.accepted, []);
  assert.equal(mapped.targets[0].decision.top.id, "mutsumi");
});

test("all targeted trace insertion points exist in production sources", async () => {
  const [client, sidecar, evidence, guidance] = await Promise.all([
    readFile(new URL("./client.js", import.meta.url), "utf8"),
    readFile(new URL("./identity_sidecar_client.js", import.meta.url), "utf8"),
    readFile(new URL("./evidence.js", import.meta.url), "utf8"),
    readFile(new URL("./guidance.js", import.meta.url), "utf8"),
  ]);
  assert.match(client, /"toriigate_identity_observation"/);
  assert.match(sidecar, /"identity_crop_batch"/);
  assert.match(sidecar, /"identity_sidecar_request"/);
  assert.match(sidecar, /"identity_sidecar_response"/);
  assert.match(evidence, /"identity_resolver_input"/);
  assert.match(evidence, /"identity_resolver_output"/);
  assert.match(guidance, /"final_identity_payload"/);
});

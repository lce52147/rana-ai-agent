import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mapSidecarResult, retrieveLocalIdentity, validateSidecarConfig } from "./identity_sidecar_client.js";

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log(`ok - ${name}`);
  });
}

await test("config validation strips trailing slash and clamps targets", () => {
  const config = validateSidecarConfig({ endpoint: "http://127.0.0.1:6971/", apiKey: "secret", timeoutMs: 50, maxTargets: 99 });
  assert.equal(config.endpoint, "http://127.0.0.1:6971");
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.maxTargets, 3);
});

await test("rejected top candidate never becomes accepted identity", () => {
  const mapped = mapSidecarResult({
    status: "ok",
    targets: [{
      target_id: "T1",
      decision: {
        accepted: false,
        candidate: false,
        top: { id: "mutsumi", top_similarity: 0.81, consensus_score: 0.79 },
        margin: 0.01,
        supportCount: 2,
      },
    }],
  });
  assert.equal(mapped.accepted.length, 0);
  assert.equal(mapped.primary, null);
});

await test("accepted repeated targets are grouped into one identity", () => {
  const target = (id) => ({
    target_id: id,
    bbox: [0.1, 0.2, 0.3, 0.4],
    decision: {
      accepted: true,
      top: { id: "rana", top_similarity: 0.86, consensus_score: 0.82 },
      margin: 0.13,
      supportCount: 2,
    },
  });
  const mapped = mapSidecarResult({ status: "ok", targets: [target("A"), target("B")] });
  assert.equal(mapped.accepted.length, 1);
  assert.equal(mapped.accepted[0].id, "rana");
  assert.equal(mapped.accepted[0].instance_count, 2);
  assert.equal(mapped.accepted[0].confidence, "high");
});


await test("accepted multi-view decision becomes canonical local identity", () => {
  const mapped = mapSidecarResult({
    status: "ok",
    aggregate_decision: {
      accepted: true,
      candidate: true,
      reason: "multi_view_open_set_accept",
      margin: 0.024,
      top: {
        id: "rana",
        name: "要樂奈",
        aggregate_score: 0.781,
        max_similarity: 0.824,
        winner_votes: 2,
        support_views: 3,
        target_ids: ["F1", "F2", "F3"],
        view_scores: [],
      },
    },
    targets: [
      { target_id: "F1", decision: { accepted: false, top: { id: "rana" } } },
      { target_id: "F2", decision: { accepted: false, top: { id: "rana" } } },
      { target_id: "F3", decision: { accepted: false, top: { id: "mutsumi" } } },
    ],
  });
  assert.equal(mapped.accepted.length, 1);
  assert.equal(mapped.primary.id, "rana");
  assert.equal(mapped.primary.evidence, "remote_clip_multiview_open_set_accept");
  assert.deepEqual(mapped.primary.target_ids, ["F1", "F2", "F3"]);
});

await test("rejected multi-view candidate never becomes identity", () => {
  const mapped = mapSidecarResult({
    status: "ok",
    aggregate_decision: {
      accepted: false,
      candidate: true,
      reason: "multi_view_margin_too_small",
      margin: 0.004,
      top: { id: "mutsumi", aggregate_score: 0.76, max_similarity: 0.79, winner_votes: 2, support_views: 3 },
    },
    targets: [],
  });
  assert.equal(mapped.accepted.length, 0);
  assert.equal(mapped.primary, null);
});

await test("aggregate conflict cannot override a strict accepted target", () => {
  const mapped = mapSidecarResult({
    status: "ok",
    aggregate_decision: {
      accepted: true,
      margin: 0.03,
      top: { id: "mutsumi", aggregate_score: 0.79, max_similarity: 0.84, winner_votes: 2, support_views: 3 },
    },
    targets: [{
      target_id: "A",
      decision: {
        accepted: true,
        top: { id: "rana", top_similarity: 0.86, consensus_score: 0.82 },
        margin: 0.13,
        supportCount: 2,
      },
    }],
  });
  assert.equal(mapped.aggregate_conflict, true);
  assert.equal(mapped.primary.id, "rana");
});

await test("remote request sends bearer token and only accepted result is exposed", async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/identity/retrieve");
    assert.equal(req.headers.authorization, "Bearer test-key");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.images.length, 1);
    assert.equal(body.images[0].target_id, "A");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      source: "clip_cpu_sidecar",
      elapsed_ms: 474,
      targets: [{
        target_id: "A",
        bbox: body.images[0].bbox,
        type: "plush",
        visibility: 0.9,
        decision: {
          accepted: true,
          candidate: true,
          margin: 0.12,
          supportCount: 2,
          top: { id: "rana", top_similarity: 0.85, consensus_score: 0.81 },
          second: { id: "mutsumi", top_similarity: 0.70, consensus_score: 0.69 },
        },
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    const result = await retrieveLocalIdentity({
      image: Buffer.from("original"),
      mimeType: "image/png",
      targets: [{ target_id: "A" }],
      requestId: "test-request",
      dependencies: {
        config: { endpoint: `http://127.0.0.1:${port}`, apiKey: "test-key", timeoutMs: 5000, maxTargets: 3 },
        extractTargets: async () => [{
          target_id: "A",
          bbox: [0.1, 0.2, 0.3, 0.4],
          type: "plush",
          visibility: 0.9,
          image: Buffer.from("crop"),
          mimeType: "image/jpeg",
        }],
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.primary.id, "rana");
    assert.equal(result.accepted.length, 1);
  } finally {
    server.close();
  }
});

await test("sidecar failure degrades to unavailable instead of throwing", async () => {
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    targets: [],
    requestId: "offline-test",
    dependencies: {
      config: { endpoint: "http://127.0.0.1:1", apiKey: "x", timeoutMs: 1000, maxTargets: 3 },
      extractTargets: async () => [{ target_id: "T1", image: Buffer.from("x"), mimeType: "image/jpeg" }],
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.accepted.length, 0);
});

console.log(`identity sidecar client tests: ${passed}/${passed} passed`);

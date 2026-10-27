import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mapFaceResult, mapSidecarResult, retrieveLocalIdentity, validateSidecarConfig, zoomInView, zoomOutView } from "./identity_sidecar_client.js";

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
        config: { endpoint: `http://127.0.0.1:${port}`, apiKey: "test-key", timeoutMs: 5000, maxTargets: 3, faces: false },
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

function recordingFetch(bodies) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const parents = new Set(body.images.map((image) => image.parent_target_id || image.target_id));
    if (parents.size > 1) {
      return new Response(JSON.stringify({ error: "cross_target_identity_aggregate_forbidden" }), { status: 400 });
    }
    return new Response(JSON.stringify({
      status: "ok",
      targets: body.images.map((image) => ({
        target_id: image.target_id,
        decision: {
          accepted: image.target_id === "T2",
          top: { id: image.target_id === "T2" ? "rana" : "tomori", top_similarity: 0.86, consensus_score: 0.82 },
          margin: 0.13,
          supportCount: 2,
        },
      })),
      aggregate_decision: { accepted: false, top: { id: "tomori" } },
    }), { status: 200 });
  };
}

const sidecarConfig = { endpoint: "http://sidecar.test", apiKey: "k", timeoutMs: 1000, maxTargets: 3, faces: false };
const crop = (extra) => ({ image: Buffer.from("c"), mimeType: "image/jpeg", ...extra });

await test("face/upper/full views of one target go out as one parent", async () => {
  const bodies = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    requestId: "multiview-test",
    dependencies: {
      config: sidecarConfig,
      fetch: recordingFetch(bodies),
      extractTargets: async () => ["F1", "F2", "F3"].map((id) => crop({ target_id: id, source_target_id: "T1", type: "target_face" })),
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].images.map((image) => image.parent_target_id), ["T1", "T1", "T1"]);
});

await test("fallback whole-image views share the image parent", async () => {
  const bodies = [];
  await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: sidecarConfig,
      fetch: recordingFetch(bodies),
      extractTargets: async () => ["F1", "F2", "F3"].map((id) => crop({ target_id: id, type: "fallback_face" })),
    },
  });
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].images.every((image) => image.parent_target_id === "image"));
});

await test("distinct characters are retrieved separately and merged", async () => {
  const bodies = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: sidecarConfig,
      fetch: recordingFetch(bodies),
      extractTargets: async () => [crop({ target_id: "T1", type: "screen_character" }), crop({ target_id: "T2", type: "screen_character" })],
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(result.targets.length, 2);
  assert.equal(result.aggregate_decision, null);
  assert.equal(result.primary.id, "rana");
});

const face = (id, accepted, extra = {}) => ({
  face_id: id,
  box: [0, 0, 10, 10],
  bbox: [0, 0, 0.1, 0.1],
  score: 0.9,
  decision: { accepted, id: extra.who || "rana", distance: 0.03, margin: 0.1, reasons: accepted ? [] : ["distance_above_threshold"] },
});

await test("accepted faces become one identity each, biggest face first", () => {
  const mapped = mapFaceResult({ status: "ok", faces: [face("F1", true, { who: "taki" }), face("F2", true), face("F3", false)] });
  assert.deepEqual(mapped.accepted.map((item) => item.id), ["taki", "rana"]);
  assert.equal(mapped.primary.id, "taki");
  assert.equal(mapped.accepted[0].evidence, "ccip_face_open_set_accept");
  assert.equal(mapped.accepted[0].confidence, "high");
  assert.equal(mapped.rejected_count, 1);
});

function facesFetch(calls, facesResponse) {
  return async (url, init) => {
    calls.push(url);
    if (url.endsWith("/v1/identity/faces")) return facesResponse();
    return recordingFetch([])(url, init);
  };
}
const faceConfig = { ...sidecarConfig, faces: true };
const twoTargets = async () => [crop({ target_id: "T1", type: "screen_character" }), crop({ target_id: "T2", type: "screen_character" })];

await test("face endpoint answers first and skips the CLIP crops", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ status: "ok", faces: [face("F1", true, { who: "umiri" })] }))),
      extractTargets: async () => { throw new Error("crops must not run when a face was found"); },
    },
  });
  assert.deepEqual(calls, ["http://sidecar.test/v1/identity/faces"]);
  assert.equal(result.source, "ccip_face_sidecar");
  assert.equal(result.primary.id, "umiri");
});

await test("a found but unknown face stays unknown", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ status: "ok", faces: [face("F1", false)] }))),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.primary, null);
});

await test("old sidecar without the face route falls back to CLIP retrieve", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls[0], "http://sidecar.test/v1/identity/faces");
  assert.equal(calls.filter((url) => url.endsWith("/v1/identity/retrieve")).length, 2);
  assert.equal(result.primary.id, "rana");
});

await test("no face found falls back to CLIP retrieve", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ status: "ok", faces: [] }))),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls.filter((url) => url.endsWith("/v1/identity/retrieve")).length, 2);
  assert.equal(result.primary.id, "rana");
});

await test("an accepted whole-frame match answers without CLIP", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ status: "ok", faces: [{
        face_id: "W1", kind: "whole_frame", box: [0, 0, 10, 10], bbox: [0, 0, 1, 1], score: null,
        decision: { accepted: true, id: "soyo", distance: 0.03, margin: 0.1, reasons: [] },
      }] }))),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls.filter((url) => url.endsWith("/v1/identity/retrieve")).length, 0);
  assert.equal(result.primary.id, "soyo");
  assert.equal(result.primary.instances[0].type, "whole_frame");
});

await test("a rejected whole-frame match still falls back to CLIP retrieve", async () => {
  const calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      fetch: facesFetch(calls, () => new Response(JSON.stringify({ status: "ok", faces: [{
        face_id: "W1", kind: "whole_frame", box: [0, 0, 10, 10], bbox: [0, 0, 1, 1], score: null,
        decision: { accepted: false, id: "soyo", distance: 0.2, margin: 0.01, reasons: ["distance_above_threshold"] },
      }] }))),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls.filter((url) => url.endsWith("/v1/identity/retrieve")).length, 2);
  assert.equal(result.primary.id, "rana");
});

// Zoom retry: the first /faces call answers the frame, later calls answer the zoomed views.
function sequenceFetch(calls, bodies) {
  return async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(bodies[Math.min(calls.length - 1, bodies.length - 1)]));
  };
}
const zoomViews = [];
const fakeZoom = async (image, view) => { zoomViews.push(view); return Buffer.from("zoomed"); };
const frame = (faces) => ({ status: "ok", image: { width: 1280, height: 720 }, faces });
const boxed = (id, accepted, box, who = "umiri", reasons = accepted ? [] : ["distance_above_threshold"]) => ({
  face_id: id, kind: "face", box, bbox: null, score: 0.9,
  decision: { accepted, id: who, distance: accepted ? 0.05 : 0.12, margin: 0.1, reasons },
});
const wholeFrame = (accepted, who = "uika") => ({
  face_id: "W1", kind: "whole_frame", box: [0, 0, 1280, 720], bbox: [0, 0, 1, 1], score: null,
  decision: { accepted, id: who, distance: accepted ? 0.03 : 0.05, margin: 0.1, reasons: accepted ? [] : ["distance_above_threshold"] },
});

await test("zoom views map back to the original frame", () => {
  const view = zoomInView([100, 100, 200, 200], 1280, 720);
  assert.deepEqual(view.box, [25, 25, 275, 275]);
  assert.deepEqual(view.toOriginal([288, 288, 672, 672]).map(Math.round), [100, 100, 200, 200]);
  assert.deepEqual(zoomOutView(0.6, 1280, 720), { kind: "out", scale: 0.6, size: [1280, 720], inner: [768, 432], offset: [256, 144] });
});

await test("an unnamed face is named when the zoomed view passes the gate over the same spot", async () => {
  const calls = [];
  zoomViews.length = 0;
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      zoomImage: fakeZoom,
      fetch: sequenceFetch(calls, [
        frame([boxed("F1", true, [700, 100, 900, 300], "taki"), boxed("F2", false, [100, 100, 200, 200])]),
        // zoom window [25,25,275,275] scaled 960/250: the face sits at 288..672
        frame([boxed("F1", true, [288, 288, 672, 672], "umiri")]),
      ]),
      extractTargets: async () => { throw new Error("crops must not run when a face was found"); },
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(zoomViews[0].kind, "in");
  assert.deepEqual(result.accepted.map((item) => item.id), ["taki", "umiri"]);
  assert.equal(result.accepted[1].evidence, "ccip_face_open_set_accept");
  assert.equal(result.accepted[1].instances[0].zoom, "in");
});

await test("a zoomed name elsewhere in the window, or a still-rejected zoom, keeps the face unknown", async () => {
  for (const zoomedFaces of [[boxed("F1", true, [0, 0, 100, 100], "soyo")], [boxed("F1", false, [288, 288, 672, 672])]]) {
    const calls = [];
    const result = await retrieveLocalIdentity({
      image: Buffer.from("x"),
      mimeType: "image/png",
      dependencies: { config: faceConfig, zoomImage: fakeZoom, fetch: sequenceFetch(calls, [frame([boxed("F1", false, [100, 100, 200, 200])]), frame(zoomedFaces)]), extractTargets: twoTargets },
    });
    assert.equal(calls.length, 2);
    assert.equal(result.accepted.length, 0);
  }
});

await test("a close-up with no face is zoomed out and named only by the gate", async () => {
  const calls = [];
  zoomViews.length = 0;
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      zoomImage: fakeZoom,
      fetch: sequenceFetch(calls, [frame([wholeFrame(false)]), frame([]), frame([boxed("F1", true, [500, 250, 780, 470], "uika")])]),
      extractTargets: twoTargets,
    },
  });
  assert.deepEqual(zoomViews.map((view) => view.scale), [0.6, 0.4]);
  assert.equal(calls.filter((url) => url.endsWith("/v1/identity/retrieve")).length, 0);
  assert.equal(result.primary.id, "uika");
  assert.equal(result.primary.instances[0].type, "whole_frame");
  assert.equal(result.primary.instances[0].zoom, "out:0.4");
});

await test("zoom retry can be turned off, and a failed zoom changes nothing", async () => {
  let calls = [];
  await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: { config: { ...faceConfig, zoomRetry: false }, zoomImage: fakeZoom, fetch: sequenceFetch(calls, [frame([boxed("F1", false, [100, 100, 200, 200])])]), extractTargets: twoTargets },
  });
  assert.equal(calls.length, 1);
  calls = [];
  const result = await retrieveLocalIdentity({
    image: Buffer.from("x"),
    mimeType: "image/png",
    dependencies: {
      config: faceConfig,
      zoomImage: async () => { throw new Error("ffmpeg missing"); },
      fetch: sequenceFetch(calls, [frame([boxed("F1", false, [100, 100, 200, 200])])]),
      extractTargets: twoTargets,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.accepted.length, 0);
});

console.log(`identity sidecar client tests: ${passed}/${passed} passed`);

import assert from "node:assert/strict";
import test from "node:test";
import { __test as guidanceTest } from "./guidance.js";
import { __test as toolTest } from "./tool.js";
import { registerVisionTool } from "./tool.js";
import { __test as clientTest } from "./client.js";

const inbound = "C:\\Users\\Administrator\\.openclaw\\media\\inbound\\current.png";

test("no current image remains ordinary text", () => {
  assert.equal(guidanceTest.imageRequest("user: hello"), null);
});

test("fabricated workspace path is rejected without current-turn attachment metadata", () => {
  const request = guidanceTest.imageRequest(`[media attached: C:\\Users\\Administrator\\.openclaw\\workspace\\fake.png (image/png)]`);
  assert.equal(request, null);
});

test("stale path is rejected when current attachment metadata names another file", () => {
  const request = guidanceTest.imageRequest(
    `[media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\stale.png (image/png)]`,
    { currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/png", path: inbound }] } },
  );
  assert.equal(request, null);
});

test("legitimate current inbound media requires authoritative image attachment metadata", () => {
  const request = guidanceTest.imageRequest(
    `[media attached: ${inbound} (image/png)]\nPlease identify this image.`,
    { currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/png", path: inbound }] } },
  );
  assert.equal(request?.sourceType, "inbound_path");
  assert.deepEqual(request.provenance.authorizedPaths, [inbound]);
});

test("verified replied image remains an API-backed source", () => {
  const request = guidanceTest.imageRequest([
    '"chat_id": "channel:1494206026390700092"',
    '"reply_to_id": "1526495598151467108"',
    '"body": "<media:image> (1 image)"',
  ].join("\n"));
  assert.equal(request?.sourceType, "discord_reply");
  assert.equal(request?.sourceMessageId, "1526495598151467108");
});

test("generated or YouTube preview staged as jpg is not inbound user media", () => {
  const request = guidanceTest.imageRequest(
    `[media attached: ${inbound} (image/jpeg)]`,
    { currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/jpeg", path: inbound, source: "youtube_thumbnail", generated: true }] } },
  );
  assert.equal(request, null);
});

test("tool authorization is current-turn scoped and rejects stale path reuse", () => {
  assert.equal(toolTest.authorizeCurrentPrompt({ prompt: "text only", runId: "run-1" }, {}, {
    attachments: [{ kind: "image", mimeType: "image/png", path: inbound }],
  }).length, 0);
  assert.equal(toolTest.isAuthorizedInboundPath(inbound, { runId: "run-1" }), false);

  toolTest.authorizeCurrentPrompt({ prompt: `[media attached: ${inbound} (image/png)]\nPlease identify this image.`, runId: "run-2" }, {}, {
    attachments: [{ kind: "image", mimeType: "image/png", path: inbound }],
  });
  assert.equal(toolTest.isAuthorizedInboundPath(inbound, { runId: "run-2" }), true);
  toolTest.authorizeCurrentPrompt({ prompt: `[media attached: ${inbound} (image/png)]\nPlease identify this image.`, runId: "run-3" }, {}, {
    attachments: [{ kind: "image", mimeType: "image/png", path: inbound }],
  });
  assert.equal(toolTest.isAuthorizedInboundPath(inbound, { runId: "run-2" }), true);
  toolTest.authorizeCurrentPrompt({ prompt: "next text turn", runId: "run-2" }, {}, {});
  assert.equal(toolTest.isAuthorizedInboundPath(inbound, { runId: "run-2" }), false);
  assert.equal(toolTest.isAuthorizedInboundPath(inbound), false);
});

test("runtime client import retains a callable OS temp directory seam", () => {
  assert.equal(typeof clientTest.tmpdir, "function");
  assert.ok(clientTest.tmpdir().length > 0);
});

test("tool capability binds to toolCallId, consumes once, and fails closed without execution context", async () => {
  let definition;
  const hooks = new Map();
  registerVisionTool({
    on(name, handler) { hooks.set(name, handler); },
    registerTool(tool) { definition = tool; },
  }, {
    currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/png", path: inbound }] },
    buildEvidence: async () => ({
      vision: { status: "ok", observation: {} },
      local_ocr: { normalized_lines: [] },
      identity_resolution: { primaryCharacter: null, detectedCharacters: [] },
      search_policy: { mode: "standard", rewardCue: null },
      deep_search: { status: "exhausted", searchExhausted: true },
      conflicts: [],
    }),
  });

  await hooks.get("before_prompt_build")({
    runId: "cap-run",
    prompt: `[media attached: ${inbound} (image/png)]\nPlease identify this image.`,
  }, {});
  await hooks.get("before_tool_call")({
    runId: "cap-run",
    toolName: "rana_analyze_image",
    toolCallId: "cap-1",
    params: { image_path: inbound },
  }, {});
  const rebound = await hooks.get("before_tool_call")({
    runId: "cap-run",
    toolName: "rana_analyze_image",
    toolCallId: "cap-2",
    params: { image_path: inbound },
  }, {});
  assert.equal(rebound?.block, true);
  assert.match(rebound?.blockReason || "", /already bound/u);
  const first = JSON.parse((await definition.execute("cap-1", { image_path: inbound }, undefined, () => {})).content[0].text);
  assert.notEqual(first.status, "ignored");
  const consumed = await hooks.get("before_tool_call")({
    runId: "cap-run",
    toolName: "rana_analyze_image",
    toolCallId: "cap-3",
    params: { image_path: inbound },
  }, {});
  assert.equal(consumed?.block, true);
  const replay = JSON.parse((await definition.execute("cap-1", { image_path: inbound }, undefined, () => {})).content[0].text);
  assert.equal(replay.status, "ignored");
  const missingContext = JSON.parse((await definition.execute("", { image_path: inbound }, undefined, () => {})).content[0].text);
  assert.equal(missingContext.status, "ignored");
});

test("before_tool_call formally blocks missing intent and mismatched or reused media", () => {
  const hooks = new Map();
  registerVisionTool({
    on(name, handler) { hooks.set(name, handler); },
    registerTool() {},
  }, {
    currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/png", path: inbound }] },
  });

  hooks.get("before_prompt_build")({
    runId: "no-intent-run",
    prompt: `[media attached: ${inbound} (image/png)]\nRiNG LIVE`,
  }, {});
  const noIntent = hooks.get("before_tool_call")({
    runId: "no-intent-run",
    toolName: "rana_analyze_image",
    toolCallId: "no-intent-call",
    params: { image_path: inbound },
  }, {});
  assert.equal(noIntent?.block, true);
  assert.match(noIntent?.blockReason || "", /explicit current-turn Vision intent/u);

  hooks.get("before_prompt_build")({
    runId: "mismatch-run",
    prompt: `[media attached: ${inbound} (image/png)]\nPlease identify this image.`,
  }, {});
  const mismatch = hooks.get("before_tool_call")({
    runId: "mismatch-run",
    toolName: "rana_analyze_image",
    toolCallId: "mismatch-call",
    params: { image_path: "C:\\wrong.png" },
  }, {});
  assert.equal(mismatch?.block, true);
  assert.match(mismatch?.blockReason || "", /exact media path/u);
});

test("OpenClaw before_tool_call event shape allows an authorized call without optional toolCallId", () => {
  const hooks = new Map();
  registerVisionTool({
    on(name, handler) { hooks.set(name, handler); },
    registerTool() {},
  }, {
    currentTurnMediaEvidence: { attachments: [{ kind: "image", mimeType: "image/png", path: inbound }] },
  });

  hooks.get("before_prompt_build")({
    runId: "runner-shape-run",
    prompt: `[media attached: ${inbound} (image/png)]\nPlease identify this image.`,
  }, { runId: "runner-shape-run" });
  const result = hooks.get("before_tool_call")({
    toolName: "rana_analyze_image",
    params: { image_path: inbound },
    runId: "runner-shape-run",
  }, {
    toolName: "rana_analyze_image",
    runId: "runner-shape-run",
  });
  assert.equal(result, undefined);
});

test("combined tool hook leaves reply candidates to guidance but guards fabricated direct paths", () => {
  const hooks = new Map();
  registerVisionTool({
    on(name, handler) { hooks.set(name, handler); },
    registerTool() {},
  });
  const replyPrompt = [
    '"chat_id": "channel:1494206026390700092"',
    '"reply_to_id": "1526495598151467108"',
    '"has_reply_context": true',
    '"body": "<media:image> (1 image)"',
  ].join("\n");
  assert.equal(hooks.get("before_prompt_build")({ runId: "reply-hook", prompt: replyPrompt }, {}), undefined);

  const fabricated = hooks.get("before_prompt_build")({
    runId: "fabricated-hook",
    prompt: "[media attached: C:\\Users\\Administrator\\.openclaw\\workspace\\fake.png (image/png)]",
  }, {});
  assert.equal(typeof fabricated?.prependSystemContext, "string");
  assert.equal(fabricated?.prependContext, undefined);
});

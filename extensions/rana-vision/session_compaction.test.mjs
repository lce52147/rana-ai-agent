import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ooggPayload,
  stripHistoricalVisionWorkingPayloads,
} from "./guidance.js";
import { registerVisionTool } from "./tool.js";

const CORE_SETTINGS = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\agent-settings-axYuScuh.js";
const CORE_RUNNER = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\agent-runner.runtime-DtdxZiBX.js";

test("historical Vision working payload is excluded from every later prompt", () => {
  const visionCallId = "call_vision";
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: visionCallId, name: "rana_analyze_image", arguments: {} }],
    },
    {
      role: "toolResult",
      toolName: "rana_analyze_image",
      toolCallId: visionCallId,
      content: [{ type: "text", text: "{\"rawVision\":\"large\",\"OCR\":\"large\",\"AniList\":\"large\",\"CLIP\":\"large\"}" }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_lore", name: "rana_lore_search", arguments: { query: "うさぎ" } }],
    },
    {
      role: "toolResult",
      toolName: "rana_lore_search",
      toolCallId: "call_lore",
      content: [{ type: "text", text: "{\"facts\":[]}" }],
    },
    { role: "assistant", content: [{ type: "text", text: "這是黃色的兔子。" }] },
  ];

  const result = stripHistoricalVisionWorkingPayloads(messages);
  const serialized = JSON.stringify(result);
  assert.equal(result.length, 3);
  assert.doesNotMatch(serialized, /rana_analyze_image|rawVision|OCR|AniList|CLIP/);
  assert.match(serialized, /rana_lore_search|這是黃色的兔子/);
});

test("Vision tool is optional and persists only the compact answer-facing payload", async () => {
  let definition;
  let registrationOptions;
  const hooks = new Map();
  registerVisionTool({
    on(eventName, handler, options) {
      assert.equal(typeof eventName, "string");
      assert.equal(typeof handler, "function");
      assert.equal(typeof options.priority, "number");
      hooks.set(eventName, handler);
    },
    registerTool(tool, options) {
      definition = tool;
      registrationOptions = options;
    },
  }, {
    buildEvidence: async () => ({
      request_id: "vision-test",
      vision: {
        status: "ok",
        observation: { summary: "一名角色", medium: "anime", subject_type: "person", people_count: 1 },
      },
      local_ocr: { normalized_lines: ["測試"] },
      reverse_image: { raw_results: "must-not-persist" },
      identity_resolution: {
        primaryCharacter: {
          entityId: "character.test",
          canonicalId: "test",
          canonicalName: "測試角色",
          confidence: "high",
          confidenceScore: 0.99,
          evidence: [{ source: "resolver" }],
        },
        detectedCharacters: [],
        primaryImpression: null,
      },
      search_policy: { mode: "standard", rewardCue: null },
      deep_search: { status: "resolved", searchExhausted: false },
      conflicts: [],
    }),
    currentTurnMediaEvidence: {
      attachments: [{ kind: "image", mimeType: "image/png", path: "C:\\image.png" }],
    },
  });

  assert.equal(registrationOptions.optional, true);
  await hooks.get("before_prompt_build")({
    runId: "vision-run",
    prompt: "[media attached: C:\\image.png (image/png)]\nPlease identify this image.",
  }, {});
  await hooks.get("before_tool_call")({
    runId: "vision-run",
    toolName: "rana_analyze_image",
    toolCallId: "call",
    params: { image_path: "C:\\image.png" },
  }, {});
  const result = await definition.execute("call", { image_path: "C:\\image.png", prompt: "這是誰？" });
  const text = result.content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.schema, "rana.vision.oogg-payload.v3");
  assert.equal(parsed.imageUnderstanding.primaryCharacter.canonicalName, "測試角色");
  assert.doesNotMatch(text, /raw_results|must-not-persist/);
  assert.ok(Buffer.byteLength(text, "utf8") < 4000);
});

test("explicit 2048 reserve overrides the larger Core default", async () => {
  const core = await import(`${pathToFileURL(CORE_SETTINGS).href}?test=${Date.now()}`);
  let applied = null;
  const result = core.r({
    cfg: {
      agents: {
        defaults: {
          compaction: {
            reserveTokens: 2048,
            reserveTokensFloor: 2048,
            keepRecentTokens: 2048,
          },
        },
      },
    },
    contextTokenBudget: 16384,
    settingsManager: {
      getCompactionReserveTokens: () => 16384,
      getCompactionKeepRecentTokens: () => 2048,
      applyOverrides: (value) => { applied = value; },
    },
  });
  assert.equal(result.compaction.reserveTokens, 2048);
  assert.deepEqual(applied, { compaction: { reserveTokens: 2048 } });
});

test("Core overflow fallback cannot expose maintenance instructions", async () => {
  const source = await readFile(CORE_RUNNER, "utf8");
  const start = source.indexOf("function buildContextOverflowRecoveryText");
  const end = source.indexOf("function buildRestartLifecycleReplyText", start);
  assert.ok(start >= 0 && end > start);
  const recovery = source.slice(start, end);
  assert.doesNotMatch(recovery, /Auto-compaction could not recover|reserveTokensFloor|\/compact|\/new|config/);
  assert.match(recovery, /現在回不了/);
});

test("known, unknown, and error payload classification remains unchanged", () => {
  const base = {
    local_ocr: { normalized_lines: [] },
    search_policy: { mode: "standard", rewardCue: null },
    deep_search: { status: "exhausted", searchExhausted: true },
    conflicts: [],
  };
  const known = ooggPayload({
    ...base,
    vision: { status: "ok", observation: {} },
    identity_resolution: {
      primaryCharacter: {
        entityId: "character.test",
        canonicalId: "test",
        canonicalName: "測試角色",
        confidence: "high",
        evidence: [],
      },
      detectedCharacters: [],
    },
  });
  const unknown = ooggPayload({
    ...base,
    vision: { status: "ok", observation: { summary: "unresolved" } },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [] },
  });
  const error = ooggPayload({
    ...base,
    vision: { status: "unavailable", observation: null },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [] },
  });
  assert.equal(known.imageUnderstanding.analysisStatus, "known");
  assert.equal(unknown.imageUnderstanding.analysisStatus, "unknown");
  assert.equal(error.imageUnderstanding.analysisStatus, "error");
});

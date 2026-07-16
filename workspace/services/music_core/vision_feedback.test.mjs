import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createVisionFeedbackStore, parseVisionFeedbackCustomId } = require("./vision_feedback.js");

test("Vision feedback custom IDs are request and requester scoped", () => {
  assert.deepEqual(parseVisionFeedbackCustomId("vf|ok|12345678-abcd|1197194412929843231"), {
    type: "button",
    action: "ok",
    requestId: "12345678-abcd",
    requesterId: "1197194412929843231",
  });
  assert.equal(parseVisionFeedbackCustomId("vf|ok|bad|someone"), null);
});

test("Vision feedback store preserves pending evidence and correction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rana-vision-feedback-"));
  const pendingDir = path.join(root, "pending");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(path.join(pendingDir, "12345678-abcd.json"), JSON.stringify({
    requestId: "12345678-abcd",
    finalIdentity: { canonicalId: "tomori", confidence: "high" },
  }), "utf8");
  const store = createVisionFeedbackStore(root);
  const recorded = store.record("12345678-abcd", "1197194412929843231", "incorrect", "要樂奈");
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.result.verdict, "incorrect");
  assert.equal(recorded.result.correction, "要樂奈");
  const log = await readFile(store.logPath, "utf8");
  assert.match(log, /"correction":"要樂奈"/u);
});

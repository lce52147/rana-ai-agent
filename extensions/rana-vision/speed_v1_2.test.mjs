import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __test as client } from "./client.js";
import { __test as guidance } from "./guidance.js";

const atlas = {
  id: "core-face",
  characters: [
    { id: "rana", visual_traits: ["灰白短髮", "異色瞳", "左眼藍、右眼黃"] },
    { id: "mutsumi", visual_traits: ["深綠長髮", "綠色眼睛", "嘴角附近有痣"] },
  ],
};
const cells = [
  { id: "rana", cell: "R1C1" },
  { id: "mutsumi", cell: "R3C2" },
];

function targetCrops() {
  return [
    { target_id: "A", type: "plush", bbox: [0.05, 0.25, 0.30, 0.35], foreground: true, visibility: 1, stable_features: ["灰白短髮", "異色瞳"], image: Buffer.from("a"), mimeType: "image/jpeg" },
    { target_id: "B", type: "plush", bbox: [0.35, 0.22, 0.25, 0.38], foreground: true, visibility: 1, stable_features: ["灰白短髮", "異色瞳"], image: Buffer.from("b"), mimeType: "image/jpeg" },
    { target_id: "C", type: "plush", bbox: [0.60, 0.18, 0.35, 0.55], foreground: true, visibility: 1, stable_features: ["灰白短髮", "異色瞳"], image: Buffer.from("c"), mimeType: "image/jpeg" },
  ];
}

test("compact ToriiGate uses left-top-right-bottom coordinates", () => {
  const parsed = client.parseObservation(JSON.stringify({
    m: "photo",
    x: ["85°C"],
    t: [
      { i: "A", k: "plush", b: [50, 250, 350, 600], f: ["灰白短髮", "異色瞳"] },
      { i: "B", k: "plush", b: [350, 220, 600, 600], f: ["灰白短髮", "異色瞳"] },
      { i: "C", k: "plush", b: [600, 180, 950, 760], f: ["灰白短髮"] },
    ],
    s: "三隻前景娃娃",
  }));
  assert.equal(parsed.targets.length, 3);
  assert.equal(parsed.targets[0].bbox_source, "xyxy");
  assert.equal(parsed.targets[0].bbox[2] < 0.5, true);
  assert.equal(parsed.targets[1].bbox[0] > 0.25, true);
  assert.equal(parsed.visible_text[0], "85°C");
});

test("truncated compact ToriiGate recovers completed target boxes", () => {
  const raw = `{"m":"photo","x":["85°C"],"t":[{"i":"A","k":"plush","b":[50,250,350,600],"f":["灰白短髮","異色瞳"]},{"i":"B","k":"plush","b":[350,220,600,600],"f":["灰白短髮"]},{"i":"C","k":"plush","b":[600,180,950,760],"f":[`;
  const parsed = client.parseObservation(raw);
  assert.equal(parsed.partial_recovery, true);
  assert.equal(parsed.targets.length, 3);
  assert.equal(parsed.targets[0].target_id, "A");
  assert.equal(parsed.targets[1].bbox[2] < 0.4, true);
});

test("compact Atlas output accepts three Rana targets and stops on core atlas", () => {
  const raw = JSON.stringify({ r: [
    { t: 0, b: 0, n: 1, p: 95, q: 72, m: true, u: 37, c: 0 },
    { t: 1, b: 0, n: 1, p: 93, q: 70, m: true, u: 21, c: 0 },
    { t: 2, b: 0, n: 1, p: 91, q: 68, m: true, u: 5, c: 0 },
  ] });
  const parsed = client.parseBatchAtlas(raw, targetCrops(), atlas, cells);
  const accepted = client.acceptedBatchAtlasMatches(parsed, "core-face");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "rana");
  assert.equal(accepted[0].instance_count, 3);
});

test("truncated legacy Atlas response salvages complete high-confidence Rana result", () => {
  const raw = `{"results":[{"target":"A","best":"core-face:R1C1","second":"core-face:R3C2","best_score":0.95,"second_score":0.88,"match":true,"support":["hair","eyes","silhouette"],"conflict":[]},{"target":"B","best":"core-face:R1C1"`;
  const parsed = client.parseBatchAtlas(raw, targetCrops(), atlas, cells);
  assert.equal(parsed[0].best_id, "rana");
  assert.equal(parsed[1].best_id, "");
  const accepted = client.acceptedBatchAtlasMatches(parsed, "core-face");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "rana");
});

test("unknown identity payload hard-blocks OOGG character guessing", () => {
  const payload = {
    userQuestion: "這是誰",
    imageUnderstanding: { analysisStatus: "unknown", primaryCharacter: null, externalIdentity: null },
  };
  const event = {
    assistantTexts: ["看起來是《無頭騎士異聞錄》的某某。"],
    lastAssistant: { role: "assistant", content: [{ type: "text", text: "看起來是某角色。" }] },
  };
  const result = guidance.guardLlmOutputInPlace(event, payload);
  assert.equal(result.changed, true);
  assert.deepEqual(event.assistantTexts, ["不知道。"]);
  assert.equal(event.lastAssistant.content[0].text, "不知道。");
});

test("known identity payload leaves OOGG response untouched", () => {
  const payload = {
    userQuestion: "這是誰",
    imageUnderstanding: { analysisStatus: "known", primaryCharacter: { canonicalId: "rana" }, externalIdentity: null },
  };
  assert.equal(guidance.guardVisionIdentityOutput("是我。", payload), "是我。");
});

test("three target crops can be composed into one contact sheet", async () => {
  const sample = path.join(tmpdir(), `rana-speed-v1_2-sample-${process.pid}.jpg`);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=32x32", "-frames:v", "1", sample]);
    const jpeg = readFileSync(sample);
    const sheet = await client.buildTargetContactSheet([
      { target_id: "A", image: jpeg, mimeType: "image/jpeg" },
      { target_id: "B", image: jpeg, mimeType: "image/jpeg" },
      { target_id: "C", image: jpeg, mimeType: "image/jpeg" },
    ]);
    assert.equal(sheet.composed, true);
    assert.deepEqual(sheet.targetOrder, ["A", "B", "C"]);
    assert.equal(sheet.image.length > 0, true);
  } finally {
    rmSync(sample, { force: true });
  }
});

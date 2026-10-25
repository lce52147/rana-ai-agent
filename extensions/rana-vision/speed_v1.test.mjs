import assert from "node:assert/strict";
import test from "node:test";
import { __test as client } from "./client.js";
import { __test as reverse } from "./reverse_search.js";

function targets() {
  return [
    { target_id: "T1", type: "plush", bbox: [0.03, 0.2, 0.3, 0.65], foreground: true, visibility: 0.75, stable_features: ["灰白短髮", "異色瞳"] },
    { target_id: "T2", type: "plush", bbox: [0.35, 0.18, 0.27, 0.68], foreground: true, visibility: 0.9, stable_features: ["灰白短髮", "異色瞳"] },
    { target_id: "T3", type: "plush", bbox: [0.63, 0.12, 0.35, 0.82], foreground: true, visibility: 1, stable_features: ["灰白短髮", "異色瞳"] },
  ];
}

function cropTargets() {
  return targets().map((target) => ({ ...target, image: Buffer.from("target"), mimeType: "image/jpeg" }));
}

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

test("ToriiGate observation carries three normalized foreground targets", () => {
  const parsed = client.parseObservation(JSON.stringify({
    medium: "photo",
    subject_type: "object",
    people_count: 0,
    visible_text: [],
    logos: [],
    distinctive_features: ["三隻角色娃娃"],
    targets: targets(),
    scene: "桌面",
    summary: "三隻娃娃",
  }));
  assert.equal(parsed.targets.length, 3);
  assert.equal(parsed.targets.every((item) => item.bbox.length === 4), true);
  assert.equal(client.visionResponseFormat().json_schema.schema.properties.t.maxItems, 3);
});

test("a high self-reported Mutsumi score is rejected when stable features conflict", () => {
  const parsed = client.parseBatchAtlas(JSON.stringify({
    results: cropTargets().map((target) => ({
      target_id: target.target_id,
      best_candidate: "core-face:R3C2",
      second_candidate: "core-face:R1C1",
      best_confidence: 0.95,
      second_confidence: 0.72,
      same_character_design: false,
      supporting_features: ["淺色頭髮"],
      conflicting_features: ["目標是短髮異色瞳，候選是長髮同色眼"],
      reason: "stable identity features conflict",
    })),
  }), cropTargets(), atlas, cells);
  assert.deepEqual(client.acceptedBatchAtlasMatches(parsed, "core-face"), []);
});

test("three independently cropped Rana targets aggregate into one identity with three instances", () => {
  const parsed = client.parseBatchAtlas(JSON.stringify({
    results: cropTargets().map((target) => ({
      target_id: target.target_id,
      best_candidate: "core-face:R1C1",
      second_candidate: "core-face:R3C2",
      best_confidence: 0.93,
      second_confidence: 0.48,
      same_character_design: true,
      supporting_features: ["灰白短髮", "異色瞳"],
      conflicting_features: [],
      reason: "two stable features agree",
    })),
  }), cropTargets(), atlas, cells);
  const accepted = client.acceptedBatchAtlasMatches(parsed, "core-face");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "rana");
  assert.equal(accepted[0].instance_count, 3);
});

test("IQDB upload is converted to a bounded JPEG instead of sending the original payload", async () => {
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyiiivzo/ssKKKKACiiigAooooA//2Q==", "base64");
  const prepared = await reverse.prepareIqdbUpload(jpeg, "image/jpeg", "speed-v1-test");
  assert.equal(prepared.mimeType, "image/jpeg");
  assert.equal(prepared.image.length > 0, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { __test as client } from "./client.js";
import { __test as reverse } from "./reverse_search.js";
import { __test as guidance } from "./guidance.js";
import { detectSearchPolicy } from "./deep_search.js";

function targets() {
  return [
    { target_id: "T1", type: "plush", bbox: [30, 200, 300, 650], foreground: true, visibility: 0.75, stable_features: ["灰白短髮", "異色瞳"] },
    { target_id: "T2", type: "plush", bbox: [350, 180, 270, 680], foreground: true, visibility: 0.9, stable_features: ["灰白短髮", "異色瞳"] },
    { target_id: "T3", type: "plush", bbox: [630, 120, 350, 820], foreground: true, visibility: 1, stable_features: ["灰白短髮", "異色瞳"] },
  ];
}

function cropTargets() {
  return targets().map((target, index) => ({
    ...client.normalizedTarget(target, index),
    image: Buffer.from("target"),
    mimeType: "image/jpeg",
  }));
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

test("ToriiGate compact schema accepts three 0-1000 targets", () => {
  const parsed = client.parseObservation(JSON.stringify({
    m: "photo",
    x: ["85°C"],
    t: targets().map((target) => ({ i: target.target_id, k: target.type, b: target.bbox, f: target.stable_features })),
    s: "三隻前景娃娃",
  }));
  assert.equal(parsed.targets.length, 3);
  assert.equal(parsed.targets.every((item) => item.bbox.every((value) => value >= 0 && value <= 1)), true);
  const schema = client.visionResponseFormat().json_schema.schema;
  assert.deepEqual(schema.required, ["m", "x", "t", "s"]);
  assert.equal(schema.properties.t.maxItems, 3);
  assert.equal(schema.properties.t.items.properties.b.items.maximum, 1000);
});

test("truncated ToriiGate JSON salvages complete target coordinates", () => {
  const truncated = `{
    "medium":"photo",
    "visible_text":["85°C"],
    "targets":[
      {"target_id":"A","type":"plush","bbox":[50,250,360,500],"foreground":true,"visibility":0.9,"stable_features":["灰白短髮","異色瞳"]},
      {"target_id":"B","type":"plush","bbox":[350,220,300,500],"foreground":true,"visibility":0.8,"stable_features":["灰白短髮"`;
  const parsed = client.parseObservation(truncated);
  assert.equal(parsed.partial_recovery, true);
  assert.equal(parsed.targets.length, 2);
  assert.equal(parsed.targets[0].target_id, "A");
  assert.equal(parsed.targets[1].target_id, "B");
});

test("compact Atlas rejects Mutsumi when stable features conflict", () => {
  const parsed = client.parseBatchAtlas(JSON.stringify({
    results: cropTargets().map((target) => ({
      target: target.target_id,
      best: "core-face:R3C2",
      second: "core-face:R1C1",
      best_score: 0.95,
      second_score: 0.72,
      match: false,
      support: ["hair"],
      conflict: ["eyes", "silhouette"],
    })),
  }), cropTargets(), atlas, cells);
  assert.deepEqual(client.acceptedBatchAtlasMatches(parsed, "core-face"), []);
});

test("three compact Atlas Rana targets aggregate into one identity", () => {
  const parsed = client.parseBatchAtlas(JSON.stringify({
    results: cropTargets().map((target) => ({
      target: target.target_id,
      best: "core-face:R1C1",
      second: "core-face:R3C2",
      best_score: 0.93,
      second_score: 0.48,
      match: true,
      support: ["hair", "eyes"],
      conflict: [],
    })),
  }), cropTargets(), atlas, cells);
  const accepted = client.acceptedBatchAtlasMatches(parsed, "core-face");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "rana");
  assert.equal(accepted[0].instance_count, 3);
});

test("再辨識 phrasing enables character-level resolution", () => {
  const policy = detectSearchPolicy("你再辨識一次");
  assert.equal(policy.asksIdentity, true);
  assert.equal(policy.requireCharacterLevel, true);
});

test("Vision Persona generation excludes all stale conversation history", () => {
  const messages = [
    { role: "user", content: "這是誰", MediaPath: "C:\\tmp\\old.png", MediaType: "image/png" },
    { role: "assistant", content: "上一輪錯誤猜測" },
    { role: "user", content: "你是誰？" },
    { role: "assistant", content: "我就是要樂奈。" },
  ];
  const isolated = guidance.isolateCurrentVisionHistory(messages);
  assert.deepEqual(isolated, []);
});

test("IQDB upload remains a bounded JPEG", async () => {
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyiiivzo/ssKKKKACiiigAooooA//2Q==", "base64");
  const prepared = await reverse.prepareIqdbUpload(jpeg, "image/jpeg", "speed-v1_1-test");
  assert.equal(prepared.mimeType, "image/jpeg");
  assert.equal(prepared.image.length > 0, true);
});

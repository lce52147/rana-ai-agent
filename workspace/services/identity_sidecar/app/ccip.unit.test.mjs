import assert from "node:assert/strict";
import path from "node:path";
import {
  CCIP_DEFAULTS,
  CCIP_SCHEMA,
  createCcipEngine,
  decideFace,
  decodeYoloFaces,
  nms,
  padBox,
  parseBank,
  resolveCcipOptions,
  toChw,
} from "./ccip-engine.mjs";

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const feature = (values) => Buffer.from(Float32Array.from(values).buffer).toString("base64");
const bankJson = (items) => JSON.stringify({ schema: CCIP_SCHEMA, version: "test", model: "m", dimension: 2, items });

// NMS keeps the higher-scoring of two overlapping boxes and an unrelated third box.
assert.deepEqual(nms([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], [0.6, 0.9, 0.7], 0.7), [1, 2]);
passed += 1;

// YOLOv8 layout [1, 5, N]: cx row, cy row, w row, h row, score row; mapped back to image pixels.
const yolo = Float32Array.from([
  320, 100, // cx
  320, 100, // cy
  64, 10, // w
  128, 10, // h
  0.9, 0.2, // face score
]);
const faces = decodeYoloFaces(yolo, [1, 5, 2], {
  width: 1280, height: 720, inputWidth: 640, inputHeight: 640, scoreThreshold: 0.5, iouThreshold: 0.7,
});
assert.deepEqual(faces.map((face) => face.box), [[576, 288, 704, 432]]);
passed += 1;
check(Math.abs(faces[0].score - 0.9) < 1e-6, "face score is kept");

assert.deepEqual(padBox([100, 100, 200, 300], 1280, 720, 0.35), [65, 30, 235, 370]);
passed += 1;
assert.deepEqual(padBox([0, 0, 100, 100], 120, 110, 0.35), [0, 0, 120, 110]);
passed += 1;

const chw = toChw(Uint8Array.from([255, 0, 0, 0, 255, 0]), 2, 1);
assert.deepEqual([...chw], [1, 0, 0, 1, 0, 0]);
passed += 1;
const normalized = toChw(Uint8Array.from([255, 255, 255]), 1, 1, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
assert.deepEqual([...normalized], [1, 1, 1]);
passed += 1;

const bankItems = [
  { id: "rana", shot_group: 1 },
  { id: "rana", shot_group: 2 },
  { id: "rana", shot_group: 3 },
  { id: "taki", shot_group: 4 },
];
const options = { ...CCIP_DEFAULTS };
const accepted = decideFace([0.02, 0.03, 0.05, 0.2], bankItems, options);
check(accepted.accepted && accepted.id === "rana", "near, pure, multi-shot neighbours are accepted");
check(Math.abs(accepted.margin - 0.18) < 1e-9, "margin is the gap to the best other character");
check(decideFace([0.1, 0.11, 0.12, 0.3], bankItems, options).reasons.includes("distance_above_threshold"), "far face is rejected");
check(decideFace([0.02, 0.03, 0.2, 0.04], bankItems, options).reasons.includes("mixed_neighbours"), "mixed neighbours are rejected");
const oneShotBank = bankItems.map((item) => ({ ...item, shot_group: item.id === "rana" ? 7 : 8 }));
check(decideFace([0.04, 0.05, 0.06, 0.2], oneShotBank, options).reasons.includes("single_shot_support"), "neighbours from one shot are rejected");
check(decideFace([0.02, 0.03, 0.05, 0.2], oneShotBank, options).accepted, "a very close face may rest on one shot");

const withOther = [...bankItems, { id: "_other", shot_group: 9 }, { id: "_other", shot_group: 10 }];
const other = decideFace([0.05, 0.06, 0.07, 0.2, 0.01, 0.02], withOther, options);
check(!other.accepted && other.reasons.includes("other_character"), "a face nearest the _other class is rejected");
check(decideFace([0.02, 0.03, 0.05, 0.2, 0.04, 0.3], withOther, options).reasons.includes("mixed_neighbours"), "an _other neighbour breaks purity");

const parsed = parseBank(bankJson([{ id: "rana", shot_group: 1, feature: feature([0.5, -1]) }]));
check(parsed.items[0].feature[1] === -1 && parsed.dimension === 2, "bank features decode from base64 float32");
assert.throws(() => parseBank(JSON.stringify({ schema: "other", items: [] })), /schema/);
passed += 1;
assert.throws(() => parseBank(bankJson([{ id: "rana", feature: feature([1, 2, 3]) }])), /dims/);
passed += 1;

const resolved = resolveCcipOptions({ modelDir: "m", bankPath: "b.json" }, "/root/sidecar");
// path.resolve gives a drive-letter path on Windows, so build the expectation the same way.
check(resolved.featurePath === path.resolve("/root/sidecar", "m", "ccip-caformer-24-randaug-pruned", "model_feat.onnx"), "model paths resolve under modelDir");
check(resolved.bankPath === path.resolve("/root/sidecar", "b.json"), "bank path resolves under the sidecar root");

// End to end with a fake runtime: one detected face whose feature is closest to the rana items.
const calls = { metric: [] };
const fakeRuntime = async () => ({
  async decode() { return { rgb: new Uint8Array(1280 * 720 * 3), width: 1280, height: 720 }; },
  async resize(_image, _box, width, height) { return new Uint8Array(width * height * 3); },
  async detect() {
    return { data: Float32Array.from([320, 320, 64, 128, 0.95]), dims: [1, 5, 1] };
  },
  async features() { return { data: Float32Array.from([1, 0]), dims: [1, 2] }; },
  async metric(data, dims) {
    calls.metric.push(dims);
    const n = dims[0];
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push([data[i * 2], data[(i * 2) + 1]]);
    const out = new Float32Array(n * n);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) out[(i * n) + j] = Math.hypot(rows[i][0] - rows[j][0], rows[i][1] - rows[j][1]) / 10;
    }
    return { data: out, dims: [n, n] };
  },
});
const engine = createCcipEngine({ ...CCIP_DEFAULTS, metricChunk: 2, bankPath: "bank.json" }, {
  runtimeFactory: fakeRuntime,
  readBank: async () => bankJson([
    { id: "rana", shot_group: 1, feature: feature([1, 0.01]) },
    { id: "rana", shot_group: 2, feature: feature([1, 0.02]) },
    { id: "rana", shot_group: 3, feature: feature([0.99, 0]) },
    { id: "taki", shot_group: 4, feature: feature([0, 1]) },
  ]),
});
const result = await engine.identifyFaces(Buffer.from("jpeg"));
check(result.status === "ok" && result.faces.length === 1, "one face is returned");
check(result.faces[0].decision.accepted && result.faces[0].decision.id === "rana", "the face is identified as rana");
assert.deepEqual(result.faces[0].box, [576, 288, 704, 432]);
passed += 1;
assert.deepEqual(calls.metric, [[3, 2], [3, 2]]);
passed += 1;
check((await engine.status()).bank_count === 4, "status reports the bank size");
check(result.faces[0].kind === "face" && result.faces[0].face_id === "F1", "detected faces are kind face");

// No face detected: the whole frame is matched with the stricter whole-frame distance.
const noFace = async () => ({ ...(await fakeRuntime()), async detect() { return { data: new Float32Array(0), dims: [1, 5, 0] }; } });
const bankReader = async () => bankJson([
  { id: "rana", shot_group: 1, feature: feature([1, 0.01]) },
  { id: "rana", shot_group: 2, feature: feature([1, 0.02]) },
  { id: "rana", shot_group: 3, feature: feature([0.99, 0]) },
]);
const whole = await createCcipEngine({ ...CCIP_DEFAULTS, bankPath: "bank.json" }, { runtimeFactory: noFace, readBank: bankReader })
  .identifyFaces(Buffer.from("jpeg"));
check(whole.faces.length === 1 && whole.faces[0].kind === "whole_frame" && whole.faces[0].face_id === "W1", "a frame without faces is matched whole");
assert.deepEqual(whole.faces[0].box, [0, 0, 1280, 720]);
passed += 1;
check(whole.faces[0].decision.accepted && whole.faces[0].decision.id === "rana", "a close whole-frame match is accepted");
const strict = await createCcipEngine({ ...CCIP_DEFAULTS, wholeFrameMaxDistance: 0.0001, bankPath: "bank.json" }, { runtimeFactory: noFace, readBank: bankReader })
  .identifyFaces(Buffer.from("jpeg"));
check(strict.faces[0].decision.reasons.includes("distance_above_threshold"), "whole-frame matches use the stricter distance");
const off = await createCcipEngine({ ...CCIP_DEFAULTS, wholeFrameMaxDistance: 0, bankPath: "bank.json" }, { runtimeFactory: noFace, readBank: bankReader })
  .identifyFaces(Buffer.from("jpeg"));
check(off.faces.length === 0, "whole-frame matching can be turned off");

// reload: resetBank makes the next request read the bank file again.
let bankVersion = 1;
const reloading = createCcipEngine({ ...CCIP_DEFAULTS, bankPath: "bank.json" }, {
  runtimeFactory: fakeRuntime,
  readBank: async () => JSON.stringify({ ...JSON.parse(await bankReader()), version: `v${bankVersion}` }),
});
check((await reloading.status()).bank_version === "v1", "the first bank is loaded");
bankVersion = 2;
check((await reloading.status()).bank_version === "v1", "the bank stays cached");
reloading.resetBank();
check((await reloading.status()).bank_version === "v2", "resetBank reloads the bank file");

console.log(`ccip unit tests passed: ${passed}`);

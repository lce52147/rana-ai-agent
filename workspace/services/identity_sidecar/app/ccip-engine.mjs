import { readFile } from "node:fs/promises";
import path from "node:path";

// Anime face detection (deepghs/anime_face_detection, YOLOv8) + CCIP character features
// (deepghs/ccip_onnx). Pre/post-processing mirrors dghs-imgutils 0.19.0 so that features
// match the bank exported by tools/ccip_bank_export.py.
export const CCIP_SCHEMA = "rana.identity.ccip-bank.v1";
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
const FEATURE_SIZE = 384;

export const CCIP_DEFAULTS = Object.freeze({
  modelDir: "models/ccip",
  detectorModel: "face_detect_v1.4_s/model.onnx",
  featureModel: "ccip-caformer-24-randaug-pruned/model_feat.onnx",
  metricModel: "ccip-caformer-24-randaug-pruned/model_metrics.onnx",
  bankPath: "references/ccip-bank.json",
  detectorSize: 640,
  faceScore: 0.5,
  nmsIou: 0.7,
  minFaceSide: 24,
  pad: 0.35,
  maxFaces: 6,
  // Open-set gate. Two blind difficulty-tiered checks on DCTEST shots outside the bank
  // (_review 2026-10-25, 120 frames): nearest < 0.09, 3 pure neighbours from >= 2 shots
  // (or one shot when nearest < 0.03), and a bank "_other" class for side characters gave
  // 0 wrong names on clear faces; one side character in the second sample was still named.
  maxDistance: 0.09,
  singleShotMaxDistance: 0.03,
  // No face detected (extreme close-ups): match the whole frame instead, with a stricter
  // distance (3 close-ups 0.022-0.037 right, a side character at 0.074). 0 turns it off.
  wholeFrameMaxDistance: 0.045,
  neighbours: 3,
  minShotGroups: 2,
  metricChunk: 256,
  threads: 4,
});

export function resolveCcipOptions(raw = {}, rootDir = ".") {
  const options = { ...CCIP_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const modelDir = path.resolve(rootDir, options.modelDir);
  return {
    ...options,
    modelDir,
    detectorPath: path.resolve(modelDir, options.detectorModel),
    featurePath: path.resolve(modelDir, options.featureModel),
    metricPath: path.resolve(modelDir, options.metricModel),
    bankPath: path.resolve(rootDir, options.bankPath),
  };
}

// ---- pure helpers (unit tested) ----

export function nms(boxes, scores, iouThreshold) {
  // Same arithmetic as imgutils _yolo_nms (inclusive pixel areas).
  const area = boxes.map(([x0, y0, x1, y1]) => (x1 - x0 + 1) * (y1 - y0 + 1));
  let order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  while (order.length) {
    const i = order[0];
    keep.push(i);
    order = order.slice(1).filter((j) => {
      const w = Math.max(0, Math.min(boxes[i][2], boxes[j][2]) - Math.max(boxes[i][0], boxes[j][0]) + 1);
      const h = Math.max(0, Math.min(boxes[i][3], boxes[j][3]) - Math.max(boxes[i][1], boxes[j][1]) + 1);
      const inter = w * h;
      return inter / (area[i] + area[j] - inter) <= iouThreshold;
    });
  }
  return keep;
}

// YOLOv8 output [1, 4 + classes, N] with centre-x/y, width, height in detector pixels.
export function decodeYoloFaces(data, dims, { width, height, inputWidth, inputHeight, scoreThreshold, iouThreshold }) {
  const rows = Number(dims[1]);
  const count = Number(dims[2]);
  const boxes = [];
  const scores = [];
  for (let i = 0; i < count; i += 1) {
    let score = 0;
    for (let c = 4; c < rows; c += 1) score = Math.max(score, data[(c * count) + i]);
    if (!(score > scoreThreshold)) continue;
    const cx = data[i];
    const cy = data[count + i];
    const w = data[(2 * count) + i];
    const h = data[(3 * count) + i];
    boxes.push([cx - (w / 2), cy - (h / 2), cx + (w / 2), cy + (h / 2)]);
    scores.push(score);
  }
  const clip = (value, max) => Math.round(Math.min(max, Math.max(0, value)));
  return nms(boxes, scores, iouThreshold).map((i) => ({
    box: [
      clip((boxes[i][0] / inputWidth) * width, width),
      clip((boxes[i][1] / inputHeight) * height, height),
      clip((boxes[i][2] / inputWidth) * width, width),
      clip((boxes[i][3] / inputHeight) * height, height),
    ],
    score: scores[i],
  }));
}

export function padBox([x0, y0, x1, y1], width, height, pad) {
  const px = Math.trunc((x1 - x0) * pad);
  const py = Math.trunc((y1 - y0) * pad);
  return [Math.max(0, x0 - px), Math.max(0, y0 - py), Math.min(width, x1 + px), Math.min(height, y1 + py)];
}

export function toChw(rgb, width, height, mean = null, std = null) {
  const plane = width * height;
  const output = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const value = rgb[(p * 3) + c] / 255;
      output[(c * plane) + p] = mean ? (value - mean[c]) / std[c] : value;
    }
  }
  return output;
}

// distances: one number per bank item, aligned with bank.items.
export function decideFace(distances, bankItems, options) {
  const order = distances.map((_, i) => i).sort((a, b) => distances[a] - distances[b]);
  const best = new Map();
  for (const i of order) {
    const id = bankItems[i].id;
    if (!best.has(id)) best.set(id, distances[i]);
  }
  const ranked = [...best.entries()].map(([id, distance]) => ({ id, distance }));
  const top = ranked[0] || null;
  const neighbours = order.slice(0, options.neighbours).map((i) => ({
    id: bankItems[i].id,
    distance: distances[i],
    shot_group: bankItems[i].shot_group ?? null,
  }));
  const pure = neighbours.length === options.neighbours && neighbours.every((item) => item.id === top?.id);
  // A bank item without a shot group counts as its own shot.
  const shots = new Set(neighbours.map((item, k) => item.shot_group ?? `item${k}`)).size;
  const margin = ranked.length > 1 ? ranked[1].distance - top.distance : 1;
  const reasons = [];
  if (!top) reasons.push("empty_bank");
  else {
    if (!(top.distance < options.maxDistance)) reasons.push("distance_above_threshold");
    // Bank items whose id starts with "_" (e.g. "_other": classmates, parents, side characters)
    // are never an answer; a face closest to them is someone the bank does not name.
    if (top.id.startsWith("_")) reasons.push("other_character");
    if (!pure) reasons.push("mixed_neighbours");
    if (shots < options.minShotGroups && !(top.distance < options.singleShotMaxDistance)) reasons.push("single_shot_support");
  }
  return {
    accepted: reasons.length === 0,
    id: top?.id || null,
    distance: top?.distance ?? null,
    margin,
    reasons,
    neighbours,
    ranked: ranked.slice(0, 5),
  };
}

export function parseBank(json) {
  const bank = typeof json === "string" ? JSON.parse(json) : json;
  if (bank?.schema !== CCIP_SCHEMA) throw new Error(`unsupported CCIP bank schema: ${bank?.schema}`);
  const items = (bank.items || []).map((item) => {
    const raw = Buffer.from(String(item.feature || ""), "base64");
    const feature = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    if (feature.length !== bank.dimension) throw new Error(`bank feature has ${feature.length} dims, expected ${bank.dimension}`);
    return { id: String(item.id), shot_group: item.shot_group ?? null, series: item.series || null, feature };
  });
  if (!items.length) throw new Error("CCIP bank is empty");
  return { version: String(bank.version || ""), model: String(bank.model || ""), dimension: bank.dimension, items };
}

// ---- runtime ----

async function defaultRuntime(options) {
  const ort = await import("onnxruntime-node");
  const sharp = (await import("sharp")).default;
  const sessionOptions = {
    executionProviders: ["cpu"],
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  };
  const [detector, feature, metric] = await Promise.all([
    ort.InferenceSession.create(options.detectorPath, sessionOptions),
    ort.InferenceSession.create(options.featurePath, sessionOptions),
    ort.InferenceSession.create(options.metricPath, sessionOptions),
  ]);
  const run = async (session, data, dims) => {
    const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", data, dims) };
    const output = (await session.run(feeds))[session.outputNames[0]];
    return { data: output.data, dims: output.dims };
  };
  return {
    async decode(buffer) {
      const { data, info } = await sharp(buffer, { failOn: "none" }).rotate().removeAlpha()
        .raw().toBuffer({ resolveWithObject: true });
      return { rgb: data, width: info.width, height: info.height };
    },
    async resize(image, box, width, height, kernel) {
      let pipeline = sharp(image.rgb, { raw: { width: image.width, height: image.height, channels: 3 } });
      if (box) pipeline = pipeline.extract({ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] });
      return pipeline.resize(width, height, { fit: "fill", kernel }).raw().toBuffer();
    },
    detect: (data, dims) => run(detector, data, dims),
    features: (data, dims) => run(feature, data, dims),
    metric: (data, dims) => run(metric, data, dims),
  };
}

export function createCcipEngine(options, { runtimeFactory = defaultRuntime, readBank = (file) => readFile(file, "utf8") } = {}) {
  let runtimePromise = null;
  let bankPromise = null;
  const runtime = () => {
    runtimePromise ||= runtimeFactory(options).catch((error) => { runtimePromise = null; throw error; });
    return runtimePromise;
  };
  const bank = () => {
    bankPromise ||= readBank(options.bankPath).then(parseBank).catch((error) => { bankPromise = null; throw error; });
    return bankPromise;
  };

  async function detectFaces(rt, image) {
    const size = options.detectorSize;
    const resized = await rt.resize(image, null, size, size, "cubic");
    const output = await rt.detect(toChw(resized, size, size), [1, 3, size, size]);
    return decodeYoloFaces(output.data, output.dims, {
      width: image.width,
      height: image.height,
      inputWidth: size,
      inputHeight: size,
      scoreThreshold: options.faceScore,
      iouThreshold: options.nmsIou,
    }).filter(({ box }) => Math.min(box[2] - box[0], box[3] - box[1]) >= options.minFaceSide)
      .sort((a, b) => ((b.box[2] - b.box[0]) * (b.box[3] - b.box[1])) - ((a.box[2] - a.box[0]) * (a.box[3] - a.box[1])))
      .slice(0, options.maxFaces);
  }

  async function distancesToBank(rt, features, loadedBank) {
    const dim = loadedBank.dimension;
    const out = features.map(() => new Array(loadedBank.items.length));
    for (let start = 0; start < loadedBank.items.length; start += options.metricChunk) {
      const chunk = loadedBank.items.slice(start, start + options.metricChunk);
      const n = features.length + chunk.length;
      const input = new Float32Array(n * dim);
      features.forEach((feature, i) => input.set(feature, i * dim));
      chunk.forEach((item, j) => input.set(item.feature, (features.length + j) * dim));
      const { data } = await rt.metric(input, [n, dim]);
      features.forEach((_, i) => {
        for (let j = 0; j < chunk.length; j += 1) out[i][start + j] = data[(i * n) + features.length + j];
      });
    }
    return out;
  }

  async function identifyFaces(buffer) {
    const startedAt = Date.now();
    const [rt, loadedBank] = await Promise.all([runtime(), bank()]);
    const image = await rt.decode(buffer);
    const detected = (await detectFaces(rt, image)).map((face) => ({ ...face, kind: "face" }));
    const wholeFrame = !detected.length && options.wholeFrameMaxDistance > 0;
    const faces = wholeFrame
      ? [{ box: [0, 0, image.width, image.height], score: null, kind: "whole_frame" }]
      : detected;
    const features = [];
    for (const face of faces) {
      const crop = face.kind === "whole_frame" ? face.box : padBox(face.box, image.width, image.height, options.pad);
      const rgb = await rt.resize(image, crop, FEATURE_SIZE, FEATURE_SIZE, "linear");
      const { data } = await rt.features(toChw(rgb, FEATURE_SIZE, FEATURE_SIZE, CLIP_MEAN, CLIP_STD), [1, 3, FEATURE_SIZE, FEATURE_SIZE]);
      features.push(Float32Array.from(data));
    }
    const distances = features.length ? await distancesToBank(rt, features, loadedBank) : [];
    return {
      status: "ok",
      source: "ccip_face_sidecar",
      model: { detector: options.detectorModel, feature: options.featureModel },
      bank: { version: loadedBank.version, count: loadedBank.items.length },
      image: { width: image.width, height: image.height },
      faces: faces.map((face, i) => ({
        face_id: face.kind === "whole_frame" ? "W1" : `F${i + 1}`,
        kind: face.kind,
        box: face.box,
        bbox: [face.box[0] / image.width, face.box[1] / image.height, face.box[2] / image.width, face.box[3] / image.height],
        score: face.score,
        decision: decideFace(distances[i], loadedBank.items,
          face.kind === "whole_frame" ? { ...options, maxDistance: options.wholeFrameMaxDistance } : options),
      })),
      elapsed_ms: Date.now() - startedAt,
    };
  }

  async function status() {
    try {
      const loadedBank = await bank();
      return { configured: true, bank_version: loadedBank.version, bank_count: loadedBank.items.length, runtime_loaded: Boolean(runtimePromise) };
    } catch (error) {
      return { configured: true, error: String(error?.message || error) };
    }
  }

  return { identifyFaces, status };
}

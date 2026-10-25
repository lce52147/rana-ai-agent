import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceVision } from "./debug.js";
import { createSidecarDeadline, loadSidecarConfig } from "./identity_sidecar_client.js";

// Near-duplicate lookup of a Discord image against the local DCTEST frame library.
// The index is built offline by embedding every DCTEST frame through the identity sidecar;
// a query is embedded the same way and matched by cosine similarity.

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = path.resolve(MODULE_DIR, "..", "..", "vision-index", "dctest_index.json");
const NEIGHBOR_COUNT = 8;

// Calibrated on 2026-10-25 (_fable_meme_lookup_eval / _fable_meme_peak_analysis):
// - exactSimilarity: every real Discord meme and resized frame at or above it was the right shot.
// - minSimilarity + minHubLead: below exact, the match must beat the frame's hubness (how well it
//   matches unrelated pictures) by minHubLead; this rejected all unrelated pictures and fan art.
// - sameShot: neighbors this close to the top frame are the same shot with a different subtitle.
// - lineDice: OCR text must overlap a candidate subtitle this much to pick that line.
export const SCENE_THRESHOLDS = Object.freeze({
  exactSimilarity: 0.93,
  minSimilarity: 0.86,
  minHubLead: 0.08,
  sameShot: 0.95,
  lineDice: 0.5,
});

let cached = null;

function indexPath(dependencies = {}) {
  return path.resolve(String(dependencies.indexPath || process.env.RANA_VISION_SCENE_INDEX || DEFAULT_INDEX_PATH));
}

function unitVector(values) {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

export function decodeSceneIndex(parsed) {
  const rows = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = [];
  const vectors = [];
  let dim = 0;
  for (const row of rows) {
    const raw = Buffer.from(String(row?.embedding_f32_b64 || ""), "base64");
    if (!raw.length || raw.length % 4) continue;
    const vector = unitVector(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)));
    if (dim && vector.length !== dim) continue;
    dim = vector.length;
    vectors.push(vector);
    items.push({
      path: String(row.path || ""),
      series: String(row.series || ""),
      line: String(row.line || ""),
      wordless: row.wordless === true,
      scene: String(row.scene || row.path || ""),
      labels: Array.isArray(row.label_ids) ? row.label_ids.map(String) : [],
      hub: Number.isFinite(row.hub) ? Number(row.hub) : null,
    });
  }
  const matrix = new Float32Array(items.length * dim);
  vectors.forEach((vector, index) => matrix.set(vector, index * dim));
  return { schema: String(parsed?.schema || ""), model: parsed?.model || null, dim, items, matrix };
}

export async function loadSceneIndex(dependencies = {}) {
  if (dependencies.index) return dependencies.index;
  const file = indexPath(dependencies);
  const info = await stat(file);
  if (cached && cached.file === file && cached.mtimeMs === info.mtimeMs) return cached.index;
  const index = decodeSceneIndex(JSON.parse(await readFile(file, "utf8")));
  cached = { file, mtimeMs: info.mtimeMs, index };
  return index;
}

function rowDot(index, left, right) {
  let dot = 0;
  for (let i = 0; i < index.dim; i += 1) dot += index.matrix[left * index.dim + i] * index.matrix[right * index.dim + i];
  return dot;
}

export function searchSceneIndex(index, embedding, count = NEIGHBOR_COUNT, thresholds = SCENE_THRESHOLDS) {
  const query = unitVector(embedding || []);
  if (query.length !== index.dim) throw new Error(`scene query has ${query.length} dims, index has ${index.dim}`);
  const scores = new Float32Array(index.items.length);
  for (let row = 0; row < index.items.length; row += 1) {
    let dot = 0;
    const offset = row * index.dim;
    for (let i = 0; i < index.dim; i += 1) dot += index.matrix[offset + i] * query[i];
    scores[row] = dot;
  }
  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, count);
  const top = order[0];
  if (top === undefined) return { top: null, similarity: 0, hubLead: null, neighbors: [], sameShot: [] };
  const neighbors = order.map((row) => ({ ...index.items[row], similarity: scores[row] }));
  return {
    top: neighbors[0],
    similarity: scores[top],
    hubLead: index.items[top].hub === null ? null : scores[top] - index.items[top].hub,
    neighbors,
    sameShot: order.filter((row) => row === top || rowDot(index, top, row) >= thresholds.sameShot)
      .map((row) => index.items[row]),
  };
}

export function decideSceneMatch(search, thresholds = SCENE_THRESHOLDS) {
  if (!search?.top) return { accepted: false, tier: null, reason: "empty_index" };
  if (search.similarity >= thresholds.exactSimilarity) return { accepted: true, tier: "exact", reason: "near_duplicate_frame" };
  if (search.similarity < thresholds.minSimilarity) return { accepted: false, tier: null, reason: "below_similarity" };
  if (search.hubLead === null || search.hubLead < thresholds.minHubLead) {
    return { accepted: false, tier: null, reason: "generic_frame_match" };
  }
  return { accepted: true, tier: "likely", reason: "edited_or_cropped_frame" };
}

function compact(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text) {
  const value = compact(text);
  if (value.length < 2) return value ? [value] : [];
  const grams = [];
  for (let i = 0; i < value.length - 1; i += 1) grams.push(value.slice(i, i + 2));
  return grams;
}

export function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const pool = new Map();
  for (const gram of b) pool.set(gram, (pool.get(gram) || 0) + 1);
  let shared = 0;
  for (const gram of a) {
    const remaining = pool.get(gram) || 0;
    if (remaining > 0) {
      shared += 1;
      pool.set(gram, remaining - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Pick the subtitle line: OCR picks among same-shot frames; otherwise fall back to the nearest frame. */
export function resolveSceneLine(lookup, ocr, thresholds = SCENE_THRESHOLDS) {
  if (!lookup?.accepted || !lookup.match) return lookup;
  const ocrLines = [
    ...(Array.isArray(ocr?.normalized_lines) ? ocr.normalized_lines : []),
    ...(Array.isArray(ocr?.lines) ? ocr.lines : []),
  ].map((line) => String(line?.text ?? line ?? "")).filter(Boolean);
  const ocrText = ocrLines.join(" ");
  let best = null;
  if (ocrText) {
    for (const candidate of lookup.shot_lines || []) {
      const score = Math.max(diceSimilarity(ocrText, candidate.line), ...ocrLines.map((line) => diceSimilarity(line, candidate.line)));
      if (!best || score > best.score) best = { ...candidate, score };
    }
  }
  if (best && best.score >= thresholds.lineDice) {
    return { ...lookup, match: { ...lookup.match, line: best.line, line_source: "ocr_confirmed", line_ocr_dice: Math.round(best.score * 100) / 100 } };
  }
  const distinctLines = new Set((lookup.shot_lines || []).map((item) => item.line));
  return {
    ...lookup,
    match: {
      ...lookup.match,
      line_source: lookup.match.wordless ? "wordless_frame" : distinctLines.size > 1 ? "nearest_frame_ambiguous" : "nearest_frame",
    },
  };
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function publicFrame(item) {
  return item ? {
    series: item.series,
    line: item.line,
    wordless: item.wordless,
    scene: item.scene,
    path: item.path,
    labels: item.labels,
    similarity: round(item.similarity),
  } : null;
}

async function embedImage(image, mimeType, config, fetchImpl, signal, requestId) {
  const deadline = createSidecarDeadline(signal, config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.endpoint}/v1/embeddings/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        request_id: `${requestId || "scene"}:scene`,
        items: [{
          target_id: "scene",
          parent_target_id: "scene",
          view_id: "scene:full",
          view_type: "full",
          media_domain: "anime_frame",
          mime_type: mimeType || "image/jpeg",
          data_base64: Buffer.from(image).toString("base64"),
        }],
      }),
      signal: deadline.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error || `scene embedding HTTP ${response.status}`));
    const item = Array.isArray(body?.items) ? body.items[0] : null;
    if (item?.status !== "ok" || !Array.isArray(item?.embedding)) throw new Error(`scene embedding status ${item?.status || "missing"}`);
    return { embedding: item.embedding, model: body?.model || null };
  } finally {
    deadline.close();
  }
}

/** Vectors from a different model (or quantization) are not comparable with the index. */
export function sceneModelMismatch(indexModel, queryModel) {
  if (!indexModel || !queryModel) return null;
  for (const key of ["id", "dtype", "dimension"]) {
    if (indexModel[key] !== undefined && queryModel[key] !== undefined && String(indexModel[key]) !== String(queryModel[key])) {
      return `index ${key}=${indexModel[key]} but sidecar ${key}=${queryModel[key]}; rebuild vision-index/dctest_index.json`;
    }
  }
  return null;
}

export async function lookupDctestScene({ image, mimeType, signal, requestId, dependencies = {} }) {
  const startedAt = Date.now();
  const trace = dependencies.trace || traceVision;
  const thresholds = dependencies.thresholds || SCENE_THRESHOLDS;
  try {
    const index = await loadSceneIndex(dependencies);
    const embedded = dependencies.embedding
      ? { embedding: dependencies.embedding, model: null }
      : await embedImage(
        image,
        mimeType,
        await loadSidecarConfig(dependencies.sidecar || {}),
        dependencies.fetch || fetch,
        signal,
        requestId,
      );
    const mismatch = sceneModelMismatch(index.model, embedded.model);
    if (mismatch) throw new Error(`scene model mismatch: ${mismatch}`);
    const embedding = embedded.embedding;
    const search = searchSceneIndex(index, embedding, NEIGHBOR_COUNT, thresholds);
    const decision = decideSceneMatch(search, thresholds);
    const seen = new Set();
    const result = {
      status: "ok",
      source: "dctest_scene_index",
      accepted: decision.accepted,
      tier: decision.tier,
      reason: decision.reason,
      similarity: round(search.similarity),
      hub_lead: search.hubLead === null ? null : round(search.hubLead),
      match: decision.accepted ? publicFrame({ ...search.top, similarity: search.similarity }) : null,
      shot_lines: decision.accepted
        ? search.sameShot.filter((item) => item.line && !seen.has(item.line) && seen.add(item.line))
          .map((item) => ({ line: item.line, path: item.path }))
        : [],
      neighbors: search.neighbors.slice(0, 3).map(publicFrame),
      index_size: index.items.length,
      elapsed_ms: Date.now() - startedAt,
    };
    await trace(requestId, "dctest_scene_lookup", result, { force: true });
    return result;
  } catch (error) {
    const result = {
      status: "unavailable",
      source: "dctest_scene_index",
      accepted: false,
      tier: null,
      match: null,
      shot_lines: [],
      error: String(error?.message || error),
      elapsed_ms: Date.now() - startedAt,
    };
    await trace(requestId, "dctest_scene_lookup", result, { force: true }).catch(() => {});
    return result;
  }
}

export const __test = { DEFAULT_INDEX_PATH, decideSceneMatch, decodeSceneIndex, diceSimilarity, resolveSceneLine, sceneModelMismatch, searchSceneIndex };

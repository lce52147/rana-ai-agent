import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { traceVision } from "./debug.js";
import { characterAtlases } from "./character_catalog.js";
import {
  identityLikeTarget,
  identityTargetMultiViewTargets,
  shouldUseIdentityFallbackTargets,
} from "./identity_target_multiview.js";

export { identityTargetMultiViewTargets, shouldUseIdentityFallbackTargets } from "./identity_target_multiview.js";

const VISION_LAN_BASE_URL = "http://192.168.50.3:6970";
const VISION_PRIMARY_BASE_URL = String(process.env.RANA_VISION_BASE_URL || VISION_LAN_BASE_URL).trim();
const VISION_FALLBACK_BASE_URL = String(process.env.RANA_VISION_FALLBACK_BASE_URL || "http://100.99.83.84:6970").trim();
const OPENCLAW_HOME = path.resolve(process.env.OPENCLAW_HOME || "C:\\Users\\Administrator\\.openclaw");
const INBOUND_DIRS = Object.freeze([...new Set([
  path.resolve(OPENCLAW_HOME, "media", "inbound"),
  path.resolve(OPENCLAW_HOME, "workspace", "media", "inbound"),
].filter(Boolean).map((item) => path.resolve(String(item))))]);
const INBOUND_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const INBOUND_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const OPENCLAW_CONFIG = "C:\\Users\\Administrator\\.openclaw\\openclaw.json";
const VISION_TIMEOUT_MS = 90000;
const VISION_MODEL_CACHE_MS = 60000;
const VISUAL_COMPARISON_BUDGET_MS = 75000;
const VISUAL_COMPARISON_REQUEST_TIMEOUT_MS = 40000;
const VISION_MODEL_MAX_EDGE = 1280;
const TARGET_CROP_MAX_EDGE = 640;
const TARGET_CONTACT_SHEET_CELL = 448;
const MAX_VISUAL_TARGETS = 3;
const execFileAsync = promisify(execFile);

let visionModelCache = { checkedAt: 0, id: "", baseUrl: "" };

const VISION_OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["m", "x", "t", "s"],
  properties: {
    m: { type: "string", enum: ["photo", "anime", "illustration", "game_ui", "manga", "poster", "other"] },
    x: { type: "array", maxItems: 4, items: { type: "string" } },
    t: {
      type: "array",
      maxItems: MAX_VISUAL_TARGETS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "k", "b", "f"],
        properties: {
          i: { type: "string" },
          k: { type: "string", enum: ["person", "character", "plush", "figure", "screen_character", "other"] },
          b: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: { type: "integer", minimum: 0, maximum: 1000 },
          },
          f: { type: "array", maxItems: 2, items: { type: "string" } },
        },
      },
    },
    s: { type: "string" },
  },
};

function visionResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "vision_observation",
      strict: true,
      schema: VISION_OBSERVATION_SCHEMA,
    },
  };
}

function atlasResponseFormat(cells) {
  return {
    type: "json_schema",
    json_schema: {
      name: "official_reference_visual_cell",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["cell", "confidence"],
        properties: {
          cell: { type: "string", enum: [...cells, "none"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  };
}


function batchAtlasResponseFormat(targetIds, candidateKeys) {
  return {
    type: "json_schema",
    json_schema: {
      name: "batched_target_atlas_v2",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["r"],
        properties: {
          r: {
            type: "array",
            minItems: targetIds.length,
            maxItems: targetIds.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["t", "b", "n", "p", "q", "m", "u", "c"],
              properties: {
                t: { type: "integer", minimum: 0, maximum: Math.max(0, targetIds.length - 1) },
                b: { type: "integer", minimum: -1, maximum: Math.max(-1, candidateKeys.length - 1) },
                n: { type: "integer", minimum: -1, maximum: Math.max(-1, candidateKeys.length - 1) },
                p: { type: "integer", minimum: 0, maximum: 100 },
                q: { type: "integer", minimum: 0, maximum: 100 },
                m: { type: "boolean" },
                u: { type: "integer", minimum: 0, maximum: 127 },
                c: { type: "integer", minimum: 0, maximum: 127 },
              },
            },
          },
        },
      },
    },
  };
}

function confirmationResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "official_reference_pair_confirmation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["same_character", "confidence", "evidence", "target_position"],
        properties: {
          same_character: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string" },
          target_position: { type: "string" },
        },
      },
    },
  };
}

function candidateBatchResponseFormat(maxIndex) {
  return {
    type: "json_schema",
    json_schema: {
      name: "external_candidate_batch_comparison",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["best_index", "same_character", "confidence", "evidence"],
        properties: {
          best_index: { type: "integer", enum: [-1, ...Array.from({ length: maxIndex + 1 }, (_, index) => index)] },
          same_character: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string" },
        },
      },
    },
  };
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function visionBaseUrls(primary = VISION_PRIMARY_BASE_URL, fallback = VISION_FALLBACK_BASE_URL) {
  return [...new Set([VISION_LAN_BASE_URL, primary, fallback].map(cleanBaseUrl).filter(Boolean))];
}

function imageMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

async function normalizeVisionImage(filePath, mimeType) {
  // llama.cpp's OpenAI-compatible image loader rejects WebP data URLs on this
  // deployment. Normalize unsupported inbound formats before every Vision call.
  if (mimeType !== "image/webp" && mimeType !== "image/gif") {
    return { image: await readFile(filePath), mimeType };
  }

  const outputPath = path.join(tmpdir(), `rana-vision-${randomUUID()}.png`);
  try {
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", filePath, "-frames:v", "1", outputPath], { windowsHide: true });
    return { image: await readFile(outputPath), mimeType: "image/png" };
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

async function normalizeVisionBuffer(image, mimeType) {
  if (mimeType !== "image/webp" && mimeType !== "image/gif") return { image, mimeType };
  const inputPath = path.join(tmpdir(), `rana-vision-${randomUUID()}.${mimeType === "image/webp" ? "webp" : "gif"}`);
  const outputPath = path.join(tmpdir(), `rana-vision-${randomUUID()}.png`);
  try {
    await writeFile(inputPath, image);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", inputPath, "-frames:v", "1", outputPath], { windowsHide: true });
    return { image: await readFile(outputPath), mimeType: "image/png" };
  } finally {
    await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})]);
  }
}


function extensionForMime(mimeType) {
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  if (/png/i.test(mimeType)) return "png";
  return "jpg";
}

async function resizeVisionBuffer(image, mimeType, maxEdge = VISION_MODEL_MAX_EDGE, quality = 3) {
  const inputPath = path.join(tmpdir(), `rana-vision-input-${randomUUID()}.${extensionForMime(mimeType)}`);
  const outputPath = path.join(tmpdir(), `rana-vision-resized-${randomUUID()}.jpg`);
  try {
    await writeFile(inputPath, image);
    await execFileAsync("ffmpeg", [
      "-v", "error", "-y", "-i", inputPath,
      "-vf", `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`,
      "-frames:v", "1", "-q:v", String(quality), outputPath,
    ], { windowsHide: true });
    return { image: await readFile(outputPath), mimeType: "image/jpeg" };
  } catch {
    return normalizeVisionBuffer(image, mimeType);
  } finally {
    await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})]);
  }
}

function normalizedTarget(target, index) {
  const bboxSource = Array.isArray(target?.bbox) ? target.bbox : Array.isArray(target?.box) ? target.box : [];
  const bbox = bboxSource.map(Number);
  if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) return null;

  let [left, top, third, fourth] = bbox;
  const thousandScale = Math.max(Math.abs(left), Math.abs(top), Math.abs(third), Math.abs(fourth)) > 1.5;
  if (thousandScale) {
    left /= 1000;
    top /= 1000;
    third /= 1000;
    fourth /= 1000;
  }

  const requestedMode = String(target?.bbox_mode || target?._bboxMode || "").toLowerCase();
  const xyxy = requestedMode === "xyxy"
    || requestedMode === "ltrb"
    || (thousandScale && third > left && fourth > top);

  let width = xyxy ? third - left : third;
  let height = xyxy ? fourth - top : fourth;
  let x = left;
  let y = top;

  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  width = Math.max(0.04, Math.min(1 - x, width));
  height = Math.max(0.04, Math.min(1 - y, height));
  if (width <= 0 || height <= 0) return null;

  const marginX = width * 0.08;
  const marginY = height * 0.08;
  const expandedX = Math.max(0, x - marginX);
  const expandedY = Math.max(0, y - marginY);
  const expandedWidth = Math.min(1 - expandedX, width + (marginX * 2));
  const expandedHeight = Math.min(1 - expandedY, height + (marginY * 2));

  const featureSource = Array.isArray(target?.stable_features)
    ? target.stable_features
    : Array.isArray(target?.features)
      ? target.features
      : Array.isArray(target?.f)
        ? target.f
        : [];

  const rawVisibility = Number(target?.visibility);
  const visibility = Number.isFinite(rawVisibility)
    ? Math.max(0, Math.min(1, rawVisibility > 1 ? rawVisibility / 100 : rawVisibility))
    : 1;

  return {
    target_id: String(target?.target_id || target?.id || target?.i || `T${index + 1}`).trim().slice(0, 32) || `T${index + 1}`,
    type: String(target?.type || target?.k || "other").trim(),
    bbox: [expandedX, expandedY, expandedWidth, expandedHeight],
    bbox_source: xyxy ? "xyxy" : "xywh",
    foreground: target?.foreground !== false,
    visibility,
    stable_features: featureSource
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 2),
  };
}

export function identityFallbackTargets() {
  return [
    {
      target_id: "F1",
      type: "fallback_face",
      bbox: [0.18, 0.0, 0.64, 0.68],
      foreground: true,
      visibility: 1,
      stable_features: [],
    },
    {
      target_id: "F2",
      type: "fallback_upper",
      bbox: [0.08, 0.0, 0.84, 0.90],
      foreground: true,
      visibility: 0.96,
      stable_features: [],
    },
    {
      target_id: "F3",
      type: "fallback_full",
      bbox: [0, 0, 1, 1],
      foreground: true,
      visibility: 0.92,
      stable_features: [],
    },
  ];
}

async function cropVisionTargets(image, mimeType, rawTargets = [], options = {}) {
  const prepared = await resizeVisionBuffer(image, mimeType, 1600, 3);
  let targets = rawTargets
    .map(normalizedTarget)
    .filter(Boolean)
    .filter((item) => item.foreground || !rawTargets.some((candidate) => candidate?.foreground === true))
    .sort((left, right) => right.visibility - left.visibility)
    .slice(0, MAX_VISUAL_TARGETS);
  const seenTargetIds = new Set();
  targets = targets.map((target, index) => {
    let targetId = target.target_id || `T${index + 1}`;
    if (seenTargetIds.has(targetId)) targetId = `T${index + 1}`;
    seenTargetIds.add(targetId);
    return { ...target, target_id: targetId };
  });
  if (options.fallbackMultiView === true) {
    if (shouldUseIdentityFallbackTargets(targets)) {
      targets = identityFallbackTargets();
    } else if (targets.length === 1 && identityLikeTarget(targets[0])) {
      const multiViewTargets = identityTargetMultiViewTargets(targets[0]);
      if (multiViewTargets.length === 3) targets = multiViewTargets;
    }
  }
  if (!targets.length) {
    return [{
      target_id: "T1",
      type: "main_target",
      bbox: [0, 0, 1, 1],
      foreground: true,
      visibility: 1,
      stable_features: [],
      image: prepared.image,
      mimeType: prepared.mimeType,
    }];
  }
  const inputPath = path.join(tmpdir(), `rana-vision-crop-source-${randomUUID()}.jpg`);
  await writeFile(inputPath, prepared.image);
  try {
    return await Promise.all(targets.map(async (target) => {
      const [x, y, width, height] = target.bbox;
      const outputPath = path.join(tmpdir(), `rana-vision-target-${randomUUID()}.jpg`);
      try {
        await execFileAsync("ffmpeg", [
          "-v", "error", "-y", "-i", inputPath,
          "-vf", `crop=iw*${width}:ih*${height}:iw*${x}:ih*${y},scale=${TARGET_CROP_MAX_EDGE}:${TARGET_CROP_MAX_EDGE}:force_original_aspect_ratio=decrease`,
          "-frames:v", "1", "-q:v", "3", outputPath,
        ], { windowsHide: true });
        return { ...target, image: await readFile(outputPath), mimeType: "image/jpeg" };
      } catch {
        return { ...target, image: prepared.image, mimeType: prepared.mimeType, crop_failed: true };
      } finally {
        await unlink(outputPath).catch(() => {});
      }
    }));
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

export async function extractVisionTargets(image, mimeType, rawTargets = []) {
  return cropVisionTargets(image, mimeType, rawTargets, { fallbackMultiView: true });
}

async function buildTargetContactSheet(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error("target contact sheet requires at least one target");
  if (targets.length === 1) {
    return {
      image: targets[0].image,
      mimeType: targets[0].mimeType,
      targetOrder: [targets[0].target_id],
      composed: false,
    };
  }

  const inputPaths = [];
  const outputPath = path.join(tmpdir(), `rana-vision-contact-${randomUUID()}.jpg`);
  try {
    for (const target of targets) {
      const inputPath = path.join(tmpdir(), `rana-vision-contact-input-${randomUUID()}.jpg`);
      await writeFile(inputPath, target.image);
      inputPaths.push(inputPath);
    }

    const args = ["-v", "error", "-y"];
    for (const inputPath of inputPaths) args.push("-i", inputPath);
    const filters = targets.map((_, index) =>
      `[${index}:v]scale=${TARGET_CONTACT_SHEET_CELL}:${TARGET_CONTACT_SHEET_CELL}:force_original_aspect_ratio=decrease,` +
      `pad=${TARGET_CONTACT_SHEET_CELL}:${TARGET_CONTACT_SHEET_CELL}:(ow-iw)/2:(oh-ih)/2:white[v${index}]`
    );
    filters.push(`${targets.map((_, index) => `[v${index}]`).join("")}hstack=inputs=${targets.length}[out]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "3", outputPath);
    await execFileAsync("ffmpeg", args, { windowsHide: true });
    return {
      image: await readFile(outputPath),
      mimeType: "image/jpeg",
      targetOrder: targets.map((item) => item.target_id),
      composed: true,
    };
  } finally {
    await Promise.all([
      ...inputPaths.map((inputPath) => unlink(inputPath).catch(() => {})),
      unlink(outputPath).catch(() => {}),
    ]);
  }
}

function abortable(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function rawVisibleText(text) {
  const source = String(text || "");
  const match = source.match(/"(?:x|visible_text)"\s*:\s*\[([\s\S]*?)(?:\]\s*,\s*"(?:t|targets|s|summary|logos)"|\]\s*\}|$)/i);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((item) => {
      try { return JSON.parse(`"${item[1]}"`); } catch { return item[1]; }
    })
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function recoverPartialTargets(text) {
  const source = String(text || "");
  const starts = [
    ...[...source.matchAll(/"target_id"\s*:\s*"([^"]+)"/gi)].map((match) => ({ match, compact: false })),
    ...[...source.matchAll(/"i"\s*:\s*"([^"]+)"/gi)].map((match) => ({ match, compact: true })),
  ].sort((left, right) => (left.match.index ?? 0) - (right.match.index ?? 0));

  const recovered = [];
  for (let index = 0; index < starts.length && recovered.length < MAX_VISUAL_TARGETS; index += 1) {
    const current = starts[index];
    const segmentStart = current.match.index ?? 0;
    const segmentEnd = index + 1 < starts.length ? (starts[index + 1].match.index ?? source.length) : source.length;
    const segment = source.slice(segmentStart, segmentEnd);

    const type = current.compact
      ? segment.match(/"k"\s*:\s*"([^"]+)"/i)?.[1] || "other"
      : segment.match(/"type"\s*:\s*"([^"]+)"/i)?.[1] || "other";
    const bboxRaw = current.compact
      ? segment.match(/"b"\s*:\s*\[([^\]]+)\]/i)?.[1] || ""
      : segment.match(/"bbox"\s*:\s*\[([^\]]+)\]/i)?.[1] || "";
    const bbox = bboxRaw.split(",").map((item) => Number(item.trim())).filter(Number.isFinite);
    if (bbox.length !== 4) continue;

    const featurePattern = current.compact ? /"f"\s*:\s*\[([\s\S]*)/i : /"stable_features"\s*:\s*\[([\s\S]*)/i;
    const featureRegion = segment.match(featurePattern)?.[1] || "";
    const stableFeatures = [...featureRegion.matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => {
        try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
      })
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 2);

    const normalized = normalizedTarget({
      target_id: current.match[1],
      type,
      bbox,
      bbox_mode: current.compact ? "xyxy" : "xyxy",
      foreground: true,
      visibility: 1,
      stable_features: stableFeatures,
    }, recovered.length);
    if (normalized) recovered.push(normalized);
  }
  return recovered;
}

function inferObservationType(targets) {
  if (targets.some((item) => ["person", "character", "plush", "figure", "screen_character"].includes(item.type))) return "character";
  return "unknown";
}

function parseObservation(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const fallbackTargets = recoverPartialTargets(text);
  const fallbackFeatures = [...new Set(fallbackTargets.flatMap((item) => item.stable_features || []))].slice(0, 8);
  const fallback = {
    medium: String(text.match(/"(?:m|medium)"\s*:\s*"([^"]+)"/i)?.[1] || "other"),
    subject_type: inferObservationType(fallbackTargets),
    people_count: fallbackTargets.filter((item) => ["person", "character"].includes(item.type)).length,
    visible_text: rawVisibleText(text),
    logos: [],
    distinctive_features: fallbackFeatures,
    targets: fallbackTargets,
    scene: "",
    summary: String(text.match(/"(?:s|summary)"\s*:\s*"([^"]*)"/i)?.[1] || fallbackFeatures.join("、") || text.slice(0, 500))
      .replace(/\s+/g, " ").trim().slice(0, 500),
    partial_recovery: fallbackTargets.length > 0,
  };
  if (start < 0 || end <= start) return fallback;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const strings = (items, limit = 8) => {
      const values = Array.isArray(items) ? items : typeof items === "string" ? [items] : [];
      return values.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, limit);
    };

    const compactTargets = Array.isArray(parsed?.t)
      ? parsed.t.map((item) => ({
        target_id: item?.i,
        type: item?.k,
        bbox: item?.b,
        bbox_mode: "xyxy",
        foreground: true,
        visibility: 1,
        stable_features: item?.f,
      }))
      : null;
    const rawTargets = compactTargets || (Array.isArray(parsed?.targets) ? parsed.targets.map((item) => ({ ...item, bbox_mode: "xyxy" })) : []);
    const targets = rawTargets.map(normalizedTarget).filter(Boolean).slice(0, MAX_VISUAL_TARGETS);

    const targetFeatures = [...new Set(targets.flatMap((item) => item.stable_features || []))].slice(0, 8);
    const explicitFeatures = strings(parsed?.distinctive_features);
    const distinctiveFeatures = explicitFeatures.length ? explicitFeatures : targetFeatures;
    const subjectType = ["food", "object", "person", "character", "scene", "unknown"].includes(parsed?.subject_type)
      ? parsed.subject_type
      : inferObservationType(targets);
    const visibleText = strings(parsed?.x ?? parsed?.visible_text, 4);

    return {
      medium: ["photo", "anime", "illustration", "game_ui", "manga", "poster", "other"].includes(parsed?.m ?? parsed?.medium)
        ? (parsed.m ?? parsed.medium)
        : "other",
      subject_type: subjectType,
      people_count: targets.filter((item) => ["person", "character"].includes(item.type)).length,
      visible_text: visibleText.length ? visibleText : rawVisibleText(text),
      logos: strings(parsed?.logos, 4),
      distinctive_features: distinctiveFeatures,
      targets,
      scene: String(parsed?.scene || "").replace(/\s+/g, " ").trim().slice(0, 300),
      summary: String(parsed?.s ?? parsed?.summary ?? distinctiveFeatures.join("、") ?? text).replace(/\s+/g, " ").trim().slice(0, 500),
      partial_recovery: false,
    };
  } catch {
    return fallback;
  }
}

function observationLooksTemplate(raw, observation) {
  const source = String(raw || "");
  const markers = [
    "photo|anime|illustration|game_ui|manga|poster|other",
    "food|object|person|character|scene|unknown",
    "factual visual summary",
    "visible scene",
    "visible feature",
  ];
  const markerCount = markers.filter((marker) => source.includes(marker)).length;
  const hasEvidence = Boolean(
    observation?.visible_text?.length
    || observation?.logos?.length
    || observation?.distinctive_features?.length
    || (observation?.summary && observation.summary !== "factual visual summary")
  );
  return markerCount >= 2 && !hasEvidence;
}

async function resolveVisionTarget(signal, requestId) {
  const now = Date.now();
  if (visionModelCache.id && visionModelCache.baseUrl && now - visionModelCache.checkedAt < VISION_MODEL_CACHE_MS) {
    return { model: visionModelCache.id, baseUrl: visionModelCache.baseUrl };
  }
  const errors = [];
  for (const baseUrl of visionBaseUrls()) {
    const endpoint = `${baseUrl}/v1/models`;
    const probe = abortable(signal, 5000);
    try {
      const response = await fetch(endpoint, { signal: probe.signal });
      console.log(`[rana-vision] request=${requestId} discovery endpoint=${endpoint} status=${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({}));
      const ids = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id || "").trim()).filter(Boolean) : [];
      const model = ids.find((id) => /ToriiGate|Qwen.*VL/i.test(id)) || ids[0];
      if (!model) throw new Error("no model returned");
      visionModelCache = { checkedAt: now, id: model, baseUrl };
      return { model, baseUrl };
    } catch (error) {
      errors.push(`${endpoint}: ${error?.message || error}`);
    } finally {
      probe.close();
    }
  }
  throw new Error(`vision discovery failed (${errors.join("; ")})`);
}

function visionUserContent(image, mimeType) {
  return [
    {
      type: "text",
      text: [
        "Visible evidence only. Never guess names, franchises, or relationships.",
        "Return one-line compact JSON with keys m,x,t,s.",
        "t contains at most three main foreground identity-bearing subjects.",
        "If any visible person, anime character, plush, figure, or screen character is present, t must contain at least one target.",
        "Never return an empty t for an obvious character close-up. If bounds are uncertain, return a conservative box around the main visible subject.",
        "Each target is {i:id,k:type,b:[left,top,right,bottom],f:[feature1,feature2]}.",
        "Coordinates are integers 0-1000. left<right and top<bottom. Do not use width/height.",
        "Prefer physical foreground subjects over monitors or posters.",
        "Use Traditional Chinese for f and s. Keep x text verbatim. Keep s under 20 Chinese characters.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
  ];
}

function atlasUserContent(image, mimeType, atlasImage) {
  return [
    {
      type: "text",
      text: [
        "Image 1 is a target. Image 2 is a grid of neutral visual reference cells.",
        "Select the one cell with the same character design, or none.",
        "Compare face and hairstyle; allow different crop, pose, expression, outfit, lighting, and rendering.",
        "The cell code is only a location. Do not use external character knowledge.",
        "Return JSON only.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
    { type: "text", text: "Image 2: official visual reference grid." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${atlasImage.toString("base64")}` } },
  ];
}


const ATLAS_FEATURE_BITS = Object.freeze({
  hair: 1,
  bangs: 2,
  eyes: 4,
  face_mark: 8,
  accessory: 16,
  silhouette: 32,
  other: 64,
});

function decodeFeatureMask(value) {
  const mask = Math.max(0, Math.min(127, Number(value) || 0));
  return Object.entries(ATLAS_FEATURE_BITS)
    .filter(([, bit]) => (mask & bit) === bit)
    .map(([name]) => name);
}

function extractCompleteObjectsFromArray(value, key) {
  const text = String(value || "");
  const marker = new RegExp(`"${key}"\\s*:\\s*\\[`, "i").exec(text);
  if (!marker) return [];
  const start = (marker.index || 0) + marker[0].length;
  const objects = [];
  let depth = 0;
  let objectStart = -1;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try { objects.push(JSON.parse(text.slice(objectStart, index + 1))); } catch {}
        objectStart = -1;
      }
      continue;
    }
    if (char === "]" && depth === 0) break;
  }
  return objects;
}

function batchAtlasUserContent(targets, contactSheet, atlasImage, atlas, cells) {
  const candidateMap = cells.map((cell, index) => {
    const character = atlas.characters.find((item) => item.id === cell.id);
    const traits = Array.isArray(character?.visual_traits) ? character.visual_traits.slice(0, 3) : [];
    return `${index}=${cell.cell}:${traits.join("|")}`;
  }).join(";");

  const targetMap = targets.map((target, index) =>
    `${index}=${target.target_id}:${target.type}:${(target.stable_features || []).join("|")}`
  ).join(";");

  return [
    {
      type: "text",
      text: [
        "Compare each contact-sheet column with the official face atlas.",
        `Targets(left-to-right):${targetMap}`,
        `Candidates:${candidateMap}`,
        "Return one-line JSON only: {\"r\":[{\"t\":0,\"b\":0,\"n\":1,\"p\":95,\"q\":70,\"m\":true,\"u\":37,\"c\":0}]}",
        "t=target index; b/n=candidate index or -1; p/q=0-100 scores; m=clear same design.",
        "u/c are feature bitmasks: hair=1,bangs=2,eyes=4,face_mark=8,accessory=16,silhouette=32,other=64.",
        "Generic color or clothing alone is insufficient. m=true requires stable support and no stable conflict.",
      ].join("\n"),
    },
    { type: "text", text: "Image 1: target contact sheet, columns follow target index order." },
    { type: "image_url", image_url: { url: `data:${contactSheet.mimeType};base64,${contactSheet.image.toString("base64")}` } },
    { type: "text", text: `Image 2: official atlas ${atlas.id}; cell labels are printed.` },
    { type: "image_url", image_url: { url: `data:image/png;base64,${atlasImage.toString("base64")}` } },
  ];
}

function parseBatchAtlas(value, targets, atlas, cells) {
  const parsed = parsedJson(value);
  const compactResults = Array.isArray(parsed?.r) ? parsed.r : extractCompleteObjectsFromArray(value, "r");
  const legacyResults = Array.isArray(parsed?.results) ? parsed.results : extractCompleteObjectsFromArray(value, "results");
  const rawResults = compactResults.length ? compactResults : legacyResults;
  const keyMap = new Map(cells.map((cell) => [`${atlas.id}:${cell.cell}`, cell]));
  const byTarget = new Map();

  for (const item of rawResults) {
    const compact = Object.prototype.hasOwnProperty.call(item || {}, "t");
    const targetIndex = compact ? Number(item?.t) : targets.findIndex((target) => target.target_id === String(item?.target ?? item?.target_id ?? "").trim());
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= targets.length) continue;

    let bestKey;
    let secondKey;
    let bestScore;
    let secondScore;
    let supporting;
    let conflicts;
    let sameDesign;

    if (compact) {
      const bestIndex = Number(item?.b);
      const secondIndex = Number(item?.n);
      bestKey = Number.isInteger(bestIndex) && bestIndex >= 0 && bestIndex < cells.length
        ? `${atlas.id}:${cells[bestIndex].cell}`
        : "none";
      secondKey = Number.isInteger(secondIndex) && secondIndex >= 0 && secondIndex < cells.length
        ? `${atlas.id}:${cells[secondIndex].cell}`
        : "none";
      bestScore = Math.max(0, Math.min(1, (Number(item?.p) || 0) / 100));
      secondScore = Math.max(0, Math.min(1, (Number(item?.q) || 0) / 100));
      sameDesign = item?.m === true;
      supporting = decodeFeatureMask(item?.u);
      conflicts = decodeFeatureMask(item?.c);
    } else {
      bestKey = String(item?.best ?? item?.best_candidate ?? "none").trim();
      secondKey = String(item?.second ?? item?.second_candidate ?? "none").trim();
      bestScore = Math.max(0, Math.min(1, Number(item?.best_score ?? item?.best_confidence) || 0));
      secondScore = Math.max(0, Math.min(1, Number(item?.second_score ?? item?.second_confidence) || 0));
      sameDesign = item?.match === true || item?.same_character_design === true;
      supporting = Array.isArray(item?.support ?? item?.supporting_features)
        ? (item.support ?? item.supporting_features).map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 3)
        : [];
      conflicts = Array.isArray(item?.conflict ?? item?.conflicting_features)
        ? (item.conflict ?? item.conflicting_features).map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 3)
        : [];
    }

    const best = keyMap.get(bestKey) || null;
    const second = keyMap.get(secondKey) || null;
    byTarget.set(targetIndex, {
      target_id: targets[targetIndex].target_id,
      target: targets[targetIndex],
      best_key: bestKey,
      second_key: secondKey,
      best_id: best?.id || "",
      second_id: second?.id || "",
      best_confidence: bestScore,
      second_confidence: secondScore,
      same_character_design: sameDesign,
      supporting_features: supporting,
      conflicting_features: conflicts,
      reason: compactResults.length && !Array.isArray(parsed?.r) ? "partial_compact_recovery" : "",
    });
  }

  return targets.map((target, index) => byTarget.get(index) || {
    target_id: target.target_id,
    target,
    best_key: "none",
    second_key: "none",
    best_id: "",
    second_id: "",
    best_confidence: 0,
    second_confidence: 0,
    same_character_design: false,
    supporting_features: [],
    conflicting_features: [],
    reason: "",
  });
}

function acceptedBatchAtlasMatches(results, atlasId) {
  const prelim = results.map((item) => ({
    ...item,
    margin: item.best_confidence - item.second_confidence,
    accepted: Boolean(
      item.best_id
      && item.same_character_design
      && item.conflicting_features.length === 0
      && (
        (
          item.best_confidence >= 0.86
          && item.best_confidence - item.second_confidence >= 0.08
          && item.supporting_features.length >= 2
        )
        || (
          item.best_confidence >= 0.92
          && item.best_confidence - item.second_confidence >= 0.06
          && item.supporting_features.length >= 3
        )
      )
    ),
  }));
  const counts = new Map();
  for (const item of prelim) {
    if (!item.best_id || !item.same_character_design || item.conflicting_features.length) continue;
    counts.set(item.best_id, (counts.get(item.best_id) || 0) + 1);
  }
  for (const item of prelim) {
    if (item.accepted) continue;
    const consensus = counts.get(item.best_id) || 0;
    if (
      item.best_id
      && consensus >= 2
      && item.same_character_design
      && item.best_confidence >= 0.82
      && item.margin >= 0.05
      && item.supporting_features.length >= 1
      && item.conflicting_features.length === 0
    ) item.accepted = true;
  }
  const grouped = new Map();
  for (const item of prelim.filter((entry) => entry.accepted)) {
    if (!grouped.has(item.best_id)) grouped.set(item.best_id, []);
    grouped.get(item.best_id).push(item);
  }
  return [...grouped.entries()].map(([id, instances]) => {
    const confidence = Math.min(0.96, Math.max(...instances.map((item) => item.best_confidence)) + (instances.length >= 2 ? 0.04 : 0));
    return {
      id,
      confidence_score: confidence >= 0.9 ? 0.92 : 0.86,
      evidence: "batched_target_atlas_feature_confirmation",
      position: instances.map((item) => item.target_id).join(","),
      atlas_id: atlasId,
      atlas_confidence: Math.max(...instances.map((item) => item.best_confidence)),
      confirmation_confidence: confidence,
      instance_count: instances.length,
      target_instances: instances.map((item) => ({
        target_id: item.target_id,
        bbox: item.target.bbox,
        type: item.target.type,
        visibility: item.target.visibility,
        supporting_features: item.supporting_features,
        reason: item.reason,
      })),
    };
  });
}

function confirmationUserContent(image, mimeType, referenceImage, targetPosition, referenceMimeType = "image/png") {
  return [
    {
      type: "text",
      text: [
        "Image 1 is the only target. Image 2 is one candidate character reference.",
        `Check only the target person at this location: ${targetPosition || "the matched target person"}.`,
        "Decide whether they show the same fictional character across different crop, pose, expression, outfit, lighting, rendering, or color shift.",
        "Compare stable design evidence: face, hairstyle shape, bangs, distinctive eye pattern, and recurring accessories.",
        "Clothing alone and small color shifts must not reject a match. Return false when stable identity features conflict or evidence is insufficient.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
    { type: "text", text: "Image 2: candidate visual reference." },
    { type: "image_url", image_url: { url: `data:${referenceMimeType};base64,${referenceImage.toString("base64")}` } },
  ];
}

function candidateBatchUserContent(image, mimeType, candidates) {
  const content = [
    {
      type: "text",
      text: [
        "Image 1 is the only target. The following images are candidate character references from one already-resolved work.",
        "Select the one candidate with the same fictional character design, or best_index=-1 when none is reliable.",
        "Compare stable identity evidence: face, hairstyle shape, bangs, eye pattern, and recurring accessories.",
        "Allow different crop, pose, expression, outfit, lighting, rendering, and small color shifts.",
        "Do not use model memory or candidate popularity. Return JSON only.",
      ].join("\\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
  ];
  candidates.forEach((candidate, index) => {
    content.push({
      type: "text",
      text: `Candidate ${index}: ${candidate?.name || "unknown"} / ${candidate?.work || "unknown work"}`,
    });
    content.push({
      type: "image_url",
      image_url: { url: `data:${candidate.referenceMimeType};base64,${candidate.referenceImage.toString("base64")}` },
    });
  });
  return content;
}

function externalIdentityResponseFormat(maxIndex) {
  return {
    type: "json_schema",
    json_schema: {
      name: "external_character_identity_candidate",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "character_name", "work_title", "confidence", "evidence_indexes", "reference_urls", "reason"],
        properties: {
          status: { type: "string", enum: ["candidate", "none"] },
          character_name: { type: "string" },
          work_title: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence_indexes: {
            type: "array",
            items: { type: "integer" },
          },
          reference_urls: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  };
}

function externalIdentityUserContent(image, mimeType, webEvidence, workHypotheses, visualSummary) {
  return [
    {
      type: "text",
      text: [
        "Identify the fictional character in the target image using ONLY the supplied web evidence.",
        "Do not answer from model memory. A character name and work title must appear explicitly in the selected evidence rows.",
        "The web evidence may contain wrong search snippets. Compare the visible target design with descriptions in the evidence and reject conflicts.",
        "Return status=none if no exact character name is text-supported. Do not invent, translate, merge, or repair a name.",
        `Work hypotheses: ${JSON.stringify(workHypotheses || [])}`,
        `Target visual summary: ${JSON.stringify(visualSummary || {})}`,
        `Indexed web evidence: ${JSON.stringify(webEvidence || [])}`,
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
  ];
}

function parsedJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

function atlasCells(atlas) {
  return atlas.characters.map((item, index) => ({
    id: item.id,
    cell: `R${Math.floor(index / 3) + 1}C${(index % 3) + 1}`,
  }));
}

function parseAtlasMatches(value, cells) {
  const parsed = parsedJson(value);
  const cell = String(parsed?.cell || "").trim().toUpperCase();
  const reference = cells.find((item) => item.cell === cell);
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
  if (!reference || confidence < 0.5) return [];
  return [{
    id: reference.id,
    confidence,
    evidence: "neutral_atlas_cell_match",
    target_position: "center",
    reference_position: cell,
  }];
}

function parseConfirmation(value) {
  const parsed = parsedJson(value);
  return {
    same_character: parsed?.same_character === true,
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    evidence: String(parsed?.evidence || "").replace(/\s+/g, " ").trim().slice(0, 500),
    target_position: String(parsed?.target_position || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

function parseCandidateBatch(value, maxIndex) {
  const parsed = parsedJson(value);
  const index = Number(parsed?.best_index);
  const bestIndex = Number.isInteger(index) && index >= 0 && index <= maxIndex ? index : -1;
  return {
    best_index: bestIndex,
    same_character: bestIndex >= 0 && parsed?.same_character === true,
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    evidence: String(parsed?.evidence || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

function parseExternalIdentity(value, maxIndex) {
  const parsed = parsedJson(value);
  const indexes = Array.isArray(parsed?.evidence_indexes)
    ? parsed.evidence_indexes.map(Number).filter((item) => Number.isInteger(item) && item >= 0 && item <= maxIndex).slice(0, 6)
    : [];
  return {
    status: parsed?.status === "candidate" ? "candidate" : "none",
    character_name: String(parsed?.character_name || "").replace(/\s+/g, " ").trim().slice(0, 160),
    work_title: String(parsed?.work_title || "").replace(/\s+/g, " ").trim().slice(0, 200),
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    evidence_indexes: indexes,
    reference_urls: Array.isArray(parsed?.reference_urls)
      ? parsed.reference_urls.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    reason: String(parsed?.reason || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

/* RANA_VISION_6970_RAW_CAPTURE_START */
const RAW_6970_CAPTURE_ENABLED = process.env.RANA_VISION_RAW_HTTP_CAPTURE === "1"
  && String(process.env.RANA_VISION_TRACE_MODE || "").toLowerCase() !== "identity";
function sanitize6970CapturePayload(value) {
  if (typeof value === "string") {
    const match = value.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (match) {
      const binary = Buffer.from(match[2], "base64");
      return {
        type: "image_data_url",
        mime_type: match[1],
        image_bytes: binary.length,
        image_sha256: createHash("sha256").update(binary).digest("hex"),
        base64_omitted: true,
      };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize6970CapturePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize6970CapturePayload(item)]));
  }
  return value;
}
/* RANA_VISION_6970_RAW_CAPTURE_END */
export async function analyzeWithToriiGate(image, mimeType, signal, requestId) {
  const startedAt = Date.now();
  const request = abortable(signal, VISION_TIMEOUT_MS);
  try {
    const { model, baseUrl } = await resolveVisionTarget(request.signal, requestId);
    const modelInput = await resizeVisionBuffer(image, mimeType, VISION_MODEL_MAX_EDGE, 3);
    const visionUrl = `${baseUrl}/v1/chat/completions`;
    await traceVision(requestId, "toriigate_request", {
      endpoint: visionUrl,
      model,
      mime_type: modelInput.mimeType,
      original_image_bytes: image.length,
      image_bytes: modelInput.image.length,
      image_sha256: createHash("sha256").update(modelInput.image).digest("hex"),
      preprocessing_ms: Date.now() - startedAt,
    });
    const response = await fetch(visionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 192,
        cache_prompt: false,
        response_format: visionResponseFormat(),
        messages: [
          { role: "system", content: "You are ToriiGate, a visual observation stage. Describe visible evidence accurately and return only the requested JSON. Do not infer identity from fandom knowledge." },
          { role: "user", content: visionUserContent(modelInput.image, modelInput.mimeType) },
        ],
      }),
      signal: request.signal,
    });
    const body = await response.text();
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}
    await traceVision(requestId, "toriigate_raw_response", { http_status: response.status, body: data || body });
    console.log(`[rana-vision] request=${requestId} ToriiGate endpoint=${visionUrl} status=${response.status}`);
    if (!response.ok) throw new Error(String(data?.error?.message || data?.error || body || `HTTP ${response.status}`));
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) throw new Error("vision returned no description");
    const observation = parseObservation(raw);
    const templateResponse = observationLooksTemplate(raw, observation);
    await traceVision(requestId, "toriigate_identity_observation", {
      http_status: response.status,
      requested_model: model,
      response_model: String(data?.model || model),
      raw: raw.slice(0, 32768),
      raw_truncated: raw.length > 32768,
      observation,
      template_response: templateResponse,
      duration_ms: Date.now() - startedAt,
    });
    const result = {
      status: templateResponse ? "invalid" : "ok",
      source: "ToriiGate",
      endpoint: visionUrl,
      http_status: response.status,
      requested_model: model,
      response_model: String(data?.model || model),
      raw,
      observation,
      duration_ms: Date.now() - startedAt,
      error: templateResponse ? "vision_template_response" : undefined,
    };
    if (templateResponse) await traceVision(requestId, "toriigate_invalid_response", result, { force: true });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("remote vision request timed out");
    throw error;
  } finally {
    request.close();
  }
}

async function postVisualComparison({ baseUrl, model, body, signal, timeoutMs = 45_000, requestId }) {
  const request = abortable(signal, timeoutMs);
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const requestPayload = { model, temperature: 0, cache_prompt: false, ...body };
  const startedAt = Date.now();
  if (RAW_6970_CAPTURE_ENABLED) {
    await traceVision(requestId, "model_6970_http_request_raw", {
      endpoint,
      timeout_ms: timeoutMs,
      payload: sanitize6970CapturePayload(requestPayload),
    }, { force: true });
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
      signal: request.signal,
    });
    const rawBody = await response.text();
    let data = {};
    try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {}
    if (RAW_6970_CAPTURE_ENABLED) {
      await traceVision(requestId, "model_6970_http_response_raw", {
        endpoint,
        http_status: response.status,
        duration_ms: Date.now() - startedAt,
        raw_body: rawBody,
        parsed_body: data,
      }, { force: true });
    }
    if (!response.ok) throw new Error(String(data?.error?.message || data?.error || rawBody || `HTTP ${response.status}`));
    return {
      endpoint,
      http_status: response.status,
      response_model: String(data?.model || model),
      raw: String(data?.choices?.[0]?.message?.content || "").trim(),
      usage: data?.usage,
    };
  } catch (error) {
    if (RAW_6970_CAPTURE_ENABLED) {
      await traceVision(requestId, "model_6970_http_error_raw", {
        endpoint,
        duration_ms: Date.now() - startedAt,
        name: error?.name,
        message: String(error?.message || error),
        stack: error?.stack,
      }, { force: true });
    }
    throw error;
  } finally {
    request.close();
  }
}
export async function resolveExternalIdentityWithWebEvidence({
  image,
  mimeType,
  webEvidence,
  workHypotheses,
  visualSummary,
  signal,
  requestId,
}) {
  const source = "external web-evidence identity resolver";
  try {
    const discovery = abortable(signal, 10_000);
    let target;
    try {
      target = await resolveVisionTarget(discovery.signal, requestId);
    } finally {
      discovery.close();
    }
    const { model, baseUrl } = target;
    const maxIndex = Math.max(0, (webEvidence || []).length - 1);
    await traceVision(requestId, "deep_search_identity_request", {
      endpoint: `${baseUrl}/v1/chat/completions`,
      model,
      evidence_count: (webEvidence || []).length,
      work_hypotheses: workHypotheses,
      visual_summary: visualSummary,
    }, { force: true });
    const response = await postVisualComparison({
      requestId,
      baseUrl,
      model,
      signal,
      timeoutMs: 35_000,
      body: {
        max_tokens: 192,
        response_format: externalIdentityResponseFormat(maxIndex),
        messages: [
          { role: "system", content: "Resolve one external fictional-character identity only from explicit indexed web evidence and target-image design. Return JSON." },
          { role: "user", content: externalIdentityUserContent(image, mimeType, webEvidence, workHypotheses, visualSummary) },
        ],
      },
    });
    const parsed = parseExternalIdentity(response.raw, maxIndex);
    const result = { status: parsed.status, source, model, ...response, ...parsed };
    await traceVision(requestId, "deep_search_identity_response", result, { force: true });
    return result;
  } catch (error) {
    const result = {
      status: "none",
      source,
      character_name: "",
      work_title: "",
      confidence: 0,
      evidence_indexes: [],
      reference_urls: [],
      reason: "resolver_unavailable",
      error: String(error?.message || error),
    };
    await traceVision(requestId, "deep_search_identity_response", result, { force: true });
    return result;
  }
}


export async function compareWithExternalCandidates({
  image,
  mimeType,
  candidates,
  signal,
  requestId,
}) {
  const source = "external candidate batch visual comparison";
  const inputCandidates = Array.isArray(candidates) ? candidates.slice(0, 4) : [];
  if (!inputCandidates.length) {
    return {
      status: "unavailable",
      source,
      best_index: -1,
      same_character: false,
      confidence: 0,
      evidence: "",
      selectedCandidate: null,
      error: "no_candidate_references",
    };
  }
  try {
    const discovery = abortable(signal, 8_000);
    let target;
    try {
      target = await resolveVisionTarget(discovery.signal, requestId);
    } finally {
      discovery.close();
    }
    const normalized = [];
    for (const candidate of inputCandidates) {
      const reference = await normalizeVisionBuffer(candidate.referenceImage, candidate.referenceMimeType);
      normalized.push({
        ...candidate,
        referenceImage: reference.image,
        referenceMimeType: reference.mimeType,
      });
    }
    const { model, baseUrl } = target;
    await traceVision(requestId, "external_candidate_batch_comparison_request", {
      endpoint: `${baseUrl}/v1/chat/completions`,
      model,
      candidate_count: normalized.length,
      candidates: normalized.map((item, index) => ({
        index,
        name: item.name,
        work: item.work,
        referenceUrl: item.referenceUrl,
        reference_sha256: createHash("sha256").update(item.referenceImage).digest("hex"),
      })),
      target_sha256: createHash("sha256").update(image).digest("hex"),
    }, { force: true });
    const response = await postVisualComparison({
      requestId,
      baseUrl,
      model,
      signal,
      timeoutMs: 28_000,
      body: {
        max_tokens: 180,
        response_format: candidateBatchResponseFormat(normalized.length - 1),
        messages: [
          { role: "system", content: "Compare one target against a small indexed candidate set. Return JSON only." },
          { role: "user", content: candidateBatchUserContent(image, mimeType, normalized) },
        ],
      },
    });
    const parsed = parseCandidateBatch(response.raw, normalized.length - 1);
    const selectedCandidate = parsed.best_index >= 0 ? normalized[parsed.best_index] : null;
    const result = {
      status: "ok",
      source,
      model,
      ...response,
      ...parsed,
      selectedCandidate: selectedCandidate ? {
        name: selectedCandidate.name,
        work: selectedCandidate.work,
        referenceUrl: selectedCandidate.referenceUrl,
        metadata: selectedCandidate.metadata || null,
      } : null,
    };
    await traceVision(requestId, "external_candidate_batch_comparison_response", result, { force: true });
    return result;
  } catch (error) {
    const result = {
      status: "unavailable",
      source,
      best_index: -1,
      same_character: false,
      confidence: 0,
      evidence: "",
      selectedCandidate: null,
      error: String(error?.message || error),
    };
    await traceVision(requestId, "external_candidate_batch_comparison_response", result, { force: true });
    return result;
  }
}

export async function compareWithExternalReference({
  image,
  mimeType,
  referenceImage,
  referenceMimeType,
  candidate,
  signal,
  requestId,
}) {
  const source = "external candidate visual comparison";
  try {
    const discovery = abortable(signal, 10_000);
    let target;
    try {
      target = await resolveVisionTarget(discovery.signal, requestId);
    } finally {
      discovery.close();
    }
    const normalizedReference = await normalizeVisionBuffer(referenceImage, referenceMimeType);
    const { model, baseUrl } = target;
    await traceVision(requestId, "external_reference_comparison_request", {
      endpoint: `${baseUrl}/v1/chat/completions`,
      model,
      candidate,
      target_sha256: createHash("sha256").update(image).digest("hex"),
      reference_sha256: createHash("sha256").update(normalizedReference.image).digest("hex"),
      reference_mime_type: normalizedReference.mimeType,
    }, { force: true });
    const response = await postVisualComparison({
      requestId,
      baseUrl,
      model,
      signal,
      timeoutMs: 25_000,
      body: {
        max_tokens: 160,
        response_format: confirmationResponseFormat(),
        messages: [
          { role: "system", content: "Pairwise fictional-character design comparison only. Return JSON." },
          {
            role: "user",
            content: confirmationUserContent(
              image,
              mimeType,
              normalizedReference.image,
              "the main target person",
              normalizedReference.mimeType,
            ),
          },
        ],
      },
    });
    const confirmation = parseConfirmation(response.raw);
    const result = { status: "ok", source, model, candidate, ...response, ...confirmation };
    await traceVision(requestId, "external_reference_comparison_response", result, { force: true });
    return result;
  } catch (error) {
    const result = {
      status: "unavailable",
      source,
      candidate,
      same_character: false,
      confidence: 0,
      evidence: "",
      target_position: "",
      error: String(error?.message || error),
    };
    await traceVision(requestId, "external_reference_comparison_response", result, { force: true });
    return result;
  }
}

function isComparisonTimeout(error) {
  return error?.name === "AbortError" || /(?:timed out|aborted)/iu.test(String(error?.message || error));
}

export async function compareWithOfficialAtlases(image, mimeType, signal, requestId, options = {}) {
  const source = "official-reference visual comparison";
  const startedAt = Date.now();
  try {
    const discovery = abortable(signal, 10_000);
    let target;
    try {
      target = await resolveVisionTarget(discovery.signal, requestId);
    } finally {
      discovery.close();
    }
    const { model, baseUrl } = target;
    const atlases = characterAtlases().filter((item) => item.id.endsWith("-face"));
    const targetCrops = await cropVisionTargets(image, mimeType, Array.isArray(options?.targets) ? options.targets : []);
    const contactSheet = await buildTargetContactSheet(targetCrops);
    const comparisonDeadline = Date.now() + VISUAL_COMPARISON_BUDGET_MS;
    const atlasRuns = [];
    const confirmations = [];
    let matches = [];

    await traceVision(requestId, "visual_target_localization", {
      target_count: targetCrops.length,
      targets: targetCrops.map((item) => ({
        target_id: item.target_id,
        type: item.type,
        bbox: item.bbox,
        foreground: item.foreground,
        visibility: item.visibility,
        stable_features: item.stable_features,
        crop_bytes: item.image.length,
        crop_failed: item.crop_failed === true,
      })),
      localization_source: Array.isArray(options?.targets) && options.targets.length ? "toriigate_bbox" : "full_image_fallback",
      contact_sheet: {
        composed: contactSheet.composed,
        target_order: contactSheet.targetOrder,
        image_bytes: contactSheet.image.length,
        image_sha256: createHash("sha256").update(contactSheet.image).digest("hex"),
      },
    }, { force: true });

    for (const atlas of atlases) {
      const remainingMs = comparisonDeadline - Date.now();
      if (remainingMs <= 0) break;
      const cells = atlasCells(atlas);
      const candidateKeys = cells.map((item) => `${atlas.id}:${item.cell}`);
      const atlasImage = await readFile(atlas.path);
      await traceVision(requestId, "visual_reference_atlas_request", {
        atlas_id: atlas.id,
        endpoint: `${baseUrl}/v1/chat/completions`,
        model,
        target_count: targetCrops.length,
        targets: targetCrops.map((item) => ({ target_id: item.target_id, bbox: item.bbox, crop_sha256: createHash("sha256").update(item.image).digest("hex") })),
        atlas_sha256: createHash("sha256").update(atlasImage).digest("hex"),
        candidate_keys: candidateKeys,
        mode: "batched_target_feature_comparison",
        cache_prompt: false,
      }, { force: true });
      try {
        const response = await postVisualComparison({
          requestId,
          baseUrl,
          model,
          signal,
          timeoutMs: Math.min(VISUAL_COMPARISON_REQUEST_TIMEOUT_MS, remainingMs),
          body: {
            max_tokens: 160,
            response_format: batchAtlasResponseFormat(targetCrops.map((item) => item.target_id), candidateKeys),
            messages: [
              { role: "system", content: "Compare target contact-sheet columns with one official face atlas. Return compact JSON only." },
              { role: "user", content: batchAtlasUserContent(targetCrops, contactSheet, atlasImage, atlas, cells) },
            ],
          },
        });
        const parsedResults = parseBatchAtlas(response.raw, targetCrops, atlas, cells);
        const runMatches = acceptedBatchAtlasMatches(parsedResults, atlas.id);
        const run = {
          atlas_id: atlas.id,
          status: "ok",
          ...response,
          target_results: parsedResults.map((item) => ({ ...item, target: undefined })),
          matches: runMatches,
        };
        atlasRuns.push(run);
        confirmations.push(...parsedResults.map((item) => ({
          target_id: item.target_id,
          candidate_id: item.best_id,
          second_candidate_id: item.second_id,
          accepted: runMatches.some((match) => match.id === item.best_id && match.target_instances?.some((targetItem) => targetItem.target_id === item.target_id)),
          best_confidence: item.best_confidence,
          second_confidence: item.second_confidence,
          supporting_features: item.supporting_features,
          conflicting_features: item.conflicting_features,
          reason: item.reason,
          mode: "batched_target_atlas_feature_confirmation",
        })));
        await traceVision(requestId, "visual_reference_atlas_response", run, { force: true });
        if (runMatches.length) {
          matches = runMatches;
          break;
        }
      } catch (error) {
        const run = {
          atlas_id: atlas.id,
          status: "unavailable",
          matches: [],
          error: String(error?.message || error),
          timed_out: isComparisonTimeout(error),
        };
        atlasRuns.push(run);
        await traceVision(requestId, "visual_reference_atlas_response", run, { force: true });
        if (run.timed_out) break;
      }
    }

    const result = {
      status: "ok",
      source,
      model,
      target_sha256: createHash("sha256").update(image).digest("hex"),
      cache_prompt: false,
      comparison_budget_ms: VISUAL_COMPARISON_BUDGET_MS,
      elapsed_ms: Date.now() - startedAt,
      target_count: targetCrops.length,
      atlas_runs: atlasRuns,
      confirmations,
      matches,
    };
    await traceVision(requestId, "visual_reference_comparison", result, { force: true });
    return result;
  } catch (error) {
    const result = { status: "unavailable", source, matches: [], elapsed_ms: Date.now() - startedAt, error: String(error?.message || error) };
    await traceVision(requestId, "visual_reference_comparison", result, { force: true });
    return result;
  }
}

function pathIsInsideRoot(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeAttachmentPathInput(filePath) {
  let value = String(filePath || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Keep the original value for diagnostics.
    }
  }
  return value;
}

function mediaInboundRelativePath(value) {
  const text = String(value || "").trim();
  if (!/^media:\/\/inbound\//i.test(text)) return "";
  let relative = text.replace(/^media:\/\/inbound\//i, "");
  try { relative = decodeURIComponent(relative); } catch {}
  relative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
  if (!relative || path.isAbsolute(relative)) return "";
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return "";
  return normalized;
}

function inboundImageCandidates(filePath) {
  const suppliedPath = normalizeAttachmentPathInput(filePath);
  const mediaRelative = mediaInboundRelativePath(suppliedPath);
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(resolved);
  };

  // OpenClaw offloads images for text-only models as media://inbound/<file>.
  // This is a logical URI, not a Windows path.
  if (mediaRelative) {
    add(path.join(OPENCLAW_HOME, "media", "inbound", mediaRelative));
    add(path.join(OPENCLAW_HOME, "workspace", "media", "inbound", mediaRelative));
  } else if (path.isAbsolute(suppliedPath)) {
    add(suppliedPath);
  } else {
    add(suppliedPath);
    const relative = suppliedPath.replace(/^[.\/\\]+/, "");
    for (const rootDir of INBOUND_DIRS) add(path.join(rootDir, relative));
  }
  return {
    suppliedPath,
    sourceScheme: mediaRelative ? "media_inbound" : "path",
    mediaRelative,
    candidates,
  };
}

function provenanceAllowsPath(filePath, provenance = {}) {
  const supplied = normalizeAttachmentPathInput(filePath);
  const authorized = Array.isArray(provenance.authorizedPaths)
    ? provenance.authorizedPaths
    : [];
  if (!provenance.currentTurn || !authorized.length) return false;
  return authorized.some((item) => normalizeAttachmentPathInput(item) === supplied);
}

async function resolveInboundImagePath(filePath, requestId = "", provenance = {}) {
  const { suppliedPath, sourceScheme, mediaRelative, candidates } = inboundImageCandidates(filePath);
  const attempts = [];

  if (!provenanceAllowsPath(suppliedPath, provenance)) {
    await traceVision(requestId, "image_attachment_path_check", {
      suppliedPath,
      sourceScheme,
      mediaRelative,
      accepted: false,
      reason: "missing_current_turn_media_provenance",
    }, { force: true });
    throw new Error("image attachment lacks current-turn media provenance");
  }

  for (const candidate of candidates) {
    try {
      const canonicalPath = await realpath(candidate);
      const info = await stat(canonicalPath);
      const extension = path.extname(canonicalPath).toLowerCase();
      const acceptedRoot = INBOUND_DIRS.find((rootDir) => pathIsInsideRoot(canonicalPath, rootDir));
      if (!acceptedRoot) {
        attempts.push({ candidate, canonicalPath, accepted: false, reason: "outside_allowed_roots" });
        continue;
      }
      if (!info.isFile()) {
        attempts.push({ candidate, canonicalPath, accepted: false, reason: "not_regular_file" });
        continue;
      }
      if (!INBOUND_IMAGE_EXTENSIONS.has(extension)) {
        attempts.push({ candidate, canonicalPath, accepted: false, reason: "unsupported_image_extension", extension });
        continue;
      }
      if (info.size <= 0 || info.size > INBOUND_IMAGE_MAX_BYTES) {
        attempts.push({ candidate, canonicalPath, accepted: false, reason: "invalid_image_size", bytes: info.size });
        continue;
      }
      const result = {
        suppliedPath,
        sourceScheme,
        mediaRelative,
        resolvedPath: canonicalPath,
        accepted: true,
        acceptedRoot,
        bytes: info.size,
        extension,
        allowedRoots: INBOUND_DIRS,
        attempts,
      };
      await traceVision(requestId, "image_attachment_path_check", result, { force: true });
      return canonicalPath;
    } catch (error) {
      attempts.push({ candidate, accepted: false, reason: "path_unavailable", error: String(error?.message || error) });
    }
  }

  await traceVision(requestId, "image_attachment_path_check", {
    suppliedPath,
    sourceScheme,
    mediaRelative,
    accepted: false,
    allowedRoots: INBOUND_DIRS,
    candidates,
    attempts,
  }, { force: true });
  throw new Error("image attachment path is unavailable");
}

export async function loadInboundImage(imagePath, signal, requestId = "", provenance = {}) {
  if (signal?.aborted) throw signal.reason || new Error("image attachment load aborted");
  const resolvedPath = await resolveInboundImagePath(imagePath, requestId, provenance);
  const mimeType = imageMime(resolvedPath);
  const normalized = await normalizeVisionImage(resolvedPath, mimeType);
  return {
    image: normalized.image,
    mimeType: normalized.mimeType,
    source: resolvedPath,
    media: {
      resolution: "openclaw_inbound_file",
      local_path: resolvedPath,
      filename: path.basename(resolvedPath),
      content_type: normalized.mimeType,
      url: "",
      proxy_url: "",
    },
  };
}

function requireSnowflake(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{17,20}$/.test(text)) throw new Error(`${label} is unavailable`);
  return text;
}

export async function discordBotToken() {
  const config = JSON.parse(await readFile(OPENCLAW_CONFIG, "utf8"));
  const token = String(config?.channels?.discord?.token || "").trim();
  if (!token) throw new Error("Discord attachment access is unavailable");
  return token;
}

export async function loadRepliedDiscordImage(channelId, messageId, signal, requestId) {
  const channel = requireSnowflake(channelId, "channel");
  const message = requireSnowflake(messageId, "reply message");
  const token = await discordBotToken();
  const request = abortable(signal, VISION_TIMEOUT_MS);
  try {
    let resolvedMessageId = message;
    let attachment = null;
    for (let depth = 0; depth < 3; depth += 1) {
      const messageUrl = `https://discord.com/api/v10/channels/${channel}/messages/${resolvedMessageId}`;
      const messageResponse = await fetch(messageUrl, {
        headers: { Authorization: `Bot ${token}` },
        signal: request.signal,
      });
      const payload = await messageResponse.json().catch(() => null);
      await traceVision(requestId, "discord_referenced_message", {
        endpoint: messageUrl,
        http_status: messageResponse.status,
        channel_id: channel,
        requested_message_id: message,
        referenced_message_id: resolvedMessageId,
        reference_depth: depth,
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
      }, { force: !messageResponse.ok });
      if (!messageResponse.ok) throw new Error(`referenced Discord image could not be read (HTTP ${messageResponse.status})`);
      attachment = (payload?.attachments || []).find((item) => /^image\//i.test(String(item?.content_type || "")) || /\.(png|jpe?g|webp|gif)$/i.test(String(item?.filename || "")));
      if (attachment?.url) break;
      const nextMessageId = String(payload?.message_reference?.message_id || "").trim();
      if (!/^\d{17,20}$/.test(nextMessageId) || nextMessageId === resolvedMessageId) break;
      resolvedMessageId = nextMessageId;
    }
    if (!attachment?.url) throw new Error("referenced message has no image attachment");
    const imageResponse = await fetch(attachment.url, { signal: request.signal });
    if (!imageResponse.ok) throw new Error(`referenced image download failed (HTTP ${imageResponse.status})`);
    const downloadedImage = Buffer.from(await imageResponse.arrayBuffer());
    const downloadedMimeType = String(attachment.content_type || imageResponse.headers.get("content-type") || "image/png").split(";")[0];
    const normalized = await normalizeVisionBuffer(downloadedImage, downloadedMimeType);
    const image = normalized.image;
    const mimeType = normalized.mimeType;
    const media = {
      resolution: "discord_referenced_attachment",
      channel_id: channel,
      requested_message_id: message,
      referenced_message_id: resolvedMessageId,
      attachment_id: String(attachment.id || ""),
      filename: String(attachment.filename || ""),
      content_type: mimeType,
      original_content_type: downloadedMimeType,
      url: String(attachment.url || ""),
      proxy_url: String(attachment.proxy_url || ""),
      width: attachment.width,
      height: attachment.height,
      download_http_status: imageResponse.status,
      image_bytes: image.length,
    };
    await traceVision(requestId, "media_resolution", media, { force: true });
    return {
      image,
      mimeType,
      source: attachment.url,
      media,
    };
  } catch (error) {
    await traceVision(requestId, "media_resolution_error", {
      channel_id: channel,
      referenced_message_id: message,
      error: String(error?.message || error),
    }, { force: true });
    throw error;
  } finally {
    request.close();
  }
}

export async function loadRepliedDiscordMedia(channelId, messageId, signal, requestId) {
  const channel = requireSnowflake(channelId, "channel");
  const message = requireSnowflake(messageId, "reply message");
  const token = await discordBotToken();
  const request = abortable(signal, VISION_TIMEOUT_MS);
  try {
    const messageUrl = `https://discord.com/api/v10/channels/${channel}/messages/${message}`;
    const messageResponse = await fetch(messageUrl, {
      headers: { Authorization: `Bot ${token}` },
      signal: request.signal,
    });
    const payload = await messageResponse.json().catch(() => null);
    if (!messageResponse.ok) throw new Error(`referenced Discord attachment could not be read (HTTP ${messageResponse.status})`);
    const attachment = (payload?.attachments || []).find((item) => {
      const type = String(item?.content_type || "").toLowerCase();
      const name = String(item?.filename || "").toLowerCase();
      return /^(?:video|audio)\//.test(type)
        || type === "application/pdf"
        || /^text\//.test(type)
        || /\.(?:mp4|webm|mov|mkv|avi|m4v|mp3|wav|ogg|opus|m4a|flac|aac|pdf|txt|log|md|csv|json|ya?ml|xml)$/i.test(name);
    });
    if (!attachment?.url) throw new Error("referenced message has no supported media attachment");
    const mediaResponse = await fetch(attachment.url, { signal: request.signal });
    if (!mediaResponse.ok) throw new Error(`referenced media download failed (HTTP ${mediaResponse.status})`);
    const data = Buffer.from(await mediaResponse.arrayBuffer());
    return {
      data,
      mimeType: String(attachment.content_type || mediaResponse.headers.get("content-type") || "application/octet-stream").split(";")[0],
      filename: String(attachment.filename || `attachment-${attachment.id || "media"}`),
      source: String(attachment.url || ""),
      media: {
        resolution: "discord_referenced_media_attachment",
        channel_id: channel,
        referenced_message_id: message,
        attachment_id: String(attachment.id || ""),
        filename: String(attachment.filename || ""),
        content_type: String(attachment.content_type || ""),
        url: String(attachment.url || ""),
        bytes: data.length,
      },
    };
  } finally {
    request.close();
  }
}

export const __test = {
  atlasResponseFormat,
  atlasUserContent,
  batchAtlasResponseFormat,
  batchAtlasUserContent,
  buildTargetContactSheet,
  decodeFeatureMask,
  extractCompleteObjectsFromArray,
  confirmationResponseFormat,
  candidateBatchResponseFormat,
  candidateBatchUserContent,
  confirmationUserContent,
  observationLooksTemplate,
  parseAtlasMatches,
  parseBatchAtlas,
  acceptedBatchAtlasMatches,
  parseConfirmation,
  parseCandidateBatch,
  parseObservation,
  rawVisibleText,
  isComparisonTimeout,
  visionBaseUrls,
  inboundImageCandidates,
  resolveInboundImagePath,
  visionResponseFormat,
  visionUserContent,
  normalizedTarget,
  resizeVisionBuffer,
  cropVisionTargets,
  tmpdir,
};

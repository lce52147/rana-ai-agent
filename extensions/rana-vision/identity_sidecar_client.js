import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { traceVision } from "./debug.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(MODULE_DIR, "identity-sidecar.json");
const MAX_TARGETS = 3;
let cachedConfig = null;
let cachedConfigPath = "";

function cleanJsonText(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(endpoint)) throw new Error("identity sidecar endpoint must use http or https");
  return endpoint;
}

export function validateSidecarConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  const endpoint = normalizeEndpoint(config.endpoint);
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) throw new Error("identity sidecar apiKey is missing");
  const timeoutMs = Math.max(1000, Math.min(120000, Number(config.timeoutMs || 30000)));
  const maxTargets = Math.max(1, Math.min(MAX_TARGETS, Number(config.maxTargets || MAX_TARGETS)));
  // Whole-image anime face identity (/v1/identity/faces); older sidecars answer 404/501 and fall back.
  const faces = config.faces !== false;
  // Look again when the face route names nobody: zoom into each unnamed face, or zoom out of a
  // frame with no face (an extreme close-up has a face bigger than the frame). The sidecar's own
  // gate still decides every name. Blind tiers s3301+s5501: B-tier unknown 9 -> 3, wrong 1 -> 1.
  const zoomRetry = config.zoomRetry !== false;
  return { endpoint, apiKey, timeoutMs, maxTargets, faces, zoomRetry };
}

export async function loadSidecarConfig(dependencies = {}) {
  if (dependencies.config) return validateSidecarConfig(dependencies.config);
  const configPath = path.resolve(String(
    dependencies.configPath
      || process.env.RANA_IDENTITY_SIDECAR_CONFIG
      || DEFAULT_CONFIG_PATH,
  ));
  if (cachedConfig && cachedConfigPath === configPath) return cachedConfig;
  const parsed = JSON.parse(cleanJsonText(await readFile(configPath, "utf8")));
  cachedConfig = validateSidecarConfig(parsed);
  cachedConfigPath = configPath;
  return cachedConfig;
}

export function createSidecarDeadline(parentSignal, timeoutMs) {
  return createDeadline(parentSignal, timeoutMs);
}

function createDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parentSignal?.reason || new Error("identity sidecar request aborted"));
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`identity sidecar timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    },
  };
}

function confidenceForDecision(decision, instanceCount = 1) {
  const topSimilarity = Number(decision?.top?.top_similarity || 0);
  const consensus = Number(decision?.top?.consensus_score || 0);
  const margin = Number(decision?.margin || 0);
  const support = Number(decision?.supportCount || 0);
  const strong = topSimilarity >= 0.82 && consensus >= 0.78 && margin >= 0.10 && support >= 2;
  const repeated = instanceCount >= 2 && topSimilarity >= 0.78 && margin >= 0.085;
  const score = strong ? 0.94 : repeated ? 0.91 : 0.86;
  return { confidence: score >= 0.90 ? "high" : "medium", confidence_score: score };
}


function confidenceForAggregate(decision) {
  const aggregate = Number(decision?.top?.aggregate_score || 0);
  const maxSimilarity = Number(decision?.top?.max_similarity || 0);
  const margin = Number(decision?.margin || 0);
  const votes = Number(decision?.top?.winner_votes || 0);
  const strong = aggregate >= 0.78 && maxSimilarity >= 0.82 && margin >= 0.025 && votes >= 2;
  const score = strong ? 0.94 : 0.91;
  return { confidence: "high", confidence_score: score };
}

export function mapSidecarResult(result) {
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  const acceptedTargets = targets.filter((target) =>
    target?.decision?.accepted === true
      && String(target?.decision?.top?.id || "").trim(),
  );
  const groups = new Map();
  for (const target of acceptedTargets) {
    const id = String(target.decision.top.id).trim();
    const group = groups.get(id) || { id, instances: [] };
    group.instances.push({
      target_id: String(target.target_id || ""),
      bbox: target.bbox || null,
      type: String(target.type || "unknown"),
      visibility: target.visibility ?? null,
      top_similarity: Number(target.decision.top.top_similarity || 0),
      consensus_score: Number(target.decision.top.consensus_score || 0),
      margin: Number(target.decision.margin || 0),
      support_count: Number(target.decision.supportCount || 0),
    });
    groups.set(id, group);
  }

  const aggregateDecision = result?.aggregate_decision && typeof result.aggregate_decision === "object"
    ? result.aggregate_decision
    : null;
  const aggregateId = String(aggregateDecision?.top?.id || "").trim();
  const acceptedTargetIds = new Set(acceptedTargets.map((target) => String(target?.decision?.top?.id || "").trim()).filter(Boolean));
  const aggregateConflict = aggregateId && acceptedTargetIds.size > 0 && !acceptedTargetIds.has(aggregateId);
  if (aggregateDecision?.accepted === true && aggregateId && !aggregateConflict) {
    const group = groups.get(aggregateId) || { id: aggregateId, instances: [] };
    group.aggregate = {
      aggregate_score: Number(aggregateDecision.top.aggregate_score || 0),
      max_similarity: Number(aggregateDecision.top.max_similarity || 0),
      margin: Number(aggregateDecision.margin || 0),
      winner_votes: Number(aggregateDecision.top.winner_votes || 0),
      support_views: Number(aggregateDecision.top.support_views || 0),
      target_ids: Array.isArray(aggregateDecision.top.target_ids)
        ? aggregateDecision.top.target_ids.map((item) => String(item || "")).filter(Boolean)
        : [],
      view_scores: Array.isArray(aggregateDecision.top.view_scores)
        ? aggregateDecision.top.view_scores
        : [],
    };
    groups.set(aggregateId, group);
  }

  const accepted = [...groups.values()].map((group) => {
    const strongest = [...group.instances].sort((a, b) =>
      (b.consensus_score + b.margin) - (a.consensus_score + a.margin),
    )[0] || null;
    if (group.aggregate) {
      return {
        id: group.id,
        ...confidenceForAggregate({ top: group.aggregate, margin: group.aggregate.margin }),
        evidence: "remote_clip_multiview_open_set_accept",
        instance_count: Math.max(group.instances.length, group.aggregate.target_ids.length),
        target_ids: [...new Set([
          ...group.instances.map((item) => item.target_id).filter(Boolean),
          ...group.aggregate.target_ids,
        ])],
        instances: group.instances,
        aggregate: group.aggregate,
      };
    }
    return {
      id: group.id,
      ...confidenceForDecision({
        top: {
          top_similarity: strongest.top_similarity,
          consensus_score: strongest.consensus_score,
        },
        margin: strongest.margin,
        supportCount: strongest.support_count,
      }, group.instances.length),
      evidence: "remote_clip_embedding_open_set_accept",
      instance_count: group.instances.length,
      target_ids: group.instances.map((item) => item.target_id).filter(Boolean),
      instances: group.instances,
    };
  }).sort((a, b) => b.confidence_score - a.confidence_score);

  return {
    status: String(result?.status || "ok"),
    source: String(result?.source || "clip_cpu_sidecar"),
    model: result?.model || null,
    dtype: result?.dtype || null,
    threads: Number(result?.threads || 0),
    elapsed_ms: Number(result?.elapsed_ms || 0),
    target_count: Number(result?.target_count || targets.length),
    accepted,
    primary: accepted[0] || null,
    targets,
    aggregate_decision: aggregateDecision,
    aggregate_conflict: aggregateConflict,
    rejected_count: targets.length - acceptedTargets.length,
  };
}

// /v1/identity/faces returns one open-set decision per detected face, biggest face first.
export function mapFaceResult(result) {
  const faces = Array.isArray(result?.faces) ? result.faces : [];
  const groups = new Map();
  for (const face of faces) {
    const id = String(face?.decision?.id || "").trim();
    if (face?.decision?.accepted !== true || !id) continue;
    const group = groups.get(id) || { id, instances: [] };
    group.instances.push({
      target_id: String(face.face_id || ""),
      bbox: face.bbox || null,
      type: face.kind === "whole_frame" ? "whole_frame" : "face",
      score: Number(face.score || 0),
      distance: Number(face.decision.distance),
      margin: Number(face.decision.margin),
      zoom: face.decision.zoom || null,
    });
    groups.set(id, group);
  }
  const accepted = [...groups.values()].map((group) => ({
    id: group.id,
    confidence: "high",
    confidence_score: 0.94,
    evidence: "ccip_face_open_set_accept",
    instance_count: group.instances.length,
    target_ids: group.instances.map((item) => item.target_id).filter(Boolean),
    instances: group.instances,
  }));
  return {
    status: String(result?.status || "ok"),
    source: String(result?.source || "ccip_face_sidecar"),
    model: result?.model || null,
    bank: result?.bank || null,
    elapsed_ms: Number(result?.elapsed_ms || 0),
    target_count: faces.length,
    accepted,
    primary: accepted[0] || null,
    targets: faces,
    aggregate_decision: null,
    aggregate_conflict: false,
    rejected_count: faces.filter((face) => face?.decision?.accepted !== true).length,
  };
}

async function postFaces({ image, mimeType, config, fetchImpl, signal, requestId, startedAt, view = "frame" }) {
  const endpoint = `${config.endpoint}/v1/identity/faces`;
  const deadline = createDeadline(signal, config.timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId || "", mime_type: mimeType || "image/jpeg", data_base64: image.toString("base64") }),
      signal: deadline.signal,
    });
    const parsed = await response.json().catch(() => ({}));
    await traceVision(requestId, "identity_faces_response", {
      endpoint,
      view,
      http_status: response.status,
      ok: response.ok,
      body: sanitizeSidecarTrace(parsed),
      elapsed_ms: Date.now() - startedAt,
    });
    return response.ok ? parsed : null;
  } catch (error) {
    await traceVision(requestId, "identity_faces_unavailable", { endpoint, view, error: String(error?.message || error) }).catch(() => {});
    return null;
  } finally {
    deadline.close();
  }
}

const ZOOM_EDGE = 960;
const ZOOM_OUT_SCALES = [0.6, 0.4];
const MAX_ZOOM_FACES = 3;
const execFileAsync = promisify(execFile);

// view.kind "in": crop view.box (pixels) and scale its long edge to ZOOM_EDGE.
// view.kind "out": shrink the frame by view.scale onto a grey canvas of the original size.
async function ffmpegZoom(image, view) {
  const inputPath = path.join(tmpdir(), `rana-vision-zoom-src-${randomUUID()}`);
  const outputPath = path.join(tmpdir(), `rana-vision-zoom-${randomUUID()}.jpg`);
  const filter = view.kind === "in"
    ? `crop=${view.box[2] - view.box[0]}:${view.box[3] - view.box[1]}:${view.box[0]}:${view.box[1]},`
      + `scale=${ZOOM_EDGE}:${ZOOM_EDGE}:force_original_aspect_ratio=decrease:flags=lanczos`
    : `scale=${view.inner[0]}:${view.inner[1]}:flags=lanczos,`
      + `pad=${view.size[0]}:${view.size[1]}:${view.offset[0]}:${view.offset[1]}:color=0x808080`;
  await writeFile(inputPath, image);
  try {
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", inputPath, "-vf", filter, "-frames:v", "1", "-q:v", "2", outputPath], { windowsHide: true });
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function boxIou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = ((a[2] - a[0]) * (a[3] - a[1])) + ((b[2] - b[0]) * (b[3] - b[1])) - (w * h);
  return union > 0 ? (w * h) / union : 0;
}

export function zoomInView(box, width, height) {
  const side = Math.max(box[2] - box[0], box[3] - box[1]) * 1.25;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const crop = [
    Math.max(0, Math.trunc(cx - side)), Math.max(0, Math.trunc(cy - side)),
    Math.min(width, Math.trunc(cx + side)), Math.min(height, Math.trunc(cy + side)),
  ];
  const k = ZOOM_EDGE / Math.max(crop[2] - crop[0], crop[3] - crop[1]);
  return { kind: "in", box: crop, toOriginal: (b) => [crop[0] + (b[0] / k), crop[1] + (b[1] / k), crop[0] + (b[2] / k), crop[1] + (b[3] / k)] };
}

export function zoomOutView(scale, width, height) {
  const inner = [Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale))];
  const offset = [Math.trunc((width - inner[0]) / 2), Math.trunc((height - inner[1]) / 2)];
  return { kind: "out", scale, size: [width, height], inner, offset };
}

function acceptedFaces(result) {
  return (Array.isArray(result?.faces) ? result.faces : [])
    .filter((face) => face?.kind !== "whole_frame" && face?.decision?.accepted === true && face.decision.id);
}

// Returns the face list with zoom-confirmed names filled in; never changes an accepted face.
export async function applyZoomRetry(result, { image, mimeType, config, fetchImpl, signal, requestId, startedAt, zoomImage = ffmpegZoom }) {
  const faces = Array.isArray(result?.faces) ? result.faces : [];
  const width = Number(result?.image?.width);
  const height = Number(result?.image?.height);
  if (!config.zoomRetry || !faces.length || !(width > 0 && height > 0)) return result;
  const ask = async (view, label) => {
    try {
      const zoomed = await zoomImage(image, view);
      return await postFaces({ image: zoomed, mimeType: "image/jpeg", config, fetchImpl, signal, requestId, startedAt, view: label });
    } catch (error) {
      await traceVision(requestId, "identity_zoom_failed", { view: label, error: String(error?.message || error) }).catch(() => {});
      return null;
    }
  };
  const next = faces.map((face) => ({ ...face }));
  const realFaces = next.filter((face) => face.kind !== "whole_frame");
  if (realFaces.length) {
    for (const face of realFaces.filter((item) => item?.decision?.accepted !== true && Array.isArray(item.box)).slice(0, MAX_ZOOM_FACES)) {
      const view = zoomInView(face.box, width, height);
      const zoomed = await ask(view, `in:${face.face_id}`);
      const ids = new Set(acceptedFaces(zoomed)
        .filter((hit) => Array.isArray(hit.box) && boxIou(view.toOriginal(hit.box), face.box) > 0.4)
        .map((hit) => hit.decision.id));
      if (ids.size !== 1) continue;
      const hit = acceptedFaces(zoomed).find((item) => ids.has(item.decision.id));
      face.decision = { ...hit.decision, reasons: [], zoom: "in", base_decision: face.decision };
    }
  } else {
    const whole = next.find((face) => face.kind === "whole_frame");
    if (whole && whole.decision?.accepted !== true) {
      for (const scale of ZOOM_OUT_SCALES) {
        const zoomed = await ask(zoomOutView(scale, width, height), `out:${scale}`);
        const ids = new Set(acceptedFaces(zoomed).map((hit) => hit.decision.id));
        if (ids.size !== 1) continue;
        const hit = acceptedFaces(zoomed)[0];
        whole.decision = { ...hit.decision, reasons: [], zoom: `out:${scale}`, base_decision: whole.decision };
        break;
      }
    }
  }
  const changed = next.filter((face, i) => face.decision !== faces[i].decision)
    .map((face) => ({ face_id: face.face_id, id: face.decision.id, distance: face.decision.distance, zoom: face.decision.zoom }));
  await traceVision(requestId, "identity_zoom_retry", { changed, elapsed_ms: Date.now() - startedAt }).catch(() => {});
  return { ...result, faces: next };
}

async function retrieveFaceIdentity({ image, mimeType, config, fetchImpl, signal, requestId, startedAt, zoomImage }) {
  const parsed = await postFaces({ image, mimeType, config, fetchImpl, signal, requestId, startedAt });
  if (!parsed) return null;
  const looked = await applyZoomRetry(parsed, { image, mimeType, config, fetchImpl, signal, requestId, startedAt, zoomImage });
  return mapFaceResult(looked);
}

// The sidecar aggregates views of ONE target per request and rejects a request
// whose images name more than one parent. Face/upper/full views (F1-F3) share
// their source target, or the whole image for the fallback views.
function cropParentId(target) {
  if (target?.source_target_id) return String(target.source_target_id);
  if (/^fallback_/u.test(String(target?.type || ""))) return "image";
  return String(target?.target_id || "");
}

function groupCropsByParent(crops) {
  const groups = new Map();
  for (const crop of crops) {
    const parent = cropParentId(crop);
    groups.set(parent, [...(groups.get(parent) || []), crop]);
  }
  return [...groups.entries()].map(([parent, items]) => ({ parent, items }));
}

function mergeSidecarResponses(responses) {
  if (responses.length === 1) return responses[0];
  const first = responses[0] || {};
  return {
    ...first,
    status: responses.every((item) => item?.status === "ok") ? "ok" : String(responses.find((item) => item?.status !== "ok")?.status || "partial"),
    elapsed_ms: Math.max(...responses.map((item) => Number(item?.elapsed_ms || 0))),
    target_count: responses.reduce((sum, item) => sum + Number(item?.target_count || item?.targets?.length || 0), 0),
    targets: responses.flatMap((item) => Array.isArray(item?.targets) ? item.targets : []),
    // Per-parent aggregates describe different people; never merge them.
    aggregate_decision: null,
  };
}

function summarizeCrop(target) {
  const image = Buffer.isBuffer(target?.image) ? target.image : Buffer.from(target?.image || []);
  return {
    target_id: String(target?.target_id || ""),
    bbox: target?.bbox || null,
    type: String(target?.type || "unknown"),
    visibility: target?.visibility ?? null,
    crop_failed: target?.crop_failed === true,
    mime_type: String(target?.mimeType || "image/jpeg"),
    image_bytes: image.length,
    image_sha256: image.length ? createHash("sha256").update(image).digest("hex") : "",
  };
}

function sanitizeSidecarTrace(value) {
  if (Array.isArray(value)) return value.map(sanitizeSidecarTrace);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:data_base64|api_?key|authorization)$/i.test(key)) {
      result[key] = "[omitted]";
      continue;
    }
    result[key] = sanitizeSidecarTrace(item);
  }
  return result;
}

export async function checkIdentitySidecar(dependencies = {}) {
  const config = await loadSidecarConfig(dependencies);
  const fetchImpl = dependencies.fetch || fetch;
  const deadline = createDeadline(dependencies.signal, Math.min(config.timeoutMs, 5000));
  try {
    const response = await fetchImpl(`${config.endpoint}/health`, { signal: deadline.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`identity sidecar health HTTP ${response.status}`);
    return body;
  } finally {
    deadline.close();
  }
}

export async function retrieveLocalIdentity({ image, mimeType, targets = [], signal, requestId, dependencies = {} }) {
  const startedAt = Date.now();
  try {
    const config = await loadSidecarConfig(dependencies);
    const fetchImpl = dependencies.fetch || fetch;
    if (config.faces) {
      const faceResult = await retrieveFaceIdentity({ image, mimeType, config, fetchImpl, signal, requestId, startedAt, zoomImage: dependencies.zoomImage });
      // No face found (plush, photo, object) and no whole-frame match: fall through to the CLIP target crops.
      const faceFound = faceResult?.targets?.some((face) => face?.kind !== "whole_frame");
      if (faceResult && (faceFound || faceResult.accepted.length)) {
        faceResult.round_trip_ms = Date.now() - startedAt;
        await traceVision(requestId, "identity_sidecar_result", {
          status: faceResult.status,
          source: faceResult.source,
          target_count: faceResult.target_count,
          accepted: faceResult.accepted,
          rejected_count: faceResult.rejected_count,
          sidecar_elapsed_ms: faceResult.elapsed_ms,
          round_trip_ms: faceResult.round_trip_ms,
        }, { force: true });
        return faceResult;
      }
    }
    const cropper = dependencies.extractTargets || (await import("./client.js")).extractVisionTargets;
    const crops = (await cropper(image, mimeType, targets)).slice(0, config.maxTargets);
    const cropSummaries = crops.map(summarizeCrop);
    await traceVision(requestId, "identity_crop_batch", {
      input_target_count: Array.isArray(targets) ? targets.length : 0,
      output_crop_count: crops.length,
      max_targets: config.maxTargets,
      crops: cropSummaries,
    });
    const groups = groupCropsByParent(crops);
    const requestBodies = groups.map((group) => ({
      request_id: requestId || "",
      images: group.items.map((target) => ({
        target_id: target.target_id,
        parent_target_id: group.parent,
        bbox: target.bbox || null,
        type: target.type || "unknown",
        visibility: target.visibility ?? null,
        mime_type: target.mimeType || "image/jpeg",
        data_base64: target.image.toString("base64"),
      })),
    }));
    const endpoint = `${config.endpoint}/v1/identity/retrieve`;
    await traceVision(requestId, "identity_sidecar_request", {
      endpoint,
      timeout_ms: config.timeoutMs,
      request_id: requestId || "",
      target_count: crops.length,
      parent_groups: groups.map((group) => ({ parent: group.parent, target_ids: group.items.map((item) => item.target_id) })),
      targets: cropSummaries,
    });
    const deadline = createDeadline(signal, config.timeoutMs);
    try {
      const responses = await Promise.all(requestBodies.map(async (requestBody) => {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: deadline.signal,
        });
        const raw = await response.text();
        let parsed = {};
        let parseError = "";
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (error) { parseError = String(error?.message || error); }
        await traceVision(requestId, "identity_sidecar_response", {
          endpoint,
          parent_target_id: requestBody.images[0]?.parent_target_id || "",
          http_status: response.status,
          ok: response.ok,
          parse_error: parseError || null,
          body: parseError ? { raw: raw.slice(0, 8192), raw_truncated: raw.length > 8192 } : sanitizeSidecarTrace(parsed),
          elapsed_ms: Date.now() - startedAt,
        });
        if (!response.ok) throw new Error(String(parsed?.error || raw || `identity sidecar HTTP ${response.status}`));
        return parsed;
      }));
      const mapped = mapSidecarResult(mergeSidecarResponses(responses));
      mapped.round_trip_ms = Date.now() - startedAt;
      await traceVision(requestId, "identity_sidecar_result", {
        status: mapped.status,
        source: mapped.source,
        target_count: mapped.target_count,
        accepted: mapped.accepted,
        aggregate_decision: mapped.aggregate_decision,
        aggregate_conflict: mapped.aggregate_conflict,
        rejected_count: mapped.rejected_count,
        sidecar_elapsed_ms: mapped.elapsed_ms,
        round_trip_ms: mapped.round_trip_ms,
      }, { force: true });
      return mapped;
    } finally {
      deadline.close();
    }
  } catch (error) {
    const unavailable = {
      status: "unavailable",
      source: "remote_clip_sidecar",
      accepted: [],
      primary: null,
      targets: [],
      elapsed_ms: Date.now() - startedAt,
      error: String(error?.message || error),
    };
    await traceVision(requestId, "identity_sidecar_unavailable", {
      status: unavailable.status,
      error: unavailable.error,
      elapsed_ms: unavailable.elapsed_ms,
    }, { force: true }).catch(() => {});
    return unavailable;
  }
}

export const __test = {
  cropParentId,
  groupCropsByParent,
  mergeSidecarResponses,
  confidenceForAggregate,
  confidenceForDecision,
  mapSidecarResult,
  mapFaceResult,
  normalizeEndpoint,
  sanitizeSidecarTrace,
  summarizeCrop,
  validateSidecarConfig,
};

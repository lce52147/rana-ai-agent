import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  return { endpoint, apiKey, timeoutMs, maxTargets };
}

async function loadSidecarConfig(dependencies = {}) {
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
    const cropper = dependencies.extractTargets || (await import("./client.js")).extractVisionTargets;
    const fetchImpl = dependencies.fetch || fetch;
    const crops = (await cropper(image, mimeType, targets)).slice(0, config.maxTargets);
    const cropSummaries = crops.map(summarizeCrop);
    await traceVision(requestId, "identity_crop_batch", {
      input_target_count: Array.isArray(targets) ? targets.length : 0,
      output_crop_count: crops.length,
      max_targets: config.maxTargets,
      crops: cropSummaries,
    });
    const requestBody = {
      request_id: requestId || "",
      images: crops.map((target) => ({
        target_id: target.target_id,
        bbox: target.bbox || null,
        type: target.type || "unknown",
        visibility: target.visibility ?? null,
        mime_type: target.mimeType || "image/jpeg",
        data_base64: target.image.toString("base64"),
      })),
    };
    const endpoint = `${config.endpoint}/v1/identity/retrieve`;
    await traceVision(requestId, "identity_sidecar_request", {
      endpoint,
      timeout_ms: config.timeoutMs,
      request_id: requestId || "",
      target_count: crops.length,
      targets: cropSummaries,
    });
    const deadline = createDeadline(signal, config.timeoutMs);
    try {
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
        http_status: response.status,
        ok: response.ok,
        parse_error: parseError || null,
        body: parseError ? { raw: raw.slice(0, 8192), raw_truncated: raw.length > 8192 } : sanitizeSidecarTrace(parsed),
        elapsed_ms: Date.now() - startedAt,
      });
      if (!response.ok) throw new Error(String(parsed?.error || raw || `identity sidecar HTTP ${response.status}`));
      const mapped = mapSidecarResult(parsed);
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
  confidenceForAggregate,
  confidenceForDecision,
  mapSidecarResult,
  normalizeEndpoint,
  sanitizeSidecarTrace,
  summarizeCrop,
  validateSidecarConfig,
};

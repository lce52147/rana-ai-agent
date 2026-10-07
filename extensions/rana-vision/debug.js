import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEBUG_DIR = "C:\\tmp\\rana-vision-debug";
const IDENTITY_TRACE_DIR = "C:\\tmp\\rana-vision-identity-trace";
const IDENTITY_TRACE_KEEP_FILES = 12;

const CORE_TRACE_STAGES = new Set([
  "image_request_resolved",
  "media_resolution",
  "media_resolution_error",
  "search_policy",
  "vision_queue_start",
  "vision_queue_end",
  "vision_pipeline_error",
  "vision_result_summary",
  "ocr_result_summary",
  "reverse_search_summary",
  "work_confidence_gate",
  "identity_sidecar_result",
  "identity_sidecar_unavailable",
  "local_first_confidence_gate",
  "canonical_identity_conflict",
  "deep_search_started",
  "work_hypotheses",
  "anilist_character_search",
  "anilist_candidate_batch_comparison",
  "deep_search_web_query",
  "character_candidate_search",
  "deep_search_short_circuit",
  "deep_search_resolution",
  "identity_resolution",
  "vision_persona_evidence",
  "vision_persona_followup",
  "oogg_persona_prepend_context",
  "oogg_raw_output",
  "oogg_output_before_message_write",
  "oogg_output_message_sending",
  "discord_final_output",
]);

const IDENTITY_TRACE_STAGES = new Set([
  "image_request_resolved",
  "media_resolution",
  "media_resolution_error",
  "vision_pipeline_error",
  "toriigate_identity_observation",
  "vision_result_summary",
  "identity_crop_batch",
  "identity_sidecar_request",
  "identity_sidecar_response",
  "identity_sidecar_result",
  "identity_sidecar_unavailable",
  "reverse_search_summary",
  "work_confidence_gate",
  "deep_search_started",
  "work_hypotheses",
  "anilist_character_search",
  "external_candidate_batch_comparison_request",
  "external_candidate_batch_comparison_response",
  "anilist_candidate_batch_comparison",
  "deep_search_resolution",
  "identity_resolver_input",
  "identity_resolver_output",
  "local_first_confidence_gate",
  "identity_resolution",
  "final_identity_payload",
  "vision_persona_evidence",
  "vision_persona_followup",
  "oogg_persona_prepend_context",
  "oogg_raw_output",
  "discord_final_output",
]);

export function visionTraceMode(env = process.env) {
  const explicitMode = String(env.RANA_VISION_TRACE_MODE || "").trim().toLowerCase();
  if (["off", "identity", "core", "full"].includes(explicitMode)) return explicitMode;
  if (env.RANA_VISION_IDENTITY_TRACE === "1") return "identity";
  if (env.RANA_VISION_TRACE === "1" || env.RANA_VISION_DEBUG === "1") return "full";
  return "off";
}

export function visionDebugEnabled(env = process.env) {
  return visionTraceMode(env) !== "off";
}

export function shouldTraceStage(stage, env = process.env) {
  const mode = visionTraceMode(env);
  if (mode === "full") return true;
  if (mode === "identity") return IDENTITY_TRACE_STAGES.has(String(stage || ""));
  if (mode === "core") return CORE_TRACE_STAGES.has(String(stage || ""));
  return false;
}

function traceDirectory(env = process.env) {
  return visionTraceMode(env) === "identity" ? IDENTITY_TRACE_DIR : DEBUG_DIR;
}

async function pruneIdentityTraces(directory) {
  if (directory !== IDENTITY_TRACE_DIR) return;
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const info = await stat(filePath);
        return { filePath, mtimeMs: info.mtimeMs };
      }));
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(files.slice(IDENTITY_TRACE_KEEP_FILES).map((item) => unlink(item.filePath).catch(() => {})));
  } catch {
    // Trace rotation must never affect the production request.
  }
}

export function createVisionRequestId() {
  return randomUUID();
}

export async function traceVision(requestId, stage, data, options = {}) {
  // `force` remains call-site compatible but cannot bypass the selected mode.
  if (!requestId || !shouldTraceStage(stage)) return;
  const directory = traceDirectory();
  await mkdir(directory, { recursive: true });
  const record = { timestamp: new Date().toISOString(), request_id: requestId, stage, data };
  await appendFile(path.join(directory, `${requestId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  if (directory === IDENTITY_TRACE_DIR && stage === "image_request_resolved") {
    await pruneIdentityTraces(directory);
  }
}

export const __test = {
  CORE_TRACE_STAGES,
  DEBUG_DIR,
  IDENTITY_TRACE_DIR,
  IDENTITY_TRACE_KEEP_FILES,
  IDENTITY_TRACE_STAGES,
  shouldTraceStage,
  traceDirectory,
  visionTraceMode,
};

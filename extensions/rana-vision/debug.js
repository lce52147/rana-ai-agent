import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEBUG_DIR = "C:\\tmp\\rana-vision-debug";

export function visionDebugEnabled() {
  return process.env.RANA_VISION_TRACE !== "0" || process.env.RANA_VISION_DEBUG === "1";
}

export function createVisionRequestId() {
  return randomUUID();
}

export async function traceVision(requestId, stage, data, options = {}) {
  if ((!visionDebugEnabled() && !options.force) || !requestId) return;
  await mkdir(DEBUG_DIR, { recursive: true });
  const record = { timestamp: new Date().toISOString(), request_id: requestId, stage, data };
  await appendFile(path.join(DEBUG_DIR, `${requestId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

export const __test = { DEBUG_DIR };

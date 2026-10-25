import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TURN_PLAN_VERSION } from "./turn_plan.js";

export const GENERATION_TRACE_SCHEMA = 2;
export const GENERATION_TRACE_BUILD = "RANA_RUNTIME_TRACE_V2_4_0_OBSERVABILITY";

const BOOT_TS = new Date();
const BOOT_ID = `${BOOT_TS.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const TRACE_DIR = path.join(
  process.env.TEMP || process.env.TMP || process.cwd(),
  "rana-runtime-trace",
);
const TRACE_FILE = path.join(
  TRACE_DIR,
  `generation-${BOOT_TS.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}-PID${process.pid}-${BOOT_ID.slice(-8)}.jsonl`,
);
const LATEST_POINTER = path.join(TRACE_DIR, "LATEST.txt");

let initialized = false;
let seq = 0;

function personaIdFrom(record = {}) {
  const explicit = String(record?.personaId || record?.agentId || "").trim();
  if (explicit) return explicit;
  const sessionKey = String(record?.sessionKey || "").trim();
  const match = sessionKey.match(/^agent:([^:]+):/u);
  return match?.[1] || "";
}

function sanitizeTraceValue(value, ancestors = new WeakSet()) {
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => sanitizeTraceValue(item, ancestors));
  } else {
    out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizeTraceValue(item, ancestors);
    }
  }
  ancestors.delete(value);
  return out;
}

function safeJsonStringify(value) {
  return JSON.stringify(sanitizeTraceValue(value));
}

const DELIVERY_CORRELATION_TTL_MS = 2 * 60 * 1000;
const DELIVERY_CORRELATION_MAX_PER_SESSION = 16;
const pendingDeliveryBySession = new Map();

function prunePendingDelivery(now = Date.now()) {
  for (const [sessionKey, queue] of pendingDeliveryBySession.entries()) {
    const kept = queue.filter((item) => now - item.createdAt <= DELIVERY_CORRELATION_TTL_MS);
    if (kept.length) pendingDeliveryBySession.set(sessionKey, kept);
    else pendingDeliveryBySession.delete(sessionKey);
  }
}

export function rememberPendingTraceCandidate(record = {}) {
  const sessionKey = String(record?.sessionKey || "").trim();
  const runId = String(record?.runId || "").trim();
  if (!sessionKey || !runId) return false;
  prunePendingDelivery();
  const queue = pendingDeliveryBySession.get(sessionKey) || [];
  queue.push({
    runId,
    rawCandidate: String(record?.candidate || "").trim(),
    createdAt: Date.now(),
  });
  if (queue.length > DELIVERY_CORRELATION_MAX_PER_SESSION) {
    queue.splice(0, queue.length - DELIVERY_CORRELATION_MAX_PER_SESSION);
  }
  pendingDeliveryBySession.set(sessionKey, queue);
  return true;
}

export function correlateDeliveredTrace(record = {}) {
  const sessionKey = String(record?.sessionKey || "").trim();
  const deliveredText = String(record?.deliveredText || "").trim();
  const directRunId = String(record?.runId || "").trim();
  if (directRunId) {
    let rawCandidate = "";
    if (sessionKey) {
      prunePendingDelivery();
      const queue = pendingDeliveryBySession.get(sessionKey) || [];
      const index = queue.findIndex((item) => item.runId === directRunId);
      if (index >= 0) {
        const [matched] = queue.splice(index, 1);
        rawCandidate = matched?.rawCandidate || "";
        if (queue.length) pendingDeliveryBySession.set(sessionKey, queue);
        else pendingDeliveryBySession.delete(sessionKey);
      }
    }
    return { runId: directRunId, correlation: "event_run_id", rawCandidate };
  }
  if (!sessionKey) return { runId: "", correlation: "unmatched", rawCandidate: "" };

  prunePendingDelivery();
  const queue = pendingDeliveryBySession.get(sessionKey) || [];
  if (!queue.length) return { runId: "", correlation: "unmatched", rawCandidate: "" };

  let index = deliveredText
    ? queue.findIndex((item) => item.rawCandidate && item.rawCandidate === deliveredText)
    : -1;
  let correlation = "exact_text";
  if (index < 0) {
    index = 0;
    correlation = "session_fifo";
  }
  const [matched] = queue.splice(index, 1);
  if (queue.length) pendingDeliveryBySession.set(sessionKey, queue);
  else pendingDeliveryBySession.delete(sessionKey);
  return {
    runId: matched?.runId || "",
    correlation,
    rawCandidate: matched?.rawCandidate || "",
  };
}

export function clearPendingTraceRun(record = {}) {
  const sessionKey = String(record?.sessionKey || "").trim();
  const runId = String(record?.runId || "").trim();
  if (!sessionKey || !runId) return false;
  const queue = pendingDeliveryBySession.get(sessionKey) || [];
  const kept = queue.filter((item) => item.runId !== runId);
  if (kept.length === queue.length) return false;
  if (kept.length) pendingDeliveryBySession.set(sessionKey, kept);
  else pendingDeliveryBySession.delete(sessionKey);
  return true;
}

function baseRecord(record = {}) {
  const sessionKey = String(record?.sessionKey || "");
  const personaId = personaIdFrom(record);
  return {
    ts: new Date().toISOString(),
    traceSchema: GENERATION_TRACE_SCHEMA,
    runtimeVersion: TURN_PLAN_VERSION,
    traceBuild: GENERATION_TRACE_BUILD,
    bootId: BOOT_ID,
    pid: process.pid,
    seq: ++seq,
    ...(personaId ? { personaId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...record,
  };
}

export function initializeGenerationTrace() {
  if (initialized) return getGenerationTraceInfo();
  initialized = true;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    fs.writeFileSync(LATEST_POINTER, TRACE_FILE + "\n", "utf8");
    const start = baseRecord({
      phase: "runtime_trace_start",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      tracePath: TRACE_FILE,
    });
    fs.appendFileSync(TRACE_FILE, safeJsonStringify(start) + "\n", "utf8");
  } catch {
    // Observe-only diagnostics must never affect runtime behavior.
  }
  return getGenerationTraceInfo();
}

export function writeGenerationTrace(record = {}) {
  initializeGenerationTrace();
  try {
    fs.appendFileSync(
      TRACE_FILE,
      safeJsonStringify(baseRecord(record)) + "\n",
      "utf8",
    );
  } catch {
    // Observe-only diagnostics must never affect generation or delivery.
  }
}

export function getGenerationTraceInfo() {
  return {
    traceSchema: GENERATION_TRACE_SCHEMA,
    runtimeVersion: TURN_PLAN_VERSION,
    traceBuild: GENERATION_TRACE_BUILD,
    bootId: BOOT_ID,
    pid: process.pid,
    traceDir: TRACE_DIR,
    tracePath: TRACE_FILE,
    latestPointer: LATEST_POINTER,
  };
}

// Lazy initialization: import-only CLI/eval processes must not create a one-line trace or overwrite LATEST.txt.
// The first real runtime trace event calls writeGenerationTrace(), which emits runtime_trace_start first.

import { timingSafeEqual } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configure,
  embedBatch,
  expiredEmbeddingBatch,
  expiredRetrieve,
  identityIndexSnapshot,
  prewarm,
  retrieve,
  resetRuntime,
  currentIndexDescriptor,
  versions,
} from "./identity-engine.mjs";
import { createJobPool } from "./job-pool.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(APP_DIR);
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configPath = configArg ? configArg.slice("--config=".length) : path.join(ROOT_DIR, "config.json");
const rawConfig = JSON.parse(await readFile(configPath, "utf8"));
const threads = Math.max(1, Math.min(os.cpus().length, Number(rawConfig.threads || os.cpus().length)));
const config = {
  ...rawConfig,
  threads,
  modelCacheDir: path.resolve(ROOT_DIR, rawConfig.modelCacheDir || "cache/models"),
  modelPath: path.resolve(ROOT_DIR, rawConfig.modelPath || "models/clip-vit-base-patch32"),
  modelVersion: String(rawConfig.modelVersion || rawConfig.modelRevision || rawConfig.model || "unknown"),
  cacheDir: path.resolve(ROOT_DIR, rawConfig.cacheDir || "cache"),
  bankCachePath: path.resolve(ROOT_DIR, rawConfig.bankCachePath || "cache/reference-bank.json"),
  indexMetadataPath: path.resolve(ROOT_DIR, rawConfig.indexMetadataPath || "references/identity-index-metadata.json"),
  maxBodyBytes: Number(rawConfig.maxBodyBytes || 32 * 1024 * 1024),
  maxImageBytes: Number(rawConfig.maxImageBytes || 8 * 1024 * 1024),
  maxTargets: Math.max(1, Math.min(8, Number(rawConfig.maxTargets || 8))),
  maxEmbeddingBatchItems: Math.max(1, Math.min(64, Number(rawConfig.maxEmbeddingBatchItems || 24))),
  topK: Math.max(1, Math.min(12, Number(rawConfig.topK || 8))),
  embeddingConcurrency: Math.max(1, Math.min(4, Number(rawConfig.embeddingConcurrency || 2))),
  maxConcurrentJobs: Math.max(1, Math.min(4, Number(rawConfig.maxConcurrentJobs || 2))),
  maxQueuedJobs: Math.max(1, Math.min(32, Number(rawConfig.maxQueuedJobs || 8))),
};
configure(config);
await mkdir(path.join(ROOT_DIR, "logs"), { recursive: true });
const logPath = path.join(ROOT_DIR, "logs", "sidecar.jsonl");

let ready = false;
let loading = false;
let lastError = "";
let readyPromise = null;
const jobPool = createJobPool({ concurrency: config.maxConcurrentJobs, maxQueuedJobs: config.maxQueuedJobs });

async function log(event, data = {}) {
  const row = JSON.stringify({ timestamp: new Date().toISOString(), event, ...data });
  console.log(row);
  await appendFile(logPath, `${row}\n`, "utf8").catch(() => {});
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function authorized(req) {
  const expected = Buffer.from(String(config.apiKey || ""));
  const actual = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function bodyJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > config.maxBodyBytes) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ensureReady(rebuild = false) {
  if (ready && !rebuild) return;
  if (readyPromise && !rebuild) return readyPromise;
  if (readyPromise && rebuild) await readyPromise.catch(() => {});
  loading = true;
  lastError = "";
  const work = (async () => {
    try {
      const result = await prewarm({
        rebuild,
        onProgress: ({ completed, total, id }) => log("prewarm_progress", { completed, total, id }),
      });
      ready = true;
      await log("prewarm_complete", result);
      return result;
    } catch (error) {
      ready = false;
      lastError = String(error?.message || error);
      await log("prewarm_failed", { error: lastError });
      throw error;
    } finally {
      loading = false;
    }
  })();
  readyPromise = work;
  try {
    return await work;
  } finally {
    if (readyPromise === work) readyPromise = null;
  }
}

function enqueue(job, options) {
  return jobPool.enqueue(job, options);
}

function requestDeadline(body) {
  if (body?.deadline_unix_ms === undefined || body?.deadline_unix_ms === null) return null;
  const value = Number(body.deadline_unix_ms);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error("deadline_unix_ms must be a positive Unix epoch in milliseconds"), { statusCode: 400 });
  }
  return Math.floor(value);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        status: ready ? "ready" : loading ? "loading" : "not_ready",
        ready,
        loading,
        last_error: lastError,
        version: "3.1.0",
        build_version: versions.service,
        backend: "clip_vision_projection_local_q4_cpu_multiview",
        model: config.model,
        model_path: config.modelPath,
        dtype: config.dtype,
        device: "cpu",
        threads: config.threads,
        concurrency: config.maxConcurrentJobs,
        embedding_concurrency: config.embeddingConcurrency,
        max_embedding_batch_items: config.maxEmbeddingBatchItems,
        embedding_contract_version: versions.embedding_contract,
        index_contract_version: versions.index_contract,
        index: currentIndexDescriptor(),
        ...jobPool.snapshot(),
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
      });
    }
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/v1/identity/prewarm") {
      const body = await bodyJson(req);
      const result = await enqueue(() => ensureReady(Boolean(body.rebuild)).then(() => ({ status: "ok", ready: true })));
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/v1/identity/retrieve") {
      const body = await bodyJson(req);
      if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > config.maxTargets) {
        return json(res, 400, { error: `images must contain 1-${config.maxTargets} targets` });
      }
      for (const image of body.images) {
        if (!image?.target_id || !image?.data_base64) return json(res, 400, { error: "each image requires target_id and data_base64" });
      }
      const parentIds = new Set(body.images.map((image) => String(image?.parent_target_id || image?.target_id || "").trim()).filter(Boolean));
      if (parentIds.size > 1) {
        return json(res, 400, { error: "cross_target_identity_aggregate_forbidden" });
      }
      const deadlineAt = requestDeadline(body);
      const queuedAt = Date.now();
      const timeoutResponse = () => expiredRetrieve(body.images, {
        receivedAt: started,
        startedAt: Date.now(),
        queueMs: Date.now() - queuedAt,
      });
      const result = deadlineAt && Date.now() >= deadlineAt
        ? timeoutResponse()
        : await enqueue(async () => {
          const executionStartedAt = Date.now();
          if (deadlineAt && executionStartedAt >= deadlineAt) return timeoutResponse();
          await ensureReady(false);
          return retrieve(body.images, {
            deadlineAt,
            receivedAt: started,
            startedAt: executionStartedAt,
            queueMs: executionStartedAt - queuedAt,
          });
        }, { deadlineAt, onExpired: timeoutResponse });
      await log("retrieve_complete", {
        request_id: body.request_id || "",
        target_count: body.images.length,
        status: result.status,
        error_count: result.error_count || 0,
        elapsed_ms: Date.now() - started,
      });
      return json(res, 200, { request_id: body.request_id || "", ...result });
    }

    if (req.method === "POST" && url.pathname === "/v1/embeddings/batch") {
      const body = await bodyJson(req);
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > config.maxEmbeddingBatchItems) {
        return json(res, 400, { error: `items must contain 1-${config.maxEmbeddingBatchItems} target views` });
      }
      const deadlineAt = requestDeadline(body);
      const queuedAt = Date.now();
      const timeoutResponse = () => expiredEmbeddingBatch(body.items, {
        receivedAt: started,
        startedAt: Date.now(),
        queueMs: Date.now() - queuedAt,
      });
      const result = deadlineAt && Date.now() >= deadlineAt
        ? timeoutResponse()
        : await enqueue(async () => {
          const executionStartedAt = Date.now();
          if (deadlineAt && executionStartedAt >= deadlineAt) return timeoutResponse();
          return embedBatch(body.items, {
            deadlineAt,
            receivedAt: started,
            startedAt: executionStartedAt,
            queueMs: executionStartedAt - queuedAt,
          });
        }, { deadlineAt, onExpired: timeoutResponse });
      await log("embedding_batch_complete", {
        request_id: body.request_id || "",
        item_count: body.items.length,
        success_count: result.success_count,
        partial_error_count: result.partial_errors.length,
        elapsed_ms: Date.now() - started,
      });
      return json(res, 200, { request_id: body.request_id || "", ...result });
    }

    if (req.method === "GET" && url.pathname === "/v1/identity/index/snapshot") {
      const queuedAt = Date.now();
      const result = await enqueue(async () => {
        const executionStartedAt = Date.now();
        await ensureReady(false);
        return identityIndexSnapshot({
          receivedAt: started,
          startedAt: executionStartedAt,
          queueMs: executionStartedAt - queuedAt,
        });
      });
      await log("identity_index_snapshot_complete", {
        exemplar_count: result.index.exemplar_count,
        identity_count: result.index.identity_count,
        partial_error_count: result.partial_errors.length,
        elapsed_ms: Date.now() - started,
      });
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/v1/identity/reload") {
      resetRuntime();
      ready = false;
      return json(res, 200, { status: "ok", ready: false });
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    await log("request_failed", { path: req.url, error: String(error?.stack || error), elapsed_ms: Date.now() - started });
    return json(res, status, { error: String(error?.message || error) });
  }
});

server.requestTimeout = Number(config.requestTimeoutMs || 180000);
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(Number(config.port || 6971), String(config.host || "0.0.0.0"), async () => {
  await log("server_started", {
    host: config.host,
    port: config.port,
    threads: config.threads,
    max_concurrent_jobs: config.maxConcurrentJobs,
    embedding_concurrency: config.embeddingConcurrency,
    version: "3.1.0",
    build_version: versions.service,
    backend: "clip_vision_projection_local_q4_cpu_multiview",
    model: config.model,
    model_path: config.modelPath,
    dtype: config.dtype,
    device: "cpu",
    pid: process.pid,
  });
  if (config.preload !== false) {
    ensureReady(false).catch(() => {});
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

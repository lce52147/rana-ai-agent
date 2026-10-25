import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGenerationTrace } from "../architecture/generation_trace.js";
import { insertMemory, isSensitiveMemoryText, isTransientMemoryText } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_ENDPOINT = "http://127.0.0.1:6969/v1";
const DEFAULT_MODEL = "OOGG";
const TIMEOUT_MS = Math.max(500, Number(process.env.RANA_MEMORY_EXTRACTOR_TIMEOUT_MS || 8000));
const DELAY_MS = 3000;
const QUEUE_LIMIT = 20;
const ALLOWED_KINDS = new Set(["fact", "preference", "identity", "commitment", "correction"]);
const extractionQueue = [];
let queueTimer;
let workerRunning = false;

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).find(Boolean) || "";
  if (value && typeof value === "object") return textOf(value.text ?? value.content ?? value.value ?? value.message ?? "");
  return "";
}

function rawMessage(row) { return row?.message && typeof row.message === "object" ? row.message : row; }
function roleOf(row) { return String(rawMessage(row)?.role || rawMessage(row)?.type || row?.role || row?.type || "").toLowerCase(); }
function rejected(row) {
  const message = rawMessage(row);
  const stop = String(message?.stopReason || row?.stopReason || message?.status || row?.status || "").toLowerCase();
  return ["error", "failed", "failure", "aborted", "cancelled", "canceled"].includes(stop);
}

function messageText(row) {
  const message = rawMessage(row);
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => textOf(part.text))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return textOf(message?.content ?? message?.text ?? message?.body).trim();
}

function senderIdOf(row) {
  const message = rawMessage(row);
  return String(message?.__openclaw?.senderId || row?.__openclaw?.senderId || "").trim() || null;
}

function pairFromMessages(messages = []) {
  let pendingUser;
  let lastPair;
  for (const row of messages) {
    const role = roleOf(row);
    if (rejected(row) || ["tool", "toolresult", "tool_result", "function"].includes(role)) continue;
    const text = messageText(row);
    if (role === "user") {
      if (text) pendingUser = { row, text };
      continue;
    }
    if (["assistant", "model"].includes(role) && pendingUser && text) {
      lastPair = { user: pendingUser.text, assistant: text, userMessage: pendingUser.row };
      pendingUser = undefined;
    }
  }
  return lastPair || { user: "", assistant: "", userMessage: null };
}

function agentFromSession(sessionKey) {
  return String(sessionKey || "").match(/^agent:([^:]+):/iu)?.[1] || "";
}

function sessionKeyOf(event, ctx) { return String(event?.sessionKey || ctx?.sessionKey || "").trim(); }
function agentIdOf(event, ctx) { return String(ctx?.agentId || event?.agentId || agentFromSession(sessionKeyOf(event, ctx))).trim().toLowerCase(); }

function sessionTranscript(event, ctx) {
  const sessionKey = sessionKeyOf(event, ctx);
  const agentId = agentIdOf(event, ctx);
  if (!sessionKey || !agentId) return null;
  const indexPath = path.join(ROOT, "agents", agentId, "sessions", "sessions.json");
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const sessionId = String(index?.[sessionKey]?.sessionId || "").trim();
    if (!sessionId) return null;
    const transcriptPath = path.join(ROOT, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    if (!fs.existsSync(transcriptPath)) return null;
    return transcriptPath;
  } catch {
    return null;
  }
}

function collectTurn(event = {}, ctx = {}) {
  const messages = Array.isArray(event?.messages) ? event.messages : Array.isArray(event?.history) ? event.history : null;
  let pair;
  let source = messages ? "event" : "transcript";
  if (messages) {
    pair = pairFromMessages(messages);
  } else {
    const transcriptPath = sessionTranscript(event, ctx);
    if (transcriptPath) {
      const rows = [];
      try {
        for (const line of fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/u)) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch { /* ignore malformed transcript lines */ }
        }
      } catch { /* trace and skip below */ }
      pair = pairFromMessages(rows);
    } else {
      source = "transcript_missing";
      pair = { user: "", assistant: "", userMessage: null };
    }
  }
  const userId = String(ctx?.senderId || event?.senderId || senderIdOf(pair.userMessage) || "").trim() || null;
  return { user: pair.user, assistant: pair.assistant, userMessage: pair.userMessage, userId, source };
}

function endpointBase() { return String(process.env.RANA_MEMORY_EXTRACTOR_URL || DEFAULT_ENDPOINT).replace(/\/+$/u, ""); }
function endpoint() {
  const configured = endpointBase();
  return configured.endsWith("/v1") ? `${configured}/chat/completions` : `${configured}/v1/chat/completions`;
}
function endpointRoot() { return endpointBase().replace(/\/v1$/iu, ""); }

function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizeCandidate(candidate) {
  const kind = String(candidate?.kind || "fact").trim().toLowerCase();
  const content = String(candidate?.content || candidate?.text || "").replace(/\s+/gu, " ").trim().slice(0, 500);
  const subject = String(candidate?.subject || "").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!ALLOWED_KINDS.has(kind) || !content || isSensitiveMemoryText(content) || isTransientMemoryText(content)) return null;
  return { kind, subject, content, confidence: Math.max(0, Math.min(1, Number(candidate?.confidence ?? 0.65))) };
}

function probeBusy(value, depth = 0) {
  if (depth > 5 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => probeBusy(item, depth + 1));
  if (typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (["in_flight", "inflight", "is_processing", "processing", "busy", "running"].includes(name) && item === true) return true;
    if (["state", "status"].includes(name) && /processing|busy|running|generating|in.?flight/iu.test(String(item))) return true;
    if (probeBusy(item, depth + 1)) return true;
  }
  return false;
}

async function extractorIdle(signal) {
  for (const route of ["/health", "/slots"]) {
    try {
      const response = await fetch(`${endpointRoot()}${route}`, { signal: signal || AbortSignal.timeout(1000) });
      if (!response.ok) continue;
      const body = await response.json().catch(() => ({}));
      return { ok: true, busy: probeBusy(body), route };
    } catch { /* try the alternate probe */ }
  }
  return { ok: false, busy: false };
}

export async function extractMemoryCandidates(turn, { signal } = {}) {
  if (!turn?.user || !turn?.assistant) return { ok: true, candidates: [], reason: "missing_turn_text" };
  const body = {
    model: process.env.RANA_MEMORY_EXTRACTOR_MODEL || DEFAULT_MODEL,
    temperature: 0,
    max_tokens: 300,
    messages: [
      { role: "system", content: "只抽取使用者在本回合明確說出或更正、且值得長期保存的資料。只輸出 JSON：{\"memories\":[{\"kind\":\"fact|preference|identity|commitment|correction\",\"subject\":\"\",\"content\":\"\",\"confidence\":0.0}] }。只採信 USER，不採信 ASSISTANT 自己說的角色設定或推測；不要保存秘密、憑證、暫時狀態、目前對話內容或除錯資訊。沒有可保存內容時輸出 {\"memories\":[]}。" },
      { role: "user", content: `USER:\n${turn.user.slice(0, 1800)}\nASSISTANT:\n${turn.assistant.slice(0, 1800)}` },
    ],
  };
  try {
    const response = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, candidates: [], reason: `http_${response.status}` };
    const payload = await response.json();
    const parsed = parseJson(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "");
    const candidates = Array.isArray(parsed?.memories) ? parsed.memories.map(normalizeCandidate).filter(Boolean) : [];
    return { ok: true, candidates, reason: candidates.length ? "extracted" : "empty" };
  } catch (error) {
    return { ok: false, candidates: [], reason: String(error?.name || "extractor_error") };
  }
}

export async function extractAndStoreTurn(event = {}, ctx = {}, { signal } = {}) {
  const turn = collectTurn(event, ctx);
  const botId = agentIdOf(event, ctx);
  if (!botId || !turn.user || !turn.assistant) {
    writeGenerationTrace({ phase: "memory_extraction", runId: String(event?.runId || ctx?.runId || ""), sessionKey: sessionKeyOf(event, ctx), personaId: botId || null, status: "skipped", reason: turn.source === "transcript_missing" ? "transcript_missing" : "missing_scope_or_turn" });
    return { ok: true, stored: 0, reason: turn.source === "transcript_missing" ? "transcript_missing" : "missing_scope_or_turn" };
  }
  const result = await extractMemoryCandidates(turn, { signal });
  let stored = 0;
  if (result.ok) {
    for (const candidate of result.candidates) {
      const outcome = insertMemory({ bot_id: botId, user_id: turn.userId, ...candidate, source: "inferred", source_message_id: event?.messageId || event?.id || null });
      if (outcome.inserted) stored += 1;
    }
  }
  writeGenerationTrace({ phase: "memory_extraction", runId: String(event?.runId || ctx?.runId || ""), sessionKey: sessionKeyOf(event, ctx), personaId: botId, status: result.ok ? "ok" : "skipped", reason: result.reason, candidates: result.candidates.length, stored });
  return { ...result, stored };
}

function scheduleDrain(delay = DELAY_MS) {
  if (queueTimer) return;
  queueTimer = setTimeout(() => { queueTimer = undefined; void drainQueue(); }, delay);
  queueTimer.unref?.();
}

function enqueue(event, ctx) {
  if (extractionQueue.length >= QUEUE_LIMIT) {
    extractionQueue.shift();
    writeGenerationTrace({ phase: "memory_extraction_queue", status: "dropped", reason: "queue_limit", limit: QUEUE_LIMIT });
  }
  extractionQueue.push({ event, ctx });
  scheduleDrain();
}

async function drainQueue() {
  if (workerRunning || !extractionQueue.length) return;
  workerRunning = true;
  try {
    while (extractionQueue.length) {
      const idle = await extractorIdle();
      if (!idle.ok || idle.busy) {
        writeGenerationTrace({ phase: "memory_extraction_queue", status: "retry", reason: idle.ok ? "extractor_busy" : "extractor_probe_failed", queued: extractionQueue.length });
        scheduleDrain();
        return;
      }
      const item = extractionQueue.shift();
      await extractAndStoreTurn(item.event, item.ctx);
    }
  } finally {
    workerRunning = false;
  }
}

export function registerAutoMemoryExtraction(api) {
  api.on("agent_end", (event, ctx) => {
    const failed = event?.success === false || event?.isError === true || Boolean(event?.error);
    if (failed) {
      writeGenerationTrace({ phase: "memory_extraction", runId: String(event?.runId || ctx?.runId || ""), sessionKey: sessionKeyOf(event, ctx), status: "skipped", reason: "agent_end_error" });
      return;
    }
    enqueue(event, ctx);
  }, { priority: 1100, timeoutMs: 1000 });
}

export const __test = {
  collectTurn,
  normalizeCandidate,
  parseJson,
  endpoint,
  probeBusy,
  extractorIdle,
  queueSnapshot: () => ({ length: extractionQueue.length, workerRunning }),
};

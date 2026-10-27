import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { writeGenerationTrace } from "../architecture/generation_trace.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "..", "..", "..");
export const MEMORY_DB_PATH = path.resolve(process.env.RANA_MEMORY_DB_PATH || path.join(ROOT, "state", "rana_memory.sqlite"));
const SENSITIVE_RE = /(token|api[\s_-]?key|secret|password|passwd|passcode|cvv|discord token|bearer\s+[a-z0-9._-]+)/iu;
const SENSITIVE_CJK_RE = /(密碼|密码|口令|通行碼|通行码|金鑰|金钥|私鑰|私钥|信用卡|卡號|卡号|身分證|身份證|身份证|護照|护照|パスワード|暗証番号)/u;
const TOKEN_SHAPE_RE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/u;
const TRANSIENT_RE = /(?:剛剛|剛才|這次|本次|目前這個|今天這個|debug|quota|額度|排程|scheduled task|music_pipeline_debug_summary|failing test|暫時|等一下再改|這輪|這個 session)/iu;
let db;
const require = createRequire(import.meta.url);

function loadDatabaseSync(loader = require, trace = writeGenerationTrace) {
  try {
    return { DatabaseSync: loader("node:sqlite").DatabaseSync, error: null };
  } catch (error) {
    trace({
      phase: "memory_store_startup",
      status: "disabled",
      reason: "node_sqlite_unavailable",
      nodeVersion: process.version,
      error: String(error?.code || error?.name || "load_error"),
    });
    return { DatabaseSync: null, error };
  }
}

const sqlite = loadDatabaseSync();
export const MEMORY_AVAILABLE = typeof sqlite.DatabaseSync === "function";

function normalizeText(value) { return String(value || "").replace(/\s+/gu, " ").trim().slice(0, 1200); }
function comparable(value) { return normalizeText(value).replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase("zh-Hant"); }
function nowMs() { return Date.now(); }
function dbHandle() {
  if (!MEMORY_AVAILABLE) return null;
  if (db) return db;
  fs.mkdirSync(path.dirname(MEMORY_DB_PATH), { recursive: true });
  db = new sqlite.DatabaseSync(MEMORY_DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      user_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('fact','preference','identity','commitment','correction')),
      subject TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source_message_id TEXT,
      source TEXT NOT NULL CHECK(source IN ('inferred','explicit','migrated')),
      confidence REAL NOT NULL DEFAULT 0.5,
      superseded_by TEXT,
      embedding_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(bot_id, user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS memories_active_idx ON memories(bot_id, superseded_by, ts DESC);
    CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories(bot_id, subject, ts DESC);
  `);
  // author_id = who taught the memory; user_id = whose memory it is (NULL = shared with everyone).
  if (!db.prepare("PRAGMA table_info(memories)").all().some((column) => column.name === "author_id")) {
    db.exec("ALTER TABLE memories ADD COLUMN author_id TEXT; UPDATE memories SET author_id = user_id WHERE author_id IS NULL;");
  }
  return db;
}

export function isSensitiveMemoryText(value) {
  const text = normalizeText(value);
  return SENSITIVE_RE.test(text) || SENSITIVE_CJK_RE.test(text) || TOKEN_SHAPE_RE.test(text);
}

// A memory about the speaker themself (「我喜歡…」「我的生日…」) stays theirs; anything else is shared.
export function isSelfMemoryText(value) {
  return /我(?!們|们)|本人|\b(?:I|my|me)\b/iu.test(normalizeText(value));
}

export function isTransientMemoryText(value) {
  const text = normalizeText(value);
  return !text || TRANSIENT_RE.test(text);
}

function validateInput(input = {}) {
  const botId = normalizeText(input.bot_id || input.botId).toLowerCase();
  const userId = normalizeText(input.user_id || input.userId) || null;
  const authorId = normalizeText(input.author_id || input.authorId) || userId;
  const kind = normalizeText(input.kind) || "fact";
  const subject = normalizeText(input.subject);
  const content = normalizeText(input.content || input.text);
  const source = normalizeText(input.source) || "inferred";
  if (!botId || !content) return { ok: false, reason: "missing_scope_or_content" };
  if (!["fact", "preference", "identity", "commitment", "correction"].includes(kind)) return { ok: false, reason: "invalid_kind" };
  if (!["inferred", "explicit", "migrated"].includes(source)) return { ok: false, reason: "invalid_source" };
  if (isSensitiveMemoryText(content) || isTransientMemoryText(content)) return { ok: false, reason: "filtered_content" };
  return { ok: true, botId, userId, authorId, kind, subject, content, source, confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.5))), sourceMessageId: normalizeText(input.source_message_id || input.sourceMessageId) || null, embeddingHash: normalizeText(input.embedding_hash || input.embeddingHash) || null, supersedesId: normalizeText(input.supersedes_by || input.supersedesBy) || null };
}

function existingExact(value) {
  const stmt = dbHandle().prepare("SELECT * FROM memories WHERE bot_id = ? AND ((user_id IS NULL AND ? IS NULL) OR user_id = ?) AND content = ? AND superseded_by IS NULL ORDER BY ts DESC LIMIT 1");
  return stmt.get(value.botId, value.userId, value.userId, value.content) || null;
}

function markSuperseded(id, nextId) {
  if (!id || !nextId || id === nextId) return;
  dbHandle().prepare("UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL").run(nextId, id);
}

export function insertMemory(input = {}) {
  const value = validateInput(input);
  if (!value.ok) return { ok: false, inserted: false, reason: value.reason };
  if (!MEMORY_AVAILABLE) return { ok: false, inserted: false, reason: "memory_unavailable" };
  const duplicate = existingExact(value);
  if (duplicate) return { ok: true, inserted: false, duplicate: true, item: duplicate };
  const id = crypto.randomUUID();
  const database = dbHandle();
  database.prepare("INSERT INTO memories (id, bot_id, user_id, author_id, kind, subject, content, ts, source_message_id, source, confidence, superseded_by, embedding_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)").run(id, value.botId, value.userId, value.authorId, value.kind, value.subject, value.content, Number(input.ts || nowMs()), value.sourceMessageId, value.source, value.confidence, value.embeddingHash);
  if (value.supersedesId) markSuperseded(value.supersedesId, id);
  if (value.kind === "correction" && value.subject) {
    const previous = database.prepare("SELECT id FROM memories WHERE bot_id = ? AND ((user_id IS NULL AND ? IS NULL) OR user_id = ?) AND subject = ? AND id <> ? AND superseded_by IS NULL ORDER BY ts DESC LIMIT 1").get(value.botId, value.userId, value.userId, value.subject, id);
    if (previous?.id) markSuperseded(previous.id, id);
  }
  return { ok: true, inserted: true, item: getMemory(id) };
}

export function getMemory(id) {
  if (!MEMORY_AVAILABLE) return null;
  return dbHandle().prepare("SELECT * FROM memories WHERE id = ?").get(String(id)) || null;
}

export function listMemories({ botId, userId, includeSuperseded = false, limit = 200 } = {}) {
  const bot = normalizeText(botId).toLowerCase();
  if (!bot) return [];
  if (!MEMORY_AVAILABLE) return [];
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  const where = includeSuperseded ? "" : " AND superseded_by IS NULL";
  return dbHandle().prepare(`SELECT * FROM memories WHERE bot_id = ? AND (user_id IS NULL OR user_id = ?)${where} ORDER BY ts DESC LIMIT ?`).all(bot, normalizeText(userId) || null, max);
}

export function deleteMemories({ botId, userId, query } = {}) {
  const bot = normalizeText(botId).toLowerCase();
  const needle = comparable(query);
  if (!bot || !needle) return { ok: false, removed: 0, reason: "missing_scope_or_query" };
  if (!MEMORY_AVAILABLE) return { ok: false, removed: 0, reason: "memory_unavailable" };
  const rows = listMemories({ botId: bot, userId, limit: 1000 }).filter((row) => comparable(`${row.subject} ${row.content}`).includes(needle));
  const database = dbHandle();
  for (const row of rows) database.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
  return { ok: true, removed: rows.length, items: rows };
}

export function memoryStats({ botId } = {}) {
  const bot = normalizeText(botId).toLowerCase();
  if (!MEMORY_AVAILABLE) return { status: "disabled", store: "state/rana_memory.sqlite", bot_id: bot || null, reason: "node_sqlite_unavailable" };
  const row = bot ? dbHandle().prepare("SELECT COUNT(*) AS count FROM memories WHERE bot_id = ?").get(bot) : dbHandle().prepare("SELECT COUNT(*) AS count FROM memories").get();
  return { status: "ok", store: "state/rana_memory.sqlite", bot_id: bot || null, count: Number(row?.count || 0) };
}

export function closeMemoryStore() {
  if (db) db.close();
  db = undefined;
}

export function migrateMemoryRows(rows = []) {
  const result = { inserted: 0, duplicates: 0, rejected: 0 };
  for (const row of rows) {
    const outcome = insertMemory({ ...row, source: "migrated" });
    if (!outcome.ok) result.rejected += 1;
    else if (outcome.inserted) result.inserted += 1;
    else result.duplicates += 1;
  }
  return result;
}

export const __test = { normalizeText, comparable, validateInput, dbHandle, loadDatabaseSync };

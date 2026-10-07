import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBm25 } from "../extensions/rana-runtime/lore/search_core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_ROOT = path.join(ROOT, "workspace", "LORE", "generated", "rag");
const CORPUS_PATH = path.join(GENERATED_ROOT, "chunk_manifest.json");
const INDEX_PATH = path.join(GENERATED_ROOT, "hybrid_index.json");
const STATUS_PATH = path.join(GENERATED_ROOT, "index_status.json");
const OLLAMA_URL = process.env.RANA_LORE_OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.RANA_LORE_EMBED_MODEL || "qwen3-embedding:0.6b";
const TOKENIZER = process.argv.find((arg) => arg.startsWith("--tokenizer="))?.split("=")[1] || "trigram";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function embedBatch(input, signal) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
    signal,
  });
  if (!response.ok) throw new Error(`local embedding failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) throw new Error("local embedding returned an invalid batch");
  return data.embeddings;
}

async function main() {
  if (!fs.existsSync(CORPUS_PATH)) throw new Error("run scripts/sync_lore_rag.mjs first");
  if (!new Set(["unicode61", "trigram"]).has(TOKENIZER)) throw new Error(`unsupported tokenizer: ${TOKENIZER}`);
  const corpus = readJson(CORPUS_PATH);
  const inputs = corpus.chunks.map((chunk) => `${chunk.metadata.sourceTitle}\n${chunk.content}`.slice(0, 6000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const embeddings = [];
  try {
    for (let index = 0; index < inputs.length; index += 12) {
      embeddings.push(...await embedBatch(inputs.slice(index, index + 12), controller.signal));
      process.stderr.write(`[lore-index] embedded ${Math.min(index + 12, inputs.length)}/${inputs.length}\n`);
    }
  } finally {
    clearTimeout(timeout);
  }
  const dimensions = embeddings[0]?.length || 0;
  if (!dimensions || embeddings.some((item) => item.length !== dimensions)) throw new Error("embedding dimensions are inconsistent");
  const lexical = buildBm25(corpus.chunks, TOKENIZER);
  const indexIdentity = sha256(JSON.stringify({ buildIdentity: corpus.buildIdentity, model: MODEL, dimensions, tokenizer: TOKENIZER }));
  const builtAt = new Date().toISOString();
  writeJson(INDEX_PATH, {
    schema: "rana.lore-hybrid-index.v1",
    namespace: corpus.namespace,
    provider: "ollama",
    model: MODEL,
    fallback: "none",
    dimensions,
    tokenizer: TOKENIZER,
    buildIdentity: corpus.buildIdentity,
    indexIdentity,
    builtAt,
    chunks: corpus.chunks,
    embeddings,
  });
  writeJson(STATUS_PATH, {
    schema: "rana.lore-index-status.v1",
    provider: "ollama",
    model: MODEL,
    dimensions,
    tokenizer: TOKENIZER,
    files: corpus.sources.length,
    chunks: corpus.chunks.length,
    dirty: false,
    builtAt,
    buildIdentity: corpus.buildIdentity,
    indexIdentity,
    lexicalDocuments: lexical.size,
    fallback: "none",
  });
  process.stdout.write(`${JSON.stringify(readJson(STATUS_PATH), null, 2)}\n`);
}

main().catch((error) => {
  writeJson(STATUS_PATH, {
    schema: "rana.lore-index-status.v1",
    provider: "ollama",
    model: MODEL,
    tokenizer: TOKENIZER,
    dirty: true,
    error: String(error?.message || error),
    failedAt: new Date().toISOString(),
    fallback: "none",
  });
  console.error(error?.stack || error);
  process.exitCode = 1;
});

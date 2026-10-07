import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactLoreSystemPrompt, formatLoreOutgoing } from "../extensions/rana-runtime/lore/guidance.js";
import { buildLoreEvidencePack, loreEvidenceContext, safeEvidencePack } from "../extensions/rana-runtime/lore/retrieval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.RANA_LORE_MODEL_ENDPOINT || "http://127.0.0.1:6969/v1/responses";
const MODEL = process.env.RANA_LORE_MODEL_ALIAS || "OOGG";
const runId = new Date().toISOString().replaceAll(":", "-");
const runDir = path.join(ROOT, "runtime-debug", "lore-model-probe", runId);
fs.mkdirSync(runDir, { recursive: true });

const validationCases = [
  {
    id: "recognition-anon",
    query: "妳認識愛音嗎？",
    expectedContract: "known",
    required: [/愛音|あのん/u, /認識|團員/u],
    forbidden: [/每天一起工作|交換名字|Mortis|SPACE/u],
  },
  {
    id: "reverse-anon",
    query: "愛音認識妳嗎？",
    expectedContract: "known",
    required: [/愛音|あのん/u, /認識/u],
    forbidden: [/我認識愛音[、，,](?:燈|立希|爽世)/u],
  },
  {
    id: "third-party-anon",
    query: "愛音認識誰？",
    expectedContract: "boundary",
    required: [/愛音|あのん/u, /燈|立希|りっきー|爽世|我/u],
    forbidden: [/完整交友圈已確認/u],
  },
  {
    id: "mutsumi-mortis",
    query: "睦和 Mortis 是同一個人嗎？",
    expectedContract: "known",
    required: [/睦/u, /Mortis|モーティス|墨緹絲/u, /相連|關聯|同一身體|不同|狀態|人格/u],
    forbidden: [/完全無關|非正統角色|Mutsuki Ifuyu/u],
  },
  {
    id: "nyamu-event",
    query: "妳和にゃむ交換名字時發生了什麼？",
    expectedContract: "known",
    required: [/にゃ/u, /にゃむ/u, /名字|念完整/u],
    forbidden: [/一起彈吉他|陪我練習/u],
  },
  {
    id: "nyamu-reason",
    query: "祐天寺にゃむ為什麼要妳念完整名字？",
    expectedContract: "boundary",
    required: [/にゃ/u, /にゃむ/u],
    forbidden: [/因為她討厭貓|商業策略|網路流量/u],
  },
  {
    id: "ave-interactions",
    query: "妳跟 Ave Mujica 的哪些人有直接互動？",
    expectedContract: "known",
    required: [/睦/u, /Mortis|モーティス/u, /にゃむ|若麥/u],
    forbidden: [/初華|海鈴/u],
  },
  {
    id: "sakiko-finance",
    query: "妳認識祥子嗎？知道她家的財務內情嗎？",
    expectedContract: "boundary",
    required: [/祥子/u, /見過|不熟/u, /不知道|不清楚|不能確認/u],
    forbidden: [/朋友|很熟/u],
  },
  {
    id: "space-time",
    query: "妳以前去過 SPACE，現在還常去嗎？",
    expectedContract: "known",
    required: [/SPACE/u, /以前|小時候|過去/u, /關閉|停車場|RiNG/u],
    forbidden: [/現在偶爾去 SPACE|SPACE 現在還在營業/u],
  },
  {
    id: "descriptor-mutsumi",
    query: "紫色長髮、跟 CRYCHIC 有關的吉他手是誰？",
    expectedContract: "known",
    required: [/睦/u],
    forbidden: [/爽世|祥子/u],
  },
  {
    id: "unsupported-mars",
    query: "妳跟愛音去過火星嗎？",
    expectedContract: "unknown",
    required: [/不知道|沒有.{0,8}證據|無法確認/u],
    forbidden: [/火星.{0,12}抹茶|一起去過|我沒去過/u],
  },
  {
    id: "source-nyamu",
    query: "妳和にゃむ互動的來源是哪個活動？",
    expectedContract: "source",
    required: [/event307|わかれ道をゆく人たちへ|活動/u],
    forbidden: [/RAG|Evidence Pack|JSON/u],
  },
];

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const repetitions = Number(process.argv.find((arg) => arg.startsWith("--repetitions="))?.slice("--repetitions=".length) || 1);
const cases = validationCases
  .filter((item) => !only || item.id.startsWith(only))
  .flatMap((item) => Array.from({ length: repetitions }, (_, index) => ({ ...item, repetition: index + 1 })));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseSse(rawText) {
  const payloads = [];
  const invalidLines = [];
  for (const line of rawText.split(/\r?\n/u).filter((item) => item.startsWith("data: "))) {
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    try { payloads.push(JSON.parse(data)); } catch { invalidLines.push(line); }
  }
  return {
    payloads,
    invalidLines,
    response: payloads.findLast((item) => item.type === "response.completed")?.response || null,
  };
}

function outputText(response) {
  return (response?.output || []).flatMap((item) => item?.content || []).map((item) => item?.text || "").join("");
}

function buildRequest(query, pack) {
  return {
    model: MODEL,
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: compactLoreSystemPrompt() }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `${loreEvidenceContext(pack)}\n\n${query}` }] },
    ],
    stream: true,
    max_output_tokens: 512,
    store: false,
  };
}

function evaluate(testCase, pack, rawOutput, finalOutput, transport) {
  const issues = [];
  if (transport.status !== 200 || transport.responseStatus !== "completed") issues.push(`transport:${transport.status}:${transport.responseStatus || "missing"}`);
  if (transport.invalidSseLines) issues.push(`invalid_sse:${transport.invalidSseLines}`);
  if (!rawOutput.trim()) issues.push("empty_output");
  if (rawOutput !== finalOutput) issues.push("output_modified");
  if (pack.knowledge_contract !== testCase.expectedContract) issues.push(`contract:${pack.knowledge_contract}`);
  for (const pattern of testCase.required || []) if (!pattern.test(finalOutput)) issues.push(`missing:${pattern}`);
  for (const pattern of testCase.forbidden || []) if (pattern.test(finalOutput)) issues.push(`forbidden:${pattern}`);
  if (/RAG|Evidence Pack|knowledge_boundaries|query_plan|system prompt|JSON/u.test(finalOutput)) issues.push("internal_language_leak");
  return { pass: issues.length === 0, issues };
}

const results = [];
for (let index = 0; index < cases.length; index += 1) {
  const testCase = cases[index];
  const pack = await buildLoreEvidencePack(testCase.query, { sessionKey: `model-probe:${runId}:${testCase.id}:${testCase.repetition}` });
  const request = buildRequest(testCase.query, pack);
  const requestText = JSON.stringify(request);
  const stem = `${String(index + 1).padStart(3, "0")}-${testCase.id}-r${testCase.repetition}`;
  fs.writeFileSync(path.join(runDir, `${stem}.request.json`), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDir, `${stem}.retrieval.json`), `${JSON.stringify({ pack: safeEvidencePack(pack), injected_context: loreEvidenceContext(pack) }, null, 2)}\n`, "utf8");

  let status = 0;
  let rawResponse = "";
  let error = null;
  const startedAt = Date.now();
  try {
    const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: requestText });
    status = response.status;
    rawResponse = Buffer.from(await response.arrayBuffer()).toString("utf8");
  } catch (caught) {
    error = String(caught);
  }
  const parsed = parseSse(rawResponse);
  const rawOutput = outputText(parsed.response);
  const finalOutput = formatLoreOutgoing(rawOutput);
  const evaluation = evaluate(testCase, pack, rawOutput, finalOutput, {
    status,
    responseStatus: parsed.response?.status || null,
    invalidSseLines: parsed.invalidLines.length,
  });

  const result = {
    schema: "rana.lore-direct-model-probe.v1",
    note: "This is a direct OOGG probe, not production Discord acceptance.",
    run_id: runId,
    case_id: testCase.id,
    repetition: testCase.repetition,
    endpoint: ENDPOINT,
    model: MODEL,
    request_sha256: sha256(requestText),
    latency_ms: Date.now() - startedAt,
    status,
    response_status: parsed.response?.status || null,
    error,
    query_plan: pack.query_plan,
    knowledge_contract: pack.knowledge_contract,
    raw_model_output: rawOutput,
    final_output: finalOutput,
    guard_modified: rawOutput !== finalOutput,
    evaluation,
  };
  results.push(result);
  fs.writeFileSync(path.join(runDir, `${stem}.result.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stderr.write(`[model-probe] ${testCase.id} r${testCase.repetition}: ${evaluation.pass ? "PASS" : `FAIL ${evaluation.issues.join(",")}`}\n`);

  if (error || status === 0) break;
}

const summary = {
  schema: "rana.lore-direct-model-probe-summary.v1",
  note: "Direct model probe only. Real Discord llm_input/raw/final remains the production acceptance path.",
  run_id: runId,
  pass: results.filter((item) => item.evaluation.pass).length,
  fail: results.filter((item) => !item.evaluation.pass).length,
  total: results.length,
  run_dir: runDir,
};
fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.fail) process.exitCode = 1;

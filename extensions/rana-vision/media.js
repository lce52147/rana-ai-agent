import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeWithToriiGate, loadRepliedDiscordMedia } from "./client.js";
import { createVisionRequestId, traceVision } from "./debug.js";
import { buildVisionEvidence } from "./evidence.js";

const execFileAsync = promisify(execFile);
const OPENCLAW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INBOUND_DIR = path.resolve(OPENCLAW_ROOT, "media", "inbound");
const MEDIA_SERVICE = path.resolve(OPENCLAW_ROOT, "workspace", "services", "rana_media_tools");
const MEDIA_PYTHON = path.resolve(MEDIA_SERVICE, ".venv", "Scripts", "python.exe");
const MEDIA_SCRIPT = path.resolve(MEDIA_SERVICE, "analyze_media.py");
const MEDIA_OUTPUT = path.resolve(process.env.RANA_MEDIA_OUTPUT_DIR || "C:\\tmp\\rana-media-analysis");
const SUPPORTED_RE = /\.(?:mp4|webm|mov|mkv|avi|m4v|pdf|txt|log|md|csv|json|ya?ml|xml)$/i;

function firstText(value) {
  return typeof value === "string" ? value : "";
}

function cleanFilename(value) {
  return path.basename(String(value || "attachment.bin")).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
}

function directMediaAttachment(prompt) {
  const text = firstText(prompt);
  const matches = [...text.matchAll(/\[media attached:\s*([^\]\n]+?\.(?:mp4|webm|mov|mkv|avi|m4v|pdf|txt|log|md|csv|json|ya?ml|xml))(?:\s+\([^)]+\))?\s*\]/gi)];
  return matches.at(-1)?.[1]?.trim() || "";
}

function hasAudioAttachment(prompt) {
  const text = firstText(prompt);
  return /<media:audio>/i.test(text)
    || /\[media attached:[^\]\n]+?\.(?:mp3|wav|ogg|opus|m4a|flac|aac)(?:\s|\(|\])/i.test(text);
}

function replyReference(prompt) {
  const text = firstText(prompt);
  if (!/"has_reply_context"\s*:\s*true/i.test(text) && !/<media:(?:video|audio|document|file)>/i.test(text)) return null;
  const channel = text.match(/"chat_id"\s*:\s*"channel:(\d{17,20})"/i)?.[1];
  const message = text.match(/"reply_to_id"\s*:\s*"(\d{17,20})"/i)?.[1];
  return channel && message ? { channel, message } : null;
}

function userQuestion(prompt) {
  const text = firstText(prompt);
  const markers = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/gi)];
  return (markers.at(-1)?.[1] || text)
    .replace(/\[media attached:[\s\S]*$/i, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/@(?:Rana|樂奈)(?:#\d+)?/gi, "")
    .trim()
    .slice(0, 1000);
}

function validateInbound(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved.startsWith(`${INBOUND_DIR}${path.sep}`) || !SUPPORTED_RE.test(resolved)) {
    throw new Error("media attachment path is unavailable");
  }
  return resolved;
}

async function materializeRequest(prompt, requestId, options = {}) {
  const direct = directMediaAttachment(prompt);
  if (direct) return { path: validateInbound(direct), source: "openclaw_inbound_file" };
  const reply = replyReference(prompt);
  if (!reply) return null;
  const loaded = await (options.loadRepliedDiscordMedia || loadRepliedDiscordMedia)(
    reply.channel,
    reply.message,
    options.signal,
    requestId,
  );
  const requestDir = path.join(MEDIA_OUTPUT, requestId, "input");
  await mkdir(requestDir, { recursive: true });
  const target = path.join(requestDir, cleanFilename(loaded.filename));
  await writeFile(target, loaded.data);
  return { path: target, source: loaded.source, media: loaded.media };
}

async function runPreprocessor(sourcePath, requestId, options = {}) {
  const outputDir = path.join(MEDIA_OUTPUT, requestId, "output");
  await mkdir(outputDir, { recursive: true });
  const args = [
    MEDIA_SCRIPT,
    sourcePath,
    "--output",
    outputDir,
    "--max-frames",
    String(options.maxFrames || 18),
  ];
  const result = await execFileAsync(MEDIA_PYTHON, args, {
    timeout: Number(options.timeoutMs || 8 * 60 * 1000),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines.at(-1) || "{}");
  if (payload.status !== "ok") throw new Error(payload.error || "media preprocessing failed");
  return payload;
}

async function analyzeVisuals(preprocessed, requestId, options = {}) {
  if (preprocessed.kind !== "video") return [];
  const candidates = (preprocessed.grids?.length ? preprocessed.grids : preprocessed.frames || []).slice(0, 4);
  const analyze = options.analyze || analyzeWithToriiGate;
  const observations = [];
  for (const [index, imagePath] of candidates.entries()) {
    const image = await readFile(imagePath);
    const result = await analyze(image, "image/jpeg", options.signal, `${requestId}-media-${index + 1}`);
    observations.push({
      index: index + 1,
      source: path.basename(imagePath),
      status: result.status,
      observation: result.observation || null,
      error: result.error || null,
    });
  }
  return observations;
}

async function resolveMediaIdentity(preprocessed, question, requestId, options = {}) {
  if (!options.resolveIdentity || preprocessed.kind !== "video") return null;
  const imagePath = (preprocessed.frames || [])[0] || (preprocessed.grids || [])[0];
  if (!imagePath) return null;
  const image = await readFile(imagePath);
  const evidence = await (options.buildEvidence || buildVisionEvidence)(
    async () => ({
      image,
      mimeType: "image/jpeg",
      source: "media_keyframe",
      media: { filename: path.basename(imagePath) },
    }),
    question,
    options.signal,
    `${requestId}-identity`,
  );
  const primary = evidence?.identity_resolution?.primaryCharacter || null;
  const impression = evidence?.identity_resolution?.primaryImpression || null;
  return {
    primaryCharacter: primary ? {
      canonicalId: primary.canonicalId,
      canonicalName: primary.canonicalName,
      confidence: primary.confidence,
      confidenceScore: primary.confidenceScore,
      evidence: primary.evidence,
    } : null,
    impression: impression ? {
      recognitionLevel: impression.recognitionLevel,
      memoryAnchors: impression.memoryAnchors,
      ranaCallsThem: impression.ranaCallsThem,
      tentative: impression.tentative,
    } : null,
  };
}

function compactPayload(preprocessed, observations, requestId, question, identity = null) {
  return {
    schema: "rana.media.understanding.v1",
    requestId,
    kind: preprocessed.kind,
    userQuestion: question,
    source: path.basename(preprocessed.source || ""),
    pages: preprocessed.pages || null,
    manifest: String(preprocessed.manifest || "").slice(0, 12000),
    text: String(preprocessed.text || "").slice(0, 30000),
    visualObservations: observations,
    characterIdentity: identity,
    probe: preprocessed.probe || {},
    responseContract: {
      answerQuestionFirst: true,
      describeOnlyObservedContent: true,
      doNotInventMissingFrames: true,
      doNotClaimAudioUnderstanding: true,
      avoidInternalPipelineTerms: true,
    },
  };
}

function mediaContext(payload) {
  return [
    "以下是附件解析結果。先直接回答使用者的問題，再補充必要內容。",
    "影片只能依 visualObservations 回答畫面內容。這條路徑沒有音訊理解，不得描述聲音、語音或台詞。",
    "如果資料不足、解析失敗或看不清楚，明確說不知道或看不清楚，不要猜人物、事件或缺少的畫面。",
    "PDF、文字與 log 的內容在 text 欄位。不要向使用者提及 preprocessing、CRV、schema 或內部檔案路徑。",
    JSON.stringify(payload),
  ].join("\n");
}

function unsupportedAudioContext(prompt, requestId) {
  const payload = {
    schema: "rana.media.understanding.v1",
    requestId,
    kind: "audio",
    status: "unsupported",
    userQuestion: userQuestion(prompt),
    responseContract: {
      answerQuestionFirst: true,
      stateAudioUnderstandingUnavailable: true,
      doNotGuessAudioContent: true,
      avoidInternalPipelineTerms: true,
    },
  };
  return {
    kind: "media",
    requestId,
    payload,
    context: [
      "這個附件是音訊。目前沒有音訊理解模型，不能聽取、轉錄或判斷內容。",
      "直接簡短說目前不能聽這個音訊。不要猜語音、歌曲、人物、事件或環境聲。",
      JSON.stringify(payload),
    ].join("\n"),
  };
}

export async function buildMediaEvidenceContext(prompt, options = {}) {
  if (hasAudioAttachment(prompt)) {
    return unsupportedAudioContext(prompt, options.requestId || createVisionRequestId());
  }
  if (!directMediaAttachment(prompt) && !replyReference(prompt)) return null;
  const requestId = options.requestId || createVisionRequestId();
  const materialized = await materializeRequest(prompt, requestId, options);
  if (!materialized) return null;
  const preprocessed = await (options.preprocess || runPreprocessor)(materialized.path, requestId, options);
  const observations = await analyzeVisuals(preprocessed, requestId, options);
  const question = userQuestion(prompt);
  const identity = await resolveMediaIdentity(preprocessed, question, requestId, options);
  const payload = compactPayload(preprocessed, observations, requestId, question, identity);
  await (options.trace || traceVision)(requestId, "final_media_payload", payload, { force: true });
  return {
    kind: "media",
    requestId,
    payload,
    context: mediaContext(payload),
  };
}

export const __test = {
  compactPayload,
  directMediaAttachment,
  hasAudioAttachment,
  mediaContext,
  replyReference,
  resolveMediaIdentity,
  unsupportedAudioContext,
  userQuestion,
};

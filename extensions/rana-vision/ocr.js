import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceVision } from "./debug.js";

const SCRIPT_PATH = fileURLToPath(new URL("./ocr.ps1", import.meta.url));
const OCR_TIMEOUT_MS = 15_000;

function extensionFor(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/bmp") return ".bmp";
  return ".png";
}

function runPowerShell(imagePath, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT_PATH,
      "-ImagePath",
      imagePath,
    ];
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      const error = new Error(`local OCR timed out after ${OCR_TIMEOUT_MS}ms`);
      error.execution = { command: "powershell.exe", args, exit_code: null, stdout, stderr };
      reject(error);
    }, OCR_TIMEOUT_MS);
    const abort = () => {
      child.kill();
      const error = signal?.reason || new Error("local OCR aborted");
      error.execution = { command: "powershell.exe", args, exit_code: null, stdout, stderr };
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (code !== 0) {
        const error = new Error(stderr.trim() || `local OCR exited with code ${code}`);
        error.execution = { command: "powershell.exe", args, exit_code: code, stdout, stderr };
        reject(error);
        return;
      }
      resolve({ command: "powershell.exe", args, exit_code: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function normalizeOcrLine(value) {
  return String(value || "")
    .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function analyzeWithLocalOcr(image, mimeType, signal, requestId) {
  const directory = path.join(os.tmpdir(), "rana-vision-ocr");
  const imagePath = path.join(directory, `${randomUUID()}${extensionFor(mimeType)}`);
  await mkdir(directory, { recursive: true });
  await writeFile(imagePath, image);
  await traceVision(requestId, "local_ocr_request", { source: "Windows.Media.Ocr", mime_type: mimeType });
  try {
    const execution = await runPowerShell(imagePath, signal);
    const raw = execution.stdout;
    const parsed = JSON.parse(raw);
    const lines = Array.isArray(parsed.lines) ? parsed.lines.map(String).filter(Boolean) : [];
    const normalizedLines = [...new Set(lines.map(normalizeOcrLine).filter(Boolean))];
    const result = {
      status: parsed.status || "ok",
      source: parsed.source || "Windows.Media.Ocr",
      languages: Array.isArray(parsed.languages) ? parsed.languages : [],
      text: String(parsed.text || ""),
      lines,
      normalized_lines: normalizedLines,
      normalized_text: normalizedLines.join("\n"),
      raw,
      results: Array.isArray(parsed.results) ? parsed.results : [],
      execution,
    };
    await traceVision(requestId, "local_ocr_raw_response", result);
    console.log(`[rana-vision] request=${requestId} local_ocr status=${result.status} lines=${result.lines.length}`);
    return result;
  } catch (error) {
    const result = { status: "unavailable", source: "Windows.Media.Ocr", lines: [], normalized_lines: [], text: "", normalized_text: "", raw: "", execution: error?.execution, error: String(error?.message || error) };
    await traceVision(requestId, "local_ocr_raw_response", result, { force: true });
    console.warn(`[rana-vision] request=${requestId} local_ocr status=unavailable error=${result.error}`);
    return result;
  } finally {
    await rm(imagePath, { force: true }).catch(() => {});
  }
}

export const __test = { normalizeOcrLine };

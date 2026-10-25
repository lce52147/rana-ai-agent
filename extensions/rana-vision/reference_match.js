import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceVision } from "./debug.js";

const SCRIPT_PATH = fileURLToPath(new URL("./reference_match.ps1", import.meta.url));
const REFERENCE_ROOT = fileURLToPath(new URL("./references/source/", import.meta.url));
const TIMEOUT_MS = 30_000;

function runPowerShell(imagePath, signal) {
  return new Promise((resolve, reject) => {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-ImagePath", imagePath, "-ReferenceRoot", REFERENCE_ROOT];
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const finish = (error, value) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`reference matcher timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    const abort = () => {
      child.kill();
      finish(signal?.reason || new Error("reference matcher aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(stderr.trim() || `reference matcher exited with code ${code}`));
      finish(null, JSON.parse(stdout.trim()));
    });
  });
}

function extensionFor(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

export async function matchOfficialReferences(image, mimeType, signal, requestId) {
  const directory = path.join(os.tmpdir(), "rana-vision-reference-match");
  const imagePath = path.join(directory, `${randomUUID()}${extensionFor(mimeType)}`);
  await mkdir(directory, { recursive: true });
  await writeFile(imagePath, image);
  try {
    const parsed = await runPowerShell(imagePath, signal);
    const matches = (parsed.matches || []).map((item) => ({ ...item, similarity: Number(item.similarity || 0) }));
    const result = { ...parsed, matches };
    await traceVision(requestId, "official_reference_match", result, { force: true });
    return result;
  } catch (error) {
    const result = { status: "unavailable", source: "local official-reference matcher", matches: [], error: String(error?.message || error) };
    await traceVision(requestId, "official_reference_match", result, { force: true });
    return result;
  } finally {
    await rm(imagePath, { force: true }).catch(() => {});
  }
}

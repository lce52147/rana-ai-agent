import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure, prewarm } from "./identity-engine.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(APP_DIR);
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configPath = configArg ? configArg.slice("--config=".length) : path.join(ROOT_DIR, "config.json");
const raw = JSON.parse(await readFile(configPath, "utf8"));
configure({
  ...raw,
  threads: Math.max(1, Math.min(os.cpus().length, Number(raw.threads || os.cpus().length))),
  modelCacheDir: path.resolve(ROOT_DIR, raw.modelCacheDir || "cache/models"),
  modelPath: path.resolve(ROOT_DIR, raw.modelPath || "models/clip-vit-base-patch32"),
  cacheDir: path.resolve(ROOT_DIR, raw.cacheDir || "cache"),
  bankCachePath: path.resolve(ROOT_DIR, raw.bankCachePath || "cache/reference-bank.json"),
});
const result = await prewarm({
  rebuild: process.argv.includes("--rebuild"),
  onProgress: ({ completed, total, id }) => process.stdout.write(`[${completed}/${total}] ${id}\n`),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

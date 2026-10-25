import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const [sourceDirArg, evidenceDirArg] = process.argv.slice(2);
if (!sourceDirArg || !evidenceDirArg) {
  throw new Error("usage: node snapshot_llama_build.mjs <source-dir> <evidence-dir>");
}

const sourceDir = path.resolve(sourceDirArg);
const evidenceDir = path.resolve(evidenceDirArg);
fs.mkdirSync(evidenceDir, { recursive: true });

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    const stat = fs.statSync(fullPath);
    return [{
      relative_path: path.relative(sourceDir, fullPath),
      full_path: fullPath,
      bytes: stat.size,
      modified_utc: stat.mtime.toISOString(),
    }];
  });
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const files = walk(sourceDir).sort((a, b) => a.relative_path.localeCompare(b.relative_path));
const hashTargets = files.filter((item) => {
  const name = path.basename(item.full_path).toLowerCase();
  return name === "llama-server.exe" || name.endsWith(".dll");
});
const hashes = hashTargets.map((item) => ({ ...item, sha256: sha256(item.full_path) }));
const serverPath = path.join(sourceDir, "llama-server.exe");
const versionProcess = fs.existsSync(serverPath)
  ? spawnSync(serverPath, ["--version"], { encoding: "utf8", windowsHide: true })
  : null;
const version = versionProcess
  ? `${versionProcess.stdout ?? ""}${versionProcess.stderr ?? ""}`.trim()
  : null;

const snapshot = {
  captured_utc: new Date().toISOString(),
  source_dir: sourceDir,
  version,
  files,
  hashes,
};
fs.writeFileSync(path.join(evidenceDir, "inventory.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
fs.writeFileSync(
  path.join(evidenceDir, "inventory.tsv"),
  ["relative_path\tbytes\tmodified_utc", ...files.map((x) => `${x.relative_path}\t${x.bytes}\t${x.modified_utc}`)].join("\n") + "\n",
);
fs.writeFileSync(
  path.join(evidenceDir, "hashes.sha256"),
  hashes.map((x) => `${x.sha256} *${x.relative_path}`).join("\n") + "\n",
);
process.stdout.write(`${JSON.stringify({ evidenceDir, version, fileCount: files.length, hashCount: hashes.length })}\n`);

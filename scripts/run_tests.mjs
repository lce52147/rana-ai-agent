import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs every *.test.mjs in the repo with node:test. Tests that need the live
// OpenClaw install (its dist files or openclaw.json) skip themselves elsewhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "_review"]);

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findTests(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith(".test.mjs")) {
      found.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
  return found;
}

const files = findTests(ROOT).sort();
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

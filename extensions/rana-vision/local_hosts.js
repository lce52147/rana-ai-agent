import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Network addresses of the machines on the user's own network (the laptop that
// serves the VLM) are kept out of git in <openclaw root>/hosts.local.json.
// Fresh clones and `node --test` runs use the committed hosts.example.json.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_NAME = "hosts.local.json";
const EXAMPLE_NAME = "hosts.example.json";

function findUp(name) {
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveHostsFile() {
  if (process.env.RANA_HOSTS_FILE) return process.env.RANA_HOSTS_FILE;
  if (!process.env.NODE_TEST_CONTEXT) {
    const home = path.join(os.homedir(), ".openclaw", LOCAL_NAME);
    const local = findUp(LOCAL_NAME) || (fs.existsSync(home) ? home : null);
    if (local) return local;
  }
  return findUp(EXAMPLE_NAME);
}

let cached;

export function localHosts() {
  if (cached) return cached;
  const file = resolveHostsFile();
  const raw = file ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};
  cached = Object.freeze({ ...raw });
  return cached;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Discord IDs (owner, bot, guild, channel, roles) are kept out of git in
// <openclaw root>/discord_ids.local.json. Fresh clones and `node --test` runs
// use the committed discord_ids.example.json, which holds fake IDs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_NAME = "discord_ids.local.json";
const EXAMPLE_NAME = "discord_ids.example.json";

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

function resolveIdsFile() {
  if (process.env.RANA_DISCORD_IDS_FILE) return process.env.RANA_DISCORD_IDS_FILE;
  if (!process.env.NODE_TEST_CONTEXT) {
    const home = path.join(os.homedir(), ".openclaw", LOCAL_NAME);
    const local = findUp(LOCAL_NAME) || (fs.existsSync(home) ? home : null);
    if (local) return local;
    console.warn(`[rana-runtime] ${LOCAL_NAME} not found; using fake IDs from ${EXAMPLE_NAME}`);
  }
  return findUp(EXAMPLE_NAME);
}

let cached;

export function localDiscordIds() {
  if (cached) return cached;
  const file = resolveIdsFile();
  const raw = file ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};
  cached = Object.freeze({ ...raw, security: Object.freeze({ ...(raw.security || {}) }) });
  return cached;
}

// rules.json keeps the security field names; the IDs themselves come from the local file.
export function withLocalSecurity(rules = {}) {
  const security = { ...(rules?.security || {}) };
  for (const [field, ids] of Object.entries(localDiscordIds().security)) {
    if (!Array.isArray(ids)) continue;
    const current = Array.isArray(security[field]) ? security[field] : [];
    security[field] = [...new Set([...current, ...ids].map(String))];
  }
  return { ...rules, security };
}

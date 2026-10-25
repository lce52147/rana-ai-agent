// CommonJS twin of extensions/rana-runtime/local_discord_ids.js for the workspace services.
// Discord IDs are kept out of git in <openclaw root>/discord_ids.local.json; fresh clones and
// `node --test` runs use the committed discord_ids.example.json (fake IDs).
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCAL_NAME = "discord_ids.local.json";
const EXAMPLE_NAME = "discord_ids.example.json";

function findUp(name) {
  let dir = __dirname;
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
    console.warn(`[rana-services] ${LOCAL_NAME} not found; using fake IDs from ${EXAMPLE_NAME}`);
  }
  return findUp(EXAMPLE_NAME);
}

let cached;

function localDiscordIds() {
  if (cached) return cached;
  const file = resolveIdsFile();
  const raw = file ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};
  cached = Object.freeze({ ...raw, security: Object.freeze({ ...(raw.security || {}) }) });
  return cached;
}

function withLocalSecurity(rules = {}) {
  const security = { ...(rules?.security || {}) };
  for (const [field, ids] of Object.entries(localDiscordIds().security)) {
    if (!Array.isArray(ids)) continue;
    const current = Array.isArray(security[field]) ? security[field] : [];
    security[field] = [...new Set([...current, ...ids].map(String))];
  }
  return { ...rules, security };
}

module.exports = { localDiscordIds, withLocalSecurity };

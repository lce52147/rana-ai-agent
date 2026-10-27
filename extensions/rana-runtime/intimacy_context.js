// Intimacy toward the current speaker: the total gifts that speaker has given this character
// (hot_tools gift ledger, table character_gifts, all five currencies 1:1). The level only sets
// tone; it grants no facts. Levels and per-character tone live in intimacy_tiers.json.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveBotContext } from "./bot_context.js";
import { senderIdFromEvent } from "./architecture/pre_dispatch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIERS_PATH = path.join(HERE, "intimacy_tiers.json");
const GIFT_DB_PATH = path.resolve(process.env.RANA_GIFT_DB_PATH || path.join(HERE, "..", "..", "state", "rana_gifts.sqlite"));

let tiersCache = { mtimeMs: -1, value: null };
export function loadIntimacyTiers(file = TIERS_PATH) {
  try {
    const { mtimeMs } = fs.statSync(file);
    if (file !== TIERS_PATH || mtimeMs !== tiersCache.mtimeMs) {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (file !== TIERS_PATH) return value;
      tiersCache = { mtimeMs, value };
    }
    return tiersCache.value;
  } catch {
    return null;
  }
}

export function intimacyLevel(total, tiers) {
  const levels = Array.isArray(tiers?.levels) ? tiers.levels : [];
  const count = Math.max(0, Number(total) || 0);
  return levels.find((lv) => count >= lv.min && (lv.max == null || count <= lv.max)) || levels[0] || null;
}

let db;
// Read-only and opened lazily; a missing database or table just means nobody has given anything yet.
export function giftTotal(botId, userId) {
  if (!botId || !/^\d{15,25}$/.test(String(userId || ""))) return 0;
  try {
    if (!db) {
      if (!fs.existsSync(GIFT_DB_PATH)) return 0;
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      db = new DatabaseSync(GIFT_DB_PATH, { readOnly: true });
    }
    const row = db.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM character_gifts WHERE bot_id = ? AND user_id = ?").get(botId, String(userId));
    return Number(row?.total) || 0;
  } catch {
    return 0;
  }
}

export function intimacyLines(personaId, total, tiers = loadIntimacyTiers()) {
  const level = intimacyLevel(total, tiers);
  const tone = tiers?.personas?.[personaId]?.tones?.[(level?.level || 1) - 1];
  if (!level || !tone) return "";
  // Plain sentences, not KEY=VALUE atoms: the lean prompt keeps sentences and drops short atoms.
  const examples = (tone.examples || []).map((line) => `「${line}」`).join("");
  return [
    `Your closeness with the person speaking now is Lv.${level.level} of 5 (${level.name}). Tone at this level: ${tone.tone}`,
    ...(examples ? [`Tone samples for this level, for feel only: ${examples}. Do not copy them, and do not take events, objects or plans from them.`] : []),
    "Let this level set only your warmth, openness and how much you seek this person out. It adds no facts. Never mention the level or any gift count.",
  ].join("\n");
}

export function buildIntimacyContext(event, ctx) {
  try {
    const botContext = resolveBotContext(event, ctx);
    if (!botContext) return "";
    const total = giftTotal(botContext.botId, senderIdFromEvent(event, ctx));
    return intimacyLines(botContext.personaId, total);
  } catch {
    return "";
  }
}

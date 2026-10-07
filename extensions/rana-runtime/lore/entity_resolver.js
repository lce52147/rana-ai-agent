import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTITY_PATH = path.resolve(MODULE_DIR, "..", "..", "..", "workspace", "LORE", "generated", "rag", "canonical_entities.json");
const CONTEXT_TTL_MS = 15 * 60 * 1000;
const sessionEntities = new Map();
let cache = { mtimeMs: 0, data: null };

export function normalizeAlias(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function loadCanonicalEntities() {
  const stat = fs.statSync(ENTITY_PATH);
  if (!cache.data || cache.mtimeMs !== stat.mtimeMs) {
    cache = {
      mtimeMs: stat.mtimeMs,
      data: JSON.parse(fs.readFileSync(ENTITY_PATH, "utf8")),
    };
  }
  return cache.data;
}

function publicEntity(entity, matchedAlias = "", source = "alias") {
  return {
    entity_id: entity.entityId,
    canonical_id: entity.canonicalId,
    canonical_name: entity.canonicalName,
    matched_alias: matchedAlias,
    source,
  };
}

export function resolveEntityMentions(text, options = {}) {
  const entities = loadCanonicalEntities().entities;
  const haystack = normalizeAlias(text);
  const matches = [];

  for (const entity of entities) {
    const aliases = [...entity.aliases]
      .sort((left, right) => normalizeAlias(right).length - normalizeAlias(left).length);
    const matchedAlias = aliases.find((alias) => {
      const needle = normalizeAlias(alias);
      if (needle.length >= 2) return haystack.includes(needle);
      return needle.length === 1
        && String(text || "").normalize("NFKC").includes(String(alias).normalize("NFKC"));
    });
    if (matchedAlias) matches.push(publicEntity(entity, matchedAlias));
  }

  for (const forced of options.forcedEntityIds || []) {
    const entity = entities.find((item) => item.entityId === forced || item.canonicalId === forced);
    if (entity && !matches.some((item) => item.entity_id === entity.entityId)) {
      matches.push(publicEntity(entity, "", "vision"));
    }
  }

  if (options.sessionKey && /(?:她|他|那個人|這個人|那位|這位)/u.test(String(text || ""))) {
    const remembered = recallResolvedEntities(options.sessionKey);
    for (const item of remembered) {
      if (!matches.some((match) => match.entity_id === item.entity_id)) {
        matches.push({ ...item, source: "session_pronoun" });
      }
    }
  }

  return matches;
}

export function rememberResolvedEntities(sessionKey, entities) {
  const key = String(sessionKey || "").trim();
  if (!key || !Array.isArray(entities) || entities.length === 0) return;
  sessionEntities.set(key, {
    updatedAt: Date.now(),
    entities: entities.map((item) => ({ ...item })),
  });
}

export function recallResolvedEntities(sessionKey) {
  const key = String(sessionKey || "").trim();
  const item = sessionEntities.get(key);
  if (!item || Date.now() - item.updatedAt > CONTEXT_TTL_MS) {
    if (item) sessionEntities.delete(key);
    return [];
  }
  return item.entities.map((entity) => ({ ...entity }));
}

export function clearResolvedEntities(scope) {
  const key = String(scope || "").trim();
  if (!key) return;
  sessionEntities.delete(key);
  for (const storedKey of sessionEntities.keys()) {
    if (storedKey.startsWith(`${key}|user:`)) sessionEntities.delete(storedKey);
  }
}

export const __test = { normalizeAlias, resolveEntityMentions };

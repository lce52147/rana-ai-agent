import fs from "node:fs";
import path from "node:path";
import { getPersonaProfile, isKnownPersonaId } from "./persona_registry.js";
import { extractUserMessageText, firstText, stripRanaMention } from "./tool_contracts.js";
import { loadCanonicalEntities, normalizeAlias } from "./lore/entity_resolver.js";

function compact(value) {
  return firstText(value).replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return String(value || "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function memoryWorkspaceDir(ctx = {}) {
  const fromCtx = String(ctx?.workspaceDir || "").trim();
  if (fromCtx) return fromCtx;
  const explicitAgent = String(ctx?.agentId || ctx?.agent_id || "").trim();
  const sessionKey = String(ctx?.sessionKey || ctx?.session_key || "").trim();
  const sessionAgent = sessionKey.match(/^agent:([^:]+):/u)?.[1] || "";
  if (explicitAgent && sessionAgent && explicitAgent !== sessionAgent) return "";
  const agentId = explicitAgent || sessionAgent;
  if (!isKnownPersonaId(agentId)) return "";
  return String(getPersonaProfile(agentId)?.workspace || "").trim();
}

function isCanonicalLoreCue(value) {
  const key = normalizeAlias(value);
  if (!key || /^\d{15,25}$/u.test(String(value || "")) || /^<@!?\d{15,25}>$/u.test(String(value || ""))) return false;
  try {
    const entities = loadCanonicalEntities()?.entities || [];
    return entities.some((entity) => {
      const names = [entity?.canonicalName, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])];
      return names.some((name) => normalizeAlias(name) === key);
    });
  } catch {
    return false;
  }
}

function memoryCueCandidates(content) {
  const out = [];
  const colon = content.match(/^(.{2,64}?)[\uFF1A:]\s*(.+)$/u);
  if (colon?.[1]) out.push(colon[1].trim());

  for (const match of content.matchAll(/<@!?(\d{15,25})>/gu)) {
    out.push(`<@${match[1]}>`);
    out.push(match[1]);
  }

  // OpenClaw may render a real Discord mention as @display-name in the text
  // while the stable ID is carried separately. Prefixes preserve a short
  // nickname cue such as 烈焰 without making the display name the identity key.
  for (const match of content.matchAll(/@([^\s，,。；;：:()（）]{2,32})/gu)) {
    const alias = match[1].trim();
    for (let len = 2; len <= Math.min(alias.length, 12); len += 1) out.push(alias.slice(0, len));
  }

  const tail = content.match(/(?:說要|想要|喜歡|愛吃|常吃|討厭|偏好)\s*([^，。；;]{2,24})[。.]?$/u);
  if (tail?.[1]) out.push(tail[1].trim());
  return [...new Set(out.filter(Boolean))];
}

export function resolveDurableMemoryMatch(prompt, ctx = {}) {
  const userText = compact(stripRanaMention(extractUserMessageText(prompt)));
  const comparableUser = normalizeComparable(userText);
  if (!comparableUser) return null;

  const workspaceDir = memoryWorkspaceDir(ctx);
  if (!workspaceDir) return null;
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  let raw = "";
  try {
    raw = fs.readFileSync(memoryPath, "utf8").replace(/^\uFEFF/u, "");
  } catch {
    return null;
  }

  for (const sourceLine of raw.split(/\r?\n/u)) {
    const bullet = sourceLine.match(/^\s*[-*]\s+(.+?)\s*$/u);
    if (!bullet?.[1]) continue;
    const content = bullet[1].trim();
    for (const cue of memoryCueCandidates(content)) {
      const comparableCue = normalizeComparable(cue);
      if (comparableCue.length < 2 || !comparableUser.includes(comparableCue)) continue;
      if (isCanonicalLoreCue(cue)) continue;
      return {
        cue,
        subject: cue,
        content,
        memoryPath,
        source: "durable_memory",
        evidenceClass: "CONTROLLED_DURABLE_MEMORY",
      };
    }
  }
  return null;
}

export const __test = { isCanonicalLoreCue, memoryCueCandidates, normalizeComparable };

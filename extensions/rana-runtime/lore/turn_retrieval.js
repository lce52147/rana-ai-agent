import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Search, buildBm25, sanitizeEvidenceText } from "./search_core.js";
import { resolveEntityMentions } from "./entity_resolver.js";
import { getPersonaProfile, MYGO_PERSONA_IDS } from "../persona_registry.js";
import { listMemories } from "../memory/store.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
const CONFIG_PATH = path.join(ROOT, "extensions", "rana-runtime", "retrieval.config.json");
const DEFAULT_CONFIG = Object.freeze({
  embedding: {
    endpoint: "http://127.0.0.1:6971",
    model: "embeddinggemma-2-Q8_0.gguf",
    timeoutMs: 3500,
    cacheDir: "workspace/LORE/generated/rag/embeddings",
  },
  k: 3,
  embeddingThreshold: 0.48,
  noEntityEmbeddingThreshold: 0.62,
  fallbackThreshold: 0.3,
  noEntityFallbackThreshold: 0.7,
});
const corpusCache = new Map();
const queryEmbeddingCache = new Map();
const RECENT_TIME_RE = /(?:最近|目前|現在|今天|昨天|昨日|前天|這幾天|這陣子|剛剛|刚刚)/u;
const RECENT_TIME_BOUNDARY_LINE = "The user is asking about recent or current time. The character material here is from the past, not recent. Do not present any of it as recent. For a self-only current-state question, use your own usual voice to say in one or two short sentences that things are as usual, then stop; do not say you are busy,「每天」or「維持日常」, or name any current activity, project, study, conversation, plan, practice, work, or errand unless a supplied current-situation list explicitly gives it. If no MyGO!!!!! current-situation list is supplied, keep that general and stop. For what is happening now, use only the MyGO!!!!! current-situation list if one is given.";
const RELATION_QUERY_RE = /(?:關係|关系|相處|相处|發生|发生|經歷|经历|記得|记得|以前|那次|一起|互動|互动|怎麼認識|怎么认识|什麼事|什么事)/u;
const ROLE_QUERY_RE = /(?:做什麼|做什么|負責|负责|是誰|是谁|什麼角色|什么角色|(?:哪個|哪个|哪)(?:樂團|乐团|團|团)|什麼樂團|什么乐团|擔任|担任|位置|\bpart\b|本名|主唱|鼓手|貝斯手|贝斯手)/iu;
const UNRESOLVED_BOUNDARY_LINES = [
  "Evidence coverage is insufficient.",
  "Keep the requested detail unresolved when the supplied character material does not answer it.",
  "The available character material does not directly answer the requested subject or aspect.",
  "Keep that claim unresolved. Do not complete it from role stereotypes, nearby facts, general knowledge, plausibility, or a first-person story.",
].join("\n");
const MUSIC_TOOL_RE = /^(?:幫我|请|請)?\s*(?:播放|播出|搜尋歌曲|搜歌|停止播放|跳過|暫停)/u;
const VERBATIM_RE = /(?:原樣|原样|一字不改|逐字|verbatim|exactly|as[- ]is)\s*(?:回覆|回复|回答|輸出|输出|照抄|重複|重复|repeat|echo)/iu;
const GENERIC_QUESTION_RE = /(?:嗎|吗|呢|[？?]|誰|谁|什麼|什么|哪些|哪個|哪个|哪裡|哪里|怎麼|怎么|如何|會不會|会不会|有沒有|有没有|是不是|能不能|可以嗎|可以吗)\s*$/u;
const ORDINARY_NO_ENTITY_RE = /(?:天氣|天气|冷|熱|热|累|困|餓|饿|燈光|燈泡|貓|猫)/u;
const PERSONAS = Object.freeze([...MYGO_PERSONA_IDS]);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")); } catch { return null; }
}

function retrievalConfig() {
  const file = readJson(CONFIG_PATH) || {};
  const configured = file.embedding || {};
  const endpoint = String(process.env.RANA_EMBEDDING_URL || configured.endpoint || DEFAULT_CONFIG.embedding.endpoint).trim();
  return {
    ...DEFAULT_CONFIG,
    ...file,
    embedding: { ...DEFAULT_CONFIG.embedding, ...configured, endpoint, model: String(configured.model || DEFAULT_CONFIG.embedding.model), timeoutMs: Math.max(250, Number(configured.timeoutMs || DEFAULT_CONFIG.embedding.timeoutMs)) },
    k: Math.max(1, Number(file.k || DEFAULT_CONFIG.k)),
    embeddingThreshold: Number(file.embeddingThreshold || DEFAULT_CONFIG.embeddingThreshold),
    noEntityEmbeddingThreshold: Number(file.noEntityEmbeddingThreshold || DEFAULT_CONFIG.noEntityEmbeddingThreshold),
    fallbackThreshold: Number(file.fallbackThreshold || DEFAULT_CONFIG.fallbackThreshold),
    noEntityFallbackThreshold: Number(file.noEntityFallbackThreshold || DEFAULT_CONFIG.noEntityFallbackThreshold),
  };
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-Hant").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function personaData(personaId) {
  if (corpusCache.has(personaId)) return corpusCache.get(personaId);
  const profile = getPersonaProfile(personaId);
  if (!profile) return null;
  const filePath = path.join(profile.workspace, "LORE", "runtime");
  const file = fs.existsSync(filePath) ? fs.readdirSync(filePath).find((name) => /^06_.*_Character_Impressions\.json$/iu.test(name)) : null;
  const data = file ? readJson(path.join(filePath, file)) : null;
  const value = { data, profile, source: file ? path.join("LORE", "runtime", file).replaceAll("\\", "/") : "" };
  corpusCache.set(personaId, value);
  return value;
}

function hardRuleDecision(query) {
  const text = String(query || "").trim();
  if (!text) return { skip: true, reason: "empty" };
  if (VERBATIM_RE.test(text)) return { skip: true, reason: "verbatim_payload" };
  if (MUSIC_TOOL_RE.test(text)) return { skip: true, reason: "music_tool_command" };
  const recent = RECENT_TIME_RE.test(text);
  return { skip: false, reason: recent ? "recent_time_boundary" : "eligible", recent, boundary: recent ? RECENT_TIME_BOUNDARY_LINE : "" };
}

function aliasesForEntity(entity) {
  return [entity?.canonical_name, entity?.matched_alias].filter(Boolean).map(normalize);
}

function entityMatches(candidate, entities) {
  const haystack = normalize(`${candidate.title || ""}\n${candidate.content || ""}`);
  return entities.some((entity) => aliasesForEntity(entity).some((alias) => alias && haystack.includes(alias)));
}

function structuralCandidates(personaId, query, entities) {
  const bundle = personaData(personaId);
  const characters = Array.isArray(bundle?.data?.characters) ? bundle.data.characters : [];
  const self = String(bundle?.data?.character || bundle?.profile?.canonicalName || "");
  const selfMentioned = /(?:我|你|妳|我的|你的|妳的)\s*(?:和|跟|與|同|的)?/u.test(String(query || ""));
  const candidates = [];
  const add = (entry) => { if (entry.content && !candidates.some((item) => item.id === entry.id)) candidates.push(entry); };
  for (const item of characters) {
    const name = String(item?.canonicalName || "").trim();
    if (!name) continue;
    const aliases = [name, ...(Array.isArray(item.aliases) ? item.aliases : [])].map(normalize);
    const isSelf = normalize(name) === normalize(self);
    const matched = entities.some((entity) => aliases.some((alias) => alias && aliasesForEntity(entity).includes(alias))) || isSelf;
    if (!matched) continue;
    for (const [index, event] of (Array.isArray(item.relationEvents) ? item.relationEvents : []).entries()) {
      if (!selfMentioned && entities.length > 1) continue;
      const text = String(event?.text || "").trim();
      if (!text) continue;
      add({ id: `relation:${personaId}:${name}:${event?.adv || index + 1}`, title: name, content: text, source: bundle.source, entity: name, kind: "relation_event" });
    }
    for (const [index, fact] of [...(item.allowedKnowledge || []), ...(item.memoryAnchors || [])].entries()) {
      const text = String(fact || "").trim();
      if (!text) continue;
      add({ id: `fact:${personaId}:${name}:${index + 1}`, title: name, content: text, source: bundle.source, entity: name, kind: isSelf ? "self_fact" : "fact" });
    }
  }
  return candidates;
}

function memoryCandidates(personaId, userId) {
  return listMemories({ botId: personaId, userId, limit: 120 }).map((item) => ({
    id: `memory:${item.id}`,
    title: item.subject || "user durable memory",
    content: String(item.content || "").slice(0, 500),
    source: "state/rana_memory.sqlite",
    entity: item.subject || "",
    kind: "memory",
    memoryId: item.id,
  }));
}

function semanticQuery(query, priorText) {
  return [String(query || "").trim(), String(priorText || "").trim()].filter(Boolean).join("\n").slice(-1600);
}

function embeddingTextForQuery(query) { return `task: search result | query: ${String(query || "").trim()}`; }
function embeddingTextForCandidate(candidate) { return `title: ${String(candidate?.title || "none")} | text: ${String(candidate?.content || "")}`; }
function contentHash(content) { return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex"); }

function cacheDirectory(config) {
  const configured = String(config.embedding.cacheDir || DEFAULT_CONFIG.embedding.cacheDir);
  return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
}

function cachePathFor(candidate, config) { return path.join(cacheDirectory(config), `${contentHash(embeddingTextForCandidate(candidate))}.json`); }
function finiteVector(value) { return Array.isArray(value) && value.length >= 8 && value.every((item) => Number.isFinite(Number(item))) ? value.map(Number) : null; }

function readCandidateCache(candidate, config) {
  try {
    const data = JSON.parse(fs.readFileSync(cachePathFor(candidate, config), "utf8"));
    const vector = finiteVector(data?.embedding);
    return data?.contentHash === contentHash(embeddingTextForCandidate(candidate)) && data?.model === config.embedding.model && vector ? vector : null;
  } catch { return null; }
}

function writeCandidateCache(candidate, vector, config) {
  const filePath = cachePathFor(candidate, config);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ contentHash: contentHash(embeddingTextForCandidate(candidate)), model: config.embedding.model, embedding: vector })}\n`, "utf8");
    fs.renameSync(temp, filePath);
    return true;
  } catch { return false; }
}

function embeddingsUrl(endpoint) {
  const clean = String(endpoint || "").replace(/\/$/u, "");
  return clean.endsWith("/v1") ? `${clean}/embeddings` : `${clean}/v1/embeddings`;
}

async function requestEmbeddings(inputs, config) {
  const response = await fetch(embeddingsUrl(config.embedding.endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: inputs, model: config.embedding.model }), signal: AbortSignal.timeout(config.embedding.timeoutMs) });
  if (!response.ok) return { ok: false, reason: `http_${response.status}` };
  const json = await response.json();
  const data = Array.isArray(json?.data) ? [...json.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
  const vectors = data.map((item) => finiteVector(item?.embedding));
  return vectors.length === inputs.length && vectors.every(Boolean) ? { ok: true, vectors } : { ok: false, reason: "invalid_shape" };
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] * left[index]; rightNorm += right[index] * right[index]; }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : -1;
}

async function optionalEmbedding(query, candidates, config) {
  const key = `${config.embedding.endpoint}|${config.embedding.model}|${query}|${candidates.map((item) => contentHash(embeddingTextForCandidate(item))).join(",")}`;
  if (queryEmbeddingCache.has(key)) return queryEmbeddingCache.get(key);
  try {
    const queryResponse = await requestEmbeddings([embeddingTextForQuery(query)], config);
    if (!queryResponse.ok) return { status: "unavailable", reason: `query_${queryResponse.reason}`, cacheHits: 0, cacheMisses: candidates.length, cacheWrites: 0 };
    const queryVector = queryResponse.vectors[0];
    const vectors = [];
    const misses = [];
    let cacheHits = 0;
    candidates.forEach((candidate, index) => { const cached = readCandidateCache(candidate, config); if (cached) { vectors[index] = cached; cacheHits += 1; } else misses.push({ candidate, index }); });
    let cacheWrites = 0;
    if (misses.length) {
      for (let offset = 0; offset < misses.length; offset += 4) {
        const batch = misses.slice(offset, offset + 4);
        const candidateResponse = await requestEmbeddings(batch.map(({ candidate }) => embeddingTextForCandidate(candidate)), config);
        if (!candidateResponse.ok) return { status: "unavailable", reason: `candidate_${candidateResponse.reason}`, cacheHits, cacheMisses: misses.length, cacheWrites };
        candidateResponse.vectors.forEach((vector, index) => { const item = batch[index]; vectors[item.index] = vector; if (writeCandidateCache(item.candidate, vector, config)) cacheWrites += 1; });
      }
    }
    const result = { status: "available", scores: vectors.map((vector) => cosineSimilarity(queryVector, vector)), dimension: queryVector.length, cacheHits, cacheMisses: misses.length, cacheWrites, endpoint: config.embedding.endpoint };
    queryEmbeddingCache.set(key, result);
    return result;
  } catch (error) { return { status: "unavailable", reason: String(error?.name || "fetch_error"), cacheHits: 0, cacheMisses: candidates.length, cacheWrites: 0 }; }
}

export async function retrieveTurnContext({ personaId, query, priorText = "", sessionKey = "", userId = "" } = {}) {
  const text = String(query || "").trim();
  const hard = hardRuleDecision(text);
  if (hard.skip) return { entries: [], text: "", trace: { rule: hard.reason, embedding: "skipped" }, resolvedEntities: [] };
  const combined = semanticQuery(text, priorText);
  const resolvedEntities = resolveEntityMentions(combined, { sessionKey });
  const profile = getPersonaProfile(personaId);
  if (!profile) return { entries: [], text: hard.boundary || "", trace: { rule: "unknown_persona", embedding: "skipped" }, resolvedEntities };
  if (!resolvedEntities.length && (ORDINARY_NO_ENTITY_RE.test(text) || (!hard.recent && !GENERIC_QUESTION_RE.test(text)))) return { entries: [], text: "", trace: { rule: "ordinary_no_entity_statement", embedding: "skipped" }, resolvedEntities };
  if (hard.recent) return { entries: [], text: hard.boundary, trace: { rule: "recent_time_boundary", embedding: "skipped", resolvedEntities }, resolvedEntities };
  const structural = structuralCandidates(personaId, combined, resolvedEntities);
  const memories = memoryCandidates(personaId, userId);
  const { searchPersonaLore } = await import("../persona_lore.js");
  const searched = searchPersonaLore(personaId, combined, { maxResults: 12, anchors: resolvedEntities.map((item) => item.canonical_name), contentLimit: 900 });
  const unique = [...new Map([...structural, ...searched.map((item) => ({ ...item, kind: "lore_chunk" })), ...memories].map((item) => [item.id, item])).values()];
  if (!unique.length) return { entries: [], text: [hard.boundary, resolvedEntities.length ? UNRESOLVED_BOUNDARY_LINES : ""].filter(Boolean).join("\n"), trace: { rule: resolvedEntities.length ? "entity_scope_empty" : hard.reason, embedding: "skipped" }, resolvedEntities };
  const structuralScoped = resolvedEntities.length ? structural.filter((item) => entityMatches(item, resolvedEntities)) : [];
  const memoryScoped = resolvedEntities.length ? memories.filter((item) => entityMatches(item, resolvedEntities)) : memories;
  const selfMentioned = /(?:我|你|妳|我的|你的|妳的)\s*(?:和|跟|與|同|的)?/u.test(combined);
  const scoped = resolvedEntities.length
    ? (structuralScoped.length ? [...structuralScoped, ...memoryScoped] : unique.filter((item) => entityMatches(item, resolvedEntities)))
    : unique;
  const ownershipScoped = scoped.filter((item) => selfMentioned || resolvedEntities.length < 2 || item.kind !== "relation_event");
  if (!ownershipScoped.length) return { entries: [], text: [hard.boundary, UNRESOLVED_BOUNDARY_LINES].filter(Boolean).join("\n"), trace: { rule: "entity_scope_empty", embedding: "skipped" }, resolvedEntities };
  const relationScoped = ownershipScoped.filter((item) => item.kind === "relation_event");
  const candidateScope = RELATION_QUERY_RE.test(combined) && selfMentioned && resolvedEntities.length === 1 && relationScoped.length
    ? relationScoped
    : ownershipScoped;
  const config = retrievalConfig();
  const roleRequested = ROLE_QUERY_RE.test(text);
  const roleScoped = roleRequested
    ? candidateScope.filter((item) => item.kind === "memory" || /(?:角色|樂團|乐团|主唱|鼓手|貝斯手|贝斯手|吉他|鍵盤|键盘|團長|队长)/u.test(`${item.title}\n${item.content}`))
    : [];
  const roleQuery = roleRequested
    ? "角色 樂團 樂隊 成員 主唱 鼓手 貝斯手"
    : "";
  const rankingCandidates = roleScoped.length ? roleScoped : candidateScope;
  const rankingChunks = rankingCandidates.map((item) => ({ metadata: { sourceTitle: item.title }, content: [item.title, item.content].filter(Boolean).join("\n") }));
  const fallbackQuery = [combined, roleQuery, ...resolvedEntities.map((entity) => entity.canonical_name)].filter(Boolean).join(" ");
  const bm25 = bm25Search(fallbackQuery, rankingChunks, buildBm25(rankingChunks, "trigram"), rankingChunks.length);
  const lexical = new Map(bm25.map((hit) => [hit.index, hit.score]));
  const embedding = await optionalEmbedding(combined, rankingCandidates, config);
  const threshold = resolvedEntities.length ? config.embeddingThreshold : config.noEntityEmbeddingThreshold;
  const scored = rankingCandidates.map((item, index) => {
    const lexicalScore = Number(lexical.get(index) || 0);
    const vectorScore = Number(embedding.scores?.[index] || -1);
    return { ...item, score: embedding.status === "available" ? vectorScore : lexicalScore, lexicalScore, vectorScore };
  });
  const fallbackThreshold = resolvedEntities.length ? config.fallbackThreshold : config.noEntityFallbackThreshold;
  const ranked = embedding.status === "available"
    ? scored.filter((item) => item.vectorScore >= threshold).sort((a, b) => b.vectorScore - a.vectorScore || a.id.localeCompare(b.id))
    : scored.filter((item) => item.lexicalScore >= fallbackThreshold).sort((a, b) => b.lexicalScore - a.lexicalScore || a.id.localeCompare(b.id));
  const selected = ranked.slice(0, config.k).map((item) => ({ ...item, score: Number(item.score.toFixed(6)), entityBoost: 0 }));
  const entries = selected.map((item) => ({ ...item, content: sanitizeEvidenceText(item.content, item.kind === "memory" ? 500 : 900) }));
  const boundary = hard.boundary || (!selected.length && resolvedEntities.length ? UNRESOLVED_BOUNDARY_LINES : "");
  const activeThreshold = embedding.status === "available" ? threshold : fallbackThreshold;
  const coverageSupported = selected.length > 0 && selected[0].score >= activeThreshold + 0.1;
  const trace = { rule: selected.length ? "entity_scoped_cosine_relevance" : (resolvedEntities.length ? "entity_scope_no_match" : hard.reason), ranking: embedding.status === "available" ? "embedding_cosine" : "bm25_fallback", resolvedEntities, embedding: embedding.status, embeddingReason: embedding.reason || "", embeddingEndpoint: embedding.endpoint || config.embedding.endpoint, embeddingDimension: embedding.dimension || 0, candidateCacheHits: embedding.cacheHits || 0, candidateCacheMisses: embedding.cacheMisses || 0, candidateCacheWrites: embedding.cacheWrites || 0, memoryCandidates: memories.length, memorySelected: selected.filter((item) => item.kind === "memory").map((item) => item.memoryId), k: selected.length, threshold: embedding.status === "available" ? threshold : fallbackThreshold, candidates: scored.slice(0, 12).map(({ id, score, lexicalScore, vectorScore, entityBoost, kind }) => ({ id, score, lexicalScore, vectorScore, entityBoost, kind })) };
  const namedEntities = resolvedEntities.map((entity) => entity.matched_alias || entity.canonical_name).filter(Boolean);
  const characters = personaData(personaId)?.data?.characters || [];
  const entityGrounding = resolvedEntities.length
    ? ["Entity grounding:", ...resolvedEntities.map((entity) => {
      const alias = String(entity?.matched_alias || "").trim();
      const canonical = String(entity?.canonical_name || "").trim();
      const character = characters.find((item) => item.canonicalName === canonical);
      const roleFact = roleRequested ? String(character?.allowedKnowledge?.[0] || "").trim() : "";
      const group = String(character?.group || "").trim();
      const role = roleFact ? [group && !roleFact.includes(group) ? group : "", roleFact].filter(Boolean).join("；") : "";
      return `- ${alias && alias !== canonical ? `${alias} = ` : ""}${canonical}${role ? `：${role}` : ""}`;
    })]
    : [];
  const contentOwners = new Map();
  for (const entry of entries) {
    const key = contentHash(entry.content);
    const previous = contentOwners.get(key);
    if (!previous || (entry.kind === "relation_event" && previous.kind !== "relation_event")) contentOwners.set(key, entry);
  }
  const renderedEntriesSource = entries.filter((entry) => contentOwners.get(contentHash(entry.content)) === entry);
  const relationEntries = renderedEntriesSource.filter((entry) => entry.kind === "relation_event");
  const controlledEventEntries = renderedEntriesSource.filter((entry) => entry.kind === "relation_event" || entry.kind === "fact");
  const renderedEntries = renderedEntriesSource.flatMap((entry) => {
    const label = entry.kind === "relation_event"
      ? "directional event:"
      : `source: ${entry.title || entry.source || "controlled Persona LORE"}`;
    if (!["relation_event", "fact", "self_fact"].includes(entry.kind)) return [label, entry.content];
    // Expand only leading actor-less interaction fragments; full events retain their own actors.
    const content = entry.content.replace(/^(在|向|跟|與|和)(?:她|他)/u, (_, preposition) => `${profile.canonicalName}${preposition} ${entry.entity} `);
    return [label, `${profile.canonicalName}記得關於${entry.entity}的事：${content}`];
  });
  const japaneseNameMentioned = resolvedEntities.some((entity) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(entity?.matched_alias || "")));
  const languageInstruction = "Reply in the user's language; Japanese names, aliases and source wording do not require a Japanese reply. Keep exact IDENTITY.md honorifics and nicknames, including Japanese ちゃん/さん forms such as 爽世ちゃん; do not transliterate them to 醬 or 桑. Other Japanese words and grammar do not require a Japanese reply. Honor any explicit language or translation request.";
  const premiseGuidance = controlledEventEntries.length ? "If the user's question assumes a detail the entries do not contain or contradict, answer with what the entries say instead of confirming the assumption." : "";
  const rendered = entries.length || (roleRequested && entityGrounding.length) ? ["CONTROLLED TURN RETRIEVAL:", `active speaker: ${profile.canonicalName}`, namedEntities.length ? `named entity aliases: ${namedEntities.join(", ")}` : "", ...entityGrounding, relationEntries.length ? "CONTROLLED DIRECTIONAL RELATION EVENTS:" : "", "Use only the supplied entries relevant to the user request. Keep the named entity and event ownership exact.", controlledEventEntries.length ? "Only repeat the event sequence and details present in the entries; do not add motives, emotions, dialogue or details absent from the entries. If the user asks about an omitted part, say you do not remember it or are unclear." : "", premiseGuidance, roleRequested ? "For a role question, state the supplied role in the user's language; source-language role terms are evidence and must be translated rather than copied." : "", ...renderedEntries, coverageSupported ? "Coverage: fact is directly supported by the supplied entries." : "", boundary, "Do not mention retrieval, records or internal IDs in the reply.", languageInstruction, japaneseNameMentioned ? "本題用使用者的語言回答" : ""].filter(Boolean).join("\n") : [boundary].filter(Boolean).join("\n");
  return { entries, text: rendered, trace, resolvedEntities };
}

export function hardRuleForTest(query) { return hardRuleDecision(query); }
export function allPersonaIds() { return [...PERSONAS]; }
export const __test = { hardRuleDecision, personaData, structuralCandidates, retrievalConfig, embeddingTextForQuery, embeddingTextForCandidate, contentHash, cosineSimilarity };

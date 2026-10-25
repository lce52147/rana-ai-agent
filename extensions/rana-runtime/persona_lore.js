import { consumeTrustedPersonaToolContext } from "./architecture/persona_tool_capability.js";
import fs from "node:fs";
import path from "node:path";
import { buildBm25, bm25Search, sanitizeEvidenceText } from "./lore/search_core.js";
import { getPersonaProfile } from "./persona_registry.js";
import { buildUnifiedTurnPlan, loreEvidencePlanForTurn, turnPlanNeedsLore } from "./architecture/turn_plan.js";
import { evaluateEvidenceCoverage } from "./architecture/evidence_coverage.js";
import { rememberCanonicalAuthorityPrefetch } from "./persona_context.js";
import { resolveBotContext } from "./bot_context.js";
import { modelFacingContext } from "./architecture/lean_prompt.js";
import { aliasMatchesText, loadCanonicalEntities, normalizeAlias, resolveEntityMentions } from "./lore/entity_resolver.js";
import { retrieveTurnContext } from "./lore/turn_retrieval.js";
import {
  authoritativeTurnPlanFor,
  rememberVerifierPrefetchedCanonicalEvidence,
  resolveTrustedInvocationContext,
  trustedContextHint,
  trustedToolError,
} from "./architecture/turn_isolation.js";

const corpusCache = new Map();

const NON_DIALOGUE_INDEX_SOURCE_TYPES = new Set([
  "official_story_index",
  "interaction_index",
  "program_index",
  "official_short_index",
  "source_audit",
  "coverage_report",
]);

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) || "";
  if (value && typeof value === "object") {
    return firstText(value.query || value.prompt || value.content || value.body || value.text);
  }
  return "";
}

function safeLoreFile(loreRoot, relativePath) {
  const root = path.resolve(loreRoot);
  const filePath = path.resolve(root, String(relativePath || ""));
  if (!filePath.startsWith(root + path.sep)) {
    throw new Error("persona LORE path escaped workspace");
  }
  return filePath;
}

function retrievableManifestRecord(item = {}) {
  const source = String(item?.source || "").trim();
  const title = String(item?.title || "").trim();
  const sourceType = String(item?.sourceType || item?.metadata?.sourceType || "").trim().toLocaleLowerCase("en-US");
  if (!source) return false;

  if (/^LORE_MANIFEST\.md$/iu.test(source)) return false;
  if (/^runtime\/(?:06_.*_Character_Impressions\.json|07_.*_Vision_Identity\.json)$/iu.test(source)) return false;

  // Manifest metadata is the stable classification boundary for generated
  // research/index tables. Titles are presentation text and may vary by
  // language or heading, so they must not decide whether a chunk is dialogue
  // evidence.
  if (NON_DIALOGUE_INDEX_SOURCE_TYPES.has(sourceType)) return false;

  // These files describe deployment, routing, source audit, or research coverage.
  // They are useful to maintain the corpus, but they are not canonical character facts.
  if (/^research\/(?:11_.*_Relationship_Map_Full|12_.*_Interaction_Index|13_.*_Game_Story_Index|15_.*_MaigoShukai_Index|16_.*_Source_Audit|17_.*_Official_Small_Theater_Index|18_Coverage_Report|20_Group_Interaction_Protocol)\.md$/iu.test(source)) {
    return false;
  }

  // Remembered-people files contain useful per-person evidence plus maintenance sections.
  if (/^research\/11_.*_Remembered_People_Evidence\.md$/iu.test(source)
      && /(?:Remembered People Evidence|收錄門檻|修正規則)$/iu.test(title)) {
    return false;
  }

  return true;
}

function supplementalCharacterImpressionRecords(loreRoot) {
  const runtimeDir = path.join(loreRoot, "runtime");
  if (!fs.existsSync(runtimeDir)) return [];
  const entry = fs.readdirSync(runtimeDir, { withFileTypes: true })
    .find((item) => item.isFile() && /^06_.*_Character_Impressions\.json$/iu.test(item.name));
  if (!entry) return [];

  const filePath = path.join(runtimeDir, entry.name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return [];
  }

  const characters = Array.isArray(data?.characters) ? data.characters : [];
  const records = characters.map((item, index) => {
    const canonicalName = String(item?.canonicalName || "").trim();
    if (!canonicalName) return null;
    const aliases = [...new Set((Array.isArray(item?.aliases) ? item.aliases : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))];
    const facts = [...new Set([
      ...(Array.isArray(item?.allowedKnowledge) ? item.allowedKnowledge : []),
      ...(Array.isArray(item?.memoryAnchors) ? item.memoryAnchors : []),
      ...(Array.isArray(item?.relationEvents) ? item.relationEvents.map((event) => event?.text) : []),
    ].map((value) => String(value || "").trim()).filter(Boolean))];
    const boundaries = [...new Set((Array.isArray(item?.forbiddenExpansion) ? item.forbiddenExpansion : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))];

    const lines = [
      `## ${canonicalName}`,
      aliases.length ? `aliases: ${aliases.join(" / ")}` : "",
      ...facts.map((value) => `- 可確認：${value}`),
      ...boundaries.map((value) => `- 邊界：${value}`),
    ].filter(Boolean);

    return {
      id: `character-impression:${index}:${canonicalName}`,
      source: `runtime/character_impressions/${entry.name}`,
      title: canonicalName,
      relativePath: path.relative(loreRoot, filePath).replace(/\\/gu, "/"),
      content: lines.join("\n"),
      metadata: { sourceTitle: canonicalName },
    };
  }).filter(Boolean);

  const knownNames = records.map((item) => item.title).filter(Boolean);
  const ownerName = String(data?.character || "").trim();
  const myGoNames = loadCanonicalEntities().entities
    .filter((item) => String(item?.group || "").split("/").map((value) => value.trim()).includes("MyGO!!!!!"))
    .map((item) => String(item?.canonicalName || "").trim())
    .filter(Boolean);
  const groupRecord = myGoNames.length ? {
    id: "character-impression:mygo-members",
    source: `runtime/character_impressions/${entry.name}`,
    title: `MyGO!!!!! 團員名單（${ownerName || "角色"}）`,
    relativePath: path.relative(loreRoot, filePath).replace(/\\/gu, "/"),
    content: `MyGO!!!!! 團員：${myGoNames.join("、")}`,
    metadata: { sourceTitle: `MyGO!!!!! 團員名單（${ownerName || "角色"}）` },
  } : null;
  const listTitle = ownerName ? `${ownerName}認識的人` : "認識的人";
  const listRecord = knownNames.length ? {
    id: "character-impression:known-people",
    source: `runtime/character_impressions/${entry.name}`,
    title: listTitle,
    relativePath: path.relative(loreRoot, filePath).replace(/\\/gu, "/"),
    content: ownerName
      ? `${ownerName}認識的人：${knownNames.join("、")}`
      : `認識的人：${knownNames.join("、")}`,
    metadata: { sourceTitle: listTitle },
  } : null;

  return [groupRecord, listRecord, ...records].filter(Boolean);
}

function supplementalCharacterImpressionSignature(loreRoot) {
  const runtimeDir = path.join(loreRoot, "runtime");
  if (!fs.existsSync(runtimeDir)) return "";
  const entry = fs.readdirSync(runtimeDir, { withFileTypes: true })
    .find((item) => item.isFile() && /^06_.*_Character_Impressions\.json$/iu.test(item.name));
  if (!entry) return "";
  const filePath = path.join(runtimeDir, entry.name);
  const stat = fs.statSync(filePath);
  return `${entry.name}:${stat.mtimeMs}:${stat.size}`;
}

function supplementalIdentityEventRecords(loreRoot) {
  const directory = path.join(loreRoot, "runtime", "identity_events");
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:md|txt)$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return files.map((name) => {
    const filePath = path.join(directory, name);
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trim();
    if (!content) return null;
    const firstHeading = content.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim() || path.parse(name).name;
    return {
      id: `identity-event:${name}`,
      source: `runtime/identity_events/${name}`,
      title: firstHeading,
      relativePath: path.relative(loreRoot, filePath).replace(/\\/gu, "/"),
      content,
      metadata: { sourceTitle: firstHeading },
    };
  }).filter(Boolean);
}

function supplementalIdentityEventSignature(loreRoot) {
  return supplementalIdentityEventRecords(loreRoot)
    .map((item) => {
      const filePath = safeLoreFile(loreRoot, item.relativePath);
      const stat = fs.statSync(filePath);
      return `${item.relativePath}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");
}

function personaCoreCapabilityRecords(profile, plan) {
  if (!profile || String(plan?.evidence?.requestedAspect || "") !== "character_capability") return [];
  if (String(plan?.subject?.type || "") !== "active_persona") return [];
  const personaPath = path.join(profile.workspace, "PERSONA.json");
  if (!fs.existsSync(personaPath)) return [];
  let persona;
  try {
    persona = JSON.parse(fs.readFileSync(personaPath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return [];
  }
  if (String(persona?.personaId || "") !== String(profile.personaId || "")) return [];
  const content = String(persona?.roleCore?.knowledgeBoundary || "").trim();
  if (!content) return [];
  return [{
    id: `persona-core:${profile.personaId}:knowledgeBoundary`,
    source: "runtime/persona_core/PERSONA.json",
    title: `${persona.canonicalName || profile.canonicalName} Persona core capability boundary`,
    relativePath: "../PERSONA.json",
    content,
    metadata: { sourceTitle: `${persona.canonicalName || profile.canonicalName} Persona core capability boundary` },
  }];
}

// Four personas ship a plain array manifest. Rana's corpus was built earlier
// as a `rana.lore-rag-corpus.v1` object with inline chunk text. Both are read
// through the same resolver; no LORE content is changed.
function normalizeManifestEntries(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (manifest?.schema === "rana.lore-rag-corpus.v1" && Array.isArray(manifest.chunks)) {
    return manifest.chunks.map((chunk) => {
      const meta = chunk?.metadata || {};
      const source = String(meta.sourcePath || "").replace(/^LORE[\\/]/u, "");
      return {
        id: chunk?.id,
        source,
        sourceType: String(meta.sourceType || ""),
        title: String(meta.sourceTitle || source),
        path: String(chunk?.generatedPath || "").replace(/^LORE[\\/]/u, ""),
        content: typeof chunk?.content === "string" ? chunk.content : "",
        metadata: { ...meta },
      };
    });
  }
  throw new Error("persona LORE chunk manifest must be an array or a rana.lore-rag-corpus.v1 object");
}

function readCorpus(personaId) {
  const profile = getPersonaProfile(personaId);
  if (!profile) return null;
  const loreRoot = path.join(profile.workspace, "LORE");
  const manifestPath = path.join(loreRoot, "generated", "rag", "chunk_manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  const manifestStat = fs.statSync(manifestPath);
  const signature = manifestPath + ":" + manifestStat.mtimeMs + ":" + manifestStat.size
    + "|" + supplementalIdentityEventSignature(loreRoot)
    + "|" + supplementalCharacterImpressionSignature(loreRoot);
  const cached = corpusCache.get(personaId);
  if (cached?.signature === signature) return cached.value;

  const manifest = normalizeManifestEntries(JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, "")));

  const manifestChunks = manifest.filter(retrievableManifestRecord).map((item) => {
    const relativePath = String(item?.path || "");
    if (!relativePath) return null;
    const filePath = safeLoreFile(loreRoot, relativePath);
    let content = typeof item?.content === "string" ? item.content.replace(/^\uFEFF/u, "").trim() : "";
    if (!content) {
      if (!fs.existsSync(filePath)) return null;
      content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trim();
    }
    if (!content) return null;
    return {
      id: String(item?.id || relativePath),
      source: String(item?.source || ""),
      title: String(item?.title || item?.source || ""),
      relativePath,
      content,
      metadata: {
        ...(item?.metadata || {}),
        sourceType: String(item?.sourceType || item?.metadata?.sourceType || ""),
        sourceTitle: String(item?.title || item?.source || ""),
      },
    };
  }).filter(Boolean);
  const supplemental = [
    ...supplementalCharacterImpressionRecords(loreRoot),
    ...supplementalIdentityEventRecords(loreRoot),
  ];
  const existingIds = new Set(manifestChunks.map((item) => item.id));
  const chunks = [...manifestChunks, ...supplemental.filter((item) => !existingIds.has(item.id))];

  const runtime = chunks.filter((item) => /^runtime\//iu.test(item.source));
  const research = chunks.filter((item) => /^research\//iu.test(item.source));
  const value = {
    signature,
    all: chunks,
    runtime,
    research,
    allIndex: buildBm25(chunks, "trigram"),
    runtimeIndex: buildBm25(runtime, "trigram"),
    researchIndex: buildBm25(research, "trigram"),
  };
  corpusCache.set(personaId, { signature, value });
  return value;
}

function ranked(query, chunks, index, limit) {
  if (!chunks.length) return [];
  const hits = bm25Search(query, chunks, index, limit);
  return hits.map((hit) => chunks[hit.index]).filter(Boolean);
}

function comparable(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function planAnchors(plan = {}) {
  const values = Array.isArray(plan?.evidence?.anchors) ? plan.evidence.anchors : [];
  const subject = String(plan?.subject?.name || "").trim();
  const out = [...values, subject]
    .map((item) => String(item || "").trim())
    .filter((item) => item && !/^(?:self|user|self_group)$/u.test(item));
  return [...new Set(out)];
}

function retrievalAnchors(plan = {}) {
  const subjectAnchors = planAnchors(plan);
  if (subjectAnchors.length) return subjectAnchors;
  const subjectType = String(plan?.subject?.type || "");
  if (!["active_persona", "active_persona_group"].includes(subjectType)) return subjectAnchors;
  const predicateAnchors = Array.isArray(plan?.evidence?.predicateAnchors)
    ? plan.evidence.predicateAnchors.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return [...new Set(predicateAnchors)];
}

function recordHasAnchor(record, anchors = []) {
  if (!anchors.length) return false;
  const haystack = comparable(`${record?.title || ""}\n${record?.source || ""}\n${record?.content || ""}`);
  return anchors.some((anchor) => haystack.includes(comparable(anchor)));
}

function recordPrimarySubjectCompatible(record = {}, anchors = []) {
  if (!anchors.length) return true;
  const source = String(record?.source || "");
  if (!/^runtime\/character_impressions\//iu.test(source)
      && !/^research\/11_.*_Remembered_People_Evidence\.md$/iu.test(source)) {
    return true;
  }

  const header = comparable([
    record?.title || "",
    ...String(record?.content || "").split(/\r?\n/u).slice(0, 2),
  ].join("\n"));
  return anchors.some((anchor) => {
    const needle = comparable(anchor);
    return needle && header.includes(needle);
  });
}

function isAnswerShapingLoreRecord(record = {}) {
  const source = String(record?.source || "");
  const title = String(record?.title || "");
  return /(?:speech[_ -]?style[_ -]?corpus|conversation[_ -]?mode[_ -]?corpus)/iu.test(source)
    || /^(?:使用者|user)[:：]/iu.test(title);
}

function isPreferenceFactLoreRecord(record = {}) {
  const source = String(record?.source || "");
  const title = String(record?.title || "");
  const content = String(record?.content || "");
  if (/(?:speech[_ -]?style|conversation[_ -]?mode|relationship[_ -]?map|interaction[_ -]?index)/iu.test(source)) return false;
  return /(?:喜歡\s*[:：／/]|喜欢\s*[:：／/]|不喜歡\s*[:：]|不喜欢\s*[:：]|討厭\s*[:：]|讨厌\s*[:：]|興趣\s*[:：]|兴趣\s*[:：]|喜歡／不喜歡|喜欢／不喜欢|CANONICAL_PROFILE_FACT)/iu.test(`${title}\n${content}`);
}

function projectionRecordPriority(record = {}, anchors = []) {
  const title = comparable(record?.title || "");
  const source = String(record?.source || "");
  const exactTitleAnchor = anchors.some((anchor) => {
    const needle = comparable(anchor);
    return needle && (title === needle || title.startsWith(needle) || title.endsWith(needle));
  });
  if (exactTitleAnchor) return 0;
  if (/(?:remembered_people_evidence|thirdperson_lore)/iu.test(source)) return 1;
  if (/(?:relationship_map|interaction_index)/iu.test(source)) return 2;
  if (/^runtime\//iu.test(source)) return 3;
  return 4;
}

function extractAnchorWindow(value, anchors = [], { maxLength = 1100, before = 220 } = {}) {
  const clean = sanitizeEvidenceText(value, Infinity);
  if (!clean) return "";

  let matchIndex = -1;
  let matchLength = 0;
  for (const anchor of anchors) {
    const needle = String(anchor || "").trim();
    if (!needle) continue;
    const index = clean.toLocaleLowerCase("zh-Hant").indexOf(needle.toLocaleLowerCase("zh-Hant"));
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index;
      matchLength = needle.length;
    }
  }

  if (matchIndex < 0) return sanitizeEvidenceText(clean, maxLength);

  const start = Math.max(0, matchIndex - before);
  const end = Math.min(clean.length, Math.max(matchIndex + matchLength + 1, start + maxLength));
  let window = clean.slice(start, end).trim();
  if (start > 0) window = `…${window}`;
  if (end < clean.length) window = `${window}…`;
  return window;
}

export function searchPersonaLore(personaId, query, { maxResults = 5, anchors = [], contentLimit = 1600 } = {}) {
  const cleanQuery = firstText(query).trim();
  if (!cleanQuery) return [];
  const corpus = readCorpus(personaId);
  if (!corpus) return [];

  const runtimeHits = ranked(cleanQuery, corpus.runtime, corpus.runtimeIndex, Math.max(2, maxResults));
  const researchHits = ranked(cleanQuery, corpus.research, corpus.researchIndex, Math.max(4, maxResults * 2));
  const allHits = ranked(cleanQuery, corpus.all, corpus.allIndex, Math.max(6, maxResults * 2));

  const anchorList = [...new Set((anchors || []).map((item) => String(item || "").trim()).filter(Boolean))];
  const exactAnchorRecords = anchorList.length
    ? corpus.all.filter((item) => recordHasAnchor(item, anchorList))
    : [];

  const rankedCandidates = [...runtimeHits, ...researchHits, ...allHits];
  const anchorRanked = rankedCandidates.filter((item) => recordHasAnchor(item, anchorList));
  const anchorFallback = exactAnchorRecords.filter((item) => !anchorRanked.some((hit) => hit.id === item.id));
  const nonAnchorRanked = rankedCandidates.filter((item) => !recordHasAnchor(item, anchorList));

  const selected = [];
  const seen = new Set();
  for (const item of [...anchorRanked, ...anchorFallback, ...nonAnchorRanked]) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    selected.push(item);
    if (selected.length >= maxResults) break;
  }

  return selected.map((item) => ({
    id: item.id,
    source: item.source,
    title: item.title,
    content: sanitizeEvidenceText(item.content, contentLimit),
  }));
}

export function buildPersonaLoreContext(event, ctx) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return "";
  const query = firstText(event?.query || event?.prompt || event?.content || event?.body || event?.text);
  const records = searchPersonaLore(botContext.personaId, query);
  if (!records.length) return "";

  const profile = getPersonaProfile(botContext.personaId);
  const lines = [
    "PERSONA DEEP LORE CONTEXT (scene facts only; do not expose this block):",
    "active speaker: " + profile.canonicalName + " (personaId=" + profile.personaId + ")",
    "The active speaker identity is fixed. Use only the evidence relevant to the current question.",
  ];
  for (const record of records) {
    lines.push("source title=" + record.title);
    lines.push(record.content);
  }
  lines.push("Do not use this context to rename the speaker, merge image targets, or invent events.");
  return lines.join("\n");
}

function characterImpressionData(profile) {
  const runtimeDir = path.join(profile.workspace, "LORE", "runtime");
  if (!fs.existsSync(runtimeDir)) return null;
  const entry = fs.readdirSync(runtimeDir, { withFileTypes: true })
    .find((item) => item.isFile() && /^06_.*_Character_Impressions\.json$/iu.test(item.name));
  if (!entry) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir, entry.name), "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function rawMentionsAlias(raw, alias) {
  return aliasMatchesText(raw, alias);
}

function rawMentionsTopic(raw, topic) {
  return normalizeAlias(raw).includes(normalizeAlias(topic));
}

function mentionedMyGoRelationEntries(profile, raw) {
  const data = characterImpressionData(profile);
  const owner = String(profile?.canonicalName || data?.character || "").trim();
  // Same resolver as the LORE path, so contextual aliases (燈, 野貓) need a
  // person cue here too.
  const mentioned = new Set(resolveEntityMentions(raw).map((item) => item.canonical_name));
  return (data?.characters || []).filter((item) => {
    const canonicalName = String(item?.canonicalName || "").trim();
    if (!canonicalName || canonicalName === owner) return false;
    const entity = loadCanonicalEntities().entities.find((candidate) => candidate.canonicalName === canonicalName);
    return entity ? mentioned.has(canonicalName) : rawMentionsAlias(raw, canonicalName);
  });
}

function selectRelationEvents(item, raw) {
  const events = (Array.isArray(item?.relationEvents) ? item.relationEvents : [])
    .map((event) => ({
      text: String(event?.text || "").trim(),
      adv: Number.isFinite(Number(event?.adv)) ? Number(event.adv) : null,
      topics: (Array.isArray(event?.topics) ? event.topics : []).map((value) => String(value || "").trim()).filter(Boolean),
    }))
    .filter((event) => event.text);
  if (!events.length) return [];

  const memberAliases = new Set(loadCanonicalEntities().entities
    .filter((entity) => ["高松燈", "千早愛音", "長崎爽世", "椎名立希", "要樂奈"].includes(entity.canonicalName))
    .flatMap((entity) => [entity.canonicalName, ...(entity.aliases || [])].map((alias) => String(alias).normalize("NFKC").toLocaleLowerCase("zh-Hant"))));
  const scored = events.map((event, index) => {
    const matches = event.topics.filter((topic) =>
      !memberAliases.has(topic.normalize("NFKC").toLocaleLowerCase("zh-Hant"))
      && rawMentionsTopic(raw, topic));
    return { event, index, score: matches.reduce((sum, topic) => sum + Math.max(1, [...topic].length), 0) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (scored.length) {
    const best = scored[0].score;
    return scored.filter((item) => item.score >= Math.max(1, best - 1)).slice(0, 1).map((item) => item.event);
  }
  const relationOrHistoryQuery = /(?:關係|关系|相處|相处|發生|发生|經歷|经历|記得|记得|以前|那次|一起|互動|互动|怎麼認識|怎么认识|什麼事|什么事)/u.test(String(raw || ""));
  return relationOrHistoryQuery ? events.slice(0, 1) : [];
}

export const RECENT_TIME_QUERY_RE = /(?:最近|目前|現在|现在|今天|昨天|昨日|前天|上週|上周|剛剛|刚刚|這幾天|这几天|這陣子|这阵子)/u;

// Canon events and impressions are past material. When the user asks about
// recent time, say so explicitly, or the model narrates an old event as recent
// (爽世「最近跟愛音去了一趟茶店」, sister live run 2026-10-15).
export const RECENT_TIME_BOUNDARY_LINE = "The user is asking about recent or current time. The character material here is from the past, not recent. Do not present any of it as recent. If you mention it, make clear it was before. For a self-only current-state question, use this character's usual voice to say in one or two short sentences that things are as usual, then stop; do not say you are busy,「每天」or「維持日常」, or name any current activity, project, study, conversation, plan, practice, work, or errand unless a supplied current-situation list explicitly gives it. For what is happening now, use only the MyGO!!!!! current-situation list if one is given; otherwise keep the answer general and stop.";

export function buildMentionedMyGoRelationContext(profile, raw) {
  if (!profile) return { context: "", evidenceResult: "", targets: [] };
  const plan = buildUnifiedTurnPlan(raw, { personaId: profile.personaId });
  if (plan?.evidence?.kind === "current_state"
      || RECENT_TIME_QUERY_RE.test(String(raw || ""))
      ) {
    return { context: "", evidenceResult: "", targets: [] };
  }
  const mentioned = mentionedMyGoRelationEntries(profile, raw);
  if (!mentioned.length) return { context: "", evidenceResult: "", targets: [] };
  // 「爽世跟燈在團裡怎麼互動？」 asks about two other members, not the speaker.
  // The speaker's own events with each of them do not answer it, and attaching
  // them invites the model to answer with its own memories instead.
  if (mentioned.length >= 2 && !/(?:你|妳|您|我)/u.test(String(raw || ""))) {
    return { context: "", evidenceResult: "", targets: [] };
  }

  const blocks = [];
  const evidence = [];
  const targets = [];
  for (const item of mentioned) {
    const selected = selectRelationEvents(item, raw);
    if (!selected.length) continue;
    const target = String(item.canonicalName || "").trim();
    targets.push(target);
    blocks.push("target member: " + target);
    for (const event of selected) {
      blocks.push(`- directional event${event.adv ? ` [ADV ${event.adv}]` : ""}: ${event.text}`);
      evidence.push(`${target}${event.adv ? ` [ADV ${event.adv}]` : ""}: ${event.text}`);
    }
  }
  if (!evidence.length) return { context: "", evidenceResult: "", targets: [] };
  return {
    context: [
      "CONTROLLED DIRECTIONAL RELATION EVENTS:",
      "active speaker: " + profile.canonicalName,
      ...blocks,
      "These are speaker→target event facts for this turn. Preserve actor ownership and sequence. Do not affirm a user premise that conflicts with these events, and do not invent an event that is not supplied.",
      "These events are things you remember. When the user asks about your relationship or what happened with this person, answer from one concrete supplied event in your own voice; do not merge separate events or add a generic impression.",
      "They happened in the past. Do not present them as something from today, these days or recently.",
    ].join("\n"),
    evidenceResult: evidence.join("\n"),
    targets,
  };
}

export function buildPersonaLoreEvidenceProjection(event, ctx, planOverride = null) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return { context: "", evidenceResult: "", coverage: null, plan: null };

  const raw = firstText(event?.query || event?.prompt || event?.content || event?.body || event?.text);
  const basePlan = planOverride || buildUnifiedTurnPlan(raw);
  const plan = loreEvidencePlanForTurn(basePlan);
  const profile = getPersonaProfile(botContext.personaId);
  const relationProjection = buildMentionedMyGoRelationContext(profile, raw);
  const recentBoundary = plan?.evidence?.kind === "current_state" || RECENT_TIME_QUERY_RE.test(String(raw || ""))
    ? RECENT_TIME_BOUNDARY_LINE
    : "";
  if (!turnPlanNeedsLore(plan)) return {
    context: [relationProjection.context, recentBoundary].filter(Boolean).join("\n"),
    evidenceResult: relationProjection.evidenceResult,
    coverage: null,
    plan,
  };

  const anchors = retrievalAnchors(plan);
  const preferenceFactRequired = plan?.evidence?.kind === "stable_profile_fact"
    && plan?.evidence?.requestedAspect === "preference";
  const retrievalQuery = preferenceFactRequired
    ? `${plan.currentUser || raw} 喜歡 喜欢 不喜歡 不喜欢 討厭 讨厌 興趣 兴趣`
    : (plan.currentUser || raw);
  const searchedRecords = searchPersonaLore(botContext.personaId, retrievalQuery, {
    maxResults: 5,
    anchors,
    contentLimit: Infinity,
  });
  const records = [...new Map([
    ...personaCoreCapabilityRecords(profile, plan),
    ...searchedRecords,
  ].map((item) => [item.id, item])).values()];
  if (!records.length && relationProjection.context) {
    return {
      context: relationProjection.context,
      evidenceResult: relationProjection.evidenceResult,
      coverage: { supported: true, reason: "directional_relation_event" },
      plan,
    };
  }
  if (!records.length) {
    const evidenceResult = "No relevant controlled Persona LORE evidence was found for this query.";
    return {
      context: [
        "CONTROLLED PERSONA LORE EVIDENCE:",
        `active speaker: ${profile.canonicalName}`,
        "EVIDENCE_COVERAGE=INSUFFICIENT",
        "CANONICAL_ANSWER_MODE=UNRESOLVED_ONLY",
        "CANONICAL_POSITIVE_COMPLETION=DENY",
        "CANONICAL_NEGATIVE_COMPLETION=DENY",
        "CANONICAL_UNRESOLVED_SENTENCE_COUNT=1",
        "CANONICAL_UNRESOLVED_SPECULATION=DENY",
        "CANONICAL_UNRESOLVED_CAUSAL_CONTINUATION=DENY",
        "CANONICAL_UNRESOLVED_TENTATIVE_SELF_ASSERTION=DENY",
        "CANONICAL_UNRESOLVED_MEMORY_ABSENCE_AS_FACT=DENY",
        "本輪可用的角色內容沒有直接回答這個主體或面向。",
        "Return one short unresolved statement and stop. Do not continue with 'because', 'probably', 'maybe', 'it feels like', a tentative self-capability claim, or a plausible first-person process/history to fill the gap. Do not use 'I have not heard/seen that' as if personal non-recall proved the canonical fact absent.",
      ].join("\n"),
      evidenceResult,
      coverage: { supported: false, reason: "empty_result" },
      plan,
    };
  }

  const factualRecords = records.filter((record) => !isAnswerShapingLoreRecord(record));
  const subjectCompatibleRecords = factualRecords.filter((record) => recordPrimarySubjectCompatible(record, anchors));
  const sourcePool = preferenceFactRequired
    ? subjectCompatibleRecords.filter((record) => isPreferenceFactLoreRecord(record))
    : (subjectCompatibleRecords.length ? subjectCompatibleRecords : factualRecords.length ? factualRecords : records);
  const anchorRecords = anchors.length ? sourcePool.filter((record) => recordHasAnchor(record, anchors)) : sourcePool;
  const projectionRecords = [...(anchorRecords.length ? anchorRecords : sourcePool)]
    .sort((a, b) => projectionRecordPriority(a, anchors) - projectionRecordPriority(b, anchors))
    .slice(0, 3);
  const evidenceLines = [];
  const evidenceParts = [];
  const projectedBlocks = [];
  for (const record of projectionRecords) {
    const compact = extractAnchorWindow(record.content, anchors, { maxLength: 700, before: 120 });
    if (!compact) continue;
    const sourceLine = `source: ${record.title || record.source || "controlled Persona LORE"}`;
    evidenceLines.push(sourceLine);
    evidenceLines.push(compact);
    evidenceParts.push(compact);
    projectedBlocks.push({
      sourceLine,
      compact,
      coverageRecord: {
        source: record.source,
        title: record.title,
        content: compact,
      },
    });
  }
  const evidenceResult = evidenceParts.join("\n");
  const coverageEvidence = projectedBlocks.map((block) => block.coverageRecord);
  const coverage = evaluateEvidenceCoverage(plan, coverageEvidence, plan.currentUser || raw);
  // Attached directional relation events answer the relationship question
  // themselves. An "unresolved only" block next to them made the model reply
  // 不知道 even with six events in the prompt (sister live run 2026-10-15).
  if (!coverage.supported && relationProjection.context) {
    return {
      context: relationProjection.context,
      evidenceResult: [evidenceResult, relationProjection.evidenceResult].filter(Boolean).join("\n"),
      coverage: { supported: true, reason: "directional_relation_event" },
      plan,
    };
  }
  // Recent/current questions have no canonical record by design. The
  // unresolved block turned them into 不知道 (Rana fix 400c88f; same for the
  // other four personas in LIVE6), so keep only the recent-time guidance.
  if (!coverage.supported && recentBoundary) {
    return {
      context: [relationProjection.context, recentBoundary].filter(Boolean).join("\n"),
      evidenceResult: [evidenceResult, relationProjection.evidenceResult].filter(Boolean).join("\n"),
      coverage,
      plan,
    };
  }
  let generatorEvidenceLines = evidenceLines;
  if (coverage.supported && projectedBlocks.length > 1) {
    const minimalLines = [];
    const minimalParts = [];
    const minimalCoverageEvidence = [];
    for (const block of projectedBlocks) {
      minimalLines.push(block.sourceLine, block.compact);
      minimalParts.push(block.compact);
      minimalCoverageEvidence.push(block.coverageRecord);
      if (evaluateEvidenceCoverage(plan, minimalCoverageEvidence, plan.currentUser || raw).supported) break;
    }
    if (minimalParts.length && evaluateEvidenceCoverage(plan, minimalCoverageEvidence, plan.currentUser || raw).supported) {
      generatorEvidenceLines = minimalLines;
    }
  }
  const requestedSubject = String(plan?.subject?.name || plan?.predicate || "requested canonical subject").trim();
  const requestedAspect = String(plan?.evidence?.requestedAspect || plan?.utteranceAct?.activity || "requested aspect").trim();
  const contextLines = [
    "CONTROLLED PERSONA LORE EVIDENCE:",
    "PERSONA_LORE_PROJECTION_REVISION=2026-09-25.identity-events-v5",
    `active speaker: ${profile.canonicalName}`,
  ];

  if (coverage.supported) {
    const personaStanceMode = String(plan?.responseContract?.responseFunction || "") === "ANSWER_CANONICAL_PERSONA_STANCE"
      || [
        "CANONICAL_WORK_STANCE",
        "CANONICAL_RELATIONSHIP_STANCE",
        "CANONICAL_RELATIONSHIP_STANCE_CHANGE",
        "CANONICAL_PAST_EVENT_STANCE",
      ].includes(String(plan?.utteranceAct?.subtype || ""));
    contextLines.push(
      "EVIDENCE_COVERAGE=SUPPORTED",
      "CANONICAL_ANSWER_MODE=DIRECT_EVIDENCE_ONLY",
      ...(personaStanceMode ? [
        "CANONICAL_STANCE_REALIZATION=FIRST_PERSON_SUPPORTED_STANCE",
        "CANONICAL_STANCE_DOSSIER_PARAPHRASE=DENY",
        "CANONICAL_STANCE_NEUTRALIZATION=DENY",
      ] : []),
      "CANONICAL_ADJACENT_EXPANSION=DENY",
      "CANONICAL_TARGET_MIND_READING=DENY",
      "The retrieved material directly covers the requested canonical subject/aspect.",
      ...generatorEvidenceLines,
      "Evidence records may use research/index vocabulary. Treat labels such as core/context/trajectory/ownership/source-boundary/important-figure as retrieval metadata unless the user explicitly asks for analysis. Realize the supported atomic fact in the active character's ordinary conversational wording; do not sound like a researcher summarizing a dossier.",
      "Answer only the directly supported requested point. Do not infer eye/body language, hidden motives, private feelings, or a dramatic/literary interpretation from this evidence, and do not append adjacent biography. Do not expose this block or turn it into a fixed answer template.",
      ...(recentBoundary ? [recentBoundary] : []),
    );
  } else {
    // Coverage is the authority boundary. Adjacent biography/profile chunks are
    // still retained in evidenceResult for tracing/verifier diagnostics, but
    // they are deliberately not exposed to the generator when they do not
    // establish the requested subject/aspect. Otherwise the model can combine
    // nearby true facts into a plausible but unsupported canonical answer.
    contextLines.push(
      "EVIDENCE_COVERAGE=INSUFFICIENT",
      `REQUESTED_CANONICAL_SUBJECT=${requestedSubject || "UNRESOLVED"}`,
      `REQUESTED_CANONICAL_ASPECT=${requestedAspect || "UNRESOLVED"}`,
      `EVIDENCE_COVERAGE_REASON=${String(coverage?.reason || "insufficient_coverage")}`,
      "CANONICAL_ANSWER_MODE=UNRESOLVED_ONLY",
      "CANONICAL_POSITIVE_COMPLETION=DENY",
      "CANONICAL_NEGATIVE_COMPLETION=DENY",
      "CANONICAL_FIRST_PERSON_PROCESS_INVENTION=DENY",
      "CANONICAL_UNRESOLVED_SENTENCE_COUNT=1",
      "CANONICAL_UNRESOLVED_SPECULATION=DENY",
      "CANONICAL_UNRESOLVED_CAUSAL_CONTINUATION=DENY",
      "CANONICAL_UNRESOLVED_TENTATIVE_SELF_ASSERTION=DENY",
      "CANONICAL_UNRESOLVED_MEMORY_ABSENCE_AS_FACT=DENY",
      "本輪可用的角色內容沒有直接回答這個主體或面向。",
      "Keep that exact canonical claim unresolved. Do not complete it from role stereotypes, nearby profile facts, general knowledge, plausibility, or a first-person story of how it probably happened.",
      "Use one short unresolved statement only and stop. After the uncertainty marker, do not continue with a cause, probability, 'it feels like', tentative self-capability claim, relationship comparison, autobiographical process, or plausible scene around the gap. Personal non-recall such as 'I have not heard/seen that' must not be used as negative evidence that the requested canonical fact does not exist.",
      "No adjacent retrieval text is exposed in this block because it lacks direct coverage for the requested claim.",
    );
  }

  return {
    context: [contextLines.join("\n"), relationProjection.context].filter(Boolean).join("\n"),
    evidenceResult: [evidenceResult, relationProjection.evidenceResult].filter(Boolean).join("\n"),
    coverage,
    plan,
  };
}

export function registerPersonaLorePrefetch(api) {
  api.on("before_prompt_build", async (event, ctx) => {
    if (ctx?.__ranaUnifiedRetrieval?.handled) return;
    const botContext = resolveBotContext(event, ctx);
    // Rana's pre-generation LORE injection is still owned by lore/guidance.js
    // (F4 partial). Running both prefetch paths would inject evidence twice.
    if (!botContext || botContext.personaId === "rana") return;
    if (ctx?.__ranaContextAssembler) {
      const unified = await retrieveTurnContext({ personaId: botContext.personaId, query: firstText(event?.prompt), priorText: ctx?.previousUserText || ctx?.recentText || "", sessionKey: ctx?.sessionKey || event?.sessionKey || "", userId: ctx?.senderId || ctx?.requesterId || event?.senderId || event?.requesterId || "" });
      if (unified.text || unified.entries.length) {
        ctx.__ranaUnifiedRetrieval = { handled: true, result: unified };
        return { appendSystemContext: unified.text, __contextTrace: { retrieved: unified.entries.map((item) => ({ id: item.id, score: item.score })), retrieval: unified.trace } };
      }
      return;
    }
    const authoritativePlan = authoritativeTurnPlanFor(event, ctx, { create: true });
    const projected = buildPersonaLoreEvidenceProjection(event, ctx, authoritativePlan);
    if (!projected.context || !projected.plan) return;

    if (!turnPlanNeedsLore(projected.plan)) return { appendSystemContext: modelFacingContext(projected.context) };

    const verifierResult = projected.evidenceResult || "No relevant controlled Persona LORE evidence was found for this query.";
    const verifierEvidence = rememberVerifierPrefetchedCanonicalEvidence(event, ctx, verifierResult);
    const authorityEvidence = rememberCanonicalAuthorityPrefetch(event, ctx, verifierResult);

    return {
      appendSystemContext: modelFacingContext([
        projected.context,
        `Evidence acquisition: runtime pre-generation retrieval (${authorityEvidence.status || verifierEvidence?.status || "UNKNOWN"}).`,
      ].join("\n")),
    };
  }, { priority: 900, timeoutMs: 5_000 });
}

export function registerPersonaLoreTool(api) {
  registerPersonaLorePrefetch(api);
  api.registerTool({
    name: "persona_lore_search",
    label: "Persona Deep LORE Search",
    description: "Read-only, query-specific retrieval from the active MyGO speaker's own Deep LORE (all five personas use the same resolver). Use only for explicit character, relationship, event, timeline, source, or setting questions. It never changes persona identity.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async (toolCallId, params, _signal, _onUpdate) => {
      const trusted = consumeTrustedPersonaToolContext(toolCallId, "persona_lore_search");
      if (!trusted.ok) return trustedToolError("persona_lore_search", trusted);
      const snapshot = trustedContextHint(trusted);
      const botContext = resolveBotContext(snapshot, snapshot);
      if (!botContext) return trustedToolError("persona_lore_search", { ok: false, error: "unresolved persona context" });
      const toolQuery = String(params?.query || "");
      // Consume the authoritative current-turn plan. The model-provided tool
      // query may narrow retrieval wording, but it must not create a second
      // semantic plan or change the requested canonical subject/aspect.
      const unified = await retrieveTurnContext({
        personaId: botContext.personaId,
        query: toolQuery,
        priorText: snapshot?.previousUserText || snapshot?.recentText || "",
        sessionKey: snapshot?.sessionKey || botContext?.sessionKey || "",
        userId: snapshot?.senderId || snapshot?.requesterId || botContext?.senderId || "",
      });
      return {
        content: [{
          type: "text",
          // Model-facing only: written as an instruction so the reply does not
          // echo search/evidence wording back to the user.
          text: unified.text || "Nothing relevant is in your character memory for this question. Do not guess, and do not mention searching, records or evidence in your reply.",
        }],
      };
    },
  });
}

export const __test = {
  readCorpus,
  searchPersonaLore,
  buildPersonaLoreContext,
  buildPersonaLoreEvidenceProjection,
  planAnchors,
  recordHasAnchor,
  extractAnchorWindow,
  supplementalIdentityEventRecords,
};

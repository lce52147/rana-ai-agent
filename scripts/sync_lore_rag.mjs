import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.join(ROOT, "workspace");
const LORE_ROOT = path.join(WORKSPACE, "LORE");
const MANIFEST_PATH = path.join(LORE_ROOT, "LORE_MANIFEST.json");
const GENERATED_ROOT = path.join(LORE_ROOT, "generated", "rag");
const CHUNKS_ROOT = path.join(GENERATED_ROOT, "chunks");
const IMPRESSIONS_PATH = path.join(LORE_ROOT, "runtime", "06_Rana_Character_Impressions.json");
const VISION_IDENTITY_PATH = path.join(LORE_ROOT, "runtime", "07_Rana_Vision_Identity.json");
const VISION_REFERENCE_PATH = path.join(ROOT, "extensions", "rana-vision", "character_catalog.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function workspacePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("manifest path must be a non-empty string");
  const clean = relativePath.replace(/\\/g, "/");
  if (path.isAbsolute(clean) || clean.split("/").includes("..")) throw new Error(`manifest path escapes workspace: ${relativePath}`);
  const resolved = path.resolve(WORKSPACE, clean);
  const boundary = `${path.resolve(WORKSPACE)}${path.sep}`.toLowerCase();
  if (!`${resolved}${path.sep}`.toLowerCase().startsWith(boundary)) throw new Error(`manifest path escapes workspace: ${relativePath}`);
  return resolved;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalized(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function slug(value) {
  const latin = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff\u3040-\u30ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return latin || "section";
}

function buildCanonicalEntities(manifest) {
  const impressions = readJson(IMPRESSIONS_PATH);
  const overridePath = workspacePath(manifest.canonicalAliasOverrides);
  const overrides = readJson(overridePath);
  const entities = impressions.characters.map((item) => {
    const override = overrides.entities?.[item.canonicalId] || {};
    return {
      entityId: override.entityId || `bangdream.character.${item.canonicalId}`,
      canonicalId: item.canonicalId,
      canonicalName: item.canonicalName,
      officialChineseName: item.canonicalName,
      group: item.group || "",
      aliases: unique([item.canonicalName, ...(item.aliases || []), ...(override.aliases || [])]),
      sourceRefs: unique(item.sourceRefs || []),
    };
  });
  const ids = new Set();
  const aliases = new Map();
  for (const entity of entities) {
    if (ids.has(entity.entityId)) throw new Error(`duplicate canonical entity id: ${entity.entityId}`);
    ids.add(entity.entityId);
    for (const alias of entity.aliases) {
      const key = normalized(alias);
      if (!key) continue;
      const existing = aliases.get(key);
      if (existing && existing !== entity.entityId) throw new Error(`ambiguous canonical alias '${alias}': ${existing} vs ${entity.entityId}`);
      aliases.set(key, entity.entityId);
    }
  }
  return { schema: "rana.canonical-entities.v1", generated: true, sources: ["LORE/runtime/06_Rana_Character_Impressions.json", manifest.canonicalAliasOverrides], entities };
}

function buildVisionIdentity(entities) {
  const source = readJson(VISION_REFERENCE_PATH);
  const byLegacyId = new Map(entities.entities.map((item) => [item.canonicalId, item]));
  const characters = source.characters.map((item) => {
    const entity = byLegacyId.get(item.id);
    if (!entity) throw new Error(`vision identity has no canonical entity: ${item.id}`);
    return {
      entityId: entity.entityId,
      canonicalId: entity.canonicalId,
      canonicalName: entity.canonicalName,
      aliases: entity.aliases,
      visualTraits: item.visual_traits || [],
      reference: item.reference || "",
      sourceUrl: item.source_url || "",
    };
  });
  return {
    schema: "rana.vision-identity.v1",
    generated: true,
    source: "LORE canonical entities + rana-vision reference catalog",
    characters,
    atlases: source.atlases || [],
  };
}

function splitMarkdownSections(text, sourcePath) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const stack = [];
  const sections = [];
  let title = path.basename(sourcePath, ".md");
  let current = { heading: title, headingPath: [title], lines: [] };
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body.length >= 24) sections.push({ ...current, body });
  };
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) {
      current.lines.push(line);
      continue;
    }
    const level = match[1].length;
    const heading = match[2].trim();
    if (level === 1 && sections.length === 0 && current.lines.join("").trim() === "") title = heading;
    flush();
    stack.splice(level - 1);
    stack[level - 1] = heading;
    current = { heading, headingPath: [title, ...stack.filter(Boolean).filter((value) => value !== title)], lines: [] };
  }
  flush();
  return sections;
}

function sourceMetadata(sourcePath) {
  const name = path.basename(sourcePath);
  if (name.startsWith("11_Rana_Remembered_People_Evidence")) return { sourceType: "evidence_map", canonLevel: "reviewed_evidence", perspective: "third_person_evidence" };
  if (name.startsWith("11_Rana_Relationship_Map")) return { sourceType: "relationship_map", canonLevel: "mixed_reviewed", perspective: "third_person" };
  if (name.startsWith("12_Rana_Interaction")) return { sourceType: "interaction_index", canonLevel: "mixed_reviewed", perspective: "third_person" };
  if (name.startsWith("13_Rana_Game")) return { sourceType: "official_story_index", canonLevel: "official_index", perspective: "third_person" };
  if (name.startsWith("14_Rana_Speech")) return { sourceType: "speech_corpus", canonLevel: "reviewed_corpus", perspective: "rana_speech" };
  if (name.startsWith("15_Rana_Maigo")) return { sourceType: "program_index", canonLevel: "mixed_reviewed", perspective: "mixed_character_actor" };
  if (name.startsWith("16_Rana_Source")) return { sourceType: "source_audit", canonLevel: "policy_boundary", perspective: "audit" };
  if (name.startsWith("17_Rana_Official")) return { sourceType: "official_short_index", canonLevel: "official_index", perspective: "third_person" };
  if (name.startsWith("18_Coverage")) return { sourceType: "coverage_report", canonLevel: "policy_boundary", perspective: "audit" };
  return { sourceType: "research_summary", canonLevel: "mixed_reviewed", perspective: "third_person" };
}

function detectEntities(text, entities) {
  const haystack = normalized(text);
  if (!haystack) return [];
  return entities.entities
    .filter((entity) => entity.aliases.some((alias) => {
      const needle = normalized(alias);
      return needle.length >= 2 && haystack.includes(needle);
    }))
    .map((entity) => entity.entityId);
}

function sanitizeForModel(text) {
  return String(text || "")
    .replace(/\b(?:DIRECT|SCENE|PENDING|MANUALLY_REVIEWED|MANUALLY REVIEWED|MEMORY_ANCHOR)\b/giu, "")
    .replace(/\[(?:Task|Source|Evidence|Confidence)[^\]]*\]/giu, "")
    .replace(/(?:[A-Z]:\\|\/)[^\s)`]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChunks(manifest, entities) {
  const chunks = [];
  const sourceHashes = [];
  for (const sourcePath of manifest.retrievalOnly) {
    const absolute = workspacePath(sourcePath);
    const raw = fs.readFileSync(absolute, "utf8");
    sourceHashes.push(`${sourcePath}\0${sha256(raw)}`);
    const fileMeta = sourceMetadata(sourcePath);
    const sections = splitMarkdownSections(raw, sourcePath);
    sections.forEach((section, index) => {
      const content = sanitizeForModel(`${section.headingPath.join(" > ")}\n${section.body}`);
      if (!content) return;
      const chunkId = sha256(`${sourcePath}\0${section.headingPath.join("/")}\0${index}`).slice(0, 20);
      const entityIds = detectEntities(content, entities);
      const metadata = {
        chunkId,
        entityIds,
        aliases: entities.entities.filter((entity) => entityIds.includes(entity.entityId)).flatMap((entity) => entity.aliases),
        work: /Ave Mujica/i.test(content) ? "Ave Mujica" : /MyGO|迷子集會/i.test(content) ? "MyGO!!!!!" : "BanG Dream!",
        group: entityIds.map((id) => entities.entities.find((entity) => entity.entityId === id)?.group).filter(Boolean),
        sourceType: fileMeta.sourceType,
        sourceTitle: section.headingPath.join(" > "),
        sourcePath,
        canonLevel: fileMeta.canonLevel,
        perspective: fileMeta.perspective,
        timeline: /event\s*\d+/i.exec(content)?.[0] || "unspecified",
        language: /[\u3040-\u30ff]/u.test(content) ? "zh-Hant+ja" : "zh-Hant",
        version: manifest.schema,
        retrievalPolicy: "canonical_lore_only",
      };
      chunks.push({ id: chunkId, metadata, content });
    });
  }
  return { chunks, sourceHashes };
}

function renderChunk(chunk) {
  return [
    "<!-- RANA_LORE_GENERATED: do not edit -->",
    `<!-- RANA_LORE_METADATA ${JSON.stringify(chunk.metadata)} -->`,
    `# ${chunk.metadata.sourceTitle}`,
    "",
    chunk.content,
    "",
  ].join("\n");
}

export function validateManifest(manifest) {
  const report = { allowed: [], rejected: [], missing: [], visionOnly: [], coreOnly: [], duplicate: [], invalid: [] };
  const categories = [
    ["retrievalOnly", manifest.retrievalOnly || []],
    ["programmaticRuntime", manifest.programmaticRuntime || []],
    ["visionOnly", manifest.visionOnly || []],
    ["nativeRuntime", manifest.nativeRuntime || []],
  ];
  const seen = new Map();
  for (const [category, paths] of categories) {
    if (!Array.isArray(paths)) report.invalid.push(`${category} must be an array`);
    for (const relativePath of paths || []) {
      try {
        const absolute = workspacePath(relativePath);
        const previous = seen.get(relativePath);
        if (previous && previous !== category) report.duplicate.push({ path: relativePath, categories: [previous, category] });
        seen.set(relativePath, category);
        if (!fs.existsSync(absolute)) report.missing.push(relativePath);
        if (category === "retrievalOnly") report.allowed.push(relativePath);
        if (category === "visionOnly") report.visionOnly.push(relativePath);
        if (category === "nativeRuntime") report.coreOnly.push(relativePath);
      } catch (error) {
        report.invalid.push(String(error?.message || error));
      }
    }
  }
  report.rejected = [...(manifest.programmaticRuntime || []), ...(manifest.visionOnly || []), ...(manifest.nativeRuntime || []), ...(manifest.excluded || [])];
  if (report.missing.length || report.duplicate.length || report.invalid.length) {
    throw new Error(`manifest validation failed: ${JSON.stringify(report)}`);
  }
  return report;
}

function resetGeneratedChunks() {
  const resolved = path.resolve(CHUNKS_ROOT);
  const expectedBoundary = `${path.resolve(LORE_ROOT, "generated")}${path.sep}`.toLowerCase();
  if (!`${resolved}${path.sep}`.toLowerCase().startsWith(expectedBoundary)) throw new Error(`unsafe generated chunk path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function main() {
  const manifest = readJson(MANIFEST_PATH);
  const entities = buildCanonicalEntities(manifest);
  writeJson(path.join(GENERATED_ROOT, "canonical_entities.json"), entities);
  writeJson(VISION_IDENTITY_PATH, buildVisionIdentity(entities));
  const report = validateManifest(manifest);
  const { chunks, sourceHashes } = buildChunks(manifest, entities);
  resetGeneratedChunks();
  const chunkRecords = chunks.map((chunk) => {
    const relative = path.join("LORE", "generated", "rag", "chunks", slug(path.basename(chunk.metadata.sourcePath, ".md")), `${chunk.id}-${slug(chunk.metadata.sourceTitle)}.md`).replace(/\\/g, "/");
    const absolute = workspacePath(relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, renderChunk(chunk), "utf8");
    return { ...chunk, generatedPath: relative };
  });
  const buildIdentity = sha256(JSON.stringify({ manifest, sourceHashes, entities: entities.entities.map((item) => ({ entityId: item.entityId, aliases: item.aliases })) }));
  const output = {
    schema: "rana.lore-rag-corpus.v1",
    generatedAt: new Date().toISOString(),
    buildIdentity,
    manifestPath: "LORE/LORE_MANIFEST.json",
    namespace: manifest.retrievalBuild?.namespace || "canonical_lore",
    sources: manifest.retrievalOnly,
    chunks: chunkRecords,
  };
  writeJson(path.join(GENERATED_ROOT, "chunk_manifest.json"), output);
  writeJson(path.join(GENERATED_ROOT, "sync_report.json"), { ...report, generatedChunks: chunkRecords.length, buildIdentity });
  process.stdout.write(`${JSON.stringify({ ...report, generatedChunks: chunkRecords.length, buildIdentity }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(APP_DIR);
const CATALOG_PATH = path.join(ROOT_DIR, "character_catalog.json");
const REFERENCE_ROOT = path.join(ROOT_DIR, "references", "source");
const SERVICE_VERSION = "3.1.0";
const EMBEDDING_CONTRACT_VERSION = "rana.identity.embedding-batch.v1";
const INDEX_CONTRACT_VERSION = "rana.identity.index-snapshot.v1";
const INDEX_SCHEMA = "rana.identity.reference-bank.v3.1.0";
const EMBEDDING_DIMENSION = 512;

let config = null;
let catalogPromise = null;
let runtimePromise = null;
let referenceBankPromise = null;
let indexMetadataPromise = null;
let lastIndexDescriptor = null;

export function configure(nextConfig) {
  config = nextConfig;
}

function requireConfig() {
  if (!config) throw new Error("identity engine is not configured");
  return config;
}

function normalizeVector(values) {
  const vector = Array.from(values || [], Number);
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += Number(left[i] || 0) * Number(right[i] || 0);
  return Math.max(-1, Math.min(1, sum));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableId(prefix, ...parts) {
  const digest = sha256(Buffer.from(parts.map((part) => String(part ?? "")).join("\u0000"), "utf8"));
  return `${prefix}_${digest.slice(0, 32)}`;
}

function modelDescriptor(dimension = EMBEDDING_DIMENSION) {
  const cfg = requireConfig();
  return {
    id: String(cfg.model || ""),
    version: String(cfg.modelVersion || cfg.modelRevision || cfg.model || "unknown"),
    dtype: String(cfg.dtype || "unknown"),
    dimension: Number(dimension || EMBEDDING_DIMENSION),
    normalized: true,
  };
}

function defaultEligibility() {
  return { retrieval: true, calibration: false, evaluation: false };
}

function normalizeEligibility(value) {
  const fallback = defaultEligibility();
  if (!value || typeof value !== "object") return fallback;
  return {
    retrieval: value.retrieval !== false,
    calibration: value.calibration === true,
    evaluation: value.evaluation === true,
  };
}

function normalizeReferencePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function referenceIntegrity(references = []) {
  const groups = new Map();
  for (const reference of references || []) {
    const digest = String(reference?.sha256 || "").toLowerCase();
    const sourceGroupId = String(reference?.source_group_id || (digest ? stableId("src", digest) : "")).trim();
    if (!sourceGroupId) continue;
    const group = groups.get(sourceGroupId) || {
      source_group_id: sourceGroupId,
      sha256: digest,
      identity_ids: new Set(),
      exemplar_ids: [],
    };
    const identityId = String(reference?.id || "").trim();
    if (identityId) group.identity_ids.add(identityId);
    if (reference?.exemplar_id) group.exemplar_ids.push(String(reference.exemplar_id));
    groups.set(sourceGroupId, group);
  }
  const ambiguous = [...groups.values()]
    .filter((group) => group.identity_ids.size > 1)
    .map((group) => ({
      source_group_id: group.source_group_id,
      sha256: group.sha256,
      identity_ids: [...group.identity_ids].sort(),
      exemplar_ids: [...new Set(group.exemplar_ids)].sort(),
    }))
    .sort((left, right) => left.source_group_id.localeCompare(right.source_group_id));
  return {
    ambiguous_reference_group_count: ambiguous.length,
    ambiguous_reference_count: ambiguous.reduce((sum, group) => sum + group.exemplar_ids.length, 0),
    ambiguous_groups: ambiguous,
  };
}

function attachReferenceIntegrity(references = []) {
  const integrity = referenceIntegrity(references);
  const bySourceGroup = new Map(integrity.ambiguous_groups.map((group) => [group.source_group_id, group]));
  return (references || []).map((reference) => {
    const group = bySourceGroup.get(String(reference?.source_group_id || ""));
    return {
      ...reference,
      ambiguity_group_id: group?.source_group_id || null,
      ambiguity_identity_ids: group?.identity_ids || [],
    };
  });
}

async function readIndexMetadata() {
  if (indexMetadataPromise) return indexMetadataPromise;
  indexMetadataPromise = (async () => {
    const cfg = requireConfig();
    if (!cfg.indexMetadataPath) return { schema: "rana.identity.index-metadata.v1", exemplars: [] };
    try {
      const parsed = JSON.parse(await readFile(cfg.indexMetadataPath, "utf8"));
      return {
        schema: String(parsed?.schema || "rana.identity.index-metadata.v1"),
        exemplars: Array.isArray(parsed?.exemplars) ? parsed.exemplars : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { schema: "rana.identity.index-metadata.v1", exemplars: [] };
      throw error;
    }
  })().catch((error) => {
    indexMetadataPromise = null;
    throw error;
  });
  return indexMetadataPromise;
}

function indexMetadataLookup(metadata) {
  const byPath = new Map();
  const bySha = new Map();
  for (const item of metadata?.exemplars || []) {
    const itemPath = normalizeReferencePath(item?.path).toLowerCase();
    const digest = String(item?.sha256 || "").toLowerCase();
    if (itemPath) byPath.set(itemPath, item);
    if (digest && !itemPath) bySha.set(digest, item);
  }
  return { byPath, bySha };
}

function enrichReference(reference, metadataItem = null) {
  const relativePath = normalizeReferencePath(reference.path);
  const digest = String(reference.sha256 || "").toLowerCase();
  const identityId = String(reference.id || "");
  const normalizedEmbedding = normalizeVector(reference.embedding);
  return {
    ...reference,
    path: relativePath,
    sha256: digest,
    embedding: normalizedEmbedding,
    exemplar_id: String(metadataItem?.exemplar_id || reference.exemplar_id || stableId("exm", identityId, relativePath, digest)),
    source_group_id: String(metadataItem?.source_group_id || reference.source_group_id || stableId("src", digest)),
    ambiguity_group_id: String(metadataItem?.ambiguity_group_id || reference.ambiguity_group_id || "") || null,
    ambiguity_identity_ids: Array.isArray(metadataItem?.ambiguity_identity_ids)
      ? metadataItem.ambiguity_identity_ids.map(String).filter(Boolean)
      : Array.isArray(reference.ambiguity_identity_ids)
        ? reference.ambiguity_identity_ids.map(String).filter(Boolean)
        : [],
    view_type: String(metadataItem?.view_type || reference.view_type || referenceKind({ path: relativePath })),
    media_domain: String(metadataItem?.media_domain || reference.media_domain || "unknown"),
    eligibility: normalizeEligibility(metadataItem?.eligibility || reference.eligibility),
  };
}

function computeIndexVersion(references) {
  const hash = createHash("sha256");
  const sorted = [...(references || [])].sort((left, right) =>
    String(left.exemplar_id || "").localeCompare(String(right.exemplar_id || "")),
  );
  for (const reference of sorted) {
    hash.update(JSON.stringify({
      exemplar_id: reference.exemplar_id,
      identity_id: reference.id,
      source_group_id: reference.source_group_id,
      sha256: reference.sha256,
      view_type: reference.view_type,
      media_domain: reference.media_domain,
      eligibility: reference.eligibility,
      embedding: reference.embedding,
    }));
    hash.update("\n");
  }
  return `idx_${hash.digest("hex")}`;
}

function updateIndexDescriptor(bank) {
  const integrity = bank?.integrity || referenceIntegrity(bank?.references || []);
  lastIndexDescriptor = {
    version: String(bank?.index_version || "unavailable"),
    schema: String(bank?.schema || INDEX_SCHEMA),
    generated_at: bank?.generatedAt || null,
    exemplar_count: Number(bank?.references?.length || 0),
    identity_count: new Set((bank?.references || []).map((item) => item.id)).size,
    reference_error_count: Array.isArray(bank?.errors) ? bank.errors.length : 0,
    ambiguous_reference_group_count: Number(integrity.ambiguous_reference_group_count || 0),
    ambiguous_reference_count: Number(integrity.ambiguous_reference_count || 0),
  };
  return lastIndexDescriptor;
}

export function currentIndexDescriptor() {
  return lastIndexDescriptor || {
    version: "unavailable",
    schema: INDEX_SCHEMA,
    generated_at: null,
    exemplar_count: 0,
    identity_count: 0,
    reference_error_count: 0,
    ambiguous_reference_group_count: 0,
    ambiguous_reference_count: 0,
  };
}

async function readCatalog() {
  if (!catalogPromise) catalogPromise = readFile(CATALOG_PATH, "utf8").then(JSON.parse);
  return catalogPromise;
}

async function createRuntime() {
  const cfg = requireConfig();
  const {
    env,
    AutoProcessor,
    CLIPVisionModelWithProjection,
    RawImage,
  } = await import("@huggingface/transformers");

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.cacheDir = cfg.modelCacheDir;

  // Transformers.js uses the native onnxruntime-node backend in Node.js.
  // On Windows, supported devices are "cpu" and "dml"; "wasm" is not valid.
  // Keep CLIP on CPU so it does not consume RTX 2060 VRAM.
  const loadOptions = {
    local_files_only: true,
    device: "cpu",
    dtype: cfg.dtype,
    session_options: {
      intraOpNumThreads: cfg.threads,
      interOpNumThreads: 1,
      executionMode: "sequential",
      graphOptimizationLevel: "all",
    },
  };
  const processor = await AutoProcessor.from_pretrained(cfg.modelPath, {
    local_files_only: true,
  });
  const model = await CLIPVisionModelWithProjection.from_pretrained(
    cfg.modelPath,
    loadOptions,
  );

  return { processor, model, RawImage };
}

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function embedPath(filePath) {
  const { processor, model, RawImage } = await getRuntime();
  const image = await RawImage.read(filePath);
  const inputs = await processor(image);
  const output = await model(inputs);
  const data = output?.image_embeds?.data || [];
  const vector = normalizeVector(data);
  if (vector.length !== 512 || vector.every((value) => value === 0)) {
    throw new Error(`CLIP backend returned an invalid embedding length: ${vector.length}`);
  }
  return vector;
}

async function embedBuffer(buffer, mimeType = "image/jpeg") {
  const ext = /png/i.test(mimeType) ? ".png" : /webp/i.test(mimeType) ? ".webp" : ".jpg";
  const tempDir = path.join(requireConfig().cacheDir, "tmp");
  await mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${randomUUID()}${ext}`);
  await writeFile(tempPath, buffer);
  try {
    return await embedPath(tempPath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

async function walkFiles(directory) {
  const output = [];
  try {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, item.name);
      if (item.isDirectory()) output.push(...await walkFiles(filePath));
      else if (item.isFile() && /\.(?:png|jpe?g|webp)$/i.test(item.name)) output.push(filePath);
    }
  } catch {}
  return output;
}

function referenceCharacterId(filePath, characterIds) {
  const relative = path.relative(REFERENCE_ROOT, filePath).replace(/\\/g, "/");
  const parts = relative.split("/").filter(Boolean);
  const base = path.basename(filePath, path.extname(filePath));
  const candidates = [
    base,
    parts[0] === "faces" || parts[0] === "face" || parts[0] === "upper" || parts[0] === "full" ? parts[1] : parts[0],
  ].filter(Boolean);
  return candidates.find((value) => characterIds.has(String(value))) || "";
}

async function existingReferences() {
  const catalog = await readCatalog();
  const characters = new Map((catalog.characters || []).map((item) => [String(item.id), item]));
  const characterIds = new Set(characters.keys());
  const output = [];
  for (const filePath of await walkFiles(REFERENCE_ROOT)) {
    const id = referenceCharacterId(filePath, characterIds);
    if (!id) continue;
    output.push({ id, character: characters.get(id), filePath });
  }
  return output.sort((left, right) => left.id.localeCompare(right.id) || left.filePath.localeCompare(right.filePath));
}

async function readBankCache() {
  const cfg = requireConfig();
  try {
    const bank = JSON.parse(await readFile(cfg.bankCachePath, "utf8"));
    if (bank?.schema !== INDEX_SCHEMA) return null;
    if (bank?.model !== cfg.model || bank?.dtype !== cfg.dtype) return null;
    return bank;
  } catch {
    return null;
  }
}

async function writeBankCache(bank) {
  const cfg = requireConfig();
  await mkdir(path.dirname(cfg.bankCachePath), { recursive: true });
  const temp = `${cfg.bankCachePath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(bank), "utf8");
  await rename(temp, cfg.bankCachePath);
}

async function buildReferenceBank({ onProgress } = {}) {
  const cfg = requireConfig();
  const references = await existingReferences();
  const cached = await readBankCache();
  const cachedByKey = new Map((cached?.references || []).map((item) => [`${item.id}:${item.path}:${item.sha256}`, item]));
  const metadata = indexMetadataLookup(await readIndexMetadata());
  const output = [];
  const errors = [];
  let completed = 0;
  for (const reference of references) {
    const relativePath = path.relative(ROOT_DIR, reference.filePath).replace(/\\/g, "/");
    try {
      const bytes = await readFile(reference.filePath);
      const digest = sha256(bytes);
      const cacheKey = `${reference.id}:${relativePath}:${digest}`;
      const existing = cachedByKey.get(cacheKey);
      const base = existing?.embedding?.length
        ? existing
        : {
          id: reference.id,
          name: reference.character.name || reference.id,
          path: relativePath,
          sha256: digest,
          embedding: await embedPath(reference.filePath),
        };
      const metadataItem = metadata.byPath.get(relativePath.toLowerCase()) || metadata.bySha.get(digest.toLowerCase()) || null;
      const enriched = enrichReference(base, metadataItem);
      if (enriched.embedding.length !== EMBEDDING_DIMENSION || enriched.embedding.every((value) => value === 0)) {
        throw new Error(`invalid reference embedding dimension: ${enriched.embedding.length}`);
      }
      output.push(enriched);
    } catch (error) {
      errors.push({
        identity_id: String(reference.id || ""),
        path: relativePath,
        code: String(error?.code || "reference_embedding_failed"),
        message: String(error?.message || error),
      });
    }
    completed += 1;
    onProgress?.({ completed, total: references.length, id: reference.id, path: relativePath });
  }
  if (!output.length && errors.length) {
    throw new Error(`reference bank build failed for all ${errors.length} exemplars`);
  }
  const integrityReferences = attachReferenceIntegrity(output);
  const bank = {
    schema: INDEX_SCHEMA,
    model: cfg.model,
    modelVersion: cfg.modelVersion || cfg.modelRevision || cfg.model,
    dtype: cfg.dtype,
    generatedAt: new Date().toISOString(),
    errors,
    references: integrityReferences,
    integrity: referenceIntegrity(integrityReferences),
  };
  bank.index_version = computeIndexVersion(integrityReferences);
  updateIndexDescriptor(bank);
  await writeBankCache(bank);
  return bank;
}

async function getReferenceBank(options = {}) {
  if (!referenceBankPromise || options.rebuild) {
    referenceBankPromise = buildReferenceBank(options).catch((error) => {
      referenceBankPromise = null;
      throw error;
    });
  }
  const bank = await referenceBankPromise;
  updateIndexDescriptor(bank);
  return bank;
}


function referenceKind(reference) {
  const normalized = String(reference?.path || "").replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)(?:faces?|head|portrait)(?:\/|$)/.test(normalized)) return "face";
  if (/(?:^|\/)(?:upper|bust|torso)(?:\/|$)/.test(normalized)) return "upper";
  if (/(?:^|\/)(?:full|body)(?:\/|$)/.test(normalized)) return "full";
  return "generic";
}

function viewKind(value) {
  const type = String(value || "").toLowerCase();
  if (/(?:face|head|portrait)/.test(type)) return "face";
  if (/(?:upper|bust|torso)/.test(type)) return "upper";
  if (/(?:full|main_target)/.test(type)) return "full";
  return "generic";
}

function viewWeight(value) {
  const kind = viewKind(value);
  if (kind === "face") return 1.2;
  if (kind === "upper") return 1.0;
  if (kind === "full") return 0.8;
  return 0.9;
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function characterScore(items, targetType = "generic") {
  const sorted = [...items].sort((a, b) => b.similarity - a.similarity);
  const top = Number(sorted[0]?.similarity || 0);
  const topThree = sorted.slice(0, 3).map((item) => Number(item.similarity || 0));
  const topThreeMean = Number(mean(topThree) ?? top);
  const bestByKind = new Map();
  for (const item of sorted) {
    if (!bestByKind.has(item.reference_kind)) bestByKind.set(item.reference_kind, Number(item.similarity || 0));
  }
  const faceTop = bestByKind.get("face");
  const upperTop = bestByKind.get("upper");
  const fullTop = bestByKind.get("full");
  const genericTop = bestByKind.get("generic");
  const kind = viewKind(targetType);
  const preferred = kind === "face" ? faceTop : kind === "upper" ? (upperTop ?? faceTop) : (fullTop ?? upperTop ?? faceTop);
  const crossKind = mean([faceTop, upperTop, fullTop, genericTop]);
  const preferredScore = Number.isFinite(preferred) ? Number(preferred) : top;
  const crossKindScore = Number.isFinite(crossKind) ? Number(crossKind) : topThreeMean;
  // Multiple references should add evidence, but a weak outfit/full-body prototype
  // must not erase a strong face or upper-body match.
  const consensus = (top * 0.55) + (preferredScore * 0.25) + (topThreeMean * 0.15) + (crossKindScore * 0.05);
  return {
    top,
    second: Number(sorted[1]?.similarity ?? top),
    faceTop: Number.isFinite(faceTop) ? Number(faceTop) : null,
    upperTop: Number.isFinite(upperTop) ? Number(upperTop) : null,
    fullTop: Number.isFinite(fullTop) ? Number(fullTop) : null,
    genericTop: Number.isFinite(genericTop) ? Number(genericTop) : null,
    topThreeMean,
    crossKindScore,
    consensus,
    sorted,
  };
}

export function rankCharacterBank(targetEmbedding, references, options = {}) {
  const sourceGroups = new Map();
  for (const reference of references || []) {
    const sourceGroupId = String(reference?.source_group_id || "").trim();
    const identityId = String(reference?.id || "").trim();
    if (!sourceGroupId || !identityId) continue;
    const identities = sourceGroups.get(sourceGroupId) || new Set();
    identities.add(identityId);
    sourceGroups.set(sourceGroupId, identities);
  }
  const inferredAmbiguousGroups = new Map(
    [...sourceGroups.entries()]
      .filter(([, identities]) => identities.size > 1)
      .map(([sourceGroupId, identities]) => [sourceGroupId, [...identities].sort()]),
  );
  const groups = new Map();
  for (const reference of references || []) {
    const similarity = cosineSimilarity(targetEmbedding, reference.embedding);
    if (!Number.isFinite(similarity)) continue;
    const sourceGroupId = String(reference.source_group_id || "").trim();
    const inferredIdentityIds = inferredAmbiguousGroups.get(sourceGroupId) || [];
    const items = groups.get(reference.id) || [];
    items.push({
      id: reference.id,
      name: reference.name || reference.id,
      similarity,
      path: reference.path,
      reference_kind: referenceKind(reference),
      source_group_id: sourceGroupId || null,
      ambiguity_group_id: reference.ambiguity_group_id || (inferredIdentityIds.length ? sourceGroupId : null),
      ambiguity_identity_ids: inferredIdentityIds.length
        ? inferredIdentityIds
        : Array.isArray(reference.ambiguity_identity_ids)
        ? reference.ambiguity_identity_ids.map(String).filter(Boolean)
        : [],
    });
    groups.set(reference.id, items);
  }
  return [...groups.entries()].map(([id, items]) => {
    const score = characterScore(items, options.targetType);
    return {
      id,
      name: score.sorted[0]?.name || id,
      top_similarity: score.top,
      second_reference_similarity: score.second,
      face_similarity: score.faceTop,
      upper_similarity: score.upperTop,
      full_similarity: score.fullTop,
      generic_similarity: score.genericTop,
      top_three_mean: score.topThreeMean,
      cross_kind_score: score.crossKindScore,
      consensus_score: score.consensus,
      prototype_count: items.length,
      ambiguity_group_ids: [...new Set(items.map((item) => item.ambiguity_group_id).filter(Boolean))].sort(),
      ambiguity_identity_ids: [...new Set(items.flatMap((item) => item.ambiguity_identity_ids || []))].sort(),
      references: score.sorted.slice(0, 3),
    };
  }).sort((a, b) =>
    (b.consensus_score - a.consensus_score)
      || (b.top_similarity - a.top_similarity)
      || a.id.localeCompare(b.id),
  );
}

export function decideOpenSet(ranked, thresholds) {
  const top = ranked?.[0] || null;
  const second = ranked?.[1] || null;
  if (!top) {
    return {
      accepted: false,
      candidate: false,
      state: "unknown",
      reason: "empty_reference_bank",
      margin: 0,
      supportCount: 0,
      ambiguity_conflict: false,
      top: null,
      second: null,
    };
  }
  const margin = Number(top.consensus_score || 0) - Number(second?.consensus_score || 0);
  const supportCount = (top.references || []).filter((item) => Number(item.similarity || 0) >= thresholds.supportFloor).length;
  const ambiguityIdentityIds = new Set((top.ambiguity_identity_ids || []).map(String));
  const ambiguityGroupIds = new Set((top.ambiguity_group_ids || []).map(String));
  const ambiguityConflict = Boolean(
    second
      && (ambiguityIdentityIds.has(String(second.id))
        || (second.ambiguity_group_ids || []).some((value) => ambiguityGroupIds.has(String(value))))
  );
  const accepted = Boolean(
    top.top_similarity >= thresholds.minTop
      && top.consensus_score >= thresholds.minConsensus
      && margin >= thresholds.minMargin
      && supportCount >= thresholds.minSupport
      && !ambiguityConflict
  );
  const candidate = !ambiguityConflict && (accepted || Boolean(top.top_similarity >= thresholds.candidateTop && margin >= thresholds.candidateMargin));
  let reason = "embedding_open_set_reject";
  if (accepted) reason = "embedding_open_set_accept";
  else if (ambiguityConflict) reason = "ambiguous_reference_group";
  else if (top.top_similarity < thresholds.minTop) reason = "top_similarity_below_accept";
  else if (top.consensus_score < thresholds.minConsensus) reason = "prototype_consensus_below_accept";
  else if (margin < thresholds.minMargin) reason = "candidate_margin_too_small";
  else if (supportCount < thresholds.minSupport) reason = "insufficient_prototype_support";
  return {
    accepted,
    candidate,
    state: accepted ? "known" : "unknown",
    reason,
    margin,
    supportCount,
    ambiguity_conflict: ambiguityConflict,
    top,
    second,
  };
}

function multiViewThresholds(thresholds = {}) {
  const configured = thresholds.multiView && typeof thresholds.multiView === "object"
    ? thresholds.multiView
    : {};
  return {
    minViews: Number(configured.minViews ?? 2),
    minWinnerVotes: Number(configured.minWinnerVotes ?? 2),
    minSupportViews: Number(configured.minSupportViews ?? 2),
    supportFloor: Number(configured.supportFloor ?? 0.72),
    minTop: Number(configured.minTop ?? 0.78),
    minConsensus: Number(configured.minConsensus ?? 0.755),
    minMargin: Number(configured.minMargin ?? 0.012),
  };
}

export function aggregateMultiViewRankings(views, thresholds = {}) {
  const unique = [];
  const seenHashes = new Set();
  for (const view of views || []) {
    const digest = String(view?.image_sha256 || "");
    if (digest && seenHashes.has(digest)) continue;
    if (digest) seenHashes.add(digest);
    if (Array.isArray(view?.ranked) && view.ranked.length) unique.push(view);
  }
  const limits = multiViewThresholds(thresholds);
  if (unique.length < limits.minViews) {
    return {
      accepted: false,
      candidate: false,
      state: "unknown",
      reason: "multi_view_not_available",
      view_count: unique.length,
      margin: 0,
      ambiguity_conflict: false,
      top: null,
      second: null,
    };
  }

  const groups = new Map();
  for (const view of unique) {
    const weight = viewWeight(view.type);
    view.ranked.forEach((candidate, index) => {
      const group = groups.get(candidate.id) || {
        id: candidate.id,
        name: candidate.name || candidate.id,
        weighted_sum: 0,
        total_weight: 0,
        winner_votes: 0,
        top_two_views: 0,
        support_views: 0,
        max_similarity: -1,
        target_ids: [],
        parent_target_ids: [],
      view_scores: [],
        ambiguity_group_ids: [],
        ambiguity_identity_ids: [],
      };
      const score = Number(candidate.consensus_score || 0);
      group.weighted_sum += score * weight;
      group.total_weight += weight;
      if (index === 0) group.winner_votes += 1;
      if (index <= 1) group.top_two_views += 1;
      if (Number(candidate.top_similarity || 0) >= limits.supportFloor) group.support_views += 1;
      group.max_similarity = Math.max(group.max_similarity, Number(candidate.top_similarity || 0));
      group.target_ids.push(String(view.target_id || ""));
      group.parent_target_ids.push(String(view.parent_target_id || view.target_id || ""));
      group.view_scores.push({
        target_id: String(view.target_id || ""),
        parent_target_id: String(view.parent_target_id || view.target_id || ""),
        view_id: String(view.view_id || view.target_id || ""),
        type: String(view.type || "unknown"),
        rank: index + 1,
        top_similarity: Number(candidate.top_similarity || 0),
        consensus_score: score,
      });
      group.ambiguity_group_ids.push(...(candidate.ambiguity_group_ids || []));
      group.ambiguity_identity_ids.push(...(candidate.ambiguity_identity_ids || []));
      groups.set(candidate.id, group);
    });
  }

  const ranked = [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    aggregate_score: group.total_weight > 0 ? group.weighted_sum / group.total_weight : 0,
    max_similarity: group.max_similarity,
    winner_votes: group.winner_votes,
    top_two_views: group.top_two_views,
    support_views: group.support_views,
    target_ids: group.target_ids.filter(Boolean),
    parent_target_ids: [...new Set(group.parent_target_ids.filter(Boolean))],
    ambiguity_group_ids: [...new Set(group.ambiguity_group_ids.filter(Boolean))].sort(),
    ambiguity_identity_ids: [...new Set(group.ambiguity_identity_ids.filter(Boolean))].sort(),
    view_scores: group.view_scores,
  })).sort((a, b) =>
    (b.aggregate_score - a.aggregate_score)
      || (b.winner_votes - a.winner_votes)
      || (b.max_similarity - a.max_similarity)
      || a.id.localeCompare(b.id),
  );

  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const margin = Number(top?.aggregate_score || 0) - Number(second?.aggregate_score || 0);
  const ambiguityIdentityIds = new Set((top?.ambiguity_identity_ids || []).map(String));
  const ambiguityGroupIds = new Set((top?.ambiguity_group_ids || []).map(String));
  const ambiguityConflict = Boolean(
    second
      && (ambiguityIdentityIds.has(String(second.id))
        || (second.ambiguity_group_ids || []).some((value) => ambiguityGroupIds.has(String(value))))
  );
  const accepted = Boolean(
    top
      && top.winner_votes >= limits.minWinnerVotes
      && top.support_views >= limits.minSupportViews
      && top.max_similarity >= limits.minTop
      && top.aggregate_score >= limits.minConsensus
      && margin >= limits.minMargin
      && !ambiguityConflict
  );
  const candidate = !ambiguityConflict && (accepted || Boolean(
    top
      && top.winner_votes >= 1
      && top.support_views >= limits.minSupportViews
      && top.max_similarity >= limits.supportFloor
  ));
  let reason = "multi_view_open_set_reject";
  if (accepted) reason = "multi_view_open_set_accept";
  else if (ambiguityConflict) reason = "ambiguous_reference_group";
  else if (!top) reason = "multi_view_empty_rankings";
  else if (top.winner_votes < limits.minWinnerVotes) reason = "multi_view_insufficient_winner_votes";
  else if (top.support_views < limits.minSupportViews) reason = "multi_view_insufficient_support";
  else if (top.max_similarity < limits.minTop) reason = "multi_view_top_similarity_below_accept";
  else if (top.aggregate_score < limits.minConsensus) reason = "multi_view_consensus_below_accept";
  else if (margin < limits.minMargin) reason = "multi_view_margin_too_small";

  return {
    accepted,
    candidate,
    state: accepted ? "known" : "unknown",
    reason,
    view_count: unique.length,
    margin,
    thresholds: limits,
    top,
    second,
    ambiguity_conflict: ambiguityConflict,
    top_candidates: ranked.slice(0, 5),
  };
}

export async function prewarm({ rebuild = false, onProgress } = {}) {
  const started = Date.now();
  const bank = await getReferenceBank({ rebuild, onProgress });
  return {
    status: "ok",
    model: requireConfig().model,
    dtype: requireConfig().dtype,
    threads: requireConfig().threads,
    references: bank.references.length,
    characters: new Set(bank.references.map((item) => item.id)).size,
    index: currentIndexDescriptor(),
    integrity: bank.integrity || referenceIntegrity(bank.references),
    elapsed_ms: Date.now() - started,
    bank_cache: requireConfig().bankCachePath,
  };
}

async function mapLimit(items, concurrency, worker) {
  const values = Array.from(items || []);
  const output = new Array(values.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(values.length || 1, Number(concurrency || 1)));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
}

function embeddingItemBase(item, index) {
  return {
    input_index: index,
    target_id: String(item?.target_id || ""),
    parent_target_id: String(item?.parent_target_id || item?.target_id || ""),
    view_id: String(item?.view_id || ""),
    view_type: String(item?.view_type || item?.type || "unknown"),
    media_domain: String(item?.media_domain || "unknown"),
  };
}

function embeddingError(item, index, status, code, message, startedAt = Date.now()) {
  return {
    ...embeddingItemBase(item, index),
    status,
    embedding: null,
    error: { code, message },
    timing: { total_ms: Math.max(0, Date.now() - startedAt), decode_ms: 0, inference_ms: 0 },
  };
}

function batchStatus(items) {
  const okCount = items.filter((item) => item.status === "ok").length;
  if (okCount === items.length) return "ok";
  if (okCount === 0) return "error";
  return "partial";
}

function batchEnvelope(items, options = {}) {
  const startedAt = Number(options.startedAt || Date.now());
  const index = options.indexDescriptor || currentIndexDescriptor();
  return {
    status: batchStatus(items),
    contract_version: EMBEDDING_CONTRACT_VERSION,
    service_version: SERVICE_VERSION,
    model: modelDescriptor(options.dimension || EMBEDDING_DIMENSION),
    index,
    item_count: items.length,
    success_count: items.filter((item) => item.status === "ok").length,
    partial_errors: items
      .filter((item) => item.status !== "ok")
      .map((item) => ({
        input_index: item.input_index,
        target_id: item.target_id,
        view_id: item.view_id,
        status: item.status,
        error: item.error,
      })),
    timing: {
      queue_ms: Math.max(0, Number(options.queueMs || 0)),
      execution_ms: Math.max(0, Date.now() - startedAt),
      total_ms: Math.max(0, Date.now() - Number(options.receivedAt || startedAt)),
    },
    items,
  };
}

export function expiredEmbeddingBatch(items, options = {}) {
  const startedAt = Number(options.startedAt || Date.now());
  const output = Array.from(items || []).map((item, index) =>
    embeddingError(item, index, "timeout", "deadline_exceeded", "deadline expired before inference", startedAt),
  );
  return batchEnvelope(output, { ...options, startedAt });
}

export async function embedBatch(items, options = {}) {
  const cfg = requireConfig();
  const values = Array.from(items || []);
  const startedAt = Number(options.startedAt || Date.now());
  const deadlineAt = Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : null;
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency || cfg.embeddingConcurrency || 2)));
  const embed = options.embed || embedBuffer;
  const expectedDimension = Number(options.dimension || EMBEDDING_DIMENSION);
  const output = new Array(values.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.max(1, Math.min(values.length || 1, concurrency)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const item = values[index];
      const itemStartedAt = Date.now();
      if (deadlineAt && Date.now() >= deadlineAt) {
        output[index] = embeddingError(item, index, "timeout", "deadline_exceeded", "deadline expired before inference", itemStartedAt);
        continue;
      }
      const base = embeddingItemBase(item, index);
      if (!base.target_id || !base.view_id || typeof item?.data_base64 !== "string") {
        output[index] = embeddingError(
          item,
          index,
          "error",
          "invalid_item",
          "target_id, view_id, and data_base64 are required",
          itemStartedAt,
        );
        continue;
      }
      try {
        const decodeStartedAt = Date.now();
        const bytes = Buffer.from(item.data_base64, "base64");
        const decodeMs = Date.now() - decodeStartedAt;
        if (!bytes.length) throw Object.assign(new Error("image data is empty"), { code: "empty_image" });
        if (bytes.length > cfg.maxImageBytes) throw Object.assign(new Error("image exceeds maxImageBytes"), { code: "image_too_large" });
        if (deadlineAt && Date.now() >= deadlineAt) {
          output[index] = embeddingError(item, index, "timeout", "deadline_exceeded", "deadline expired before inference", itemStartedAt);
          output[index].timing.decode_ms = decodeMs;
          continue;
        }
        const inferenceStartedAt = Date.now();
        const embedding = normalizeVector(await embed(bytes, item.mime_type, item));
        const inferenceMs = Date.now() - inferenceStartedAt;
        if (deadlineAt && Date.now() >= deadlineAt) {
          output[index] = embeddingError(item, index, "timeout", "deadline_exceeded", "inference did not complete before deadline", itemStartedAt);
          output[index].timing.decode_ms = decodeMs;
          output[index].timing.inference_ms = inferenceMs;
          continue;
        }
        if (embedding.length !== expectedDimension || embedding.every((value) => value === 0)) {
          throw Object.assign(new Error(`invalid embedding dimension: ${embedding.length}`), { code: "invalid_embedding" });
        }
        output[index] = {
          ...base,
          status: "ok",
          image_sha256: sha256(bytes),
          embedding,
          embedding_dimension: embedding.length,
          error: null,
          timing: {
            total_ms: Date.now() - itemStartedAt,
            decode_ms: decodeMs,
            inference_ms: inferenceMs,
          },
        };
      } catch (error) {
        output[index] = embeddingError(
          item,
          index,
          "error",
          String(error?.code || "embedding_failed"),
          String(error?.message || error),
          itemStartedAt,
        );
      }
    }
  }));

  const indexDescriptor = options.indexDescriptor || currentIndexDescriptor();
  return batchEnvelope(output, {
    ...options,
    startedAt,
    dimension: expectedDimension,
    indexDescriptor,
  });
}

export async function identityIndexSnapshot(options = {}) {
  const startedAt = Number(options.startedAt || Date.now());
  const bank = options.bank || await getReferenceBank();
  const references = attachReferenceIntegrity((bank.references || [])
    .map((reference) => enrichReference(reference, null))
    .sort((left, right) => left.exemplar_id.localeCompare(right.exemplar_id)));
  const index = updateIndexDescriptor({
    ...bank,
    references,
    integrity: referenceIntegrity(references),
    index_version: bank.index_version || computeIndexVersion(references),
  });
  return {
    status: bank.errors?.length ? "partial" : "ok",
    contract_version: INDEX_CONTRACT_VERSION,
    service_version: SERVICE_VERSION,
    model: modelDescriptor(references[0]?.embedding?.length || EMBEDDING_DIMENSION),
    index,
    integrity: referenceIntegrity(references),
    partial_errors: Array.isArray(bank.errors) ? bank.errors : [],
    timing: {
      queue_ms: Math.max(0, Number(options.queueMs || 0)),
      execution_ms: Math.max(0, Date.now() - startedAt),
      total_ms: Math.max(0, Date.now() - Number(options.receivedAt || startedAt)),
    },
    exemplars: references.map((reference) => ({
      exemplar_id: reference.exemplar_id,
      identity: {
        canonical_id: String(reference.id || ""),
        display_name: String(reference.name || reference.id || ""),
      },
      source_group_id: reference.source_group_id,
      ambiguity_group_id: reference.ambiguity_group_id,
      ambiguity_identity_ids: reference.ambiguity_identity_ids,
      view_type: reference.view_type,
      media_domain: reference.media_domain,
      eligibility: reference.eligibility,
      source: {
        path: reference.path,
        sha256: reference.sha256,
      },
      embedding_dimension: reference.embedding.length,
      embedding: normalizeVector(reference.embedding),
    })),
  };
}

function retrieveError(image, code, message, startedAt, state = "error") {
  const targetId = String(image?.target_id || "");
  const parentTargetId = String(image?.parent_target_id || image?.target_id || "");
  const viewId = String(image?.view_id || image?.target_id || "");
  return {
    ranking: null,
    output: {
      target_id: targetId,
      parent_target_id: parentTargetId,
      view_id: viewId,
      bbox: image?.bbox || null,
      type: image?.type || "unknown",
      visibility: image?.visibility ?? null,
      image_bytes: 0,
      image_sha256: null,
      elapsed_ms: Date.now() - startedAt,
      decision: {
        accepted: false,
        candidate: false,
        state,
        reason: code,
        margin: 0,
        supportCount: 0,
        ambiguity_conflict: false,
        top: null,
        second: null,
      },
      top_candidates: [],
      error: { code, message },
    },
  };
}

export function expiredRetrieve(images, options = {}) {
  const cfg = requireConfig();
  const startedAt = Number(options.startedAt || Date.now());
  const targets = (images || []).map((image) => retrieveError(
    image,
    "deadline_exceeded",
    "deadline expired before identity retrieval",
    startedAt,
  ).output);
  return {
    status: "error",
    source: "clip_cpu_sidecar",
    model: cfg.model,
    dtype: cfg.dtype,
    threads: cfg.threads,
    embedding_concurrency: Number(options.concurrency || cfg.embeddingConcurrency || 2),
    elapsed_ms: Math.max(0, Date.now() - Number(options.receivedAt || startedAt)),
    reference_count: 0,
    character_count: 0,
    target_count: targets.length,
    aggregate_decision: {
      accepted: false,
      candidate: false,
      state: "error",
      reason: "deadline_exceeded",
      view_count: 0,
      margin: 0,
      top: null,
      second: null,
      ambiguity_conflict: false,
      top_candidates: [],
    },
    thresholds_used: cfg.thresholds || {},
    error: { code: "deadline_exceeded", message: "deadline expired before identity retrieval" },
    targets,
  };
}

export async function retrieve(images, options = {}) {
  const cfg = requireConfig();
  const bank = options.bank || await getReferenceBank();
  const started = Date.now();
  const embeddingConcurrency = Math.max(1, Math.min(4, Number(options.concurrency || cfg.embeddingConcurrency || 2)));
  const embed = options.embed || embedBuffer;
  const deadlineAt = Number(options.deadlineAt || 0);
  const rows = await mapLimit(images, embeddingConcurrency, async (image) => {
    const imageStarted = Date.now();
    try {
      if (deadlineAt && Date.now() >= deadlineAt) {
        return retrieveError(image, "deadline_exceeded", "deadline expired before inference", imageStarted);
      }
      const bytes = Buffer.from(image.data_base64, "base64");
      if (!bytes.length) return retrieveError(image, "empty_image", `target ${image.target_id} has empty image data`, imageStarted);
      if (bytes.length > cfg.maxImageBytes) return retrieveError(image, "image_too_large", `target ${image.target_id} exceeds maxImageBytes`, imageStarted);
      const embedding = normalizeVector(await embed(bytes, image.mime_type, image));
      if (deadlineAt && Date.now() >= deadlineAt) {
        return retrieveError(image, "deadline_exceeded", "inference did not complete before deadline", imageStarted);
      }
      if (embedding.length !== EMBEDDING_DIMENSION || embedding.every((value) => value === 0)) {
        return retrieveError(image, "invalid_embedding", `target ${image.target_id} returned an invalid embedding`, imageStarted);
      }
      const ranked = rankCharacterBank(embedding, bank.references, { targetType: image.type });
      const decision = decideOpenSet(ranked, cfg.thresholds);
      const digest = sha256(bytes);
      return {
        ranking: {
          target_id: image.target_id,
          parent_target_id: String(image.parent_target_id || image.target_id || ""),
          view_id: String(image.view_id || image.target_id || ""),
          type: image.type || "unknown",
          image_sha256: digest,
          state: decision.state,
          ranked,
        },
        output: {
          target_id: image.target_id,
          parent_target_id: String(image.parent_target_id || image.target_id || ""),
          view_id: String(image.view_id || image.target_id || ""),
          bbox: image.bbox || null,
          type: image.type || "unknown",
          visibility: image.visibility ?? null,
          image_bytes: bytes.length,
          image_sha256: digest,
          elapsed_ms: Date.now() - imageStarted,
          decision,
          error: null,
          top_candidates: ranked.slice(0, cfg.topK).map((item) => ({
            id: item.id,
            name: item.name,
            top_similarity: item.top_similarity,
            second_reference_similarity: item.second_reference_similarity,
            face_similarity: item.face_similarity,
            upper_similarity: item.upper_similarity,
            full_similarity: item.full_similarity,
            generic_similarity: item.generic_similarity,
            top_three_mean: item.top_three_mean,
            cross_kind_score: item.cross_kind_score,
            consensus_score: item.consensus_score,
            prototype_count: item.prototype_count,
            ambiguity_group_ids: item.ambiguity_group_ids,
            ambiguity_identity_ids: item.ambiguity_identity_ids,
          })),
        },
      };
    } catch (error) {
      return retrieveError(
        image,
        String(error?.code || "retrieval_failed"),
        String(error?.message || error),
        imageStarted,
      );
    }
  });
  const outputs = rows.map((row) => row.output);
  const viewRankings = rows.map((row) => row.ranking).filter(Boolean);
  const aggregateDecision = aggregateMultiViewRankings(viewRankings, cfg.thresholds);
  const errorCount = outputs.filter((output) => output.decision?.state === "error").length;
  return {
    status: errorCount === outputs.length ? "error" : errorCount ? "partial" : "ok",
    source: "clip_cpu_sidecar",
    model: cfg.model,
    dtype: cfg.dtype,
    threads: cfg.threads,
    embedding_concurrency: embeddingConcurrency,
    elapsed_ms: Date.now() - started,
    reference_count: bank.references.length,
    character_count: new Set(bank.references.map((item) => item.id)).size,
    target_count: outputs.length,
    error_count: errorCount,
    aggregate_decision: aggregateDecision,
    thresholds_used: cfg.thresholds || {},
    targets: outputs,
  };
}

export function resetRuntime() {
  runtimePromise = null;
  referenceBankPromise = null;
  indexMetadataPromise = null;
  lastIndexDescriptor = null;
}

export const versions = {
  service: SERVICE_VERSION,
  embedding_contract: EMBEDDING_CONTRACT_VERSION,
  index_contract: INDEX_CONTRACT_VERSION,
};

export const testExports = {
  normalizeVector,
  cosineSimilarity,
  stableId,
  referenceIntegrity,
  enrichReference,
  computeIndexVersion,
  currentIndexDescriptor,
  batchStatus,
  referenceKind,
  viewKind,
  viewWeight,
  characterScore,
  multiViewThresholds,
  mapLimit,
  referenceCharacterId,
};

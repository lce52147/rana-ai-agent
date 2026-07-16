import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(MODULE_DIR, "character_catalog.json");
const IMPRESSIONS_PATH = path.resolve(MODULE_DIR, "..", "..", "workspace", "LORE", "runtime", "06_Rana_Character_Impressions.json");
const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const impressionData = JSON.parse(readFileSync(IMPRESSIONS_PATH, "utf8"));
const identities = impressionData.characters.map((item) => ({
  canonicalId: item.canonicalId,
  canonicalName: item.canonicalName,
  aliases: [...new Set([item.canonicalName, ...(item.aliases || [])])],
}));
const identityById = new Map(identities.map((item) => [item.canonicalId, item]));
const impressionById = new Map(impressionData.characters.map((item) => [item.canonicalId, item]));
const referenceById = new Map(catalog.characters.map((item) => [item.id, item]));

function normalized(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function aliasMatch(text, identity) {
  const haystack = normalized(text);
  if (!haystack) return null;
  const ordered = [...identity.aliases].sort((left, right) => normalized(right).length - normalized(left).length);
  for (const alias of ordered) {
    const needle = normalized(alias);
    if (needle.length >= 2 && haystack.includes(needle)) return alias;
  }
  return null;
}

function exactNameEvidence(evidence) {
  return {
    ocr: [
      ...(evidence?.local_ocr?.normalized_lines || []),
      evidence?.local_ocr?.normalized_text,
      evidence?.local_ocr?.text,
    ].filter(Boolean),
    reverse: (evidence?.reverse_image?.accepted || []).flatMap((item) => [
      { text: item.title, item },
      { text: item.characters, item },
      { text: item.material, item },
    ]).filter((entry) => entry.text),
  };
}

function visualMatches(evidence) {
  const items = evidence?.official_reference_match?.matches;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const similarity = Number(item?.similarity || 0);
    const confidence = item?.exact_sha256 ? 1 : similarity >= 0.985 ? 0.95 : similarity >= 0.97 ? 0.8 : 0;
    return {
      id: item?.id,
      confidence,
      evidence: item?.exact_sha256 ? "exact_sha256_official_reference" : "perceptual_official_reference_match",
      similarity,
    };
  }).filter((item) => item.confidence > 0);
}

function verifiedVisualReferenceMatches(evidence) {
  const matches = evidence?.visual_reference_comparison?.matches;
  if (!Array.isArray(matches)) return [];
  return matches.map((item) => ({
    id: String(item?.id || "").trim(),
    confidence: Number(item?.confidence_score || 0),
    evidence: String(item?.evidence || "").trim(),
    position: String(item?.position || "").trim(),
    atlasId: String(item?.atlas_id || "").trim(),
    atlasConfidence: Number(item?.atlas_confidence || 0),
    confirmationConfidence: Number(item?.confirmation_confidence || 0),
  })).filter((item) => item.id && item.confidence >= 0.8);
}

function confidenceLabel(score) {
  if (score >= 0.9) return "high";
  if (score >= 0.72) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

function putCandidate(map, identity, score, reason, evidence) {
  const existing = map.get(identity.canonicalId);
  const item = {
    canonicalId: identity.canonicalId,
    canonicalName: identity.canonicalName,
    confidence: confidenceLabel(score),
    confidenceScore: score,
    evidence: [{ reason, ...evidence }],
  };
  if (!existing || score > existing.confidenceScore) {
    map.set(identity.canonicalId, item);
  } else if (score === existing.confidenceScore) {
    existing.evidence.push({ reason, ...evidence });
  }
}

/** Identity resolution consumes only image-derived identity evidence. It never reads relationship fields. */
export function resolveCanonicalIdentities(evidence, userQuestion = "") {
  const candidates = new Map();
  const texts = exactNameEvidence(evidence);

  for (const identity of identities) {
    for (const text of texts.ocr) {
      const alias = aliasMatch(text, identity);
      if (alias) putCandidate(candidates, identity, 0.99, "ocr_alias_match", { observedText: text, matchedAlias: alias });
    }
    for (const entry of texts.reverse) {
      const alias = aliasMatch(entry.text, identity);
      if (!alias) continue;
      const reverseScore = Number(entry.item?.similarity || 0);
      const score = reverseScore >= 0.9 ? 0.92 : 0.8;
      putCandidate(candidates, identity, score, "accepted_reverse_alias_match", {
        observedText: entry.text,
        matchedAlias: alias,
        service: entry.item?.service,
        similarity: reverseScore,
      });
    }
  }

  for (const match of visualMatches(evidence)) {
    const identity = identityById.get(String(match?.id || "").trim());
    const score = Number(match?.confidence || 0);
    if (!identity || score < 0.55) continue;
    putCandidate(candidates, identity, score, String(match?.evidence || "official_reference_match"), {
      visualEvidence: "Local visual comparison matched an official identity reference",
      position: String(match?.position || "").trim(),
      similarity: Number(match?.similarity || 0),
    });
  }

  for (const match of verifiedVisualReferenceMatches(evidence)) {
    const identity = identityById.get(match.id);
    if (!identity) continue;
    const conflicting = [...candidates.values()].some((item) =>
      item.canonicalId !== identity.canonicalId && item.confidenceScore >= 0.9);
    if (conflicting) continue;
    putCandidate(candidates, identity, match.confidence, "verified_official_visual_reference_match", {
      visualEvidence: match.evidence,
      position: match.position,
      atlasId: match.atlasId,
      atlasConfidence: match.atlasConfidence,
      confirmationConfidence: match.confirmationConfidence,
    });
  }
  const detectedCharacters = [...candidates.values()].sort((left, right) => right.confidenceScore - left.confidenceScore);
  const namedByUser = detectedCharacters.find((item) => {
    const identity = identityById.get(item.canonicalId);
    return identity?.aliases.some((alias) => normalized(userQuestion).includes(normalized(alias)));
  });
  const ocrNamed = detectedCharacters.find((item) => item.evidence.some((entry) => entry.reason === "ocr_alias_match"));
  const primaryCharacter = namedByUser || ocrNamed || detectedCharacters[0] || null;
  return { detectedCharacters, primaryCharacter };
}

/** Impression lookup happens only after identity resolution and cannot affect the selected identity. */
export function lookupCharacterImpression(identity) {
  if (!identity || identity.confidence === "low" || identity.confidence === "unknown") return null;
  const source = impressionById.get(identity.canonicalId);
  if (!source) return null;
  return {
    canonicalId: source.canonicalId,
    canonicalName: source.canonicalName,
    recognitionLevel: source.recognitionLevel,
    howRanaKnowsThem: source.howRanaKnowsThem,
    memoryAnchors: source.memoryAnchors,
    ranaCallsThem: source.ranaCallsThem,
    allowedKnowledge: source.allowedKnowledge,
    allowedReactionStyle: source.allowedReactionStyle,
    forbiddenExpansion: source.forbiddenExpansion,
    tentative: identity.confidence === "medium",
  };
}

export function resolveImageCharacters(evidence, userQuestion = "") {
  const resolved = resolveCanonicalIdentities(evidence, userQuestion);
  return {
    primaryCharacter: resolved.primaryCharacter,
    detectedCharacters: resolved.detectedCharacters.map((identity) => ({
      ...identity,
      impression: lookupCharacterImpression(identity),
    })),
    primaryImpression: lookupCharacterImpression(resolved.primaryCharacter),
  };
}

export function characterAtlases() {
  return catalog.atlases.map((atlas) => ({
    id: atlas.id,
    path: path.join(MODULE_DIR, "references", atlas.file),
    characters: atlas.characters.map((id) => {
      const reference = referenceById.get(id);
      const identity = identityById.get(id);
      return reference && identity ? { ...reference, name: identity.canonicalName, aliases: identity.aliases } : null;
    }).filter(Boolean),
  }));
}

export function identityReferenceCatalog() {
  return identities.map((identity) => {
    const reference = referenceById.get(identity.canonicalId);
    return {
      id: identity.canonicalId,
      name: identity.canonicalName,
      aliases: identity.aliases,
      visualTraits: reference?.visual_traits || [],
    };
  });
}

export function relationshipCatalog() {
  return impressionData.characters;
}

export const __test = {
  aliasMatch,
  confidenceLabel,
  exactNameEvidence,
  identities,
  normalized,
  visualMatches,
  verifiedVisualReferenceMatches,
};

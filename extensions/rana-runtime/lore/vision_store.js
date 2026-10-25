import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
const STORE_PATH = path.join(ROOT, "workspace", "LORE", "runtime", "06_Rana_Character_Impressions.json");
const RANA_ENTITY_ID = "bangdream.character.rana_kaname";
const PAIRWISE_PREDICATES = new Set([
  "recognizes",
  "has_seen",
  "identity_link",
  "family_relation",
  "worked_with",
  "performed_live_with",
  "rehearsed_with",
  "rehearsed_and_performed_with",
  "interacted_with",
]);
const PARTICIPANT_PREDICATES = new Set(["member_of", "member_of_or_associated_with", "role"]);
let cached = { signature: "", store: null };

function signature() {
  if (!fs.existsSync(STORE_PATH)) return "missing";
  const stat = fs.statSync(STORE_PATH);
  return `${stat.mtimeMs}:${stat.size}`;
}

function loadStore() {
  const current = signature();
  if (cached.signature === current && cached.store) return cached.store;
  const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8").replace(/^\uFEFF/u, ""));
  if (!Array.isArray(store?.characters) || !Array.isArray(store?.facts)) {
    throw new Error("Rana character store is missing characters or facts");
  }
  cached = { signature: current, store };
  return store;
}

function uniqueFacts(facts) {
  return [...new Map(facts.map((fact) => [String(fact?.factId || JSON.stringify(fact)), fact])).values()];
}

function factTargetsRanaAnd(fact, targetId) {
  return (fact.subject === RANA_ENTITY_ID && fact.object === targetId)
    || (fact.subject === targetId && fact.object === RANA_ENTITY_ID)
    || (fact.subject === RANA_ENTITY_ID && fact.qualifiers?.person === targetId)
    || (fact.subject === targetId && fact.qualifiers?.person === RANA_ENTITY_ID);
}

export function characterForVision(entityId) {
  return loadStore().characters.find((item) => item.entityId === entityId) || null;
}

export function exactVisionSource(entityId) {
  const character = characterForVision(entityId);
  if (!character) return null;
  return {
    evidence_id: `character:${entityId}`,
    source_type: "structured_character_store",
    source_title: `${character.canonicalName} canonical record`,
    entity_ids: [entityId],
    canonical_id: character.canonicalId,
    canonical_name: character.canonicalName,
    recognition_level: character.recognitionLevel,
    inventory_name: character.ranaCallsThem?.[0] || character.canonicalName,
    rana_calls_them: character.ranaCallsThem || [],
    group: character.group || "",
    source_refs: character.sourceRefs || [],
    how_rana_knows_them: character.howRanaKnowsThem || [],
    memory_anchors: character.memoryAnchors || [],
    allowed_knowledge: character.allowedKnowledge || [],
    forbidden_expansion: character.forbiddenExpansion || [],
  };
}

export function visionStructuredFacts(entityId, mode = "relationship") {
  const store = loadStore();
  const all = store.facts;
  if (mode === "recognition") {
    return uniqueFacts(all.filter((fact) => factTargetsRanaAnd(fact, entityId)
      && ["recognizes", "has_seen", "knows_of"].includes(String(fact.predicate || ""))));
  }
  const pairwise = all.filter((fact) => factTargetsRanaAnd(fact, entityId)
    && PAIRWISE_PREDICATES.has(String(fact.predicate || "")));
  const participant = all.filter((fact) => [RANA_ENTITY_ID, entityId].includes(fact.subject)
    && PARTICIPANT_PREDICATES.has(String(fact.predicate || "")));
  return uniqueFacts([...pairwise, ...participant]);
}

export function visionBoundaries(entityId) {
  const store = loadStore();
  const policyBoundaries = (store.policies?.recognitionDoesNotImply || []).map((predicate) => ({
    boundaryId: `recognition_does_not_imply.${predicate}`,
    subject: RANA_ENTITY_ID,
    predicate,
    object: null,
    status: "not_implied_by_recognition_fact",
  }));
  const scoped = (store.boundaries || []).filter((item) =>
    !(item.entityIds || []).length || item.entityIds.includes(entityId));
  return uniqueFacts([...policyBoundaries, ...scoped]);
}

export function visionLoreSnapshot(entityId, mode = "relationship") {
  const exactSource = exactVisionSource(entityId);
  const structuredFacts = visionStructuredFacts(entityId, mode);
  return {
    exactSource,
    structuredFacts,
    relationshipEvidence: structuredFacts,
    knowledgeBoundaries: visionBoundaries(entityId),
    knowledgeContract: structuredFacts.length ? "supported" : "unknown",
  };
}

export const __test = { loadStore, factTargetsRanaAnd };

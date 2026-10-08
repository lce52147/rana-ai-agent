import { buildUnifiedTurnPlan, turnPlanNeedsLore } from "../architecture/turn_plan.js";
import { evaluateEvidenceCoverage } from "../architecture/evidence_coverage.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Search, buildBm25, sanitizeEvidenceText } from "./search_core.js";
import { loadCanonicalEntities, rememberResolvedEntities, resolveEntityMentions } from "./entity_resolver.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
const LORE_ROOT = path.join(ROOT, "workspace", "LORE");
const STORE_PATH = path.join(LORE_ROOT, "runtime", "06_Rana_Character_Impressions.json");
const CORPUS_PATH = path.join(LORE_ROOT, "generated", "rag", "chunk_manifest.json");
const MANIFEST_PATH = path.join(LORE_ROOT, "LORE_MANIFEST.json");
const PERSONA_PATH = path.join(ROOT, "workspace", "PERSONA.json");
const RANA_ENTITY_ID = "bangdream.character.rana_kaname";

let cache = { signature: "", store: null, corpus: null, manifest: null, entities: null };

function fileSignature(filePath) {
  if (!fs.existsSync(filePath)) return `${filePath}:missing`;
  const stat = fs.statSync(filePath);
  return `${filePath}:${stat.mtimeMs}:${stat.size}`;
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function normalizeLoreManifestPath(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/^LORE\//u, "").trim();
}

function liveMarkdownChunks(relativePath, content) {
  const clean = String(content || "").replace(/^\uFEFF/u, "").trim();
  if (!clean) return [];
  const lines = clean.split(/\r?\n/u);
  const chunks = [];
  let heading = path.parse(relativePath).name;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (!body) return;
    chunks.push({
      id: `live:${relativePath}:${chunks.length}`,
      content: body,
      metadata: {
        sourcePath: relativePath,
        sourceTitle: heading,
        sourceType: /^runtime\//iu.test(relativePath) ? "runtime" : "research",
        retrievalPolicy: "canonical_lore_only",
        entityIds: [],
        canonLevel: "reviewed",
      },
    });
    buffer = [];
  };
  for (const line of lines) {
    const match = line.match(/^#{1,4}\s+(.+)$/u);
    if (match) {
      flush();
      heading = match[1].trim() || heading;
      buffer.push(line);
    } else buffer.push(line);
  }
  flush();
  return chunks;
}

function liveRetrievalCorpus(manifest) {
  const sourceList = [...new Set((Array.isArray(manifest?.retrievalOnly) ? manifest.retrievalOnly : [])
    .map(normalizeLoreManifestPath)
    .filter(Boolean))];
  const chunks = [];
  const signatures = [];
  for (const relativePath of sourceList) {
    const filePath = path.join(LORE_ROOT, relativePath);
    if (!filePath.startsWith(LORE_ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      signatures.push(`${relativePath}:missing`);
      continue;
    }
    const stat = fs.statSync(filePath);
    signatures.push(`${relativePath}:${stat.mtimeMs}:${stat.size}`);
    const content = fs.readFileSync(filePath, "utf8");
    chunks.push(...liveMarkdownChunks(relativePath, content));
  }
  return { chunks, signature: signatures.join("|") };
}

function loadState() {
  const baseManifest = readJson(MANIFEST_PATH, { retrievalOnly: [] }) || { retrievalOnly: [] };
  const liveCorpus = liveRetrievalCorpus(baseManifest);
  const current = [STORE_PATH, MANIFEST_PATH].map(fileSignature).join("|") + "|" + liveCorpus.signature;
  if (cache.signature === current && cache.store) return cache;
  const store = readJson(STORE_PATH);
  if (!store?.authority || !Array.isArray(store.facts) || !Array.isArray(store.boundaries)) {
    throw new Error("06_Rana_Character_Impressions.json is missing the structured authority/facts/boundaries schema");
  }
  const generatedEntities = (() => {
    try {
      return loadCanonicalEntities();
    } catch {
      return {
        entities: (store.characters || []).map((item) => ({
          entityId: item.entityId,
          canonicalId: item.canonicalId,
          canonicalName: item.canonicalName,
          aliases: [item.canonicalName, ...(item.aliases || [])],
          group: item.group || "",
        })).filter((item) => item.entityId),
      };
    }
  })();

  // Current source files selected by LORE_MANIFEST are authoritative for
  // retrieval. The stale generated corpus remains on disk only as build/debug
  // material and is not consulted for production evidence.
  const corpus = { chunks: liveCorpus.chunks, sourceMode: "live_manifest_sources" };
  const manifest = {
    ...baseManifest,
    retrievalOnly: [...new Set((baseManifest.retrievalOnly || []).map(normalizeLoreManifestPath))],
  };
  cache = { signature: current, store, corpus, manifest, entities: generatedEntities };
  return cache;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
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

function entityMaps(state = loadState()) {
  const byId = new Map(state.entities.entities.map((item) => [item.entityId, item]));
  const byCanonicalId = new Map(state.entities.entities.map((item) => [item.canonicalId, item]));
  return { byId, byCanonicalId };
}

function entityName(entityId, state = loadState()) {
  if (entityId === RANA_ENTITY_ID) return "我";
  if (entityId === "place:SPACE") return "SPACE";
  if (entityId === "place:RiNG") return "RiNG";
  return entityMaps(state).byId.get(entityId)?.canonicalName || entityId;
}

function descriptorResolution(query, explicitEntities, state = loadState()) {
  if (explicitEntities.some((item) => item.source === "alias" || item.source === "vision")) return [];
  const text = normalize(query);
  const ranked = (state.store.descriptors || []).map((descriptor) => {
    const matches = [];
    let score = 0;
    for (const feature of descriptor.features || []) {
      const alias = (feature.aliases || []).find((candidate) => text.includes(normalize(candidate)));
      if (!alias) continue;
      score += Number(feature.weight || 1);
      matches.push({ key: feature.key, alias, weight: Number(feature.weight || 1) });
    }
    return { descriptor, score, matches };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.matches.length - left.matches.length);

  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 3 || best.score - (second?.score || 0) < 1) return [];
  const entity = entityMaps(state).byId.get(best.descriptor.entityId);
  if (!entity) return [];
  return [{ ...publicEntity(entity, best.matches.map((item) => item.alias).join("+"), "structured_descriptor"), descriptor_matches: best.matches }];
}

function isUnknownPeopleInventoryQuery(query) {
  const text = String(query || "").replace(/<@!?\d+>|@Rana/giu, " ").replace(/\s+/gu, "");
  return /(?:你|妳|樂奈|Rana)(?:到底|目前)?(?:都)?(?:不|沒|沒有)(?:認識|記得|熟悉)(?:的)?(?:有)?(?:誰|哪些人|哪幾個人|什麼人)/iu.test(text)
    || /(?:哪些名字|哪些人).{0,28}(?:無法確認|不在).{0,28}(?:認識|記憶)/u.test(text);
}

function thirdPartySubject(query, resolved) {
  const text = normalize(query);
  const predicateIndex = text.indexOf("認識");
  if (predicateIndex < 0) return null;
  return resolved.find((entity) => {
    if (entity.entity_id === RANA_ENTITY_ID) return false;
    const alias = normalize(entity.matched_alias || entity.canonical_name);
    const index = text.indexOf(alias);
    if (index < 0 || index >= predicateIndex) return false;
    const between = text.slice(index + alias.length, predicateIndex);
    return !/(?:你|妳|樂奈|Rana|我)/iu.test(between);
  }) || null;
}

function isSourceQuery(query) {
  return /(?:來源|證據|出處|哪個活動|哪個故事|哪一話|哪一章|官方|CG)/iu.test(String(query || ""));
}

function isPrivateInformationQuery(query) {
  return /(?:財務|經濟狀況|家庭內情|家庭財務|私生活|未說出口|全部動機|精神醫學|醫療診斷)/u.test(String(query || ""));
}

function isReasonQuery(query) {
  return /(?:為什麼|原因|理由)/u.test(String(query || ""));
}

function isIdentityComparisonQuery(query, resolved) {
  return resolved.filter((item) => item.entity_id !== RANA_ENTITY_ID).length > 1
    && /(?:同一|一樣|不同|不一樣|差異|差別|區別|關係|分辨|辨別)/u.test(String(query || ""));
}

function isIdentityQuestion(query) {
  return /(?:是誰|誰是|哪個角色|指的是誰|什麼人)/u.test(String(query || ""));
}

function isAssistantSelfIdentityQuestion(query) {
  const text = normalize(String(query || "")
    .replace(/<@!?\d+>|@Rana(?:#\d+)?|@樂奈/giu, " "));
  return /^(?:你|妳)(?:是誰|叫什麼(?:名字)?|是哪位)$/u.test(text);
}

function isRecognitionQuestion(query) {
  return /(?:認識|記得|熟悉|熟人|熟嗎|熟不熟)/u.test(String(query || ""));
}

function isSubjectiveImpressionQuestion(query) {
  return /(?:怎麼看|如何看待|覺得.{0,12}(?:怎樣|怎麼樣|如何)|印象)/u.test(String(query || ""));
}

function isRanaRelationshipQuestion(query, resolved) {
  const text = String(query || "");
  const hasTarget = resolved.some((item) => item.entity_id !== RANA_ENTITY_ID);
  const mentionsRanaAsParticipant = /(?:你|妳|要樂奈|樂奈|Rana|我)/iu.test(text);
  if (!hasTarget || !mentionsRanaAsParticipant || isSubjectiveImpressionQuestion(text)) return false;
  return /(?:關係|熟嗎|熟不熟|熟悉嗎|團員|同團|隊友|朋友|搭檔|同事)/u.test(text);
}

function isGroupInteractionInventory(query) {
  return /(?:誰|哪些(?:人|成員)|哪幾(?:人|位|個)|哪位)/u.test(String(query || ""))
    && /(?:互動|接觸|一起做過|做過什麼)/u.test(String(query || ""));
}

function isPlaceQuery(query) {
  return /(?:SPACE|RiNG)/iu.test(String(query || ""));
}

function isSelfProfileQuery(query) {
  const text = String(query || "");
  return /(?:妳|你|要樂奈|樂奈|Rana)/iu.test(text)
    && /(?:生日|幾歲|學校|樂器|吉他|喜歡|SPACE|RiNG|樂團|團員)/iu.test(text);
}

function isEventQuery(query) {
  return /(?:互動|接觸|發生|做過|談過|聊過|事件|活動|劇情|故事|一起|見過|去過|吃過|喝過|看過|參加過|彈過|買過|送過|說過|影響|想做什麼|交換|指尖|貓集會|排練|演奏|教過|叫過|認識過|CG)/iu.test(String(query || ""));
}

function isMovementEventQuery(query) {
  return /(?:帶.{0,6}去|跟著|跟隨|怎麼到|如何到|到了|到過|前往|去到)/iu.test(String(query || ""));
}

function isLocationSeekingEventQuery(query) {
  return /(?:去哪(?:裡|里|儿)?|去過哪(?:裡|里|儿)?|到哪(?:裡|里|儿)?|哪(?:裡|里|儿)|何處|何处)/iu.test(String(query || ""));
}

function isSpatialEventFact(fact) {
  if (!isEventFact(fact)) return false;
  if (/(?:place|location|venue|地點|地点)/iu.test(Object.keys(fact.qualifiers || {}).join(" "))) return true;
  return [fact.predicate, fact.object, ...(fact.topics || []), ...Object.values(fact.qualifiers || {})]
    .some((value) => /(?:SPACE|RiNG|舊址|旧址|場所|场所|地點|地点)/iu.test(String(value || "")));
}

function explicitRelationshipPair(query, resolved, state = loadState()) {
  const unified = buildUnifiedTurnPlan(query);
  if (unified?.subject?.type !== "relationship_pair" || !Array.isArray(unified.subject.names) || unified.subject.names.length < 2) return null;
  const names = unified.subject.names.slice(0, 2).map((name) => String(name || "").replace(/^(?:你|妳)的?/u, "").trim()).filter(Boolean);
  if (names.length < 2) return null;
  const resolveOne = (name) => {
    const needle = normalize(name);
    const hit = resolved.find((item) => [item.matched_alias, item.canonical_name].some((value) => value && normalize(value) === needle));
    if (hit) return { name, entity_id: hit.entity_id, canonical_name: hit.canonical_name };
    const entity = state.entities.entities.find((item) => [item.canonicalName, ...(item.aliases || [])].some((value) => value && normalize(value) === needle));
    if (entity) return { name, entity_id: entity.entityId, canonical_name: entity.canonicalName };
    return { name, literal: name };
  };
  return names.map(resolveOne);
}

function participantMatchesFactValue(participant, value, state = loadState()) {
  if (!participant) return false;
  if (participant.entity_id && value === participant.entity_id) return true;
  const valueName = entityName(value, state);
  const expected = participant.canonical_name || participant.literal || participant.name;
  return Boolean(expected && (normalize(value) === normalize(expected) || normalize(valueName) === normalize(expected)));
}

function buildQueryPlan(query, resolved, unifiedTurnPlan = null) {
  const thirdParty = thirdPartySubject(query, resolved);
  const nonRana = resolved.filter((item) => item.entity_id !== RANA_ENTITY_ID);
  const explicitPair = explicitRelationshipPair(query, resolved);
  let intent = "entity_or_event";
  let subject = { type: "speaker", entity_ids: [RANA_ENTITY_ID] };
  let object = { type: nonRana.length ? "resolved_entities" : "requested_value", entity_ids: nonRana.map((item) => item.entity_id) };
  let scope = "named_entities_and_requested_fact";
  const requestedAspect = String(unifiedTurnPlan?.evidence?.requestedAspect || "");
  let predicate = requestedAspect === "event_ownership"
    ? "event_ownership"
    : isEventQuery(query) ? "interaction_or_event" : "identity_or_attribute";
  let polarity = /(?:沒|沒有|未曾)/u.test(String(query || "")) ? "negative" : "positive";
  let temporal_scope = /(?:現在|目前|如今|還)/u.test(String(query || "")) ? "current" : /(?:以前|過去|曾經|小時候)/u.test(String(query || "")) ? "past" : "unspecified";
  const knownPeopleInventoryContinuation = String(unifiedTurnPlan?.utteranceAct?.continuationMode || "") === "known_people_inventory_followup";
  const knownPeopleInventoryFirstRound = !knownPeopleInventoryContinuation
    && unifiedTurnPlan?.subject?.type === "active_persona"
    && unifiedTurnPlan?.predicate === "relationship"
    && unifiedTurnPlan?.evidence?.source === "persona_canonical"
    && (unifiedTurnPlan?.evidence?.predicateAnchors || []).some((item) => /(?:認識|认识)/u.test(String(item || "")));

  if (explicitPair) {
    intent = "explicit_relationship_pair";
    subject = { type: "explicit_participant", entity_ids: explicitPair[0].entity_id ? [explicitPair[0].entity_id] : [], participant: explicitPair[0] };
    object = { type: "explicit_participant", entity_ids: explicitPair[1].entity_id ? [explicitPair[1].entity_id] : [], participant: explicitPair[1] };
    scope = "explicit_pairwise_relationship";
    predicate = "relationship";
  } else if (isUnknownPeopleInventoryQuery(query)) {
    intent = "unknown_people_inventory";
    scope = "unconfirmed_recognition_set";
    predicate = "recognition_status";
    polarity = "negative";
    object = { type: "relationship_target_set", entity_ids: [] };
  } else if (thirdParty && /(?:誰|哪些人|哪幾個人|哪幾人|什麼人)/u.test(String(query || ""))) {
    intent = "third_party_relationship_inventory";
    subject = { type: "third_party", entity_ids: [thirdParty.entity_id], canonical_name: thirdParty.canonical_name };
    object = { type: "relationship_target_set", entity_ids: [] };
    scope = "explicit_pairwise_relationships";
    predicate = "recognizes";
  } else if (thirdParty && /(?:妳|你|樂奈|Rana|我)/iu.test(String(query || ""))) {
    intent = "third_party_relationship_check";
    subject = { type: "third_party", entity_ids: [thirdParty.entity_id], canonical_name: thirdParty.canonical_name };
    object = { type: "speaker", entity_ids: [RANA_ENTITY_ID] };
    scope = "explicit_pairwise_relationship";
    predicate = "recognizes";
  } else if (knownPeopleInventoryContinuation || knownPeopleInventoryFirstRound) {
    intent = "known_people_inventory";
    object = { type: "relationship_target_set", entity_ids: [] };
    scope = knownPeopleInventoryContinuation ? "remembered_people_followup" : "core_people_first_round";
    predicate = "recognizes_or_has_seen";
  } else if (isGroupInteractionInventory(query)) {
    intent = "rana_relationship_inventory";
    object = { type: "relationship_target_set", entity_ids: [] };
    scope = "direct_interactions_in_named_group";
    predicate = "interacted_with";
  } else if (isIdentityComparisonQuery(query, resolved)) {
    intent = "entity_comparison";
    subject = { type: "resolved_entities", entity_ids: nonRana.map((item) => item.entity_id) };
    object = { type: "relationship", entity_ids: nonRana.map((item) => item.entity_id) };
    scope = "linked_identity_and_event_ownership";
    predicate = "linked_identity_distinct_state_or_persona";
  } else if (isPrivateInformationQuery(query)) {
    intent = "knowledge_boundary";
    scope = "requested_private_information";
    predicate = /(?:財務|經濟狀況|家庭內情|家庭財務)/u.test(String(query || "")) ? "family_financial_information" : "private_information";
  } else if (isReasonQuery(query)) {
    intent = "reason_or_motivation";
    scope = "supported_event_sequence_and_unknown_motivation";
    predicate = "reason_or_motivation";
  } else if (isRanaRelationshipQuestion(query, resolved)) {
    intent = "relationship";
    subject = { type: "speaker", entity_ids: [RANA_ENTITY_ID] };
    object = { type: "resolved_entities", entity_ids: nonRana.map((item) => item.entity_id) };
    scope = "explicit_pairwise_relationship";
    predicate = "recognizes";
  } else if (isIdentityQuestion(query)) {
    intent = "identity";
    if (resolved.length) subject = { type: "resolved_entities", entity_ids: resolved.map((item) => item.entity_id) };
    else subject = { type: "unresolved_entity", entity_ids: [] };
    object = { type: "identity", entity_ids: [] };
    scope = "resolved_entity_identity";
    predicate = "identity";
  } else if (isRecognitionQuestion(query) && nonRana.length) {
    intent = "person_recognition_check";
    scope = "recognition_only";
    predicate = "recognizes_or_has_seen";
  } else if (isPlaceQuery(query) && !(nonRana.length && (isEventQuery(query) || isMovementEventQuery(query)))) {
    intent = "place_state";
    scope = "place_history_and_current_state";
    predicate = "place_state";
  } else if (isSelfProfileQuery(query) && !(nonRana.length && (isEventQuery(query) || isMovementEventQuery(query)))) {
    intent = "self_profile";
    scope = "stable_self_profile";
    predicate = "self_attribute";
  }

  return { intent, subject, object, scope, predicate, polarity, temporal_scope };
}

function factInvolves(fact, entityId) {
  return fact.subject === entityId || fact.object === entityId || fact.qualifiers?.person === entityId;
}

function factTargetsRanaAnd(fact, targetId) {
  return (fact.subject === RANA_ENTITY_ID && fact.object === targetId)
    || (fact.subject === targetId && fact.object === RANA_ENTITY_ID)
    || (fact.subject === RANA_ENTITY_ID && fact.qualifiers?.person === targetId)
    || (fact.subject === targetId && fact.qualifiers?.person === RANA_ENTITY_ID);
}

function isRelationshipPredicate(predicate) {
  return ["recognizes", "has_seen", "identity_link", "family_relation"].includes(predicate);
}

const EXPLICIT_PAIRWISE_RELATION_PREDICATES = new Set([
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

const RELATIONSHIP_PARTICIPANT_PREDICATES = new Set([
  "member_of",
  "member_of_or_associated_with",
  "role",
]);

const AMBIGUOUS_RELATIONSHIP_PREDICATES = new Set([
  "member_of_or_associated_with",
  "associated_with",
  "relationship",
]);

function isEventFact(fact) {
  return !["identity", "member_of", "member_of_or_associated_with", "role", "likes", "recognizes", "has_seen", "status", "current_use", "frequented", "frequents", "identity_link"].includes(fact.predicate);
}

function focusedEventFacts(eventFacts, query, resolved = []) {
  const focus = stripQuestionFocus(query, resolved);
  const scored = eventFacts.map((fact) => ({ fact, score: topicMatchScore(fact, query, resolved) }))
    .sort((left, right) => right.score - left.score);
  if (isLocationSeekingEventQuery(query)) return eventFacts.filter(isSpatialEventFact);
  if (isSourceQuery(query) || !focus || /^(?:互動|事件|故事|劇情|來源|活動)$/u.test(focus)) return eventFacts;
  return scored.filter((item) => item.score > 0).map((item) => item.fact);
}

function linkedIdentityTargets(targets, allFacts = []) {
  const pairs = [];
  for (const fact of allFacts) {
    if (fact.predicate !== "identity_link") continue;
    for (const target of targets) {
      const linked = fact.subject === target ? fact.object : fact.object === target ? fact.subject : null;
      if (!linked || linked === target) continue;
      pairs.push({ target, linked, identityFact: fact });
    }
  }
  return [...new Map(pairs.map((item) => [`${item.target}\u0000${item.linked}`, item])).values()];
}

function linkedIdentityEventProjection(target, linked, eventFact) {
  return {
    factId: `derived.linked_identity_event_ownership.${target}.${eventFact.factId || eventFact.predicate}`,
    subject: target,
    predicate: "linked_identity_event_ownership",
    object: linked,
    qualifiers: {
      relation: "linked_identity_distinct_state_or_persona",
      event_owner: linked,
      event_fact_id: eventFact.factId || null,
      event_predicate: eventFact.predicate,
      direct_ownership_by_requested_entity: false,
    },
    topics: [...new Set([...(eventFact.topics || []), "event ownership"])],
  };
}

function stripQuestionFocus(query, resolved) {
  let text = String(query || "").normalize("NFKC");
  for (const entity of resolved) {
    for (const alias of [entity.matched_alias, entity.canonical_name]) {
      if (alias) text = text.replaceAll(String(alias), " ");
    }
  }
  return normalize(text
    .replace(/<@!?\d+>|@Rana|@樂奈/giu, " ")
    .replace(/(?:你|妳|我|樂奈|Rana|她|他|那個人|這個人|那位|這位|跟|和|與|認識|記得|熟悉|有什麼|做過什麼|談過什麼|聊過什麼|發生過什麼|發生了什麼|一起|是否|有沒有|沒有|沒|嗎|呢|吧|的|了|是|在|為什麼|原因|理由|請|說說|分別|清楚|實際|直接)/giu, " "));
}

function topicMatchScore(fact, query, resolved = []) {
  let cleaned = String(query || "");
  for (const entity of resolved) {
    for (const alias of [entity.matched_alias, entity.canonical_name]) {
      if (alias) cleaned = cleaned.replaceAll(String(alias), " ");
    }
  }
  const q = normalize(cleaned);
  return (fact.topics || []).reduce((score, topic) => score + (q.includes(normalize(topic)) ? Math.max(1, normalize(topic).length) : 0), 0);
}

function selectedTargetIds(resolved) {
  return resolved.filter((item) => item.entity_id !== RANA_ENTITY_ID).map((item) => item.entity_id);
}

function groupNamesInQuery(query, store) {
  const text = normalize(query);
  const groups = new Set();
  for (const character of store.characters || []) {
    for (const group of String(character.group || "").split("/").map((item) => item.trim()).filter(Boolean)) {
      if (text.includes(normalize(group))) groups.add(group);
    }
  }
  return [...groups];
}

function factGroupForEntity(entityId, store) {
  const character = (store.characters || []).find((item) => item.entityId === entityId);
  return String(character?.group || "").split("/").map((item) => item.trim()).filter(Boolean);
}

function selectFacts(plan, resolved, query, state = loadState()) {
  const all = state.store.facts || [];
  const targets = selectedTargetIds(resolved);
  let facts = [];

  switch (plan.intent) {
    case "known_people_inventory": {
      const characterByEntityId = new Map((state.store.characters || []).map((item) => [item.entityId, item]));
      const isFollowup = plan.scope === "remembered_people_followup";
      facts = all.filter((fact) => {
        if (fact.subject !== RANA_ENTITY_ID || fact.object === RANA_ENTITY_ID || !["recognizes", "has_seen"].includes(fact.predicate)) return false;
        const character = characterByEntityId.get(fact.object);
        const level = String(character?.recognitionLevel || "").toLowerCase();
        if (isFollowup) return ["remembered", "remembered_once"].includes(level);
        const groups = String(character?.group || "").split("/").map((item) => item.trim()).filter(Boolean);
        return level === "core" && groups.includes("MyGO!!!!!");
      });
      break;
    }
    case "unknown_people_inventory":
      facts = (state.store.characters || [])
        .filter((item) => (state.store.policies?.unknownRecognitionLevels || ["unknown"]).includes(item.recognitionLevel))
        .map((item) => ({
          factId: `unconfirmed.${item.canonicalId}`,
          subject: RANA_ENTITY_ID,
          predicate: "recognition_status",
          object: item.entityId,
          qualifiers: { status: "unconfirmed" },
          sourceRefs: item.sourceRefs || [],
        }));
      break;
    case "third_party_relationship_inventory": {
      const subjectId = plan.subject.entity_ids[0];
      facts = all.filter((fact) => fact.subject === subjectId && fact.predicate === "recognizes");
      break;
    }
    case "third_party_relationship_check": {
      const subjectId = plan.subject.entity_ids[0];
      facts = all.filter((fact) => fact.subject === subjectId && fact.object === RANA_ENTITY_ID && fact.predicate === "recognizes");
      break;
    }
    case "rana_relationship_inventory": {
      const groups = groupNamesInQuery(query, state.store);
      const candidateTargets = new Set();
      for (const fact of all) {
        if (!isEventFact(fact)) continue;
        const other = fact.subject === RANA_ENTITY_ID ? fact.object : fact.object === RANA_ENTITY_ID ? fact.subject : null;
        if (!other || !state.entities.entities.some((entity) => entity.entityId === other)) continue;
        if (groups.length && !factGroupForEntity(other, state.store).some((group) => groups.includes(group))) continue;
        candidateTargets.add(other);
      }
      facts = [...candidateTargets].map((entityId) => ({
        factId: `derived.direct_interaction.${entityId}`,
        subject: RANA_ENTITY_ID,
        predicate: "interacted_with",
        object: entityId,
        qualifiers: { basis: "explicit_event_facts_in_same_store" },
      }));
      break;
    }
    case "entity_comparison":
      facts = all.filter((fact) => fact.predicate === "identity_link" && targets.includes(fact.subject) && targets.includes(fact.object));
      break;
    case "knowledge_boundary":
      facts = all.filter((fact) => targets.some((target) => factTargetsRanaAnd(fact, target)) && ["recognizes", "has_seen"].includes(fact.predicate));
      break;
    case "explicit_relationship_pair": {
      const left = plan.subject?.participant;
      const right = plan.object?.participant;
      facts = all.filter((fact) => {
        const direct = participantMatchesFactValue(left, fact.subject, state) && participantMatchesFactValue(right, fact.object, state);
        const reverse = participantMatchesFactValue(right, fact.subject, state) && participantMatchesFactValue(left, fact.object, state);
        if (direct || reverse) return true;
        // Participant metadata may also be useful, but only when it directly names one side.
        return RELATIONSHIP_PARTICIPANT_PREDICATES.has(fact.predicate)
          && (participantMatchesFactValue(left, fact.subject, state) || participantMatchesFactValue(right, fact.subject, state))
          && (participantMatchesFactValue(left, fact.object, state) || participantMatchesFactValue(right, fact.object, state));
      });
      break;
    }
    case "relationship": {
      const participantIds = new Set([RANA_ENTITY_ID, ...targets]);
      const pairwiseFacts = all.filter((fact) => targets.some((target) => factTargetsRanaAnd(fact, target))
        && EXPLICIT_PAIRWISE_RELATION_PREDICATES.has(fact.predicate));
      const participantFacts = all.filter((fact) => participantIds.has(fact.subject)
        && RELATIONSHIP_PARTICIPANT_PREDICATES.has(fact.predicate));
      facts = [...pairwiseFacts, ...participantFacts];
      break;
    }
    case "identity": {
      const identityTargets = resolved.length ? resolved.map((item) => item.entity_id) : targets;
      facts = all.filter((fact) => identityTargets.includes(fact.subject) && ["identity", "member_of", "member_of_or_associated_with", "role"].includes(fact.predicate));
      if (!facts.length && identityTargets.length) {
        facts = identityTargets.map((entityId) => ({ factId: `identity.${entityId}`, subject: entityId, predicate: "identity", object: entityName(entityId, state) }));
      }
      break;
    }
    case "person_recognition_check":
      facts = all.filter((fact) => targets.some((target) => fact.subject === RANA_ENTITY_ID && fact.object === target)
        && ["recognizes", "has_seen"].includes(fact.predicate));
      break;
    case "place_state":
      facts = all.filter((fact) => ["frequented", "frequents", "status", "current_use", "entity_type", "current_activity_place"].includes(fact.predicate)
        && (String(fact.object).match(/SPACE|RiNG/iu) || String(fact.subject).match(/SPACE|RiNG/iu)));
      break;
    case "self_profile": {
      const q = normalize(query);
      facts = all.filter((fact) => fact.subject === RANA_ENTITY_ID && ["identity", "member_of", "role", "likes", "frequented", "frequents"].includes(fact.predicate))
        .filter((fact) => !fact.topics?.length || fact.topics.some((topic) => q.includes(normalize(topic))));
      break;
    }
    default: {
      const targetFacts = targets.length
        ? all.filter((fact) => targets.some((target) => factTargetsRanaAnd(fact, target) || (fact.predicate === "identity_link" && factInvolves(fact, target))))
        : [];
      if (isReasonQuery(query) || isEventQuery(query) || isMovementEventQuery(query)) {
        const eventFacts = targetFacts.filter(isEventFact);
        facts = focusedEventFacts(eventFacts, query, resolved);
        if (!facts.length && targets.length) {
          const linkedPairs = linkedIdentityTargets(targets, all);
          const linkedEventFacts = all.filter((fact) => isEventFact(fact)
            && linkedPairs.some((pair) => factTargetsRanaAnd(fact, pair.linked)));
          const selectedLinkedEvents = focusedEventFacts(linkedEventFacts, query, resolved);
          if (selectedLinkedEvents.length) {
            const selectedLinkedIds = new Set();
            for (const eventFact of selectedLinkedEvents) {
              for (const pair of linkedPairs) {
                if (!factTargetsRanaAnd(eventFact, pair.linked)) continue;
                selectedLinkedIds.add(`${pair.target}\u0000${pair.linked}`);
              }
            }
            const selectedPairs = linkedPairs.filter((pair) => selectedLinkedIds.has(`${pair.target}\u0000${pair.linked}`));
            const ownership = [];
            for (const pair of selectedPairs) {
              for (const eventFact of selectedLinkedEvents) {
                if (factTargetsRanaAnd(eventFact, pair.linked)) ownership.push(linkedIdentityEventProjection(pair.target, pair.linked, eventFact));
              }
            }
            facts = [...selectedPairs.map((pair) => pair.identityFact), ...selectedLinkedEvents, ...ownership];
          }
        }
      } else {
        facts = targetFacts.filter((fact) => isRelationshipPredicate(fact.predicate));
      }
      break;
    }
  }

  return [...new Map(facts.map((fact) => [fact.factId || JSON.stringify(fact), fact])).values()];
}

function selectBoundaries(plan, resolved, query, selectedFacts, state = loadState()) {
  const targetIds = selectedTargetIds(resolved);
  const boundaries = [];
  const storeBoundaries = state.store.boundaries || [];

  for (const item of storeBoundaries) {
    const scopeMatch = (item.scopes || []).includes(plan.predicate)
      || (item.scopes || []).includes(plan.intent)
      || (plan.intent === "entity_comparison" && (item.scopes || []).includes("identity_comparison"));
    const entityMatch = !(item.entityIds || []).length || item.entityIds.some((id) => targetIds.includes(id));
    if (scopeMatch && entityMatch) boundaries.push(item);
  }

  if (plan.intent === "unknown_people_inventory") {
    boundaries.push({
      boundaryId: "unknown_inventory.scope",
      subject: RANA_ENTITY_ID,
      predicate: "recognition_status",
      object: "complete_universe_of_people",
      status: "open_world_incomplete",
    });
  }

  if (["known_people_inventory", "person_recognition_check", "third_party_relationship_check", "relationship"].includes(plan.intent)) {
    for (const predicate of state.store.policies?.recognitionDoesNotImply || []) {
      boundaries.push({
        boundaryId: `recognition_does_not_imply.${predicate}`,
        subject: plan.intent === "known_people_inventory" ? "inventory:recognized_people" : plan.subject.entity_ids?.[0] || RANA_ENTITY_ID,
        predicate,
        object: null,
        status: "not_implied_by_recognition_fact",
      });
    }
  }

  if (plan.intent === "third_party_relationship_inventory") {
    boundaries.push({
      boundaryId: "third_party_inventory.incomplete",
      subject: plan.subject.entity_ids[0],
      predicate: "complete_relationship_set",
      object: null,
      status: "incomplete",
    });
  }

  if (plan.intent === "place_state" && /(?:現在|目前|如今|還)/u.test(String(query || ""))) {
    const closed = selectedFacts.some((fact) => fact.subject === "place:SPACE" && fact.predicate === "status" && fact.object === "closed");
    if (closed) boundaries.push({
      boundaryId: "space.current_visit",
      subject: "place:SPACE",
      predicate: "current_visit_or_operation",
      object: null,
      status: "contradicted_by_current_closed_status",
    });
  }

  const eventLike = isEventQuery(query) || isReasonQuery(query);
  if (eventLike && targetIds.length && selectedFacts.filter(isEventFact).length === 0) {
    boundaries.push({
      boundaryId: "requested_event.unsupported",
      subject: RANA_ENTITY_ID,
      predicate: "requested_event",
      object: targetIds.length === 1 ? targetIds[0] : targetIds,
      status: "no_direct_evidence",
      qualifiers: { requested_focus: stripQuestionFocus(query, resolved) || "unspecified_event" },
    });
  }

  if (plan.subject.type === "unresolved_entity") {
    boundaries.push({
      boundaryId: "described_entity.unresolved",
      subject: "described_entity",
      predicate: "identity",
      object: null,
      status: "unresolved",
    });
  }

  return [...new Map(boundaries.map((item) => [item.boundaryId || JSON.stringify(item), item])).values()];
}

function explicitSupportingAnchors(query) {
  const plan = buildUnifiedTurnPlan(query);
  const out = [];
  for (const item of plan.evidence?.anchors || []) out.push(item);
  const subject = String(plan.subject?.name || "").trim();
  if (!out.length && subject && !/^(?:self|user|self_group)$/u.test(subject)) out.push(subject);
  return [...new Set(out.map((item) => String(item || "").trim()).filter(Boolean))];
}

function supportingAnchorGroups(query, resolved = []) {
  return explicitSupportingAnchors(query).map((anchor) => {
    const key = normalize(anchor);
    const group = new Set([key]);
    for (const entity of resolved) {
      const alias = normalize(entity?.matched_alias);
      const canonical = normalize(entity?.canonical_name);
      if (key && (key === alias || key === canonical)) {
        if (alias) group.add(alias);
        if (canonical) group.add(canonical);
      }
    }
    return [...group].filter((item) => item.length >= 2);
  }).filter((group) => group.length);
}


const GENERIC_RELATIONSHIP_CONTEXT_ANCHOR_RE = /^(?:舊團|旧团|前團|前团|以前的團|以前的团|以前的樂團|以前的乐团|以前|過去|过去|當時|当时)$/u;

function isConcreteRelationshipEntityAnchor(anchor, resolved = []) {
  const raw = String(anchor || "").trim();
  if (!raw || GENERIC_RELATIONSHIP_CONTEXT_ANCHOR_RE.test(raw)) return false;
  const key = normalize(raw);
  if (!key) return false;
  // A resolved named entity is always concrete. Unresolved proper/place/group
  // anchors (e.g. SPACE) remain concrete too; only generic relationship-context
  // placeholders are excluded above.
  if (resolved.some((entity) => [normalize(entity?.matched_alias), normalize(entity?.canonical_name)].includes(key))) return true;
  return true;
}

const PREDICATE_AWARE_SOURCE_ASPECTS = new Set([
  "language_capability",
  "auditory_capability",
  "practice_duration",
  "performance_repertoire",
  "performance_skill_opinion",
  "relationship_stance",
  "school_affiliation",
  "entity_definition",
  "group_place_activity",
  "current_activity_place",
]);

function turnPlanRelevantStructuredFacts(turnPlan, resolved = [], state = loadState()) {
  // An event relation chosen by the canonical TurnPlan is a typed predicate,
  // independent of the user's surface wording. Search only reviewed structured
  // facts; never use a hard-coded question -> response mapping.
  const relation = String(turnPlan?.utteranceAct?.requestedRelation || "");
  // Same entity focus selected once by the planner; this additive evidence
  // applies even when the act remains USER_STATEMENT, USER_TASK or opinion.
  const focus = turnPlan?.evidence?.reviewedEntityFocus
    || turnPlan?.utteranceAct?.reviewedEntityFocus;
  if (focus && (focus.mortis || focus.mutsumi || focus.spaceSite)) {
    const all = state.store?.facts || [];
    const requestedIds = new Set(resolved.map((item) => item.entity_id).filter(Boolean));
    const anchors = [
      ...(turnPlan?.evidence?.anchors || []),
      ...(focus.anchors || []),
    ].map((value) => normalize(value)).filter(Boolean);
    for (const entity of state.entities?.entities || []) {
      const names = [entity.canonicalName, ...(entity.aliases || [])].map(normalize);
      if (anchors.some((candidate) => names.includes(candidate))) requestedIds.add(entity.entityId);
    }
    const identityFacts = (focus.mortis || focus.mutsumi)
      ? all.filter((fact) => fact.predicate === "identity_link"
        && (requestedIds.has(fact.subject) || requestedIds.has(fact.object)))
      : [];
    // A canonical identity comparison is scoped to identity links only.
    // Additive G2 facts for ordinary entity mentions remain unchanged.
    if (turnPlan?.evidence?.source === "persona_canonical"
        && (relation === "identity_link" || turnPlan?.evidence?.requestedAspect === "identity_relation")) {
      return identityFacts;
    }
    const linkedIds = new Set(requestedIds);
    for (const fact of identityFacts) { linkedIds.add(fact.subject); linkedIds.add(fact.object); }
    const linkedPairs = (focus.mortis || focus.mutsumi)
      ? linkedIdentityTargets([...requestedIds], all)
      : [];
    const fingerFacts = (focus.mortis || focus.mutsumi)
      ? all.filter((fact) => fact.predicate === "observed"
        && /(?:finger|指尖|手指)/iu.test(String(fact.qualifiers?.attribute || "") + " " + (fact.topics || []).join(" "))
        && (linkedIds.has(fact.subject) || linkedIds.has(fact.object)))
      : [];
    const projectedFingerFacts = linkedPairs.flatMap((pair) => fingerFacts
      .filter((fact) => fact.subject === pair.linked || fact.object === pair.linked)
      .map((fact) => linkedIdentityEventProjection(pair.target, pair.linked, fact)));
    const directionFacts = (focus.mortis || focus.spaceSite)
      ? all.filter((fact) => fact.predicate === "followed_to"
        && fact.object === RANA_ENTITY_ID
        && /SPACE/iu.test(String(fact.qualifiers?.place || ""))
        && (focus.spaceSite || linkedIds.has(fact.subject)))
      : [];
    return [...new Map([...identityFacts, ...directionFacts,
      ...fingerFacts, ...projectedFingerFacts].map((fact) =>
        [fact.id || JSON.stringify(fact), fact])).values()];
  }

  if (turnPlan?.evidence?.source === "persona_canonical" && ["followed_to", "fingertips", "identity_link"].includes(relation)) {
    const all = state.store?.facts || [];
    const requestedIds = new Set(resolved.map((item) => item.entity_id).filter(Boolean));
    const anchors = (turnPlan.evidence.anchors || []).map((value) => normalize(value)).filter(Boolean);
    for (const entity of state.entities?.entities || []) {
      const names = [entity.canonicalName, ...(entity.aliases || [])].map(normalize);
      if (anchors.some((anchor) => names.includes(anchor))) requestedIds.add(entity.entityId);
    }
    if (relation === "identity_link") {
      return all.filter((fact) => fact.predicate === "identity_link"
        && requestedIds.has(fact.subject) && requestedIds.has(fact.object));
    }
    if (relation === "followed_to") {
      const placeAnchors = anchors.filter((anchor) => /(?:space|ring|舊址|旧址)/iu.test(anchor));
      return all.filter((fact) => fact.predicate === "followed_to"
        && (requestedIds.has(fact.subject) || !requestedIds.size)
        && fact.object === RANA_ENTITY_ID
        && (!placeAnchors.length || placeAnchors.some((place) =>
          normalize(fact.qualifiers?.place || "").includes(place)
          || place.includes(normalize(fact.qualifiers?.place || "")))));
    }
    const direct = all.filter((fact) => fact.predicate === "observed"
      && /(?:finger|指尖|手指)/iu.test(String(fact.qualifiers?.attribute || "") + " " + (fact.topics || []).join(" ")));
    const links = linkedIdentityTargets([...requestedIds], all);
    const linkedOwners = links.filter((pair) =>
      direct.some((fact) => fact.object === pair.linked || fact.subject === pair.linked));
    return [
      ...direct.filter((fact) =>
        !requestedIds.size
        || requestedIds.has(fact.subject) || requestedIds.has(fact.object)
        || linkedOwners.some((pair) => fact.object === pair.linked)),
      ...linkedOwners.map((pair) => pair.identityFact),
      ...linkedOwners.flatMap((pair) => direct.filter((fact) =>
        fact.subject === pair.linked || fact.object === pair.linked)
        .map((fact) => linkedIdentityEventProjection(pair.target, pair.linked, fact))),
    ];
  }
  const aspect = String(turnPlan?.evidence?.requestedAspect || turnPlan?.predicate || "");
  if (!turnPlan?.evidence?.required
    || turnPlan?.evidence?.source !== "persona_canonical"
    || !PREDICATE_AWARE_SOURCE_ASPECTS.has(aspect)) return [];

  const anchors = Array.isArray(turnPlan?.evidence?.anchors)
    ? turnPlan.evidence.anchors.map((item) => normalize(item)).filter(Boolean)
    : [];
  const all = state.store?.facts || [];
  const semanticForFact = (fact) => normalize([
    fact.subject,
    fact.predicate,
    fact.object,
    entityName(fact.subject, state),
    entityName(fact.object, state),
    ...(fact.topics || []),
    ...Object.entries(fact.qualifiers || {}).flatMap(([key, value]) => [key, value]),
  ].join(" "));

  if (aspect === "entity_definition") {
    return all.filter((fact) => fact.predicate === "entity_type"
      && (!anchors.length || anchors.every((anchor) => semanticForFact(fact).includes(anchor))));
  }

  if (["group_place_activity", "current_activity_place"].includes(aspect)) {
    return all.filter((fact) => fact.predicate === "current_activity_place"
      && (!anchors.length || anchors.every((anchor) => semanticForFact(fact).includes(anchor))));
  }

  const targetIds = resolved
    .map((item) => item?.entity_id)
    .filter((entityId) => entityId && entityId !== RANA_ENTITY_ID);
  const predicateAnchors = Array.isArray(turnPlan?.evidence?.predicateAnchors)
    ? turnPlan.evidence.predicateAnchors.map((item) => normalize(item)).filter(Boolean)
    : [];
  return all.filter((fact) => {
    const targetMatch = targetIds.length
      ? targetIds.some((targetId) => factInvolves(fact, targetId))
      : factInvolves(fact, RANA_ENTITY_ID);
    if (!targetMatch) return false;

    // A skill-opinion query asks for Rana's stance toward the named target.
    // Target-only profile facts are context, not stance evidence; only a fact
    // that actually links Rana and that target may enter the evidence pack.
    if (aspect === "performance_skill_opinion"
      && targetIds.length
      && !targetIds.some((targetId) => factTargetsRanaAnd(fact, targetId))) return false;

    if (!predicateAnchors.length) return true;
    const semantic = normalize([
      fact.predicate,
      entityName(fact.subject, state),
      entityName(fact.object, state),
      ...(fact.topics || []),
      ...Object.entries(fact.qualifiers || {}).flatMap(([key, value]) => [key, value]),
    ].join(" "));
    return predicateAnchors.every((anchor) => semantic.includes(anchor));
  });
}

function coverageProbeForSource(turnPlan, item, resolved = []) {
  return {
    resolved_entities: resolved.map((entity) => ({
      entity_id: entity?.entity_id,
      canonical_name: entity?.canonical_name,
      matched_alias: entity?.matched_alias,
    })),
    supporting_evidence: [item],
  };
}

function personaCoreCapabilityEvidence(turnPlan, query) {
  if (String(turnPlan?.evidence?.requestedAspect || "") !== "character_capability") return [];
  if (String(turnPlan?.subject?.type || "") !== "active_persona") return [];
  if (!fs.existsSync(PERSONA_PATH)) return [];
  const persona = readJson(PERSONA_PATH, null);
  if (!persona) return [];
  const plannedPersona = String(turnPlan?.personaId || "").trim();
  if (plannedPersona && plannedPersona !== "unresolved" && String(persona.personaId || "") !== plannedPersona) return [];
  const content = String(persona?.roleCore?.knowledgeBoundary || "").trim();
  if (!content) return [];
  const item = {
    evidence_id: "persona_core.roleCore.knowledgeBoundary",
    source_type: "persona_core",
    source_path: "PERSONA.json#roleCore.knowledgeBoundary",
    source_title: `${persona.canonicalName || turnPlan.personaId} Persona core capability boundary`,
    content,
  };
  return evaluateEvidenceCoverage(turnPlan, coverageProbeForSource(turnPlan, item, []), query).supported ? [item] : [];
}

function directSupportingEvidence(query, accepted = [], resolved = [], turnPlan = null) {
  const plan = turnPlan || buildUnifiedTurnPlan(query);
  const requestedAspect = String(plan?.evidence?.requestedAspect || plan?.predicate || "");
  if (PREDICATE_AWARE_SOURCE_ASPECTS.has(requestedAspect)) {
    return accepted.filter((item) => evaluateEvidenceCoverage(
      plan,
      coverageProbeForSource(plan, item, resolved),
      query,
    ).supported).slice(0, 2);
  }
  const anchors = explicitSupportingAnchors(query);
  const groups = supportingAnchorGroups(query, resolved);
  if (!groups.length) return [];
  const requireEveryAnchor = plan?.subject?.type === "relationship_pair"
    || plan?.evidence?.kind === "relationship_fact";
  const requiredIndexes = groups
    .map((_, index) => index)
    .filter((index) => isConcreteRelationshipEntityAnchor(anchors[index], resolved));

  return accepted.filter((item) => {
    const haystack = normalize(`${item?.source_title || ""} ${item?.content || ""}`);
    const matched = groups.map((group) => group.some((anchor) => haystack.includes(anchor)));
    if (!requireEveryAnchor) return matched.some(Boolean);
    // Relationship evidence must cover every concrete named entity. Generic
    // context placeholders such as "舊團/以前" specify the aspect/time frame,
    // not an independent entity whose literal surface form must occur in lore.
    const required = requiredIndexes.length ? requiredIndexes : matched.map((_, index) => index);
    return required.every((index) => matched[index]);
  }).slice(0, 2);
}

function relationshipNeedsSupportingEvidence(plan, facts = []) {
  if (!["explicit_relationship_pair", "relationship"].includes(String(plan?.intent || ""))) return false;
  return facts.some((fact) => AMBIGUOUS_RELATIONSHIP_PREDICATES.has(String(fact?.predicate || "")));
}

function sourceEvidence(query, resolved, state = loadState(), { allowResolvedSupport = false, turnPlan = null } = {}) {
  if (!isSourceQuery(query) && resolved.length > 0 && !allowResolvedSupport) return { accepted: [], rejected: [], bm25: [] };
  const chunks = state.corpus?.chunks || [];
  if (!chunks.length) return { accepted: [], rejected: [], bm25: [] };
  const allowed = new Set(state.manifest?.retrievalOnly || []);
  const bm25State = buildBm25(chunks, "trigram");
  const bm25Results = bm25Search(query, chunks, bm25State, 12);
  const requestedAspect = String(turnPlan?.evidence?.requestedAspect || turnPlan?.predicate || "");
  const exactCoverageIndexes = turnPlan?.evidence?.required
    && turnPlan?.evidence?.source === "persona_canonical"
    && PREDICATE_AWARE_SOURCE_ASPECTS.has(requestedAspect)
    ? chunks.map((chunk, index) => {
        const candidate = {
          source_title: chunk?.metadata?.sourceTitle || "",
          content: chunk?.content || "",
        };
        const coverage = evaluateEvidenceCoverage(turnPlan, coverageProbeForSource(turnPlan, candidate, resolved), query);
        return coverage.supported ? { index, score: 2_000_000 } : null;
      }).filter(Boolean)
    : [];
  const anchorGroups = supportingAnchorGroups(query, resolved);
  const exactAnchorIndexes = anchorGroups.length
    ? chunks.map((chunk, index) => {
        const haystack = normalize(`${chunk?.metadata?.sourceTitle || ""} ${chunk?.content || ""}`);
        const matched = anchorGroups.filter((group) => group.some((anchor) => haystack.includes(anchor))).length;
        return matched ? { index, score: 1_000_000 + matched } : null;
      }).filter(Boolean)
    : [];
  const mergedResults = [];
  const seenIndexes = new Set();
  for (const result of [...exactCoverageIndexes, ...exactAnchorIndexes, ...bm25Results]) {
    if (seenIndexes.has(result.index)) continue;
    seenIndexes.add(result.index);
    mergedResults.push(result);
  }
  const resolvedIds = new Set(resolved.map((item) => item.entity_id));
  const accepted = [];
  const rejected = [];
  for (const result of mergedResults) {
    const chunk = chunks[result.index];
    if (!chunk) continue;
    let reason = "";
    if (!allowed.has(chunk.metadata?.sourcePath)) reason = "manifest_rejected";
    else if (chunk.metadata?.retrievalPolicy !== "canonical_lore_only") reason = "policy_rejected";
    else if (resolvedIds.size && chunk.metadata?.entityIds?.length && !chunk.metadata.entityIds.some((id) => resolvedIds.has(id))) reason = "entity_mismatch";
    else if (result.score <= 0) reason = "low_relevance";
    if (reason) rejected.push({ evidence_id: chunk.id, source_title: chunk.metadata?.sourceTitle || "", reason });
    else accepted.push({
      evidence_id: chunk.id,
      source_type: chunk.metadata?.sourceType || "research",
      source_title: chunk.metadata?.sourceTitle || "",
      source_path: chunk.metadata?.sourcePath || "",
      entity_ids: chunk.metadata?.entityIds || [],
      canon_level: chunk.metadata?.canonLevel || "reviewed",
      content: sanitizeEvidenceText(chunk.content, 1200),
      _score: result.score,
    });
    if (accepted.length >= 3) break;
  }
  return {
    accepted,
    rejected,
    bm25: mergedResults.slice(0, 8).map((item) => ({
      evidence_id: chunks[item.index]?.id || "",
      source_title: chunks[item.index]?.metadata?.sourceTitle || "",
      score: Number(item.score.toFixed(6)),
    })),
  };
}

function knowledgeContract(plan, facts, boundaries, query, supportingEvidence = []) {
  if (isSourceQuery(query) && facts.some((fact) => (fact.sourceRefs || []).length)) return "source";
  if (["knowledge_boundary", "reason_or_motivation", "third_party_relationship_inventory", "unknown_people_inventory"].includes(plan.intent)) return "boundary";
  if (!facts.length && boundaries.length && !supportingEvidence.length) return "unknown";
  if (!facts.length && !supportingEvidence.length) return "unknown";
  return "known";
}

export function buildRanaMicroRelationshipHint(query, { maxTargets = 2 } = {}) {
  const text = String(query || "").trim();
  if (!text) return { hint: "", matchedTargets: [] };

  const state = loadState();
  const initiallyResolved = resolveEntityMentions(text);
  const explicitPriority = initiallyResolved.filter((item) =>
    ["alias", "vision"].includes(String(item?.source || ""))
  );
  const described = descriptorResolution(text, explicitPriority, state);
  const resolved = [
    ...explicitPriority,
    ...described.filter((item) =>
      !explicitPriority.some((existing) => existing.entity_id === item.entity_id)
    ),
  ].filter((item) => item.entity_id && item.entity_id !== RANA_ENTITY_ID);

  const byEntityId = new Map(
    (state.store.characters || []).map((item) => [item.entityId, item])
  );
  const seen = new Set();
  const lines = [];
  const matchedTargets = [];

  for (const entity of resolved) {
    if (seen.has(entity.entity_id)) continue;
    const item = byEntityId.get(entity.entity_id);
    if (!item || String(item.recognitionLevel || "").toLowerCase() === "unknown") continue;
    seen.add(entity.entity_id);

    const targetId = String(item.canonicalId || entity.canonical_id || entity.entity_id);
    const targetName = String(item.ranaCallsThem?.[0] || item.canonicalName || entity.canonical_name || targetId);
    const matchedAlias = String(entity.matched_alias || entity.canonical_name || "").trim();
    const reaction = (item.allowedReactionStyle || []).slice(0, 2).join("、");
    const boundary = (item.forbiddenExpansion || []).slice(0, 2).join("、");
    const parts = [
      targetName ? `對象=${targetName}` : "",
      matchedAlias ? `本輪稱呼=${matchedAlias}` : "",
      reaction ? `互動傾向=${reaction}` : "",
      boundary ? `邊界=${boundary}` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join("；"));
    matchedTargets.push(targetId);
    if (matchedTargets.length >= Math.max(1, Number(maxTargets || 2))) break;
  }

  return {
    hint: lines.join("\n").slice(0, 420),
    matchedTargets,
  };
}

function exactSources(resolved, state = loadState()) {
  const byId = new Map((state.store.characters || []).map((item) => [item.entityId, item]));
  return resolved.map((entity) => {
    const item = byId.get(entity.entity_id);
    if (!item) return null;
    return {
      evidence_id: `character:${entity.entity_id}`,
      source_type: "structured_character_store",
      source_title: `${entity.canonical_name} canonical record`,
      entity_ids: [entity.entity_id],
      canonical_id: entity.canonical_id,
      canonical_name: entity.canonical_name,
      recognition_level: item.recognitionLevel,
      inventory_name: item.ranaCallsThem?.[0] || entity.canonical_name,
      group: item.group || "",
      source_refs: item.sourceRefs || [],
    };
  }).filter(Boolean);
}

export async function buildLoreEvidencePack(query, options = {}) {
  const startedAt = Date.now();
  const text = String(query || "").trim();
  const unifiedTurnPlan = options.turnPlan || buildUnifiedTurnPlan(text);
  const visionStatus = options.visionStatus || "text";
  if (["unknown", "error"].includes(visionStatus)) {
    const queryPlan = { ...buildQueryPlan(text, [], unifiedTurnPlan), unified_turn_plan: unifiedTurnPlan };
    return {
      query: text,
      intent: queryPlan.intent,
      query_plan: queryPlan,
      knowledge_contract: "unknown",
      resolved_entities: [],
      exact_sources: [],
      relationship_evidence: [],
      structured_facts: [],
      knowledge_boundaries: [{ subject: "image_identity", predicate: "identity", object: null, status: `vision_${visionStatus}` }],
      bm25_results: [],
      vector_results: [],
      retrieved_evidence: [],
      rejected_evidence: [{ reason: `vision_${visionStatus}_blocks_lore` }],
      conflicts: [],
      retrieval_confidence: "none",
      degraded: false,
      namespace: "canonical_character_facts",
      latency_ms: Date.now() - startedAt,
    };
  }

  const state = loadState();
  const initiallyResolved = resolveEntityMentions(text, { forcedEntityIds: options.forcedEntityIds, sessionKey: options.sessionKey });
  const hasExplicit = initiallyResolved.some((item) => ["alias", "vision"].includes(item.source));
  const explicitPriority = hasExplicit
    ? initiallyResolved.filter((item) => item.source !== "session_pronoun")
    : initiallyResolved;
  const described = descriptorResolution(text, explicitPriority, state);
  const resolved = described.length
    ? [...explicitPriority.filter((item) => item.source !== "session_pronoun"), ...described.filter((item) => !explicitPriority.some((existing) => existing.entity_id === item.entity_id))]
    : explicitPriority;

  const plan = { ...buildQueryPlan(text, resolved, unifiedTurnPlan), unified_turn_plan: unifiedTurnPlan };
  const explicitConversationEntities = resolved.filter((item) => item.entity_id !== RANA_ENTITY_ID && ["alias", "vision", "structured_descriptor"].includes(item.source));
  if (text.length <= 500 && explicitConversationEntities.length) rememberResolvedEntities(options.sessionKey, explicitConversationEntities);

  const selectedFacts = selectFacts(plan, resolved, text, state);
  const turnPlanFacts = turnPlanRelevantStructuredFacts(unifiedTurnPlan, resolved, state);
  const requestedAspect = String(unifiedTurnPlan?.evidence?.requestedAspect || unifiedTurnPlan?.predicate || "");
  const definitionScopedFacts = unifiedTurnPlan?.evidence?.source === "persona_canonical"
    && requestedAspect === "entity_definition";
  const onlyMutsumi = unifiedTurnPlan?.evidence?.reviewedEntityFocus?.mutsumi
    && !unifiedTurnPlan?.evidence?.reviewedEntityFocus?.mortis;
  const onlyMortis = unifiedTurnPlan?.evidence?.reviewedEntityFocus?.mortis
    && !unifiedTurnPlan?.evidence?.reviewedEntityFocus?.mutsumi;
  const facts = [...new Map([(definitionScopedFacts ? turnPlanFacts : [...selectedFacts, ...turnPlanFacts])]
    .flat()
    .map((fact) => [fact.factId || JSON.stringify(fact), fact])).values()]
    // With only 睦 in focus, the inverse Mortis-owned identity record should
    // not be presented as an event belonging to her.
    .filter((fact) => !(onlyMutsumi && fact.predicate === "identity_link"
      && fact.subject === "bangdream.character.mortis")
      && !(onlyMortis && String(fact.factId || "").startsWith("mutsumi.")));
  const boundaries = selectBoundaries(plan, resolved, text, facts, state);
  const predicateAwareSourceRequired = unifiedTurnPlan?.evidence?.required
    && unifiedTurnPlan?.evidence?.source === "persona_canonical"
    && PREDICATE_AWARE_SOURCE_ASPECTS.has(requestedAspect);
  const structuredInventoryOnly = plan.intent === "known_people_inventory";
  const source = definitionScopedFacts || structuredInventoryOnly
    ? { accepted: [], rejected: [], bm25: [] }
    : sourceEvidence(text, resolved, state, {
        allowResolvedSupport: relationshipNeedsSupportingEvidence(plan, facts) || predicateAwareSourceRequired,
        turnPlan: unifiedTurnPlan,
      });
  const supporting = definitionScopedFacts
    ? []
    : [...new Map([
        ...directSupportingEvidence(text, source.accepted, resolved, unifiedTurnPlan),
        ...personaCoreCapabilityEvidence(unifiedTurnPlan, text),
      ].map((item) => [item.evidence_id || `${item.source_path || ""}\u0000${item.content || ""}`, item])).values()];
  const coverageMaterial = {
    resolved_entities: resolved.map((item) => ({
      entity_id: item.entity_id,
      canonical_name: item.canonical_name,
      matched_alias: item.matched_alias,
    })),
    structured_facts: facts,
    supporting_evidence: supporting,
  };
  const evidenceCoverage = evaluateEvidenceCoverage(unifiedTurnPlan, coverageMaterial, text);
  const baseContract = knowledgeContract(plan, facts, boundaries, text, supporting);
  const contract = unifiedTurnPlan?.evidence?.source === "persona_canonical" && !evidenceCoverage.supported
    ? "unknown"
    : baseContract;
  const confidence = contract === "unknown" ? "none" : facts.length ? (resolved.length ? "high" : "medium") : supporting.length ? "medium" : "none";

  return {
    query: text,
    intent: plan.intent,
    query_plan: plan,
    knowledge_contract: contract,
    resolved_entities: resolved,
    exact_sources: exactSources(resolved, state),
    relationship_evidence: facts.filter((fact) => ["relationship", "explicit_relationship_pair"].includes(plan.intent)
      ? EXPLICIT_PAIRWISE_RELATION_PREDICATES.has(fact.predicate) || RELATIONSHIP_PARTICIPANT_PREDICATES.has(fact.predicate)
      : ["recognizes", "has_seen", "interacted_with", "identity_link"].includes(fact.predicate)),
    structured_facts: facts,
    knowledge_boundaries: boundaries,
    bm25_results: source.bm25,
    vector_results: [],
    retrieved_evidence: source.accepted,
    supporting_evidence: supporting,
    rejected_evidence: source.rejected,
    conflicts: facts.filter((fact) => fact.predicate === "identity_link").map((fact) => ({
      rule: "linked_identity_distinct_state_or_persona",
      subject: fact.subject,
      object: fact.object,
      verdict: fact.qualifiers?.relation || "linked_identity_distinct_state_or_persona",
    })),
    retrieval_confidence: confidence,
    evidence_coverage: evidenceCoverage,
    degraded: false,
    namespace: "canonical_character_facts",
    latency_ms: Date.now() - startedAt,
  };
}

export function safeEvidencePack(pack) {
  return {
    query: pack.query,
    intent: pack.intent,
    query_plan: pack.query_plan,
    knowledge_contract: pack.knowledge_contract,
    resolved_entities: pack.resolved_entities,
    exact_sources: pack.exact_sources,
    relationship_evidence: pack.relationship_evidence || [],
    structured_facts: pack.structured_facts || [],
    knowledge_boundaries: pack.knowledge_boundaries || [],
    retrieved_evidence: (pack.retrieved_evidence || []).map(({ _score, ...item }) => item),
    supporting_evidence: (pack.supporting_evidence || []).map(({ _score, ...item }) => item),
    rejected_evidence: pack.rejected_evidence || [],
    conflicts: pack.conflicts || [],
    retrieval_confidence: pack.retrieval_confidence,
    evidence_coverage: pack.evidence_coverage || null,
    degraded: pack.degraded,
  };
}

function publicFact(fact, sourceRequested, state = loadState()) {
  const qualifiers = { ...(fact.qualifiers || {}) };
  for (const [key, value] of Object.entries(qualifiers)) {
    if (typeof value === "string" && entityMaps(state).byId.has(value)) qualifiers[key] = entityName(value, state);
  }
  return {
    subject: entityName(fact.subject, state),
    predicate: fact.predicate,
    object: Array.isArray(fact.object) ? fact.object.map((item) => entityName(item, state)) : entityName(fact.object, state),
    ...qualifiers,
    ...(fact.subject === RANA_ENTITY_ID ? { subject_entity_id: RANA_ENTITY_ID } : {}),
    ...(fact.object === RANA_ENTITY_ID ? { object_entity_id: RANA_ENTITY_ID } : {}),
    ...(sourceRequested && fact.sourceRefs?.length ? { source_refs: fact.sourceRefs } : {}),
  };
}

function publicBoundary(item, state = loadState()) {
  return {
    subject: entityName(item.subject, state),
    predicate: item.predicate,
    object: Array.isArray(item.object) ? item.object.map((value) => entityName(value, state)) : item.object == null ? null : entityName(item.object, state),
    status: item.status,
    ...(item.qualifiers || {}),
    ...(item.subject === RANA_ENTITY_ID ? { subject_entity_id: RANA_ENTITY_ID } : {}),
    ...(item.object === RANA_ENTITY_ID ? { object_entity_id: RANA_ENTITY_ID } : {}),
  };
}

export function loreEvidencePayload(pack) {
  const state = loadState();
  const sourceRequested = isSourceQuery(pack.query);
  return {
    query_plan: pack.query_plan || {},
    entity_bindings: {
      assistant_speaker: {
        entity_id: RANA_ENTITY_ID,
        canonical_name: "要樂奈",
        first_person_pronoun: "我",
      },
    },
    resolved_entities: (pack.resolved_entities || [])
      .filter((item) => item.entity_id !== RANA_ENTITY_ID)
      .map(({ entity_id, canonical_name, matched_alias, source }) => ({ entity_id, canonical_name, matched_alias, source })),
    facts: (pack.structured_facts || []).map((fact) => publicFact(fact, sourceRequested, state)),
    knowledge_boundaries: {
      contract: pack.knowledge_contract || "unknown",
      evidence_coverage: pack.evidence_coverage || null,
      unsupported: (pack.knowledge_boundaries || []).filter((item) => item.status !== "incomplete" && item.status !== "open_world_incomplete").map((item) => publicBoundary(item, state)),
      incomplete: (pack.knowledge_boundaries || []).filter((item) => item.status === "incomplete" || item.status === "open_world_incomplete").map((item) => publicBoundary(item, state)),
    },
    ...(!sourceRequested && (pack.supporting_evidence || []).length ? {
      supporting_evidence: (pack.supporting_evidence || []).map((item) => ({
        source_title: item.source_title,
        source_path: item.source_path,
        content: String(item.content || "").slice(0, 700),
      })),
    } : {}),
    ...(sourceRequested ? {
      source_evidence: (pack.retrieved_evidence || []).map((item) => ({
        source_title: item.source_title,
        source_path: item.source_path,
        content: item.content,
      })),
    } : {}),
  };
}

const MODEL_PREDICATE_LABELS = Object.freeze({
  member_of: "隸屬於",
  member_of_or_associated_with: "有直接關聯（此欄位本身不指定具體角色）",
  role: "擔當／角色",
  frequented: "過去常去",
  frequents: "常去",
  status: "狀態",
  current_use: "目前用途",
  relationship: "關係",
  associated_with: "有直接關聯",
  knows: "認識",
  friend_of: "朋友關係",
  performed: "演奏／演出",
});

const MODEL_QUALIFIER_LABELS = Object.freeze({
  temporal_scope: "時間",
  time: "時間",
  period: "時期",
  status: "狀態",
  familiarity: "熟悉程度",
  context: "情境",
  scope: "範圍",
  relation: "關係",
});

const MODEL_VALUE_LABELS = Object.freeze({
  linked_identity_distinct_state_or_persona: "同一個人的兩個狀態／persona；樂奈的說法是「同一個人。不一樣。」，兩個狀態的事件要分開記",
});

function modelValue(value) {
  if (Array.isArray(value)) return value.map(modelValue).filter(Boolean).join("、");
  if (value == null) return "";
  if (typeof value === "object") return Object.entries(value)
    .map(([key, item]) => `${MODEL_QUALIFIER_LABELS[key] || key}=${modelValue(item)}`)
    .filter((item) => !item.endsWith("="))
    .join("；");
  const raw = String(value).trim();
  return MODEL_VALUE_LABELS[raw] || raw;
}

function modelPredicate(value) {
  const raw = String(value || "").trim();
  return MODEL_PREDICATE_LABELS[raw] || raw.replaceAll("_", " ");
}

function modelFactLine(fact) {
  const subject = modelValue(fact?.subject);
  const predicate = modelPredicate(fact?.predicate);
  const object = modelValue(fact?.object);
  if (!subject || !predicate) return "";
  if (fact?.predicate === "linked_identity_event_ownership") {
    const owner = modelValue(fact?.event_owner || fact?.object);
    if (!owner || !object) return "";
    return `- 歸屬約束: ${subject} 與 ${object} 是連結身份；這筆內容直接屬於${owner}；不可轉移成 ${subject} 的事件／屬性。`;
  }
  if (fact?.predicate === "followed_to") {
    const followed = fact?.object_entity_id === RANA_ENTITY_ID ? "要樂奈" : object;
    const place = modelValue(fact?.place);
    return `- 方向事實: ${subject} 跟著${followed}${place ? `前往 ${place}` : ""}（跟隨者=${subject}；被跟隨者=${followed}）。`;
  }
  const ignored = new Set(["subject", "predicate", "object", "subject_entity_id", "object_entity_id", "source_refs"]);
  const qualifiers = Object.entries(fact || {})
    .filter(([key, value]) => !ignored.has(key) && value != null && modelValue(value))
    .map(([key, value]) => `${MODEL_QUALIFIER_LABELS[key] || key}: ${modelValue(value)}`);
  return `- ${subject}｜${predicate}${object ? `｜${object}` : ""}${qualifiers.length ? `（${qualifiers.join("；")}）` : ""}`;
}

function modelBoundaryLine(item, label) {
  const subject = modelValue(item?.subject);
  const predicate = modelPredicate(item?.predicate);
  const object = modelValue(item?.object);
  const status = modelValue(item?.status);
  const relation = [subject, predicate, object].filter(Boolean).join("｜");
  if (!relation) return "";
  return `- ${label}: ${relation}${status ? `（${status}）` : ""}`;
}

function modelCoverageLines(coverage) {
  if (!coverage || typeof coverage !== "object") return [];
  const requestedAspect = modelValue(coverage.requestedAspect || coverage.requested_aspect || coverage.aspect);
  const supported = coverage.supported === true && coverage.aspectCoverage !== false && coverage.aspect_coverage !== false;
  if (supported) {
    return [`- 證據覆蓋: ${requestedAspect ? `${requestedAspect} 已有直接支持。` : "本題要求的主體與範圍已有直接支持。"}`];
  }
  const reason = modelValue(coverage.reason);
  return [
    `- 證據覆蓋: ${requestedAspect ? `${requestedAspect} 尚未被直接支持。` : "本題要求的主體或範圍尚未被直接支持。"}`,
    "- 判定狀態: 未解決。現有證據不能據此判定 YES，也不能判定 NO。",
    ...(reason ? [`- 覆蓋說明: ${reason.replaceAll("_", " ")}`] : []),
  ];
}

export function loreEvidenceContext(pack) {
  const payload = loreEvidencePayload(pack);
  const lines = [
    "CONTROLLED EVIDENCE (model-facing semantic projection; not dialogue):",
  ];

  const resolved = Array.isArray(payload.resolved_entities) ? payload.resolved_entities : [];
  if (resolved.length) {
    lines.push("Entity grounding:");
    for (const item of resolved) {
      const alias = modelValue(item?.matched_alias);
      const canonical = modelValue(item?.canonical_name);
      if (canonical) lines.push(`- ${alias && alias !== canonical ? `${alias} = ` : ""}${canonical}`);
    }
  }

  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  if (facts.length) {
    lines.push("Known:");
    for (const fact of facts) {
      const line = modelFactLine(fact);
      if (line) lines.push(line);
    }
  }

  lines.push(...modelCoverageLines(payload?.knowledge_boundaries?.evidence_coverage));

  const unsupported = Array.isArray(payload?.knowledge_boundaries?.unsupported)
    ? payload.knowledge_boundaries.unsupported
    : [];
  const incomplete = Array.isArray(payload?.knowledge_boundaries?.incomplete)
    ? payload.knowledge_boundaries.incomplete
    : [];
  if (unsupported.length || incomplete.length) {
    lines.push("Unresolved / bounded:");
    for (const item of unsupported) {
      const line = modelBoundaryLine(item, "未由受控證據建立");
      if (line) lines.push(line);
    }
    for (const item of incomplete) {
      const line = modelBoundaryLine(item, "資料範圍不完整");
      if (line) lines.push(line);
    }
  }

  const supporting = Array.isArray(payload.supporting_evidence) ? payload.supporting_evidence : [];
  if (supporting.length) {
    lines.push("Direct supporting text:");
    for (const item of supporting.slice(0, 4)) {
      const title = modelValue(item?.source_title);
      const content = modelValue(item?.content).slice(0, 420);
      if (content) lines.push(`- ${title ? `${title}: ` : ""}${content}`);
    }
  }

  const sources = Array.isArray(payload.source_evidence) ? payload.source_evidence : [];
  if (sources.length) {
    lines.push("Requested source evidence:");
    for (const item of sources.slice(0, 6)) {
      const title = modelValue(item?.source_title);
      const path = modelValue(item?.source_path);
      const content = modelValue(item?.content).slice(0, 700);
      if (title || path) lines.push(`- ${[title, path].filter(Boolean).join(" | ")}`);
      if (content) lines.push(`  ${content}`);
    }
  }

  if (lines.length === 1) {
    lines.push("- 本輪沒有可用的受控角色事實；不要把模型先驗當成已建立事件。");
  }

  return lines.join("\n");
}


export function shouldRetrieveLore(query) {
  const plan = buildUnifiedTurnPlan(query);
  return turnPlanNeedsLore(plan);
}

export function resolveIndexCompatibility(index, corpus, status) {
  return Boolean(index && corpus && status && status.dirty === false && index.buildIdentity === corpus.buildIdentity && index.indexIdentity === status.indexIdentity);
}

export const __test = {
  buildQueryPlan,
  descriptorResolution,
  isUnknownPeopleInventoryQuery,
  isAssistantSelfIdentityQuestion,
  isRanaRelationshipQuestion,
  selectFacts,
  selectBoundaries,
  shouldRetrieveLore,
  directSupportingEvidence,
  relationshipNeedsSupportingEvidence,
};

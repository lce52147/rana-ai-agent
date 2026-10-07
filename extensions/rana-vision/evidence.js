import { analyzeWithToriiGate } from "./client.js";
import { analyzeWithLocalOcr } from "./ocr.js";
import { reverseImageSearch, verifyKnownCandidate } from "./reverse_search.js";
import { traceVision } from "./debug.js";
import { identityReferenceCatalog, resolveImageCharacters } from "./character_catalog.js";
import { deepSearchExternalIdentity, detectSearchPolicy, workConfidenceGate } from "./deep_search.js";
import { retrieveLocalIdentity } from "./identity_sidecar_client.js";

const REVERSE_THRESHOLDS = Object.freeze({
  "trace.moe": 0.87,
  SauceNAO: 0.8,
  IQDB: 0.8,
});

const LOCAL_IDENTITY_THRESHOLDS = Object.freeze({
  locked_local: 0.90,
  verify_existing_candidate: 0.60,
  candidate_expansion: 0.30,
});

function ocrEvidence(vision, localOcr) {
  const localValues = Array.isArray(localOcr?.normalized_lines)
    ? localOcr.normalized_lines
    : Array.isArray(localOcr?.lines) ? localOcr.lines : [];
  return [...new Set(localValues
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, 24);
}

function visionReportedText(vision) {
  const values = Array.isArray(vision?.observation?.visible_text)
    ? vision.observation.visible_text
    : typeof vision?.observation?.visible_text === "string"
      ? [vision.observation.visible_text]
      : [];
  return [...new Set(values
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function meaningfulCandidate(result) {
  const title = String(result?.title || "").replace(/\s+/g, " ").trim();
  return Boolean(title && !/^\d+(?:\.\d+)?%\s*(?:similarity|similar)?$/i.test(title));
}

function ocrIdentityTerms(ocr) {
  const normalized = (value) => String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const lines = ocr.map((item) => ({ raw: String(item || "").trim(), normalized: normalized(item) })).filter((item) => item.normalized);
  const matches = [];
  for (const identity of identityReferenceCatalog()) {
    for (const alias of identity.aliases || []) {
      const needle = normalized(alias);
      if (needle.length < 2) continue;
      const line = lines.find((item) => item.normalized.includes(needle));
      if (line) matches.push(alias);
    }
  }
  return [...new Set(matches)].slice(0, 8);
}

function candidateIdentityText(item) {
  return [item?.title, item?.characters, item?.material].map((value) => String(value || "").toLowerCase()).join(" ");
}

function candidateLevel(item) {
  if (String(item?.characters || "").trim()) return "character";
  if (String(item?.material || "").trim() || item?.service === "trace.moe") return "work";
  return meaningfulCandidate(item) ? "source" : "unknown";
}

function normalizedWorkTitle(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function externalWorkReference(results, ocrTerms = []) {
  // A non-catalog work can be reported only when trace.moe independently returns
  // the same work several times. This remains work-level evidence: it never creates
  // a canonical character identity or an impression lookup.
  const groups = new Map();
  for (const item of results || []) {
    if (item?.service !== "trace.moe") continue;
    const key = normalizedWorkTitle(item.title);
    if (!key || ocrTerms.length) continue;
    const group = groups.get(key) || { title: String(item.title || "").trim(), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const best = [...groups.values()]
    .map((group) => ({ ...group, similarity: Math.max(...group.items.map((item) => Number(item.similarity || 0))) }))
    .filter((group) => group.items.length >= 3 && group.similarity >= 0.83)
    .sort((left, right) => right.similarity - left.similarity)[0];
  return best ? {
    title: best.title,
    confidence: "medium",
    similarity: best.similarity,
    service: "trace.moe",
    corroboratingResults: best.items.length,
    scope: "work_only",
  } : null;
}


const CATALOG_WORK_TOKENS = Object.freeze([
  "bangdream",
  "バンドリ",
  "mygo",
  "迷子",
  "avemujica",
  "アヴェムジカ",
]);


function localIdentityScore(identity) {
  return Number(identity?.confidenceScore || 0);
}

function independentLocalIdentityEvidenceCount(identity) {
  const evidenceItems = Array.isArray(identity?.evidence) ? identity.evidence : [];
  const buckets = new Set();
  for (const item of evidenceItems) {
    const reason = String(item?.reason || "");
    if (!reason) continue;
    if (/ocr/i.test(reason)) buckets.add('ocr');
    else if (/direct_official_reference_pair_confirmation/i.test(reason)) buckets.add('direct_pair');
    else if (/verified_official_visual_reference_match/i.test(reason)) buckets.add('official_visual');
    else if (/atlas|reference/i.test(reason)) buckets.add('atlas_or_reference');
    else buckets.add(reason);
  }
  return buckets.size;
}

function directCharacterEvidence(identity) {
  const evidenceItems = Array.isArray(identity?.evidence) ? identity.evidence : [];
  return evidenceItems.some((item) => {
    const reason = String(item?.reason || "");
    return [
      "ocr_alias_match",
      "exact_sha256_official_reference",
      "accepted_reverse_alias_match",
      "local_embedding_open_set_match",
    ].includes(reason);
  });
}

function localIdentityTier(identity) {
  const score = localIdentityScore(identity);
  if (score >= LOCAL_IDENTITY_THRESHOLDS.locked_local && directCharacterEvidence(identity)) {
    return "locked_local";
  }
  if (score >= LOCAL_IDENTITY_THRESHOLDS.verify_existing_candidate) {
    return "verify_existing_candidate";
  }
  if (score >= LOCAL_IDENTITY_THRESHOLDS.candidate_expansion) {
    return "candidate_expansion";
  }
  return "weak_local";
}

function canonicalEvidenceIsAtlasOnly(identity) {
  const evidenceItems = Array.isArray(identity?.evidence) ? identity.evidence : [];
  if (!evidenceItems.length) return false;
  return evidenceItems.every((item) => [
    "local_embedding_open_set_match",
    "exact_sha256_official_reference",
    "verified_official_visual_reference_match",
    "direct_official_reference_pair_confirmation",
  ].includes(String(item?.reason || "")));
}

function strongExternalWorkEvidence(gate) {
  const work = gate?.external_work_reference || null;
  return Boolean(
    work
    && Number(work.similarity || 0) >= 0.87
    && Number(work.corroboratingResults || 0) >= 3
  );
}

function catalogWorkCompatible(title) {
  const normalizedTitle = String(title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return CATALOG_WORK_TOKENS.some((token) => normalizedTitle.includes(
    token.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""),
  ));
}

function canonicalIdentityConflict(searchPolicy, identity, gate) {
  if (!searchPolicy?.asksIdentity || !identity) return null;
  if (!canonicalEvidenceIsAtlasOnly(identity)) return null;
  if (!strongExternalWorkEvidence(gate)) return null;
  const work = gate.external_work_reference;
  if (catalogWorkCompatible(work.title)) return null;
  const tier = localIdentityTier(identity);
  if (tier === "locked_local") return null;
  return {
    type: "strong_external_work_vs_catalog_atlas_identity",
    work: {
      title: work.title,
      similarity: Number(work.similarity || 0),
      corroboratingResults: Number(work.corroboratingResults || 0),
      service: work.service,
    },
    canonicalCandidate: {
      canonicalId: identity.canonicalId,
      canonicalName: identity.canonicalName,
      confidence: identity.confidence,
      confidenceScore: Number(identity.confidenceScore || 0),
      localTier: tier,
      independentEvidence: independentLocalIdentityEvidenceCount(identity),
      evidence: identity.evidence || [],
    },
    localDecision: {
      tier,
      score: localIdentityScore(identity),
      action: tier === "verify_existing_candidate"
        ? "verify_existing_candidate"
        : tier === "candidate_expansion"
          ? "candidate_expansion"
          : "force_deep_search",
    },
  };
}


function determineWebDecision(searchPolicy, identity, gate, canonicalConflict, workGate = null) {
  const asksIdentity = Boolean(searchPolicy?.asksIdentity);
  const tier = identity ? localIdentityTier(identity) : "weak_local";
  const score = identity ? localIdentityScore(identity) : 0;

  if (!asksIdentity) {
    return {
      localTier: tier,
      localScore: score,
      webMode: "disabled",
      runDeepSearch: false,
      reason: "not_identity_question",
      preserveCanonicalOnUnresolvedConflict: true,
    };
  }

  if (tier === "locked_local" && !canonicalConflict) {
    return {
      localTier: tier,
      localScore: score,
      webMode: "disabled",
      runDeepSearch: false,
      reason: "local_embedding_identity_locked",
      preserveCanonicalOnUnresolvedConflict: true,
    };
  }

  if (canonicalConflict) {
    return {
      localTier: tier,
      localScore: score,
      workTier: workGate?.tier || "weak_work",
      webMode: "verify_local_candidate_against_external_work",
      runDeepSearch: true,
      reason: "local_external_conflict",
      preserveCanonicalOnUnresolvedConflict: tier === "locked_local",
    };
  }

  if (identity) {
    return {
      localTier: tier,
      localScore: score,
      workTier: workGate?.tier || "weak_work",
      webMode: "verify_local_candidate",
      runDeepSearch: true,
      reason: "local_candidate_requires_open_world_verification",
      preserveCanonicalOnUnresolvedConflict: true,
    };
  }

  return {
    localTier: tier,
    localScore: score,
    workTier: workGate?.tier || "weak_work",
    webMode: workGate?.tier === "locked_work"
      ? "locked_work_character_lookup"
      : "open_world_candidate_search",
    runDeepSearch: true,
    reason: workGate?.tier === "locked_work"
      ? "strong_work_lock_requires_character_lookup"
      : "identity_question_without_local_open_set_match",
    preserveCanonicalOnUnresolvedConflict: false,
  };
}

function removeCanonicalIdentity(resolution, canonicalId) {
  if (!resolution || !canonicalId) return;
  resolution.detectedCharacters = (resolution.detectedCharacters || [])
    .filter((item) => item?.canonicalId !== canonicalId);
  if (resolution.primaryCharacter?.canonicalId === canonicalId) {
    resolution.primaryCharacter = null;
    resolution.primaryImpression = null;
  }
}

function evaluateReverseEvidence(reverse, vision, localOcr) {
  const ocr = ocrEvidence(vision, localOcr);
  const ocrTerms = ocrIdentityTerms(ocr);
  const results = (reverse?.results || []).map((item) => {
    const threshold = REVERSE_THRESHOLDS[item?.service] ?? 0.9;
    const similarity = Number(item?.similarity || 0);
    const thresholdPassed = meaningfulCandidate(item) && similarity >= threshold;
    const identity = candidateIdentityText(item);
    const identityConflict = thresholdPassed && ocrTerms.length > 0 && identity
      && !ocrTerms.some((term) => identity.includes(term.toLowerCase()));
    const accepted = thresholdPassed && !identityConflict;
    return {
      ...item,
      similarity,
      candidate_level: candidateLevel(item),
      threshold,
      threshold_passed: thresholdPassed,
      accepted,
      reason: identityConflict
        ? "ocr_identity_conflict"
        : accepted
        ? "meets_service_threshold"
        : !meaningfulCandidate(item)
          ? "candidate_has_no_identity"
          : "below_service_threshold",
    };
  });
  const accepted = results.filter((item) => item.accepted);
  const rejected = results.filter((item) => !item.accepted);
  const conflicts = [];
  for (const item of results) {
    const identity = candidateIdentityText(item);
    if (ocrTerms.length && identity && !ocrTerms.some((term) => identity.includes(term.toLowerCase()))) {
      conflicts.push({
        type: "ocr_candidate_mismatch",
        ocr: ocrTerms,
        candidate: { service: item.service, title: item.title, similarity: item.similarity, accepted: item.accepted },
        resolution: item.reason === "ocr_identity_conflict"
          ? "reject_candidate_and_block_text_verification"
          : "preserve_rejected_candidate_and_ocr_for_oogg",
      });
    }
  }
  if (ocrTerms.length && rejected.length) {
    conflicts.push({
      type: "ocr_vs_rejected_reverse_candidates",
      ocr: ocrTerms,
      candidates: rejected.map((item) => ({ service: item.service, title: item.title, similarity: item.similarity, reason: item.reason })),
      resolution: "preserve_ocr_and_do_not_verify_rejected_candidates",
    });
  }
  return { ocr, results, accepted, rejected, conflicts, candidate: accepted[0] || null, external_work_reference: externalWorkReference(results, ocrTerms) };
}

function normalizeEvidence(loaded, vision, localOcr, reverse, gate, verification, visualComparison = {}, referenceMatch = {}, identityResolution = {}, localIdentityRetrieval = {}) {
  const finalCandidate = gate.candidate
    ? { ...gate.candidate, text_verification_status: verification.status, corroborated: verification.status === "ok" && verification.results.length > 0 }
    : null;
  const observation = vision?.observation || {};
  const visualSummary = String(observation.summary || "").trim();
  const reportedText = visionReportedText(vision);
  const supportedLevel = finalCandidate?.candidate_level === "character"
    ? "character"
    : finalCandidate
      ? "work"
      : vision.status === "ok" && (visualSummary || observation.distinctive_features?.length)
        ? "description"
        : gate.ocr.length
          ? "text"
          : "none";
  const confidence = finalCandidate
    ? Number(finalCandidate.similarity || 0)
    : supportedLevel === "description"
      ? 0.5
      : supportedLevel === "text"
        ? 0.35
        : 0;
  const standardized = {
    schema: "rana.vision.evidence.v1",
    supported_level: supportedLevel,
    confidence,
    visual: {
      status: vision.status,
      medium: observation.medium || "other",
      subject_type: observation.subject_type || "unknown",
      people_count: Number(observation.people_count || 0),
      summary: visualSummary,
      distinctive_features: Array.isArray(observation.distinctive_features) ? observation.distinctive_features : [],
      reported_text: reportedText,
    },
    ocr: {
      status: localOcr.status,
      lines: gate.ocr,
      identity_terms: ocrIdentityTerms(gate.ocr),
    },
    candidates: {
      accepted: gate.accepted,
      rejected: gate.rejected,
    },
    conflicts: gate.conflicts,
    final_candidate: finalCandidate,
    external_work_reference: gate.external_work_reference,
    local_identity_retrieval: {
      status: localIdentityRetrieval?.status || "skipped",
      source: localIdentityRetrieval?.source || "remote_clip_sidecar",
      model: localIdentityRetrieval?.model || null,
      accepted: localIdentityRetrieval?.accepted || [],
      primary: localIdentityRetrieval?.primary || null,
      elapsed_ms: Number(localIdentityRetrieval?.elapsed_ms || 0),
      error: localIdentityRetrieval?.error || null,
    },
  };
  return {
    image_source: {
      source: loaded.source,
      mime_type: loaded.mimeType,
      image_bytes: loaded.image?.length,
      media: loaded.media,
    },
    vision: {
      status: vision.status,
      source: vision.source,
      model: vision.response_model || vision.requested_model,
      endpoint: vision.endpoint,
      http_status: vision.http_status,
      raw: vision.raw,
      observation: vision.observation,
      reported_text: reportedText,
      error: vision.error,
    },
    local_ocr: {
      status: localOcr.status,
      source: localOcr.source,
      languages: localOcr.languages,
      raw: localOcr.raw,
      text: localOcr.text,
      lines: localOcr.lines,
      normalized_text: localOcr.normalized_text,
      normalized_lines: localOcr.normalized_lines,
      execution: localOcr.execution,
      error: localOcr.error,
    },
    reverse_image: {
      status: reverse.status,
      error: reverse.error,
      services: reverse.attempts.map((item) => ({ service: item.service, status: item.status, http_status: item.http_status, error: item.error })),
      raw_candidates: reverse.results.map((item) => ({
        service: item.service,
        title: item.title,
        similarity: item.similarity,
        source: item.source,
        episode: item.episode,
        from: item.from,
        to: item.to,
        characters: item.characters,
        material: item.material,
        creator: item.creator,
      })),
      results: gate.results,
      accepted: gate.accepted,
      rejected: gate.rejected,
      conflicts: gate.conflicts,
    },
    text_verification: verification,
    conflicts: gate.conflicts,
    final_candidate: finalCandidate,
    external_work_reference: gate.external_work_reference,
    identity_resolution: identityResolution,
    local_identity_retrieval: localIdentityRetrieval,
    official_reference_match: referenceMatch,
    visual_reference_comparison: visualComparison,
    final_identity: identityResolution.primaryCharacter || null,
    impression_lookup: identityResolution.primaryImpression || null,
    standardized,
  };
}

const VISION_PIPELINE_TIMEOUT_MS = 150_000;
let visionQueueTail = Promise.resolve();
let visionQueueDepth = 0;

function linkedDeadline(parentSignal, timeoutMs = VISION_PIPELINE_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason || new Error("vision request aborted"));
  if (parentSignal) parentSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`vision pipeline timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
    },
  };
}

async function runVisionQueued(task, parentSignal, requestId, trace) {
  const queuedAt = Date.now();
  visionQueueDepth += 1;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const previous = visionQueueTail.catch(() => {});
  visionQueueTail = previous.then(() => gate);
  await trace(requestId, "vision_queue_wait", {
    queue_depth: visionQueueDepth,
    queued_at: new Date(queuedAt).toISOString(),
  }, { force: true });
  await previous;
  if (parentSignal?.aborted) {
    release();
    visionQueueDepth -= 1;
    throw parentSignal.reason || new Error("vision request aborted while queued");
  }
  const deadline = linkedDeadline(parentSignal);
  await trace(requestId, "vision_queue_start", {
    waited_ms: Date.now() - queuedAt,
    queue_depth: visionQueueDepth,
    deadline_ms: VISION_PIPELINE_TIMEOUT_MS,
  }, { force: true });
  try {
    return await task(deadline.signal);
  } finally {
    deadline.close();
    release();
    visionQueueDepth = Math.max(0, visionQueueDepth - 1);
    await trace(requestId, "vision_queue_end", {
      total_ms: Date.now() - queuedAt,
      queue_depth: visionQueueDepth,
    }, { force: true }).catch(() => {});
  }
}

async function buildVisionEvidenceInternal(loadImage, prompt, signal, requestId, dependencies = {}) {
  const trace = dependencies.trace || traceVision;
  const loaded = await loadImage(signal, requestId);
  await trace(requestId, "media_resolution", {
    source: loaded.source,
    mime_type: loaded.mimeType,
    image_bytes: loaded.image?.length,
    media: loaded.media,
  }, { force: true });
  const analyze = dependencies.analyze || analyzeWithToriiGate;
  const reverseLookup = dependencies.reverse || reverseImageSearch;
  const localOcr = dependencies.ocr || analyzeWithLocalOcr;
  const verify = dependencies.verify || verifyKnownCandidate;
  const policyDetector = dependencies.searchPolicy || detectSearchPolicy;
  const deepSearch = dependencies.deepSearch || deepSearchExternalIdentity;
  const localRetrieve = dependencies.localIdentity || (dependencies.analyze
    ? async () => ({
      status: "skipped",
      source: "remote_clip_sidecar",
      accepted: [],
      primary: null,
      targets: [],
      reason: "test_override_without_local_identity",
    })
    : retrieveLocalIdentity);
  const searchPolicy = policyDetector(prompt);
  await trace(requestId, "search_policy", searchPolicy, { force: true });

  const [visionResult, ocrResult, reverseResult] = await Promise.allSettled([
    analyze(loaded.image, loaded.mimeType, signal, requestId),
    localOcr(loaded.image, loaded.mimeType, signal, requestId),
    reverseLookup(loaded.image, loaded.mimeType, signal, requestId),
  ]);
  const vision = visionResult.status === "fulfilled"
    ? visionResult.value
    : { status: "unavailable", source: "ToriiGate", raw: "", observation: null, error: String(visionResult.reason?.message || visionResult.reason) };
  const reverse = reverseResult.status === "fulfilled"
    ? reverseResult.value
    : { status: "unavailable", attempts: [], results: [], error: String(reverseResult.reason?.message || reverseResult.reason) };
  const ocr = ocrResult.status === "fulfilled"
    ? ocrResult.value
    : { status: "unavailable", source: "Windows.Media.Ocr", lines: [], text: "", raw: "", error: String(ocrResult.reason?.message || ocrResult.reason) };

  await trace(requestId, "vision_result_summary", {
    status: vision?.status || "unknown",
    source: vision?.source || "ToriiGate",
    error: vision?.error || null,
    observation: vision?.observation ? {
      subject_type: vision.observation.subject_type || vision.observation.subjectType || null,
      people_count: vision.observation.people_count ?? vision.observation.peopleCount ?? null,
      summary: vision.observation.summary || "",
      visible_text: Array.isArray(vision.observation.visible_text)
        ? vision.observation.visible_text.slice(0, 12)
        : vision.observation.visible_text || [],
      targets: Array.isArray(vision.observation.targets)
        ? vision.observation.targets.slice(0, 6).map((target) => ({
          target_id: target?.target_id || target?.id || null,
          bbox: target?.bbox || null,
          type: target?.type || null,
          visibility: target?.visibility ?? null,
        }))
        : [],
    } : null,
  }, { force: true });
  await trace(requestId, "ocr_result_summary", {
    status: ocr?.status || "unknown",
    source: ocr?.source || "Windows.Media.Ocr",
    lines: (Array.isArray(ocr?.normalized_lines) ? ocr.normalized_lines : ocr?.lines || []).slice(0, 16),
    error: ocr?.error || null,
  }, { force: true });
  await trace(requestId, "reverse_search_summary", {
    status: reverse?.status || "unknown",
    attempts: Array.isArray(reverse?.attempts)
      ? reverse.attempts.map((item) => ({
        service: item?.service || null,
        status: item?.status || null,
        http_status: item?.http_status ?? null,
        result_count: Array.isArray(item?.results) ? item.results.length : 0,
        error: item?.error || null,
      }))
      : [],
    top_results: Array.isArray(reverse?.results)
      ? reverse.results.slice(0, 5).map((item) => ({
        service: item?.service || null,
        title: item?.title || "",
        material: item?.material || "",
        characters: item?.characters || "",
        similarity: Number(item?.similarity || 0),
        source: item?.source || "",
      }))
      : [],
    error: reverse?.error || null,
  }, { force: true });

  const gate = evaluateReverseEvidence(reverse, vision, ocr);
  const workGate = workConfidenceGate(reverse);
  await trace(requestId, "work_confidence_gate", {
    ...workGate,
    atlasEnabled: false,
    reason: "identity_engine_v2_disables_atlas_decision",
  }, { force: true });

  const localIdentityRetrieval = await localRetrieve({
    image: loaded.image,
    mimeType: loaded.mimeType,
    targets: Array.isArray(vision?.observation?.targets) ? vision.observation.targets : [],
    signal,
    requestId,
    dependencies: dependencies.localIdentityDependencies || {},
  });
  await trace(requestId, "identity_resolver_input", {
    vision_status: vision?.status || "unknown",
    vision_targets: Array.isArray(vision?.observation?.targets)
      ? vision.observation.targets.map((target) => ({
        target_id: target?.target_id || target?.id || null,
        bbox: target?.bbox || null,
        type: target?.type || null,
        visibility: target?.visibility ?? null,
        stable_features: Array.isArray(target?.stable_features) ? target.stable_features : [],
      }))
      : [],
    local_identity_retrieval: localIdentityRetrieval,
    reverse_gate: {
      candidate: gate?.candidate || null,
      conflicts: gate?.conflicts || [],
      accepted: gate?.accepted || [],
      rejected: gate?.rejected || [],
    },
    work_confidence_gate: workGate,
  });
  const visualComparison = {
    status: "skipped",
    source: "official-reference visual comparison",
    matches: [],
    confirmations: [],
    reason: "identity_engine_v2_atlas_disabled",
  };
  const referenceMatch = {
    status: "skipped",
    source: "legacy perceptual official-reference matcher",
    matches: [],
    reason: "identity_engine_v2_legacy_hash_matcher_disabled",
  };
  await trace(requestId, "resolver_input", {
    vision,
    work_confidence_gate: workGate,
    local_identity_retrieval: localIdentityRetrieval,
    visual_reference_comparison: visualComparison,
    official_reference_match: referenceMatch,
    local_ocr: ocr,
    reverse_image: reverse,
  }, { force: true });
  const verification = gate.candidate
    ? await verify(gate.candidate, signal, requestId)
    : { status: "skipped", reason: "no_candidate_passed_evidence_gate", results: [] };
  const provisional = normalizeEvidence(
    loaded,
    vision,
    ocr,
    reverse,
    gate,
    verification,
    visualComparison,
    referenceMatch,
    {},
    localIdentityRetrieval,
  );
  const identityResolution = resolveImageCharacters(provisional, prompt);
  await trace(requestId, "identity_resolver_output", {
    detected_characters: identityResolution?.detectedCharacters || [],
    primary_character: identityResolution?.primaryCharacter || null,
    primary_impression: identityResolution?.primaryImpression || null,
    local_identity_primary: localIdentityRetrieval?.primary || null,
    local_identity_accepted: localIdentityRetrieval?.accepted || [],
    local_identity_targets: localIdentityRetrieval?.targets || [],
  });
  const canonicalConflict = canonicalIdentityConflict(
    searchPolicy,
    identityResolution.primaryCharacter,
    gate,
  );

  if (canonicalConflict) {
    gate.conflicts.push({
      ...canonicalConflict,
      resolution: searchPolicy.mode === "exhaustive"
        ? "force_deep_search_and_reject_local_visual_identity"
        : "reject_local_visual_identity",
    });
    await trace(requestId, "canonical_identity_conflict", {
      ...canonicalConflict,
      searchPolicy,
    }, { force: true });
  }

  const webDecision = determineWebDecision(
    searchPolicy,
    identityResolution.primaryCharacter,
    gate,
    canonicalConflict,
    workGate,
  );
  await trace(requestId, "local_first_confidence_gate", webDecision, { force: true });

  let deepSearchResult = {
    status: "skipped",
    searchMode: searchPolicy.mode,
    searchExhausted: false,
    resolvedIdentity: null,
    webMode: webDecision.webMode,
    reason: webDecision.reason,
  };

  if (webDecision.runDeepSearch) {
    deepSearchResult = await deepSearch({
      image: loaded.image,
      mimeType: loaded.mimeType,
      vision,
      ocr,
      reverse,
      workGate,
      signal,
      requestId,
      dependencies: dependencies.deepSearchDependencies || {},
    });
    deepSearchResult.webMode = webDecision.webMode;
  }

  if (canonicalConflict && !webDecision.preserveCanonicalOnUnresolvedConflict) {
    removeCanonicalIdentity(
      identityResolution,
      canonicalConflict.canonicalCandidate.canonicalId,
    );
  }

  identityResolution.externalIdentity = deepSearchResult?.resolvedIdentity || null;

  if (identityResolution.externalIdentity) {
    // A verified external identity outranks a local visual hypothesis.
    for (const item of [...(identityResolution.detectedCharacters || [])]) {
      if (canonicalEvidenceIsAtlasOnly(item)) {
        removeCanonicalIdentity(identityResolution, item.canonicalId);
      }
    }
  }

  const normalized = normalizeEvidence(
    loaded,
    vision,
    ocr,
    reverse,
    gate,
    verification,
    visualComparison,
    referenceMatch,
    identityResolution,
    localIdentityRetrieval,
  );
  normalized.search_policy = searchPolicy;
  normalized.local_confidence_gate = webDecision;
  normalized.work_confidence_gate = workGate;
  normalized.deep_search = deepSearchResult;
  normalized.external_identity = deepSearchResult?.resolvedIdentity || null;
  normalized.final_identity = normalized.external_identity
    || identityResolution.primaryCharacter
    || null;
  normalized.identity_decision = normalized.external_identity
    ? "external_verified"
    : identityResolution.primaryCharacter
      ? "local_embedding_verified"
      : canonicalConflict
        ? "local_candidate_rejected_external_work_unresolved"
        : "unresolved";
  normalized.identity_status = normalized.external_identity || identityResolution.primaryCharacter
    ? "known"
    : (vision.status === "ok" || localIdentityRetrieval?.status === "ok" || reverse.status === "ok")
      ? "unknown"
      : "error";
  normalized.identity_source = normalized.external_identity
    ? "external_verified"
    : identityResolution.primaryCharacter
      ? "local_reference_bank"
      : null;
  normalized.standardized.search_policy = searchPolicy;
  normalized.standardized.local_confidence_gate = webDecision;
  normalized.standardized.work_confidence_gate = workGate;
  normalized.standardized.deep_search = {
    status: deepSearchResult?.status,
    search_mode: deepSearchResult?.searchMode,
    search_exhausted: deepSearchResult?.searchExhausted,
    resolved_identity: deepSearchResult?.resolvedIdentity || null,
    reason: deepSearchResult?.reason,
  };
  normalized.standardized.identity_decision = normalized.identity_decision;
  normalized.standardized.identity_status = normalized.identity_status;
  normalized.standardized.identity_source = normalized.identity_source;

  await trace(requestId, "identity_resolution", {
    user_question: prompt,
    detected_characters: identityResolution.detectedCharacters,
    primary_character: identityResolution.primaryCharacter,
    external_identity: identityResolution.externalIdentity,
    search_policy: searchPolicy,
  }, { force: true });
  await trace(requestId, "impression_lookup", {
    final_identity: identityResolution.primaryCharacter || identityResolution.externalIdentity,
    impression: identityResolution.primaryImpression,
  }, { force: true });
  await trace(requestId, "normalized_evidence", normalized, {
    force: vision.status !== "ok" || ocr.status === "unavailable" || !gate.candidate || searchPolicy.mode === "exhaustive",
  });
  return normalized;
}

export async function buildVisionEvidence(loadImage, prompt, signal, requestId, dependencies = {}) {
  const trace = dependencies.trace || traceVision;
  return runVisionQueued(
    (pipelineSignal) => buildVisionEvidenceInternal(loadImage, prompt, pipelineSignal, requestId, dependencies),
    signal,
    requestId,
    trace,
  );
}

export const __test = {
  REVERSE_THRESHOLDS,
  buildVisionEvidenceInternal,
  candidateLevel,
  evaluateReverseEvidence,
  externalWorkReference,
  normalizeEvidence,
  ocrEvidence,
  ocrIdentityTerms,
  visionReportedText,
  canonicalEvidenceIsAtlasOnly,
  canonicalIdentityConflict,
  catalogWorkCompatible,
  strongExternalWorkEvidence,
  localIdentityScore,
  independentLocalIdentityEvidenceCount,
  localIdentityTier,
  directCharacterEvidence,
  determineWebDecision,
};

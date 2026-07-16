import { analyzeWithToriiGate, compareWithOfficialAtlases } from "./client.js";
import { analyzeWithLocalOcr } from "./ocr.js";
import { reverseImageSearch, verifyKnownCandidate } from "./reverse_search.js";
import { traceVision } from "./debug.js";
import { identityReferenceCatalog, resolveImageCharacters } from "./character_catalog.js";
import { matchOfficialReferences } from "./reference_match.js";

const REVERSE_THRESHOLDS = Object.freeze({
  "trace.moe": 0.87,
  SauceNAO: 0.8,
  IQDB: 0.8,
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

function normalizeEvidence(loaded, vision, localOcr, reverse, gate, verification, visualComparison = {}, referenceMatch = {}, identityResolution = {}) {
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
    official_reference_match: referenceMatch,
    visual_reference_comparison: visualComparison,
    final_identity: identityResolution.primaryCharacter || null,
    impression_lookup: identityResolution.primaryImpression || null,
    standardized,
  };
}

export async function buildVisionEvidence(loadImage, prompt, signal, requestId, dependencies = {}) {
  const trace = dependencies.trace || traceVision;
  const loaded = await loadImage(signal, requestId);
  await trace(requestId, "media_resolution", {
    source: loaded.source,
    mime_type: loaded.mimeType,
    image_bytes: loaded.image?.length,
    media: loaded.media,
  }, { force: true });
  const analyze = dependencies.analyze || analyzeWithToriiGate;
  const visualCompare = dependencies.visualCompare || (dependencies.analyze
    ? async () => ({ status: "skipped", source: "test override", raw: "", matches: [] })
    : compareWithOfficialAtlases);
  const referenceMatcher = dependencies.referenceMatch || (dependencies.analyze
    ? async () => ({ status: "skipped", source: "test override", matches: [] })
    : matchOfficialReferences);
  const reverseLookup = dependencies.reverse || reverseImageSearch;
  const localOcr = dependencies.ocr || analyzeWithLocalOcr;
  const verify = dependencies.verify || verifyKnownCandidate;
  const [visionResult, referenceResult, ocrResult, reverseResult] = await Promise.allSettled([
    analyze(loaded.image, loaded.mimeType, signal, requestId),
    referenceMatcher(loaded.image, loaded.mimeType, signal, requestId),
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
  const visualComparisonResult = await Promise.allSettled([
    visualCompare(loaded.image, loaded.mimeType, signal, requestId, {
      peopleCount: Number(vision?.observation?.people_count || 1),
    }),
  ]).then((items) => items[0]);
  const visualComparison = visualComparisonResult.status === "fulfilled"
    ? visualComparisonResult.value
    : { status: "unavailable", source: "official-reference visual comparison", matches: [], error: String(visualComparisonResult.reason?.message || visualComparisonResult.reason) };
  const referenceMatch = referenceResult.status === "fulfilled"
    ? referenceResult.value
    : { status: "unavailable", source: "local official-reference matcher", matches: [], error: String(referenceResult.reason?.message || referenceResult.reason) };
  await trace(requestId, "resolver_input", { vision, visual_reference_comparison: visualComparison, official_reference_match: referenceMatch, local_ocr: ocr, reverse_image: reverse }, { force: true });
  const gate = evaluateReverseEvidence(reverse, vision, ocr);
  const verification = gate.candidate
    ? await verify(gate.candidate, signal, requestId)
    : { status: "skipped", reason: "no_candidate_passed_evidence_gate", results: [] };
  const provisional = normalizeEvidence(loaded, vision, ocr, reverse, gate, verification, visualComparison, referenceMatch, {});
  const identityResolution = resolveImageCharacters(provisional, prompt);
  const normalized = normalizeEvidence(loaded, vision, ocr, reverse, gate, verification, visualComparison, referenceMatch, identityResolution);
  await trace(requestId, "identity_resolution", {
    user_question: prompt,
    detected_characters: identityResolution.detectedCharacters,
    primary_character: identityResolution.primaryCharacter,
  }, { force: true });
  await trace(requestId, "impression_lookup", {
    final_identity: identityResolution.primaryCharacter,
    impression: identityResolution.primaryImpression,
  }, { force: true });
  await trace(requestId, "normalized_evidence", normalized, {
    force: vision.status !== "ok" || ocr.status === "unavailable" || !gate.candidate,
  });
  return normalized;
}

export const __test = { REVERSE_THRESHOLDS, candidateLevel, evaluateReverseEvidence, externalWorkReference, normalizeEvidence, ocrEvidence, ocrIdentityTerms, visionReportedText };

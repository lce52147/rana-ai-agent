import { traceVision } from "./debug.js";
import {
  compareWithExternalReference,
  compareWithExternalCandidates,
  resolveExternalIdentityWithWebEvidence,
} from "./client.js";

const WEB_SEARCH_URL = String(process.env.RANA_WEB_SEARCH_URL || "").trim();
const WEB_SEARCH_TIMEOUT_MS = 8_000;

function isLegacyLocalOllamaWebSearch(value) {
  try {
    const url = new URL(String(value || ""));
    const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
    return localHost && url.port === "11434" && /\/api\/experimental\/web_search\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function configuredWebSearchUrl(env = process.env) {
  const value = String(env.RANA_WEB_SEARCH_URL || WEB_SEARCH_URL || "").trim();
  if (!value) return "";
  if (isLegacyLocalOllamaWebSearch(value) && env.RANA_ALLOW_OLLAMA_WEB_SEARCH !== "1") return "";
  return value;
}
const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const ANILIST_TIMEOUT_MS = 15_000;
const PAGE_FETCH_TIMEOUT_MS = 12_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_WEB_QUERIES = 2;
const MAX_WEB_RESULTS = 8;
const MAX_REFERENCE_IMAGES = 1;
const MAX_ANILIST_CHARACTERS = 16;
const ANILIST_BATCH_SIZE = 4;
const ANILIST_BATCH_SHORTLIST_FLOOR = 0.68;
const ANILIST_ACCEPT_CONFIDENCE = 0.88;
const ANILIST_TOURNAMENT_ACCEPT_CONFIDENCE = 0.90;
const MAX_WORK_HYPOTHESES = 2;
const DEEP_SEARCH_BUDGET_MS = 105_000;
const MIN_GENERIC_WEB_REMAINING_MS = 38_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function firstText(value) {
  return typeof value === "string" ? value : "";
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function compact(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function abortable(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function identityQuestion(value) {
  return /(?:這|这|她|他|它|右邊|右边|左邊|左边).{0,12}(?:是誰|是谁|哪個人|哪个人)|(?:是誰|是谁|認識|认识|認得|认得|叫什麼|叫什么|全名|本名|哪位角色|哪個角色|哪个角色|辨識|辨认|辨認|再辨識|再辨认|再辨認|重新辨識|重新辨认|重新辨認|認一下|认一下|看一下是誰|看一下是谁|看得出來|看得出来)/u.test(firstText(value));
}

function rewardCue(value) {
  return /(?:抹茶\s*(?:芭菲|巴菲|パフェ)|matcha\s+parfait)/iu.test(firstText(value));
}

export function detectSearchPolicy(userQuestion) {
  const asksIdentity = identityQuestion(userQuestion);
  const reward = rewardCue(userQuestion);
  return {
    mode: asksIdentity && reward ? "exhaustive" : "standard",
    asksIdentity,
    rewardCue: reward ? "matcha_parfait" : null,
    requireCharacterLevel: asksIdentity,
    allowExternalIdentity: asksIdentity,
  };
}

function usefulTitle(value) {
  const title = compact(value, 300);
  if (!title) return "";
  if (/^\d+(?:\.\d+)?%\s*(?:similarity|similar)?$/iu.test(title)) return "";
  return title;
}

function hypothesisThreshold(service) {
  if (service === "trace.moe") return 0.45;
  if (service === "SauceNAO") return 0.35;
  if (service === "IQDB") return 0.30;
  return 0.45;
}

export function workConfidenceGate(reverse) {
  const groups = new Map();
  for (const item of reverse?.results || []) {
    if (item?.service !== "trace.moe") continue;
    const title = usefulTitle(item?.material || item?.title);
    const key = normalize(title);
    const similarity = Number(item?.similarity || 0);
    if (!key || !Number.isFinite(similarity)) continue;
    const group = groups.get(key) || { title, score: 0, count: 0, items: [] };
    group.score = Math.max(group.score, similarity);
    group.count += 1;
    group.items.push(item);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((left, right) => right.score - left.score);
  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const margin = top ? top.score - Number(second?.score || 0) : 0;
  const tier = top?.score >= 0.90 && top.count >= 3 && margin >= 0.20
    ? "locked_work"
    : top?.score >= 0.60
      ? "verify_work"
      : top?.score >= 0.30
        ? "explore_work"
        : "weak_work";
  return {
    tier,
    top: top ? { title: top.title, score: top.score, count: top.count } : null,
    second: second ? { title: second.title, score: second.score, count: second.count } : null,
    margin,
    genericWebAllowed: tier !== "locked_work",
  };
}

function remainingBudgetMs(deadlineAt) {
  return Math.max(0, Number(deadlineAt || 0) - Date.now());
}

export function buildWorkHypotheses(reverse, suppliedGate = null) {
  const gate = suppliedGate || workConfidenceGate(reverse);
  const byTitle = new Map();
  for (const item of reverse?.results || []) {
    const title = usefulTitle(item?.material || item?.title);
    const similarity = Number(item?.similarity || 0);
    if (!title || similarity < hypothesisThreshold(item?.service)) continue;
    const key = normalize(title);
    if (!key) continue;
    const existing = byTitle.get(key);
    const candidate = {
      title,
      service: String(item?.service || ""),
      similarity,
      source: String(item?.source || ""),
      characters: compact(item?.characters, 300),
      material: compact(item?.material, 300),
      episode: item?.episode ?? null,
      from: Number.isFinite(Number(item?.from)) ? Number(item.from) : null,
      to: Number.isFinite(Number(item?.to)) ? Number(item.to) : null,
      anilistId: Number.isInteger(Number(item?.anilist_id)) ? Number(item.anilist_id) : null,
      traceImage: String(item?.trace_image || ""),
      titleEnglish: compact(item?.title_english, 300),
      titleRomaji: compact(item?.title_romaji, 300),
    };
    if (!existing || similarity > existing.similarity) byTitle.set(key, candidate);
  }
  const ranked = [...byTitle.values()].sort((left, right) => right.similarity - left.similarity);
  if (gate.tier === "locked_work" && gate.top?.title) {
    const lockedKey = normalize(gate.top.title);
    const locked = ranked.find((item) => normalize(item.title) === lockedKey);
    return locked ? [locked] : ranked.slice(0, 1);
  }
  return ranked.slice(0, MAX_WORK_HYPOTHESES);
}

function observationTerms(vision, ocr) {
  const observation = vision?.observation || {};
  const features = Array.isArray(observation?.distinctive_features)
    ? observation.distinctive_features
    : [];
  const ocrLines = Array.isArray(ocr?.normalized_lines)
    ? ocr.normalized_lines
    : Array.isArray(ocr?.lines) ? ocr.lines : [];
  return {
    summary: compact(observation?.summary, 500),
    features: [...new Set(features.map((item) => compact(item, 120)).filter(Boolean))].slice(0, 8),
    ocr: [...new Set(ocrLines.map((item) => compact(item, 160)).filter(Boolean))].slice(0, 8),
  };
}

export function buildDeepSearchQueries(workHypotheses, terms) {
  const queries = [];
  const descriptor = compact(
    [terms.features.slice(0, 4).join(" "), terms.summary]
      .filter(Boolean)
      .join(" "),
    260,
  );
  for (const work of workHypotheses.slice(0, 3)) {
    const title = work.title.replace(/"/g, "");
    queries.push(`"${title}" character cast official`);
    if (work.episode !== null && work.episode !== undefined) {
      queries.push(`"${title}" episode ${work.episode} character`);
    }
    if (descriptor) queries.push(`"${title}" character ${descriptor}`);
  }
  for (const line of terms.ocr.slice(0, 2)) {
    if (line.length >= 3) queries.push(`"${line.replace(/"/g, "")}" anime character`);
  }
  if (!workHypotheses.length && descriptor) {
    queries.push(`anime character ${descriptor}`);
  }
  return [...new Set(
    queries.map((item) => compact(item, 500)).filter(Boolean),
  )].slice(0, MAX_WEB_QUERIES);
}

async function runWebSearch(query, signal, requestId) {
  const endpoint = configuredWebSearchUrl();
  if (!endpoint) {
    const output = {
      query,
      status: "disabled",
      httpStatus: null,
      results: [],
      error: null,
      reason: "generic_web_backend_disabled",
    };
    await traceVision(requestId, "deep_search_web_query", output, { force: true });
    return output;
  }
  const request = abortable(signal, WEB_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: 8 }),
      signal: request.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const results = Array.isArray(payload?.results)
      ? payload.results.slice(0, 8).map((item) => ({
        title: compact(item?.title, 500),
        url: String(item?.url || "").trim(),
        content: compact(item?.content, 1200),
      })).filter((item) => item.title || item.content)
      : [];
    const output = {
      query,
      status: response.ok ? "ok" : "unavailable",
      httpStatus: response.status,
      results,
      error: response.ok ? null : compact(payload?.error || `HTTP ${response.status}`, 500),
    };
    await traceVision(requestId, "deep_search_web_query", output, { force: true });
    return output;
  } catch (error) {
    const output = {
      query,
      status: "unavailable",
      httpStatus: null,
      results: [],
      error: compact(error?.message || error, 500),
    };
    await traceVision(requestId, "deep_search_web_query", output, { force: true });
    return output;
  } finally {
    request.close();
  }
}

function dedupeWebResults(attempts) {
  const byKey = new Map();
  for (const attempt of attempts) {
    for (const item of attempt.results || []) {
      let domain = "";
      try { domain = new URL(item.url).hostname.toLowerCase(); } catch {}
      const key = item.url || `${normalize(item.title)}:${normalize(item.content).slice(0, 120)}`;
      if (!key || byKey.has(key)) continue;
      byKey.set(key, {
        index: byKey.size,
        query: attempt.query,
        title: item.title,
        url: item.url,
        domain,
        content: item.content,
      });
      if (byKey.size >= MAX_WEB_RESULTS) break;
    }
    if (byKey.size >= MAX_WEB_RESULTS) break;
  }
  return [...byKey.values()];
}

function selectedEvidence(candidate, results) {
  const indexes = Array.isArray(candidate?.evidence_indexes)
    ? candidate.evidence_indexes.map(Number).filter(Number.isInteger)
    : [];
  return indexes.map((index) => results[index]).filter(Boolean);
}

function textSupportsCandidate(candidate, results) {
  const selected = selectedEvidence(candidate, results);
  if (!selected.length) return { supported: false, selected, domains: [] };
  const haystack = normalize(selected.map((item) => `${item.title} ${item.content}`).join("\n"));
  const name = normalize(candidate?.character_name);
  const work = normalize(candidate?.work_title);
  const domains = [...new Set(selected.map((item) => item.domain).filter(Boolean))];
  return {
    supported: Boolean(name && haystack.includes(name) && (!work || haystack.includes(work))),
    selected,
    domains,
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local")) return false;
    if (/^(?:127|10|0)\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    return true;
  } catch {
    return false;
  }
}

function absoluteUrl(value, base) {
  try { return new URL(decodeHtml(value), base).href; } catch { return ""; }
}

function candidateImageUrls(html, pageUrl) {
  const values = [];
  const metaPatterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/giu,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/giu,
  ];
  for (const pattern of metaPatterns) {
    for (const match of html.matchAll(pattern)) values.push(absoluteUrl(match[1], pageUrl));
  }
  for (const match of html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/giu)) {
    values.push(absoluteUrl(match[1], pageUrl));
    if (values.length >= 12) break;
  }
  return [...new Set(values.filter(isSafePublicUrl))].slice(0, 8);
}

async function fetchPageImageUrls(pageUrl, signal) {
  if (!isSafePublicUrl(pageUrl)) return [];
  if (/\.(?:png|jpe?g|webp)(?:\?|$)/i.test(pageUrl)) return [pageUrl];
  const request = abortable(signal, PAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 RanaVision/1.0" },
      signal: request.signal,
      redirect: "follow",
    });
    if (!response.ok) return [];
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_PAGE_BYTES) return [];
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    return candidateImageUrls(html, response.url || pageUrl);
  } catch {
    return [];
  } finally {
    request.close();
  }
}

async function fetchImage(url, signal) {
  const request = abortable(signal, IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 RanaVision/1.0" },
      signal: request.signal,
      redirect: "follow",
    });
    if (!response.ok) return null;
    const mimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mimeType)) return null;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_IMAGE_BYTES) return null;
    const image = Buffer.from(await response.arrayBuffer());
    if (!image.length || image.length > MAX_IMAGE_BYTES) return null;
    return { image, mimeType, url: response.url || url };
  } catch {
    return null;
  } finally {
    request.close();
  }
}

function stripHtmlText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAniListCharacters(workHypotheses, signal, requestId, options = {}) {
  const maxMedia = Math.max(1, Math.min(2, Number(options.maxMedia || 2)));
  const maxCandidates = Math.max(1, Math.min(MAX_ANILIST_CHARACTERS, Number(options.maxCandidates || MAX_ANILIST_CHARACTERS)));
  const mediaIds = [...new Set(
    (workHypotheses || [])
      .map((item) => Number(item?.anilistId))
      .filter((item) => Number.isInteger(item) && item > 0),
  )].slice(0, maxMedia);

  const attempts = [];
  const candidates = [];

  for (const mediaId of mediaIds) {
    const request = abortable(signal, ANILIST_TIMEOUT_MS);
    try {
      const response = await fetch(ANILIST_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "RanaVision/1.0",
        },
        body: JSON.stringify({
          query: `
            query RanaVisionCharacters($id: Int!) {
              Media(id: $id, type: ANIME) {
                id
                title { romaji english native }
                characters(page: 1, perPage: 25, sort: [ROLE, RELEVANCE, ID]) {
                  edges {
                    role
                    node {
                      id
                      name { full native alternative }
                      image { large medium }
                      description
                      siteUrl
                    }
                  }
                }
              }
            }
          `,
          variables: { id: mediaId },
        }),
        signal: request.signal,
      });

      const payload = await response.json().catch(() => ({}));
      const media = payload?.data?.Media || null;
      const workTitle = compact(
        media?.title?.native
          || media?.title?.english
          || media?.title?.romaji
          || workHypotheses.find((item) => Number(item?.anilistId) === mediaId)?.title,
        300,
      );
      const edges = Array.isArray(media?.characters?.edges)
        ? media.characters.edges
        : [];

      const mapped = edges.map((edge, index) => {
        const node = edge?.node || {};
        const fullName = compact(node?.name?.full, 160);
        const nativeName = compact(node?.name?.native, 160);
        const alternativeNames = Array.isArray(node?.name?.alternative)
          ? node.name.alternative.map((item) => compact(item, 160)).filter(Boolean).slice(0, 8)
          : [];
        return {
          mediaId,
          characterId: Number(node?.id || 0),
          role: String(edge?.role || ""),
          relevanceIndex: index,
          name: nativeName || fullName,
          fullName,
          nativeName,
          alternativeNames,
          work: workTitle,
          imageUrl: String(node?.image?.large || node?.image?.medium || "").trim(),
          url: String(node?.siteUrl || "").trim(),
          description: compact(stripHtmlText(node?.description), 1000),
        };
      }).filter((item) => item.name && item.imageUrl);

      attempts.push({
        mediaId,
        status: response.ok && media ? "ok" : "unavailable",
        httpStatus: response.status,
        workTitle,
        characterCount: mapped.length,
        error: response.ok ? null : compact(payload?.errors?.[0]?.message || `HTTP ${response.status}`, 500),
      });
      candidates.push(...mapped);
    } catch (error) {
      attempts.push({
        mediaId,
        status: "unavailable",
        httpStatus: null,
        workTitle: "",
        characterCount: 0,
        error: compact(error?.message || error, 500),
      });
    } finally {
      request.close();
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.characterId || `${normalize(candidate.name)}:${normalize(candidate.work)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= maxCandidates) break;
  }

  const output = { attempts, candidates: unique };
  await traceVision(requestId, "anilist_character_search", output, { force: true });
  return output;
}

export async function resolveAniListVisualIdentity({
  image,
  mimeType,
  candidates,
  compare,
  batchCompare = compareWithExternalCandidates,
  fetchReference = fetchImage,
  signal,
  requestId,
  deadlineAt,
}) {
  const candidateLimit = Math.min(MAX_ANILIST_CHARACTERS, Math.max(1, candidates?.length || 0));
  const selected = (candidates || []).slice(0, candidateLimit);
  const downloaded = [];

  // AniList ensemble works may expose far more than four relevant characters.
  // Download a bounded candidate pool, then compare it in four-image batches so
  // the Vision server never receives an oversized multi-image request.
  for (const candidate of selected) {
    if (signal?.aborted) throw signal.reason || new Error("vision pipeline aborted");
    if (remainingBudgetMs(deadlineAt) < 12_000) break;
    const reference = await fetchReference(candidate.imageUrl, signal);
    if (!reference) continue;
    downloaded.push({
      name: candidate.nativeName || candidate.fullName || candidate.name,
      work: candidate.work,
      referenceUrl: reference.url || candidate.imageUrl,
      referenceImage: reference.image,
      referenceMimeType: reference.mimeType,
      metadata: candidate,
    });
  }

  const batchRuns = [];
  const shortlisted = [];
  for (let offset = 0; offset < downloaded.length; offset += ANILIST_BATCH_SIZE) {
    if (remainingBudgetMs(deadlineAt) < 16_000) break;
    const group = downloaded.slice(offset, offset + ANILIST_BATCH_SIZE);
    const scoped = abortable(signal, Math.min(30_000, Math.max(5_000, remainingBudgetMs(deadlineAt) - 3_000)));
    let batch;
    try {
      batch = await batchCompare({
        image,
        mimeType,
        candidates: group,
        signal: scoped.signal,
        requestId,
      });
    } finally {
      scoped.close();
    }

    const localIndex = Number(batch?.best_index);
    const selectedReference = Number.isInteger(localIndex) && localIndex >= 0 && localIndex < group.length
      ? group[localIndex]
      : null;
    const confidence = Number(batch?.confidence || 0);
    const sameCharacter = Boolean(selectedReference && batch?.same_character === true);
    const run = {
      batchIndex: Math.floor(offset / ANILIST_BATCH_SIZE),
      candidateOffset: offset,
      candidateCount: group.length,
      candidateNames: group.map((item) => item.name),
      bestLocalIndex: Number.isInteger(localIndex) ? localIndex : -1,
      bestGlobalIndex: selectedReference ? downloaded.indexOf(selectedReference) : -1,
      sameCharacter,
      confidence,
      evidence: compact(batch?.evidence, 500),
      error: compact(batch?.error, 500),
      selectedName: selectedReference?.name || "",
    };
    batchRuns.push(run);

    if (sameCharacter && confidence >= ANILIST_BATCH_SHORTLIST_FLOOR) {
      shortlisted.push({
        ...selectedReference,
        batchConfidence: confidence,
        batchIndex: run.batchIndex,
      });
    }
  }

  // A second comparison across batch winners prevents "first four characters"
  // from becoming an implicit hard cap and reduces false positives caused by a
  // weak winner inside one batch.
  shortlisted.sort((left, right) => right.batchConfidence - left.batchConfidence);
  const finalists = shortlisted.slice(0, ANILIST_BATCH_SIZE);
  let finalBatch = null;
  let selectedReference = null;
  let finalConfidence = 0;
  let accepted = false;

  if (finalists.length === 1) {
    selectedReference = finalists[0];
    finalConfidence = Number(finalists[0].batchConfidence || 0);
    accepted = finalConfidence >= ANILIST_ACCEPT_CONFIDENCE;
    finalBatch = {
      status: "single_shortlist",
      bestIndex: 0,
      sameCharacter: accepted,
      confidence: finalConfidence,
      evidence: "single ensemble-batch winner",
      error: "",
    };
  } else if (finalists.length > 1 && remainingBudgetMs(deadlineAt) >= 16_000) {
    const scoped = abortable(signal, Math.min(30_000, Math.max(5_000, remainingBudgetMs(deadlineAt) - 3_000)));
    let tournament;
    try {
      tournament = await batchCompare({
        image,
        mimeType,
        candidates: finalists,
        signal: scoped.signal,
        requestId,
      });
    } finally {
      scoped.close();
    }
    const winnerIndex = Number(tournament?.best_index);
    selectedReference = Number.isInteger(winnerIndex) && winnerIndex >= 0 && winnerIndex < finalists.length
      ? finalists[winnerIndex]
      : null;
    finalConfidence = Number(tournament?.confidence || 0);
    accepted = Boolean(
      selectedReference
      && tournament?.same_character === true
      && finalConfidence >= ANILIST_TOURNAMENT_ACCEPT_CONFIDENCE
    );
    finalBatch = {
      status: tournament?.status || "ok",
      bestIndex: Number.isInteger(winnerIndex) ? winnerIndex : -1,
      sameCharacter: tournament?.same_character === true,
      confidence: finalConfidence,
      evidence: compact(tournament?.evidence, 500),
      error: compact(tournament?.error, 500),
    };
  } else if (finalists.length > 1) {
    const lead = Number(finalists[0]?.batchConfidence || 0) - Number(finalists[1]?.batchConfidence || 0);
    selectedReference = finalists[0] || null;
    finalConfidence = Number(finalists[0]?.batchConfidence || 0);
    accepted = Boolean(finalConfidence >= 0.94 && lead >= 0.05);
    finalBatch = {
      status: "deadline_shortlist_fallback",
      bestIndex: selectedReference ? 0 : -1,
      sameCharacter: accepted,
      confidence: finalConfidence,
      evidence: `lead=${lead.toFixed(4)}`,
      error: "final tournament skipped by safe deadline",
    };
  }

  const selectedCandidate = selectedReference?.metadata || null;
  const score = accepted ? finalConfidence : 0;
  const resolvedIdentity = accepted ? {
    name: compact(selectedCandidate.nativeName || selectedCandidate.fullName || selectedCandidate.name, 160),
    nameRomanized: compact(selectedCandidate.fullName, 160),
    work: compact(selectedCandidate.work, 200),
    scope: "external",
    confidence: score >= 0.92 ? "high" : "medium",
    confidenceScore: score,
    sourceDomains: ["anilist.co"],
    evidenceIndexes: [],
    referenceUrl: selectedReference.referenceUrl || selectedCandidate.imageUrl,
    evidence: [{
      reason: "trace_work_anilist_ensemble_tournament_visual_match",
      visualConfidence: score,
      anilistMediaId: selectedCandidate.mediaId,
      anilistCharacterId: selectedCandidate.characterId,
      role: selectedCandidate.role,
      comparedCandidates: downloaded.length,
      comparedBatches: batchRuns.length,
    }],
  } : null;

  const output = {
    status: resolvedIdentity ? "resolved" : "unresolved",
    candidateCount: selected.length,
    downloadedCount: downloaded.length,
    comparedBatchCount: batchRuns.length,
    batchSize: ANILIST_BATCH_SIZE,
    batchRuns,
    shortlist: finalists.map((item) => ({
      name: item.name,
      work: item.work,
      batchConfidence: item.batchConfidence,
      batchIndex: item.batchIndex,
      characterId: item.metadata?.characterId || null,
    })),
    batch: finalBatch || {
      status: "unavailable",
      bestIndex: -1,
      sameCharacter: false,
      confidence: 0,
      evidence: "",
      error: downloaded.length ? "no_reliable_batch_winner" : "candidate_images_unavailable",
    },
    selectedCandidate: selectedCandidate ? {
      name: selectedCandidate.name,
      fullName: selectedCandidate.fullName,
      nativeName: selectedCandidate.nativeName,
      work: selectedCandidate.work,
      role: selectedCandidate.role,
      characterId: selectedCandidate.characterId,
      imageUrl: selectedCandidate.imageUrl,
    } : null,
    comparisons: selected.map((candidate) => {
      const shortlistItem = shortlisted.find((item) => item.metadata?.characterId === candidate.characterId);
      return {
        candidate: {
          name: candidate.name,
          fullName: candidate.fullName,
          nativeName: candidate.nativeName,
          work: candidate.work,
          role: candidate.role,
          characterId: candidate.characterId,
          imageUrl: candidate.imageUrl,
        },
        shortlisted: Boolean(shortlistItem),
        batchConfidence: Number(shortlistItem?.batchConfidence || 0),
        selected: accepted && selectedCandidate?.characterId === candidate.characterId,
        confidence: accepted && selectedCandidate?.characterId === candidate.characterId ? score : 0,
      };
    }),
    resolvedIdentity,
    reason: resolvedIdentity
      ? "anilist_ensemble_tournament_visual_verified"
      : downloaded.length
        ? "anilist_ensemble_tournament_unresolved"
        : "anilist_candidate_images_unavailable",
  };
  await traceVision(requestId, "anilist_candidate_batch_comparison", output, { force: true });
  return output;
}

async function collectReferenceImages(candidate, textSupport, signal, requestId) {
  const pageUrls = [...new Set(
    textSupport.selected.map((item) => item.url).filter(isSafePublicUrl),
  )].slice(0, 5);
  const imageUrls = [];
  for (const pageUrl of pageUrls) {
    const urls = await fetchPageImageUrls(pageUrl, signal);
    imageUrls.push(...urls);
    if (imageUrls.length >= 12) break;
  }
  const images = [];
  for (const url of [...new Set(imageUrls)]) {
    const fetched = await fetchImage(url, signal);
    if (fetched) images.push(fetched);
    if (images.length >= MAX_REFERENCE_IMAGES) break;
  }
  await traceVision(requestId, "deep_search_reference_images", {
    pageUrls,
    imageUrls: imageUrls.slice(0, 12),
    downloaded: images.map((item) => ({ url: item.url, mimeType: item.mimeType, bytes: item.image.length })),
  }, { force: true });
  return images;
}

function confidenceLabel(score) {
  if (score >= 0.85) return "high";
  if (score >= 0.72) return "medium";
  return "low";
}

export async function deepSearchExternalIdentity({
  image,
  mimeType,
  vision,
  ocr,
  reverse,
  workGate: suppliedWorkGate = null,
  signal,
  requestId,
  dependencies = {},
}) {
  const compare = dependencies.compare || compareWithExternalReference;
  const batchCompare = dependencies.batchCompare || compareWithExternalCandidates;
  const resolve = dependencies.resolve || resolveExternalIdentityWithWebEvidence;
  const search = dependencies.search || runWebSearch;
  const collectReferences = dependencies.collectReferences || collectReferenceImages;
  const fetchCharacters = dependencies.anilistCharacters || fetchAniListCharacters;
  const resolveAniList = dependencies.resolveAniList || resolveAniListVisualIdentity;
  const workGate = suppliedWorkGate || workConfidenceGate(reverse);
  const deadlineAt = Date.now() + DEEP_SEARCH_BUDGET_MS;
  const workHypotheses = buildWorkHypotheses(reverse, workGate);
  const terms = observationTerms(vision, ocr);
  let queries = buildDeepSearchQueries(workHypotheses, terms);
  if (workGate.tier === "locked_work") queries = queries.slice(0, 1);

  await traceVision(requestId, "deep_search_started", {
    mode: "fast_exhaustive",
    workGate,
    budgetMs: DEEP_SEARCH_BUDGET_MS,
    workHypotheses,
    terms,
    queries,
  }, { force: true });
  await traceVision(requestId, "work_hypotheses", { workGate, workHypotheses }, { force: true });

  const anilistOptions = {
    maxMedia: workGate.tier === "locked_work" ? 1 : 2,
    // Ensemble works such as BanG Dream must not be truncated to the first
    // four AniList characters. The visual resolver compares this bounded pool
    // in four-candidate batches and runs a final tournament among winners.
    maxCandidates: workGate.tier === "locked_work" ? 16 : 8,
  };
  const anilistSearch = await fetchCharacters(workHypotheses, signal, requestId, anilistOptions);
  if (anilistSearch?.candidates?.length && remainingBudgetMs(deadlineAt) >= 18_000) {
    const anilistResolution = await resolveAniList({
      image,
      mimeType,
      candidates: anilistSearch.candidates,
      compare,
      batchCompare,
      fetchReference: dependencies.fetchReference,
      signal,
      requestId,
      deadlineAt,
    });
    if (anilistResolution?.resolvedIdentity) {
      const output = {
        status: "resolved",
        searchMode: "fast_exhaustive",
        searchExhausted: true,
        workGate,
        workHypotheses,
        queries,
        anilistSearch,
        anilistResolution,
        webResults: [],
        candidate: null,
        visualComparisons: anilistResolution.comparisons || [],
        resolvedIdentity: anilistResolution.resolvedIdentity,
        reason: anilistResolution.reason || "anilist_ensemble_tournament_visual_verified",
        elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
      };
      await traceVision(requestId, "deep_search_resolution", output, { force: true });
      return output;
    }
  }

  const remainingAfterAniList = remainingBudgetMs(deadlineAt);
  if (workGate.tier === "locked_work" && remainingAfterAniList < MIN_GENERIC_WEB_REMAINING_MS) {
    const output = {
      status: "exhausted",
      searchMode: "fast_exhaustive",
      searchExhausted: true,
      workGate,
      workHypotheses,
      queries,
      anilistSearch,
      webResults: [],
      candidate: null,
      visualComparisons: [],
      resolvedIdentity: null,
      reason: "locked_work_candidates_unresolved_before_safe_deadline",
      elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingAfterAniList,
    };
    await traceVision(requestId, "deep_search_short_circuit", output, { force: true });
    await traceVision(requestId, "deep_search_resolution", output, { force: true });
    return output;
  }

  if (!queries.length || remainingBudgetMs(deadlineAt) < MIN_GENERIC_WEB_REMAINING_MS) {
    const output = {
      status: "exhausted",
      searchMode: "fast_exhaustive",
      searchExhausted: true,
      workGate,
      workHypotheses,
      queries,
      anilistSearch,
      webResults: [],
      candidate: null,
      visualComparisons: [],
      resolvedIdentity: null,
      reason: queries.length ? "safe_deadline_reached_before_generic_web" : "no_searchable_work_or_visual_terms",
      elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
    };
    await traceVision(requestId, "deep_search_short_circuit", output, { force: true });
    await traceVision(requestId, "deep_search_resolution", output, { force: true });
    return output;
  }

  if (signal?.aborted) throw signal.reason || new Error("vision pipeline aborted");
  const settledSearches = await Promise.allSettled(
    queries.slice(0, MAX_WEB_QUERIES).map((query) => search(query, signal, requestId)),
  );
  const attempts = settledSearches.map((item, index) => item.status === "fulfilled"
    ? item.value
    : {
      query: queries[index],
      status: "unavailable",
      httpStatus: null,
      results: [],
      error: compact(item.reason?.message || item.reason, 500),
    });
  const webResults = dedupeWebResults(attempts);
  await traceVision(requestId, "character_candidate_search", { queries, attempts, webResults }, { force: true });

  const availableAttempts = attempts.filter((item) => item.status === "ok");
  const backendDisabled = attempts.length > 0 && attempts.every((item) => item.status === "disabled");
  if (!availableAttempts.length || !webResults.length || remainingBudgetMs(deadlineAt) < 28_000) {
    const output = {
      status: availableAttempts.length || backendDisabled ? "exhausted" : "error",
      searchMode: "fast_exhaustive",
      searchExhausted: availableAttempts.length > 0 || backendDisabled,
      workGate,
      workHypotheses,
      queries,
      webResults,
      candidate: null,
      visualComparisons: [],
      resolvedIdentity: null,
      reason: backendDisabled
        ? "generic_web_backend_disabled"
        : !availableAttempts.length
          ? "all_web_search_attempts_unavailable"
          : !webResults.length
          ? "web_search_returned_no_identity_evidence"
          : "safe_deadline_reached_before_web_resolver",
      errors: attempts.map((item) => item.error).filter(Boolean),
      elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
    };
    await traceVision(requestId, "deep_search_resolution", output, { force: true });
    return output;
  }

  const candidate = await resolve({
    image,
    mimeType,
    webEvidence: webResults,
    workHypotheses,
    visualSummary: terms,
    signal,
    requestId,
  });
  const textSupport = textSupportsCandidate(candidate, webResults);
  if (candidate?.status !== "candidate" || !textSupport.supported || Number(candidate?.confidence || 0) < 0.60) {
    const output = {
      status: "exhausted",
      searchMode: "fast_exhaustive",
      searchExhausted: true,
      workGate,
      workHypotheses,
      queries,
      webResults,
      candidate,
      textSupport: {
        supported: textSupport.supported,
        domains: textSupport.domains,
        selectedIndexes: candidate?.evidence_indexes || [],
      },
      visualComparisons: [],
      resolvedIdentity: null,
      reason: "no_text_supported_character_candidate",
      elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
    };
    await traceVision(requestId, "deep_search_resolution", output, { force: true });
    return output;
  }

  if (remainingBudgetMs(deadlineAt) < 18_000) {
    const output = {
      status: "exhausted",
      searchMode: "fast_exhaustive",
      searchExhausted: true,
      workGate,
      workHypotheses,
      queries,
      webResults,
      candidate,
      visualComparisons: [],
      resolvedIdentity: null,
      reason: "safe_deadline_reached_before_final_visual_check",
      elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
    };
    await traceVision(requestId, "deep_search_short_circuit", output, { force: true });
    await traceVision(requestId, "deep_search_resolution", output, { force: true });
    return output;
  }

  const references = await collectReferences(candidate, textSupport, signal, requestId);
  const visualComparisons = [];
  const reference = references[0] || null;
  if (reference && remainingBudgetMs(deadlineAt) >= 12_000) {
    const scoped = abortable(signal, Math.min(22_000, Math.max(5_000, remainingBudgetMs(deadlineAt) - 2_000)));
    try {
      const comparison = await compare({
        image,
        mimeType,
        referenceImage: reference.image,
        referenceMimeType: reference.mimeType,
        candidate: {
          name: candidate.character_name,
          work: candidate.work_title,
          referenceUrl: reference.url,
        },
        signal: scoped.signal,
        requestId,
      });
      visualComparisons.push({ referenceUrl: reference.url, ...comparison });
    } finally {
      scoped.close();
    }
  }
  await traceVision(requestId, "candidate_visual_comparison", { candidate, visualComparisons }, { force: true });

  const acceptedVisual = visualComparisons.find((item) =>
    item?.same_character === true && Number(item?.confidence || 0) >= 0.84);
  const modelConfidence = Number(candidate?.confidence || 0);
  const accepted = Boolean(acceptedVisual);
  const score = acceptedVisual
    ? Math.max(0.88, Number(acceptedVisual.confidence || 0))
    : 0;

  const resolvedIdentity = accepted ? {
    name: compact(candidate.character_name, 160),
    work: compact(candidate.work_title, 200),
    scope: "external",
    confidence: confidenceLabel(score),
    confidenceScore: score,
    sourceDomains: textSupport.domains,
    evidenceIndexes: candidate.evidence_indexes || [],
    referenceUrl: acceptedVisual?.referenceUrl || "",
    evidence: [{
      reason: "web_candidate_visual_pair_confirmation",
      visualConfidence: acceptedVisual ? Number(acceptedVisual.confidence || 0) : null,
      textDomains: textSupport.domains,
      candidateConfidence: modelConfidence,
    }],
  } : null;

  const output = {
    status: resolvedIdentity ? "resolved" : "exhausted",
    searchMode: "fast_exhaustive",
    searchExhausted: true,
    workGate,
    workHypotheses,
    queries,
    webResults,
    candidate,
    textSupport: {
      supported: textSupport.supported,
      domains: textSupport.domains,
      selectedIndexes: candidate.evidence_indexes || [],
    },
    visualComparisons,
    resolvedIdentity,
    reason: resolvedIdentity ? "external_character_identity_verified" : "candidate_not_visually_verified",
    elapsedMs: DEEP_SEARCH_BUDGET_MS - remainingBudgetMs(deadlineAt),
  };
  await traceVision(requestId, "deep_search_resolution", output, { force: true });
  return output;
}

export const __test = {
  buildDeepSearchQueries,
  buildWorkHypotheses,
  detectSearchPolicy,
  normalize,
  textSupportsCandidate,
  fetchAniListCharacters,
  resolveAniListVisualIdentity,
  workConfidenceGate,
  remainingBudgetMs,
  configuredWebSearchUrl,
  isLegacyLocalOllamaWebSearch,
  runWebSearch,
};

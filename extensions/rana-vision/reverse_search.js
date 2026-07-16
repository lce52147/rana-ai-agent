import { traceVision } from "./debug.js";

const TRACE_MOE_URL = "https://api.trace.moe/search?anilistInfo";
const SAUCENAO_URL = "https://saucenao.com/search.php";
const IQDB_URL = "https://iqdb.org/";
const WEB_SEARCH_URL = String(process.env.RANA_WEB_SEARCH_URL || "http://127.0.0.1:11434/api/experimental/web_search").trim();
const SEARCH_TIMEOUT_MS = 30000;

function abortable(signal, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function imageForm(image, mimeType, fields = {}, fileField = "file") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "") form.append(key, String(value));
  }
  const extension = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  form.append(fileField, new Blob([image], { type: mimeType }), `rana-image.${extension}`);
  return form;
}

function titleOfAnilist(anilist) {
  return String(anilist?.title?.native || anilist?.title?.romaji || anilist?.title?.english || anilist?.synonyms?.[0] || "").trim();
}

async function searchTraceMoe(image, mimeType, signal, requestId) {
  const request = abortable(signal);
  try {
    const response = await fetch(TRACE_MOE_URL, {
      method: "POST",
      body: imageForm(image, mimeType, {}, "image"),
      signal: request.signal,
    });
    const payload = await response.json().catch(() => ({}));
    await traceVision(requestId, "reverse_search_raw", { service: "trace.moe", http_status: response.status, payload });
    if (!response.ok) {
      return { service: "trace.moe", status: "unavailable", http_status: response.status, results: [], error: String(payload?.error || `HTTP ${response.status}`) };
    }
    const results = Array.isArray(payload?.result) ? payload.result.slice(0, 5).map((item) => ({
      service: "trace.moe",
      title: titleOfAnilist(item?.anilist) || String(item?.filename || ""),
      similarity: Number(item?.similarity) || 0,
      episode: item?.episode ?? null,
      from: item?.from ?? null,
      to: item?.to ?? null,
      source: item?.anilist?.siteUrl || item?.video || "",
    })) : [];
    return { service: "trace.moe", status: results.length ? "ok" : "empty", http_status: response.status, results };
  } catch (error) {
    return { service: "trace.moe", status: "unavailable", results: [], error: String(error?.message || error) };
  } finally {
    request.close();
  }
}

async function searchSauceNao(image, mimeType, signal, requestId) {
  const apiKey = String(process.env.RANA_SAUCENAO_API_KEY || "").trim();
  if (!apiKey) {
    return { service: "SauceNAO", status: "not_configured", results: [], error: "RANA_SAUCENAO_API_KEY is not configured" };
  }
  const request = abortable(signal);
  try {
    const response = await fetch(SAUCENAO_URL, {
      method: "POST",
      body: imageForm(image, mimeType, { api_key: apiKey, output_type: 2, db: 999, numres: 6 }),
      signal: request.signal,
    });
    const payload = await response.json().catch(() => ({}));
    await traceVision(requestId, "reverse_search_raw", { service: "SauceNAO", http_status: response.status, payload });
    if (!response.ok || Number(payload?.header?.status || 0) < 0) {
      return { service: "SauceNAO", status: "unavailable", http_status: response.status, results: [], error: String(payload?.header?.message || `HTTP ${response.status}`) };
    }
    const results = Array.isArray(payload?.results) ? payload.results.slice(0, 6).map((item) => {
      const data = item?.data || {};
      const title = data.title || data.eng_name || data.jp_name || data.material || data.source || data.characters || "";
      return {
        service: "SauceNAO",
        title: String(title),
        similarity: Math.max(0, Math.min(1, Number(item?.header?.similarity || 0) / 100)),
        characters: String(data.characters || ""),
        material: String(data.material || ""),
        creator: String(data.creator || data.member_name || data.author_name || ""),
        source: String(data.source || data.ext_urls?.[0] || ""),
      };
    }) : [];
    return { service: "SauceNAO", status: results.length ? "ok" : "empty", http_status: response.status, results };
  } catch (error) {
    return { service: "SauceNAO", status: "unavailable", results: [], error: String(error?.message || error) };
  } finally {
    request.close();
  }
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchIqdb(image, mimeType, signal, requestId) {
  const request = abortable(signal);
  try {
    const response = await fetch(IQDB_URL, {
      method: "POST",
      body: imageForm(image, mimeType),
      signal: request.signal,
    });
    const html = await response.text();
    await traceVision(requestId, "reverse_search_raw", { service: "IQDB", http_status: response.status, body: html.slice(0, 20000) });
    if (!response.ok) {
      return { service: "IQDB", status: "unavailable", http_status: response.status, results: [], error: `HTTP ${response.status}` };
    }
    const blocks = [...html.matchAll(/<div[^>]*>\s*<table[^>]*>([\s\S]*?)<\/table>\s*<\/div>/gi)].map((match) => match[1]);
    const results = blocks.map((block) => {
      const similarity = Number(block.match(/(\d+(?:\.\d+)?)%\s*(?:similarity|similar)/i)?.[1] || 0) / 100;
      const href = block.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1] || "";
      const imageTag = block.match(/<img\b[^>]*(?:class=["'][^"']*["'])?[^>]*>/i)?.[0] || "";
      const tags = imageTag.match(/(?:title|alt)=["']([^"']+)["']/i)?.[1] || "";
      const service = stripHtml(block.match(/<img[^>]+class=["'][^"']*service-icon[^"']*["'][^>]*>\s*([^<]*)/i)?.[1] || "");
      const label = tags ? `${service || "IQDB"}: ${stripHtml(tags)}` : "";
      return {
        service: "IQDB",
        title: label.slice(0, 300),
        similarity,
        source: href.startsWith("//") ? `https:${href}` : href,
        tags: stripHtml(tags).slice(0, 1000),
      };
    }).filter((item) => item.similarity > 0).slice(0, 6);
    return { service: "IQDB", status: results.length ? "ok" : "empty", http_status: response.status, results };
  } catch (error) {
    return { service: "IQDB", status: "unavailable", results: [], error: String(error?.message || error) };
  } finally {
    request.close();
  }
}

function hasUsefulResult(result, threshold = 0.65) {
  return result?.status === "ok" && result.results.some((item) => item.similarity >= threshold);
}

export async function reverseImageSearch(image, mimeType, signal, requestId, services = {}) {
  const runners = [
    services.traceMoe || searchTraceMoe,
    services.sauceNao || searchSauceNao,
    services.iqdb || searchIqdb,
  ];
  const serviceNames = ["trace.moe", "SauceNAO", "IQDB"];
  const settled = await Promise.allSettled(runners.map((runner) => runner(image, mimeType, signal, requestId)));
  const attempts = settled.map((item, index) => item.status === "fulfilled"
    ? item.value
    : { service: serviceNames[index], status: "unavailable", results: [], error: String(item.reason?.message || item.reason) });
  const results = attempts
    .flatMap((attempt) => attempt.results || [])
    .sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0))
    .slice(0, 8);
  const output = { status: results.length ? "ok" : "empty", attempts, results };
  console.log(`[rana-vision] request=${requestId} reverse services=${attempts.map((item) => `${item.service}:${item.status}`).join(",")} results=${results.length}`);
  return output;
}

export async function verifyKnownCandidate(candidate, signal, requestId) {
  const title = String(candidate?.title || "").replace(/\s+/g, " ").trim();
  if (!candidate?.accepted || !title) return { status: "skipped", reason: "candidate_not_accepted", results: [] };
  const query = `"${title.replace(/"/g, "")}" official character work`;
  const request = abortable(signal, 15000);
  try {
    const response = await fetch(WEB_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: request.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const results = Array.isArray(payload?.results) ? payload.results.slice(0, 5).map((item) => ({
      title: String(item?.title || ""),
      url: String(item?.url || ""),
      content: String(item?.content || "").slice(0, 500),
    })) : [];
    const output = { status: response.ok ? "ok" : "unavailable", query, http_status: response.status, results };
    await traceVision(requestId, "text_verification", output);
    return output;
  } catch (error) {
    return { status: "unavailable", query, results: [], error: String(error?.message || error) };
  } finally {
    request.close();
  }
}

export const __test = { hasUsefulResult, imageForm, stripHtml };

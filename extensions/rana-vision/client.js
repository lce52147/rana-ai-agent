import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { traceVision } from "./debug.js";
import { characterAtlases } from "./character_catalog.js";

const VISION_LAN_BASE_URL = "http://192.168.50.3:6970";
const VISION_PRIMARY_BASE_URL = String(process.env.RANA_VISION_BASE_URL || VISION_LAN_BASE_URL).trim();
const VISION_FALLBACK_BASE_URL = String(process.env.RANA_VISION_FALLBACK_BASE_URL || "http://100.99.83.84:6970").trim();
const INBOUND_DIR = path.resolve("C:\\Users\\Administrator\\.openclaw\\media\\inbound");
const OPENCLAW_CONFIG = "C:\\Users\\Administrator\\.openclaw\\openclaw.json";
const VISION_TIMEOUT_MS = 90000;
const VISION_MODEL_CACHE_MS = 60000;
const VISUAL_COMPARISON_BUDGET_MS = 45000;
const VISUAL_COMPARISON_REQUEST_TIMEOUT_MS = 15000;

let visionModelCache = { checkedAt: 0, id: "", baseUrl: "" };

const VISION_OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["medium", "subject_type", "people_count", "visible_text", "logos", "distinctive_features", "scene", "summary"],
  properties: {
    medium: { type: "string", enum: ["photo", "anime", "illustration", "game_ui", "manga", "poster", "other"] },
    subject_type: { type: "string", enum: ["food", "object", "person", "character", "scene", "unknown"] },
    people_count: { type: "integer", minimum: 0, maximum: 50 },
    visible_text: { type: "array", items: { type: "string" } },
    logos: { type: "array", items: { type: "string" } },
    distinctive_features: { type: "array", items: { type: "string" } },
    scene: { type: "string" },
    summary: { type: "string" },
  },
};

function visionResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "vision_observation",
      strict: true,
      schema: VISION_OBSERVATION_SCHEMA,
    },
  };
}

function atlasResponseFormat(cells) {
  return {
    type: "json_schema",
    json_schema: {
      name: "official_reference_visual_cell",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["cell", "confidence"],
        properties: {
          cell: { type: "string", enum: [...cells, "none"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  };
}

function confirmationResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "official_reference_pair_confirmation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["same_character", "confidence", "evidence", "target_position"],
        properties: {
          same_character: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string" },
          target_position: { type: "string" },
        },
      },
    },
  };
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function visionBaseUrls(primary = VISION_PRIMARY_BASE_URL, fallback = VISION_FALLBACK_BASE_URL) {
  return [...new Set([VISION_LAN_BASE_URL, primary, fallback].map(cleanBaseUrl).filter(Boolean))];
}

function imageMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

function abortable(signal, timeoutMs) {
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

function rawVisibleText(text) {
  const source = String(text || "");
  const match = source.match(/"visible_text"\s*:\s*\[\s*"([\s\S]*?)(?:"\s*\]|"\s*,\s*"logos"|$)/i);
  if (!match?.[1]) return [];
  return match[1]
    .replace(/\\n/g, "\n")
    .split(/\r?\n|\\n/u)
    .map((item) => item.replace(/\\"/g, '"').replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function parseObservation(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const fallback = {
    medium: "other",
    subject_type: "unknown",
    people_count: 0,
    visible_text: rawVisibleText(text),
    logos: [],
    distinctive_features: [],
    scene: "",
    summary: text.slice(0, 1200),
  };
  if (start < 0 || end <= start) return fallback;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const strings = (items, limit = 12) => {
      const values = Array.isArray(items) ? items : typeof items === "string" ? [items] : [];
      return values.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, limit);
    };
    const featureText = strings(parsed?.distinctive_features).join(" ");
    return {
      medium: ["photo", "anime", "illustration", "game_ui", "manga", "poster", "other"].includes(parsed?.medium) ? parsed.medium : "other",
      subject_type: ["food", "object", "person", "character", "scene", "unknown"].includes(parsed?.subject_type) ? parsed.subject_type : "unknown",
      people_count: Math.max(0, Math.min(50, Number(parsed?.people_count) || 0)),
      visible_text: strings(parsed?.visible_text).length ? strings(parsed?.visible_text) : rawVisibleText(text),
      logos: strings(parsed?.logos, 6),
      distinctive_features: strings(parsed?.distinctive_features),
      scene: String(parsed?.scene || "").replace(/\s+/g, " ").trim().slice(0, 500),
      summary: String(parsed?.summary || featureText || text).replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  } catch {
    return fallback;
  }
}

function observationLooksTemplate(raw, observation) {
  const source = String(raw || "");
  const markers = [
    "photo|anime|illustration|game_ui|manga|poster|other",
    "food|object|person|character|scene|unknown",
    "factual visual summary",
    "visible scene",
    "visible feature",
  ];
  const markerCount = markers.filter((marker) => source.includes(marker)).length;
  const hasEvidence = Boolean(
    observation?.visible_text?.length
    || observation?.logos?.length
    || observation?.distinctive_features?.length
    || (observation?.summary && observation.summary !== "factual visual summary")
  );
  return markerCount >= 2 && !hasEvidence;
}

async function resolveVisionTarget(signal, requestId) {
  const now = Date.now();
  if (visionModelCache.id && visionModelCache.baseUrl && now - visionModelCache.checkedAt < VISION_MODEL_CACHE_MS) {
    return { model: visionModelCache.id, baseUrl: visionModelCache.baseUrl };
  }
  const errors = [];
  for (const baseUrl of visionBaseUrls()) {
    const endpoint = `${baseUrl}/v1/models`;
    const probe = abortable(signal, 5000);
    try {
      const response = await fetch(endpoint, { signal: probe.signal });
      console.log(`[rana-vision] request=${requestId} discovery endpoint=${endpoint} status=${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({}));
      const ids = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id || "").trim()).filter(Boolean) : [];
      const model = ids.find((id) => /ToriiGate|Qwen.*VL/i.test(id)) || ids[0];
      if (!model) throw new Error("no model returned");
      visionModelCache = { checkedAt: now, id: model, baseUrl };
      return { model, baseUrl };
    } catch (error) {
      errors.push(`${endpoint}: ${error?.message || error}`);
    } finally {
      probe.close();
    }
  }
  throw new Error(`vision discovery failed (${errors.join("; ")})`);
}

function visionUserContent(image, mimeType) {
  return [
    {
      type: "text",
      text: [
        "Observe this image without guessing a character name, franchise, or relationship.",
        "Report only visible evidence: medium, subject type, people count, OCR text, logos, distinctive features, scene, and a concise factual summary.",
        "Return one JSON object only. Do not use Markdown.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
  ];
}

function atlasUserContent(image, mimeType, atlasImage) {
  return [
    {
      type: "text",
      text: [
        "Image 1 is a target. Image 2 is a grid of neutral visual reference cells.",
        "Select the one cell with the same character design, or none.",
        "Compare face and hairstyle; allow different crop, pose, expression, outfit, lighting, and rendering.",
        "The cell code is only a location. Do not use external character knowledge.",
        "Return JSON only.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
    { type: "text", text: "Image 2: official visual reference grid." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${atlasImage.toString("base64")}` } },
  ];
}

function confirmationUserContent(image, mimeType, referenceImage, targetPosition) {
  return [
    {
      type: "text",
      text: [
        "Image 1 is the only target. Image 2 is one official character reference.",
        `Check only the target person at this location: ${targetPosition || "the matched target person"}.`,
        "Decide whether they show the same fictional character across different crop, pose, expression, outfit, lighting, rendering, or color shift.",
        "Compare stable design evidence: face, hairstyle shape, bangs, distinctive eye pattern, and recurring accessories.",
        "Clothing alone and small color shifts must not reject a match. Return false when stable identity features conflict or evidence is insufficient.",
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
    { type: "text", text: "Image 2: single official visual reference." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${referenceImage.toString("base64")}` } },
  ];
}

function parsedJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

function atlasCells(atlas) {
  return atlas.characters.map((item, index) => ({
    id: item.id,
    cell: `R${Math.floor(index / 3) + 1}C${(index % 3) + 1}`,
  }));
}

function parseAtlasMatches(value, cells) {
  const parsed = parsedJson(value);
  const cell = String(parsed?.cell || "").trim().toUpperCase();
  const reference = cells.find((item) => item.cell === cell);
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
  if (!reference || confidence < 0.5) return [];
  return [{
    id: reference.id,
    confidence,
    evidence: "neutral_atlas_cell_match",
    target_position: "center",
    reference_position: cell,
  }];
}

function parseConfirmation(value) {
  const parsed = parsedJson(value);
  return {
    same_character: parsed?.same_character === true,
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    evidence: String(parsed?.evidence || "").replace(/\s+/g, " ").trim().slice(0, 500),
    target_position: String(parsed?.target_position || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

export async function analyzeWithToriiGate(image, mimeType, signal, requestId) {
  const request = abortable(signal, VISION_TIMEOUT_MS);
  try {
    const { model, baseUrl } = await resolveVisionTarget(request.signal, requestId);
    const visionUrl = `${baseUrl}/v1/chat/completions`;
    await traceVision(requestId, "toriigate_request", {
      endpoint: visionUrl,
      model,
      mime_type: mimeType,
      image_bytes: image.length,
      image_sha256: createHash("sha256").update(image).digest("hex"),
    });
    const response = await fetch(visionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 512,
        cache_prompt: false,
        response_format: visionResponseFormat(),
        messages: [
          { role: "system", content: "You are ToriiGate, a visual observation stage. Describe visible evidence accurately and return only the requested JSON. Do not infer identity from fandom knowledge." },
          { role: "user", content: visionUserContent(image, mimeType) },
        ],
      }),
      signal: request.signal,
    });
    const body = await response.text();
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}
    await traceVision(requestId, "toriigate_raw_response", { http_status: response.status, body: data || body });
    console.log(`[rana-vision] request=${requestId} ToriiGate endpoint=${visionUrl} status=${response.status}`);
    if (!response.ok) throw new Error(String(data?.error?.message || data?.error || body || `HTTP ${response.status}`));
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) throw new Error("vision returned no description");
    const observation = parseObservation(raw);
    const templateResponse = observationLooksTemplate(raw, observation);
    const result = {
      status: templateResponse ? "invalid" : "ok",
      source: "ToriiGate",
      endpoint: visionUrl,
      http_status: response.status,
      requested_model: model,
      response_model: String(data?.model || model),
      raw,
      observation,
      error: templateResponse ? "vision_template_response" : undefined,
    };
    if (templateResponse) await traceVision(requestId, "toriigate_invalid_response", result, { force: true });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("remote vision request timed out");
    throw error;
  } finally {
    request.close();
  }
}

async function postVisualComparison({ baseUrl, model, body, signal, timeoutMs = 45_000 }) {
  const request = abortable(signal, timeoutMs);
  try {
    const endpoint = `${baseUrl}/v1/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, cache_prompt: false, ...body }),
      signal: request.signal,
    });
    const rawBody = await response.text();
    let data = {};
    try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {}
    if (!response.ok) throw new Error(String(data?.error?.message || data?.error || rawBody || `HTTP ${response.status}`));
    return {
      endpoint,
      http_status: response.status,
      response_model: String(data?.model || model),
      raw: String(data?.choices?.[0]?.message?.content || "").trim(),
      usage: data?.usage,
    };
  } finally {
    request.close();
  }
}

function isComparisonTimeout(error) {
  return error?.name === "AbortError" || /(?:timed out|aborted)/iu.test(String(error?.message || error));
}

export async function compareWithOfficialAtlases(image, mimeType, signal, requestId, options = {}) {
  const source = "official-reference visual comparison";
  try {
    const discovery = abortable(signal, 10_000);
    let target;
    try {
      target = await resolveVisionTarget(discovery.signal, requestId);
    } finally {
      discovery.close();
    }
    const { model, baseUrl } = target;
    const atlasRuns = [];
    const confirmations = [];
    const matches = [];
    const atlases = characterAtlases();
    const comparisonDeadline = Date.now() + VISUAL_COMPARISON_BUDGET_MS;

    const compareAtlas = async (atlas) => {
      const cells = atlasCells(atlas);
      const atlasImage = await readFile(atlas.path);
      await traceVision(requestId, "visual_reference_atlas_request", {
        atlas_id: atlas.id,
        endpoint: `${baseUrl}/v1/chat/completions`,
        model,
        target_sha256: createHash("sha256").update(image).digest("hex"),
        atlas_sha256: createHash("sha256").update(atlasImage).digest("hex"),
        neutral_cells: cells,
        cache_prompt: false,
      }, { force: true });
      try {
        const remainingMs = comparisonDeadline - Date.now();
        if (remainingMs <= 0) {
          const run = { atlas_id: atlas.id, status: "skipped", matches: [], error: "comparison_budget_exhausted" };
          atlasRuns.push(run);
          return run;
        }
        const response = await postVisualComparison({
          baseUrl,
          model,
          signal,
          timeoutMs: Math.min(VISUAL_COMPARISON_REQUEST_TIMEOUT_MS, remainingMs),
          body: {
            max_tokens: 64,
            response_format: atlasResponseFormat(cells.map((item) => item.cell)),
            messages: [
              { role: "system", content: "Visual reference-cell comparison only. Return JSON." },
              { role: "user", content: atlasUserContent(image, mimeType, atlasImage) },
            ],
          },
        });
        const run = { atlas_id: atlas.id, ...response, matches: parseAtlasMatches(response.raw, cells) };
        atlasRuns.push(run);
        await traceVision(requestId, "visual_reference_atlas_response", run, { force: true });
        return run;
      } catch (error) {
        const run = {
          atlas_id: atlas.id,
          status: "unavailable",
          matches: [],
          error: String(error?.message || error),
          timed_out: isComparisonTimeout(error),
        };
        atlasRuns.push(run);
        await traceVision(requestId, "visual_reference_atlas_response", run, { force: true });
        return run;
      }
    };

    const faceRuns = [];
    for (const atlas of atlases.filter((item) => item.id.endsWith("-face"))) {
      const run = await compareAtlas(atlas);
      faceRuns.push(run);
      if (run.timed_out) break;
      if ((run.matches || []).some((item) => item.confidence >= 0.8)) break;
    }
    const faceCandidates = faceRuns.flatMap((run) => (run.matches || []).map((item) => ({ ...item, atlas_id: run.atlas_id })));
    const rankedFaceCandidates = faceCandidates.sort((left, right) => right.confidence - left.confidence);
    const firstCandidate = rankedFaceCandidates[0];
    const conflictingCandidate = rankedFaceCandidates.find((item) => item.id !== firstCandidate?.id);
    const candidate = conflictingCandidate && firstCandidate.confidence - conflictingCandidate.confidence < 0.1
      ? null
      : firstCandidate;
    if (candidate && candidate.confidence >= 0.8) {
      const confirmationAtlas = atlases.find((atlas) => atlas.id === candidate.atlas_id.replace(/-face$/, ""));
      if (confirmationAtlas) {
        const confirmationRun = await compareAtlas(confirmationAtlas);
        const confirmation = (confirmationRun.matches || []).find((item) => item.id === candidate.id);
        const record = {
          candidate_id: candidate.id,
          candidate_atlas: candidate.atlas_id,
          confirmation_atlas: confirmationAtlas.id,
          candidate,
          confirmation: confirmation || null,
          accepted: Boolean(confirmation && confirmation.confidence >= 0.8),
        };
        confirmations.push(record);
        await traceVision(requestId, "visual_reference_cross_atlas_confirmation", record, { force: true });
        if (record.accepted) {
          matches.push({
            id: candidate.id,
            confidence_score: 0.92,
            evidence: "neutral_face_and_body_atlas_agree",
            position: candidate.target_position,
            atlas_id: candidate.atlas_id,
            atlas_confidence: candidate.confidence,
            confirmation_confidence: confirmation.confidence,
            atlas_evidence: candidate.evidence,
            confirmation_evidence: confirmation.evidence,
          });
        }
      }
    }

    const result = {
      status: "ok",
      source,
      model,
      target_sha256: createHash("sha256").update(image).digest("hex"),
      cache_prompt: false,
      comparison_budget_ms: VISUAL_COMPARISON_BUDGET_MS,
      atlas_runs: atlasRuns,
      confirmations,
      matches,
    };
    await traceVision(requestId, "visual_reference_comparison", result, { force: true });
    return result;
  } catch (error) {
    const result = { status: "unavailable", source, matches: [], error: String(error?.message || error) };
    await traceVision(requestId, "visual_reference_comparison", result, { force: true });
    return result;
  }
}

function assertInboundImage(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved.startsWith(`${INBOUND_DIR}${path.sep}`)) throw new Error("image attachment path is unavailable");
  return resolved;
}

export async function loadInboundImage(imagePath) {
  const resolvedPath = assertInboundImage(imagePath);
  const mimeType = imageMime(resolvedPath);
  return {
    image: await readFile(resolvedPath),
    mimeType,
    source: resolvedPath,
    media: {
      resolution: "openclaw_inbound_file",
      local_path: resolvedPath,
      filename: path.basename(resolvedPath),
      content_type: mimeType,
      url: "",
      proxy_url: "",
    },
  };
}

function requireSnowflake(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{17,20}$/.test(text)) throw new Error(`${label} is unavailable`);
  return text;
}

async function discordBotToken() {
  const config = JSON.parse(await readFile(OPENCLAW_CONFIG, "utf8"));
  const token = String(config?.channels?.discord?.token || "").trim();
  if (!token) throw new Error("Discord attachment access is unavailable");
  return token;
}

export async function loadRepliedDiscordImage(channelId, messageId, signal, requestId) {
  const channel = requireSnowflake(channelId, "channel");
  const message = requireSnowflake(messageId, "reply message");
  const token = await discordBotToken();
  const request = abortable(signal, VISION_TIMEOUT_MS);
  try {
    const messageUrl = `https://discord.com/api/v10/channels/${channel}/messages/${message}`;
    const messageResponse = await fetch(messageUrl, {
      headers: { Authorization: `Bot ${token}` },
      signal: request.signal,
    });
    const payload = await messageResponse.json().catch(() => null);
    await traceVision(requestId, "discord_referenced_message", {
      endpoint: messageUrl,
      http_status: messageResponse.status,
      channel_id: channel,
      referenced_message_id: message,
      attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
    }, { force: !messageResponse.ok });
    if (!messageResponse.ok) throw new Error(`referenced Discord image could not be read (HTTP ${messageResponse.status})`);
    const attachment = (payload?.attachments || []).find((item) => /^image\//i.test(String(item?.content_type || "")) || /\.(png|jpe?g|webp|gif)$/i.test(String(item?.filename || "")));
    if (!attachment?.url) throw new Error("referenced message has no image attachment");
    const imageResponse = await fetch(attachment.url, { signal: request.signal });
    if (!imageResponse.ok) throw new Error(`referenced image download failed (HTTP ${imageResponse.status})`);
    const image = Buffer.from(await imageResponse.arrayBuffer());
    const mimeType = String(attachment.content_type || imageResponse.headers.get("content-type") || "image/png").split(";")[0];
    const media = {
      resolution: "discord_referenced_attachment",
      channel_id: channel,
      referenced_message_id: message,
      attachment_id: String(attachment.id || ""),
      filename: String(attachment.filename || ""),
      content_type: mimeType,
      url: String(attachment.url || ""),
      proxy_url: String(attachment.proxy_url || ""),
      width: attachment.width,
      height: attachment.height,
      download_http_status: imageResponse.status,
      image_bytes: image.length,
    };
    await traceVision(requestId, "media_resolution", media, { force: true });
    return {
      image,
      mimeType,
      source: attachment.url,
      media,
    };
  } catch (error) {
    await traceVision(requestId, "media_resolution_error", {
      channel_id: channel,
      referenced_message_id: message,
      error: String(error?.message || error),
    }, { force: true });
    throw error;
  } finally {
    request.close();
  }
}

export const __test = {
  atlasResponseFormat,
  atlasUserContent,
  confirmationResponseFormat,
  confirmationUserContent,
  observationLooksTemplate,
  parseAtlasMatches,
  parseConfirmation,
  parseObservation,
  rawVisibleText,
  isComparisonTimeout,
  visionBaseUrls,
  visionResponseFormat,
  visionUserContent,
};

import { buildImageEvidenceContext } from "./guidance.js";
import { buildMediaEvidenceContext } from "./media.js";

function sourcePrompt(pending, kind, question) {
  return [
    `"chat_id": "channel:${pending.channelId}"`,
    `"reply_to_id": "${pending.sourceMessageId}"`,
    '"has_reply_context": true',
    `<media:${kind}>`,
    question,
  ].join("\n");
}

function shortDescription(summary, visibleText = []) {
  const clean = String(summary || "").replace(/\s+/g, " ").trim();
  const text = [...new Set((visibleText || [])
    .map((item) => String(item || "").trim())
    .filter((item) => item && !/^(?:frame|grid)_\d+\.(?:jpe?g|png|webp)$/i.test(item)))];
  if (!clean) return "重新看過了。畫面還是看不清楚。";
  return text.length ? `${clean}\n看得到的文字：${text.join("、")}` : clean;
}

function identityReply(primary, impression, description) {
  if (!primary || !["high", "medium"].includes(primary.confidence)) {
    return `重新看過了，還是不知道是誰。\n${description}`;
  }
  const name = String(primary.canonicalName || "").trim();
  if (primary.canonicalId === "rana") return "是我。";
  const level = impression?.recognitionLevel || "unknown";
  if (level === "seen_not_close") return `${name}。見過，但不熟。`;
  if (level === "unknown") return `${name}。不熟。`;
  const anchor = String(impression?.memoryAnchors?.[0] || "").trim();
  return anchor ? `${name}。${anchor}` : `${name}。`;
}

export async function runVisionFeedbackAction(pending, action, options = {}) {
  if (!pending?.channelId || !pending?.sourceMessageId) {
    throw new Error("feedback source image is unavailable");
  }
  const buildImage = options.buildImage || buildImageEvidenceContext;
  const buildMedia = options.buildMedia || buildMediaEvidenceContext;
  const question = action === "describe"
    ? "只描述畫面中直接可見的內容，不要猜人物姓名。"
    : "重新辨識這張圖裡的人是誰。";

  let image = null;
  try {
    image = await buildImage(sourcePrompt(pending, "image", question), {
      requestId: `${pending.requestId}-${action}`,
    });
  } catch (error) {
    if (!/no image attachment/i.test(String(error?.message || error))) throw error;
  }

  if (image) {
    const payload = image.payload;
    const description = shortDescription(
      payload?.imageUnderstanding?.summary,
      payload?.imageUnderstanding?.visibleText,
    );
    return action === "describe"
      ? description
      : identityReply(
        payload?.imageUnderstanding?.primaryCharacter,
        payload?.ranaCharacterImpression,
        description,
      );
  }

  const media = await buildMedia(sourcePrompt(pending, "video", question), {
    requestId: `${pending.requestId}-${action}`,
    resolveIdentity: action === "retry",
  });
  if (!media || media.payload?.kind !== "video") {
    throw new Error("feedback source image or video is unavailable");
  }
  const observation = media.payload.visualObservations?.[0]?.observation || null;
  const description = shortDescription(observation?.summary, observation?.visible_text);
  return action === "describe"
    ? description
    : identityReply(
      media.payload.characterIdentity?.primaryCharacter,
      media.payload.characterIdentity?.impression,
      description,
    );
}

export const __test = {
  identityReply,
  shortDescription,
  sourcePrompt,
};

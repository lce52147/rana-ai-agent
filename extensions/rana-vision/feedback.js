import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discordBotToken } from "./client.js";

const FEEDBACK_ROOT = path.resolve(process.env.RANA_VISION_FEEDBACK_DIR || "C:\\tmp\\rana-vision-feedback");
const PENDING_DIR = path.join(FEEDBACK_ROOT, "pending");

function snowflake(value) {
  const text = String(value || "").trim();
  return /^\d{17,20}$/.test(text) ? text : "";
}

function requestId(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9-]{8,64}$/.test(text) ? text : "";
}

export function discordPromptMetadata(prompt) {
  const text = String(prompt || "");
  const channelFromChat = text.match(/"chat_id"\s*:\s*"channel:(\d{17,20})"/i)?.[1] || "";
  return {
    channelId: snowflake(channelFromChat || text.match(/"channel_id"\s*:\s*"(\d{17,20})"/i)?.[1]),
    sourceMessageId: snowflake(text.match(/"message_id"\s*:\s*"(\d{17,20})"/i)?.[1]),
    requesterId: snowflake(text.match(/"sender_id"\s*:\s*"(\d{17,20})"/i)?.[1]),
  };
}

export function visionFeedbackComponents(runId, requesterId) {
  const cleanRunId = requestId(runId);
  const cleanRequester = snowflake(requesterId);
  if (!cleanRunId || !cleanRequester) return [];
  return [{
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "認對了",
        custom_id: `vf|ok|${cleanRunId}|${cleanRequester}`,
      },
      {
        type: 2,
        style: 4,
        label: "認錯了",
        custom_id: `vf|wrong|${cleanRunId}|${cleanRequester}`,
      },
    ],
  }];
}

export async function attachVisionFeedbackPanel(options = {}) {
  const channelId = snowflake(options.channelId);
  const responseMessageId = snowflake(options.responseMessageId);
  const requesterId = snowflake(options.requesterId);
  const runId = requestId(options.requestId);
  const components = visionFeedbackComponents(runId, requesterId);
  if (!channelId || !responseMessageId || !runId || components.length === 0) {
    return { status: "skipped", reason: "feedback_coordinates_incomplete" };
  }

  const primary = options.payload?.imageUnderstanding?.primaryCharacter || null;
  const pending = {
    schema: "rana.vision.feedback.pending.v1",
    requestId: runId,
    createdAt: new Date().toISOString(),
    requesterId,
    channelId,
    sourceMessageId: snowflake(options.sourceMessageId),
    responseMessageId,
    userQuestion: String(options.userQuestion || "").slice(0, 500),
    analysisStatus: String(options.payload?.imageUnderstanding?.analysisStatus || "unknown"),
    finalIdentity: primary ? {
      canonicalId: String(primary.canonicalId || ""),
      canonicalName: String(primary.canonicalName || ""),
      confidence: String(primary.confidence || "unknown"),
      confidenceScore: Number(primary.confidenceScore || 0),
    } : null,
  };

  await mkdir(PENDING_DIR, { recursive: true });
  await writeFile(path.join(PENDING_DIR, `${runId}.json`), `${JSON.stringify(pending, null, 2)}\n`, "utf8");

  const token = await discordBotToken();
  const endpoint = `https://discord.com/api/v10/channels/${channelId}/messages/${responseMessageId}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ components }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Vision feedback component attach failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }
  return { status: "attached", channelId, responseMessageId, requestId: runId };
}

export const __test = {
  discordPromptMetadata,
  visionFeedbackComponents,
};

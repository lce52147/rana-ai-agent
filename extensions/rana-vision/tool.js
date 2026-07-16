import { loadInboundImage, loadRepliedDiscordImage } from "./client.js";
import { buildVisionEvidence } from "./evidence.js";
import { createVisionRequestId } from "./debug.js";

export function registerVisionTool(api) {
  api.registerTool({
    name: "rana_analyze_image",
    label: "Rana Analyze Image",
    description: "Analyze one Discord image through ToriiGate, OCR, reverse-image evidence, canonical identity resolution, and Rana impression lookup. The main model writes the response from the resolved result.",
    parameters: {
      type: "object",
      properties: {
        image_path: { type: "string" },
        channel_id: { type: "string" },
        reply_message_id: { type: "string" },
        prompt: { type: "string" },
      },
      required: [],
    },
    execute: async (_toolCallId, params, signal) => {
      const requestId = createVisionRequestId();
      try {
        const load = params?.image_path
          ? () => loadInboundImage(params.image_path)
          : (innerSignal) => loadRepliedDiscordImage(params?.channel_id, params?.reply_message_id, innerSignal);
        const result = await buildVisionEvidence(load, params?.prompt, signal, requestId);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", request_id: requestId, error: String(error?.message || error) }) }] };
      }
    },
  });
}

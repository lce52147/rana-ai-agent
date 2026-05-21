const DEFAULT_BASE_URL = "http://127.0.0.1:8081";

function resolveBaseUrl(api) {
  const fromConfig = api?.config?.baseUrl;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim().replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) {
    const detail = data?.error || text || `HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  return data ?? {};
}

const plugin = {
  id: "rana-music-tools",
  name: "Rana Music Tools",
  description: "Register Rana voice bridge tools",
  register(api) {
    const baseUrl = resolveBaseUrl(api);
    api.registerTool({
      name: "rana_play_music",
      label: "Rana Play Music",
      description: "Play audio in requester's Discord VC via local bridge.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          guild_id: { type: "string" },
          channel_id: { type: "string" },
          requester: { type: "string" },
          voice_token: { type: "string" },
          voice_endpoint: { type: "string" },
          voice_session: { type: "string" },
        },
        required: ["url", "guild_id", "channel_id"],
      },
      execute: async (_toolCallId, params, signal) => {
        const data = await postJson(`${baseUrl}/voice/play`, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    });

    api.registerTool({
      name: "rana_stop_music",
      label: "Rana Stop Music",
      description: "Stop playback and leave VC via local bridge.",
      parameters: {
        type: "object",
        properties: {
          guild_id: { type: "string" },
        },
        required: ["guild_id"],
      },
      execute: async (_toolCallId, params, signal) => {
        const data = await postJson(`${baseUrl}/voice/leave`, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    });
  },
};

export default plugin;

import {
  hasPlaybackEvidence,
  __test as musicToolTest,
  ranaError,
  ranaPlayPendingFromQueue,
  registerMusicTools,
} from "./tools/music.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8081";

function resolveBaseUrl(api) {
  const fromConfig = api?.config?.baseUrl;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim().replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

const plugin = {
  id: "rana-music-tools",
  name: "Rana Music Tools",
  description: "Register Rana voice bridge tools",
  register(api) {
    registerMusicTools(api, { baseUrl: resolveBaseUrl(api) });
  },
};

export const __test = {
  hasPlaybackEvidence,
  ...musicToolTest,
  ranaError,
  ranaPlayPendingFromQueue,
};

export default plugin;

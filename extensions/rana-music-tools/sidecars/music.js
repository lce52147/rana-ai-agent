import { firstText, hasBilibiliHint, isPlainKeyword, stripSourceHint } from "../../rana-runtime/tool_contracts.js";
import { getJson, postJson } from "../../rana-runtime/sidecars/http.js";

export const PLAY_API_URL = "http://127.0.0.1:8080/api/play";
export const VOICE_BASE_URL = "http://127.0.0.1:8081";
export const DEFAULT_GUILD_ID = "1486679037605842944";
const HTTP_TIMEOUT_MS = 12000;
const PLAY_HTTP_TIMEOUT_MS = 45000;
const PLAYLIST_HTTP_TIMEOUT_MS = 180000;

export function isRequestTimeoutError(err) {
  return /^request timeout \(\d+ms\):/.test(String(err?.message || err || ""));
}

export function looksLikePlaylistUrl(url) {
  return /(?:[?&]list=|\/playlist\?)/i.test(firstText(url));
}

export function playTimeoutMsFor(url) {
  return looksLikePlaylistUrl(url) ? PLAYLIST_HTTP_TIMEOUT_MS : PLAY_HTTP_TIMEOUT_MS;
}

export async function queueStateAfterSlowPlay() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return await getJson(`${VOICE_BASE_URL}/voice/queue?guild_id=${encodeURIComponent(DEFAULT_GUILD_ID)}`, undefined, HTTP_TIMEOUT_MS);
}

export async function resolveYouTubeKeyword(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    const html = await res.text();
    const ids = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map((match) => match[1]);
    const id = ids.find((value, index) => ids.indexOf(value) === index);
    if (!id) throw new Error("找不到歌。");
    return `https://www.youtube.com/watch?v=${id}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveBilibiliKeyword(query) {
  const clean = stripSourceHint(query);
  if (!clean) throw new Error("找不到歌。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Referer": "https://www.bilibili.com/",
    };
    const readSearch = async (apiUrl) => {
      const res = await fetch(apiUrl, { headers, signal: controller.signal });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {}
      return { res, data };
    };
    const pickVideo = (data) => {
      const flat = Array.isArray(data?.data?.result) ? data.data.result : [];
      const nested = flat.flatMap((entry) => Array.isArray(entry?.data) ? entry.data : []);
      return [...flat, ...nested].find((entry) => entry?.bvid || entry?.arcurl || entry?.id);
    };
    const urls = [
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(clean)}`,
      `https://api.bilibili.com/x/web-interface/search/all/v2?page=1&keyword=${encodeURIComponent(clean)}`,
    ];
    let blocked = false;
    for (const apiUrl of urls) {
      const { res, data } = await readSearch(apiUrl);
      if (!res.ok || data?.code === -412) {
        blocked = true;
        continue;
      }
      const item = pickVideo(data);
      if (item?.bvid) return `https://www.bilibili.com/video/${item.bvid}`;
      if (item?.arcurl && /^https?:\/\//i.test(item.arcurl)) return item.arcurl;
      if (item?.id) return `https://www.bilibili.com/video/av${item.id}`;
    }
    if (blocked) throw new Error("B站搜尋被擋。貼B站連結。");
    throw new Error("B站沒找到。貼連結。");
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePlayTarget(target, sourceText) {
  if (!isPlainKeyword(target)) return target;
  if (hasBilibiliHint(sourceText) || hasBilibiliHint(target)) return await resolveBilibiliKeyword(target);
  return await resolveYouTubeKeyword(target);
}

export async function postPlay(body, signal, timeoutMs) { return await postJson(PLAY_API_URL, body, signal, timeoutMs); }
export async function getQueue(guildId = DEFAULT_GUILD_ID, signal) { return await getJson(`${VOICE_BASE_URL}/voice/queue?guild_id=${encodeURIComponent(guildId)}`, signal); }
export async function postQueuePanel(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/queue-panel`, body, signal); }
export async function postSkip(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/skip`, body, signal); }
export async function postVolume(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/volume`, body, signal); }
export async function postStop(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/stop`, body, signal); }
export async function postJoin(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/join`, body, signal); }
export async function postLeave(body, signal) { return await postJson(`${VOICE_BASE_URL}/voice/leave`, body, signal); }

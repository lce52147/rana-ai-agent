const DEFAULT_BASE_URL = "http://127.0.0.1:8081";
const PLAY_API_URL = "http://127.0.0.1:8080/api/play";
const VOICE_BASE_URL = "http://127.0.0.1:8081";
const HOT_TOOLS_URL = "http://127.0.0.1:8091";
const DEFAULT_GUILD_ID = "1486679037605842944";
const DEFAULT_TEXT_CHANNEL_ID = "1495319712370917396";
const URL_RE = /https?:\/\/\S+/i;
const AUDIO_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com|bilibili\.com|b23\.tv|soundcloud\.com)\/\S+/i;
const PLAY_COMMAND_RE = /(?:^|\s)(?:@?rana\s*)?(?:(?:play|p)\s+|(?:播放|撥放|放歌|點歌|放|播)\s*)(.+)/i;
const QUEUE_RE = /(?:queue|清單|列表|歌單|還有哪些歌|有哪些歌|還有什麼歌|剩下(?:什麼|哪些|幾首)?歌|正在播(?:什麼)?|現在(?:播什麼|放什麼|還有哪些歌|還有什麼歌)|目前(?:播什麼|放什麼|還有哪些歌|還有什麼歌)|播放中)/i;
const NEXT_RE = /(?:下一首|下一個|next)/i;
const SKIP_RE = /^(?:@?rana\s+)?(?:跳過|skip|切歌)(?:\s*(?:這一首|這首|目前這首|current)|\s+(.+))?\s*$/i;
const JOIN_RE = /(?:進來|加入|過來|join|come in)(?:我|這個|這裡|這邊|這頻道|這個頻道|語音|voice|channel|\s)*/i;
const LEAVE_RE = /(?:離開|退出|出來|leave|disconnect|退語音|離開語音)/i;
const STOP_RE = /(?:停|停止|停歌|stop|安靜|別放了|不要放了)$/i;
const VOLUME_SET_RE = /(?:音量|volume|vol)\s*(?:調到|設成|設定|=|:|：)?\s*(\d{1,3})\s*%?/i;
const VOLUME_QUERY_RE = /(?:音量多少|目前音量|現在音量|volume\??|vol\??)$/i;
const VOLUME_DOWN_RE = /(?:小聲|太大聲|音量小|小聲一點|降低音量|volume down|vol down)/i;
const VOLUME_UP_RE = /(?:大聲|太小聲|音量大|大聲一點|提高音量|volume up|vol up)/i;
const VOLUME_MUTE_RE = /(?:靜音|mute)/i;

function firstText(value) {
  return typeof value === "string" ? value : "";
}

function compactText(value) {
  return firstText(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function routeLog(kind, text, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`[rana-music-tools] route=${kind}${suffix} text="${compactText(text)}"`);
}

function isRanaMention(text) {
  return /(?:^|\s)@?rana\b/i.test(text) || /樂奈/.test(text);
}

function stripRanaMention(text) {
  return firstText(text).replace(/<@!?\d+>/g, "").replace(/(?:^|\s)@?rana\b/ig, " ").replace(/樂奈/g, " ").replace(/\s+/g, " ").trim();
}

function isMusicSourceUrl(url) {
  return AUDIO_URL_RE.test(firstText(url));
}

function ranaFallback(text) {
  if (/(洗碗|洗盤|洗杯|打掃|掃地|拖地|倒垃圾)/.test(text)) return "不要。";
  if (/(幫我|拜託|求你|可以|能不能|可不可以)/.test(text)) return "不行。";
  if (/(早安|午安|晚安|嗨|你好|哈囉|hello|hi)/i.test(text)) return "嗯。";
  return "無聊。";
}

async function hotFallback(event, ctx, signal) {
  const res = await postJson(`${HOT_TOOLS_URL}/decide`, {
    body: firstText(event?.body),
    content: firstText(event?.content),
    senderId: firstText(event?.senderId) || firstText(ctx?.senderId),
    isGroup: Boolean(event?.isGroup),
  }, signal);
  return firstText(res?.reply) || null;
}

function parsePlayRequest(event) {
  const body = firstText(event?.body);
  const content = firstText(event?.content);
  const candidates = [body, content].filter(Boolean);

  for (const text of candidates) {
    const command = text.match(PLAY_COMMAND_RE);
    if (!command) {
      if (!isRanaMention(text)) continue;
      const bareUrl = text.match(AUDIO_URL_RE)?.[0]?.replace(/[>\])"'.,]+$/g, "");
      if (bareUrl) return { url: bareUrl, query: null, display: bareUrl };
      continue;
    }

    const target = command[1].trim().replace(/[>\])"'.,]+$/g, "");
    if (!target) continue;

    const url = target.match(URL_RE)?.[0]?.replace(/[>\])"'.,]+$/g, "");
    if (url && isMusicSourceUrl(url)) return { url, query: null, display: url };

    const query = target.replace(/^["'「『“”]+|["'」』“”]+$/g, "").trim();
    if (query) return { url: null, query, display: query };
  }

  return null;
}

function parseControlRequest(event) {
  const body = firstText(event?.body);
  const content = firstText(event?.content);
  const text = [body, content].filter(Boolean).join("\n");
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const clean = stripRanaMention(text);

  if (JOIN_RE.test(text)) return { kind: "join" };

  const volumeSet = text.match(VOLUME_SET_RE);
  if (volumeSet) return { kind: "volume", volume: Number(volumeSet[1]) };
  if (VOLUME_QUERY_RE.test(text)) return { kind: "volume_query" };
  if (VOLUME_MUTE_RE.test(text)) return { kind: "volume", volume: 0 };
  if (VOLUME_DOWN_RE.test(text)) return { kind: "volume", delta: -10 };
  if (VOLUME_UP_RE.test(text)) return { kind: "volume", delta: 10 };

  const skip = lines.map((line) => line.match(SKIP_RE)).find(Boolean);
  if (skip) {
    const rawQuery = firstText(skip[1]).trim();
    return { kind: "skip", query: rawQuery || null };
  }
  if (LEAVE_RE.test(text)) return { kind: "leave" };
  if (STOP_RE.test(text)) return { kind: "stop" };
  if (NEXT_RE.test(clean)) return { kind: "next" };
  if (QUEUE_RE.test(clean)) return { kind: "queue" };
  return null;
}

function ranaOk(title) {
  return `嗯。${title}。彈了。`;
}

function ranaPlaylistOk(count) {
  return `嗯。${count}首。彈了。`;
}

function ranaQueuedOk(title, queuedCount) {
  const count = Number(queuedCount || 0);
  if (count <= 1) return `嗯。${title}。排了。下一首。`;
  return `嗯。${title}。排了。隊列${count}首。`;
}

function ranaPlaylistQueuedOk(playlistCount, queuedCount) {
  const total = Number(playlistCount || 0);
  const queued = Number(queuedCount || 0);
  return `嗯。${total}首。排了。隊列${queued}首。`;
}

function ranaError(message) {
  return `不行。${message || "這個放不了。"}`;
}

function formatQueue(data) {
  const current = data?.current?.title ? `現在。${data.current.title}。` : "現在。沒有。";
  const queue = Array.isArray(data?.queue) ? data.queue : [];
  if (queue.length === 0) return `${current}後面沒了。`;
  const shown = queue.slice(0, 5).map((item) => `${item.index}. ${item.title}`).join(" / ");
  const more = queue.length > 5 ? ` / 還有${queue.length - 5}首。` : "";
  return `${current}後面。${shown}${more}`;
}

function formatNext(data) {
  return data?.next?.title ? `下一首。${data.next.title}。` : "後面沒了。";
}

function formatVolume(data) {
  const volume = Number(data?.volume ?? 35);
  if (volume === 0) return "嗯。安靜了。";
  return `嗯。音量${volume}。`;
}

function resolveBaseUrl(api) {
  const fromConfig = api?.config?.baseUrl;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim().replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

function resolveTextChannelId(event, ctx) {
  const candidates = [
    event?.textChannelId,
    event?.channelId,
    event?.channel_id,
    event?.discord?.channelId,
    event?.channel?.id,
    event?.metadata?.channelId,
    event?.to,
    event?.sessionKey,
    ctx?.textChannelId,
    ctx?.channelId,
    ctx?.to,
    ctx?.sessionKey,
  ];
  for (const value of candidates) {
    const text = firstText(value);
    if (/^\d{17,20}$/.test(text)) return text;
    const match = text.match(/(?:channel:|channel\/|channels\/)(\d{17,20})/i);
    if (match) return match[1];
  }
  return DEFAULT_TEXT_CHANNEL_ID;
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

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
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

async function resolveYouTubeKeyword(query) {
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
          channel_id: { type: "string", description: "Optional Discord voice channel id. Do not use the text chat channel id here." },
          requester_id: { type: "string", description: "Discord user id of the requester. Prefer sender_id from Discord metadata; the bridge uses this to join the user's current voice channel." },
          requester: { type: "string" },
          voice_token: { type: "string" },
          voice_endpoint: { type: "string" },
          voice_session: { type: "string" },
        },
        required: ["url", "guild_id", "requester_id"],
      },
      execute: async (_toolCallId, params, signal) => {
        const data = await postJson(PLAY_API_URL, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    });

    api.registerTool({
      name: "rana_stop_music",
      label: "Rana Stop Music",
      description: "Stop playback but keep Rana in the current Discord voice channel.",
      parameters: {
        type: "object",
        properties: {
          guild_id: { type: "string" },
        },
        required: ["guild_id"],
      },
      execute: async (_toolCallId, params, signal) => {
        const data = await postJson(`${baseUrl}/voice/stop`, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    });

    api.on("before_dispatch", async (event, ctx) => {
      const routeText = firstText(event?.body) || firstText(event?.content);
      const control = parseControlRequest(event);
      if (control) {
        routeLog(control.kind, routeText, control.query ? `query="${compactText(control.query)}"` : "");
        try {
          if (control.kind === "queue") {
            const textChannelId = resolveTextChannelId(event, ctx);
            await postJson(`${VOICE_BASE_URL}/voice/queue-panel`, {
              guild_id: DEFAULT_GUILD_ID,
              text_channel_id: textChannelId,
            });
            return { handled: true, text: "嗯。歌單。" };
          }
          if (control.kind === "next") {
            const data = await getJson(`${VOICE_BASE_URL}/voice/queue?guild_id=${encodeURIComponent(DEFAULT_GUILD_ID)}`);
            return { handled: true, text: formatNext(data) };
          }
          if (control.kind === "skip") {
            const data = await postJson(`${VOICE_BASE_URL}/voice/skip`, {
              guild_id: DEFAULT_GUILD_ID,
              query: control.query,
            });
            if (data.status === "removed") {
              return { handled: true, text: `嗯。${data.removed?.title || "那首"}。拿掉了。` };
            }
            if (data.status === "skipped") {
              const next = data.current?.title ? `下一首。${data.current.title}。` : "後面沒了。";
              return { handled: true, text: `跳過了。${next}` };
            }
            return { handled: true, text: "沒有歌。無聊。" };
          }
          if (control.kind === "volume") {
            const data = await postJson(`${VOICE_BASE_URL}/voice/volume`, {
              guild_id: DEFAULT_GUILD_ID,
              volume: control.volume,
              delta: control.delta,
            });
            return { handled: true, text: formatVolume(data) };
          }
          if (control.kind === "volume_query") {
            const data = await getJson(`${VOICE_BASE_URL}/voice/queue?guild_id=${encodeURIComponent(DEFAULT_GUILD_ID)}`);
            return { handled: true, text: formatVolume(data) };
          }
          if (control.kind === "stop") {
            const data = await postJson(`${VOICE_BASE_URL}/voice/stop`, { guild_id: DEFAULT_GUILD_ID });
            return { handled: true, text: data.stay ? "停了。還在。" : "停了。" };
          }
          if (control.kind === "join") {
            const requesterId = firstText(event?.senderId) || firstText(ctx?.senderId);
            if (!requesterId) return { handled: true, text: "找不到你。不能進去。" };
            await postJson(`${VOICE_BASE_URL}/voice/join`, {
              guild_id: DEFAULT_GUILD_ID,
              requester_id: requesterId,
            });
            return { handled: true, text: "嗯。進來了。" };
          }
          if (control.kind === "leave") {
            await postJson(`${VOICE_BASE_URL}/voice/leave`, { guild_id: DEFAULT_GUILD_ID });
            return { handled: true, text: "走了。" };
          }
        } catch (err) {
          return { handled: true, text: ranaError(err?.message || String(err)) };
        }
      }

      const parsed = parsePlayRequest(event);
      if (!parsed) {
        if (isRanaMention(routeText)) {
          routeLog("fallback", routeText);
          try {
            const hotReply = await hotFallback(event, ctx);
            if (hotReply) return { handled: true, text: hotReply };
          } catch (err) {
            console.warn(`[rana-music-tools] hot fallback unavailable: ${err?.message || String(err)}`);
          }
          return { handled: true, text: ranaFallback(routeText) };
        }
        return;
      }
      routeLog("play", firstText(event?.body) || firstText(event?.content), parsed.query ? `query="${compactText(parsed.query)}"` : `url="${compactText(parsed.url)}"`);

      const requesterId = firstText(event?.senderId) || firstText(ctx?.senderId);
      if (!requesterId) {
        return {
          handled: true,
          text: "找不到你。不能進去。",
        };
      }

      try {
        const playUrl = parsed.url || await resolveYouTubeKeyword(parsed.query);
        const data = await postJson(PLAY_API_URL, {
          url: playUrl,
          guild_id: DEFAULT_GUILD_ID,
          requester_id: requesterId,
          requester: requesterId,
        });
        const title = firstText(data?.title) || parsed.display;
        const playlistCount = Number(data?.playlist_count || 0);
        const queuedCount = Number(data?.queued_count || 0);
        const wasQueuedBehindCurrent = playlistCount > 1 ? queuedCount >= playlistCount : queuedCount > 0;
        return {
          handled: true,
          text: playlistCount > 1
            ? (wasQueuedBehindCurrent ? ranaPlaylistQueuedOk(playlistCount, queuedCount) : ranaPlaylistOk(playlistCount))
            : (wasQueuedBehindCurrent ? ranaQueuedOk(title, queuedCount) : ranaOk(title)),
        };
      } catch (err) {
        return {
          handled: true,
          text: ranaError(err?.message || String(err)),
        };
      }
    }, { priority: 1000 });
  },
};

export default plugin;

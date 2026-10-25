import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real-world MyGO!!!!! schedule (scripts/fetch_current_events.mjs). Only
// events a person confirmed are shown to the characters; this is the one
// source they may use for "what is the band up to these days".
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(MODULE_DIR, "..", "..", "..", "workspace", "LORE", "current_events.json");
const PAST_WINDOW_DAYS = 14;
const FUTURE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
let cache = { mtimeMs: -1, events: [] };

export const RECENT_OR_CURRENT_QUERY_RE = /(?:最近|目前|現在|现在|今天|剛剛|刚刚|這幾天|这几天|這陣子|这阵子|這週|这周|這禮拜|近況|近况|最近在忙|在忙什麼|在忙什么)/u;

function loadConfirmedEvents(dataPath = DATA_PATH) {
  let stat;
  try {
    stat = fs.statSync(dataPath);
  } catch {
    return [];
  }
  if (cache.mtimeMs !== stat.mtimeMs || cache.path !== dataPath) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, "utf8").replace(/^﻿/u, ""));
      cache = {
        path: dataPath,
        mtimeMs: stat.mtimeMs,
        events: (Array.isArray(data?.events) ? data.events : []).filter((event) => event?.status === "confirmed"),
      };
    } catch {
      cache = { path: dataPath, mtimeMs: stat.mtimeMs, events: [] };
    }
  }
  return cache.events;
}

function dayStart(value) {
  const date = new Date(`${value}T00:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function timing(event, now) {
  const start = dayStart(event.start);
  const end = dayStart(event.end || event.start);
  if (start === null || end === null) return null;
  const endOfLastDay = end + DAY_MS;
  if (now >= endOfLastDay) {
    const daysAgo = Math.floor((now - endOfLastDay) / DAY_MS);
    return daysAgo <= PAST_WINDOW_DAYS ? `已經結束（約 ${daysAgo + 1} 天前）` : null;
  }
  if (now >= start) return "正在舉行";
  const daysAhead = Math.ceil((start - now) / DAY_MS);
  return daysAhead <= FUTURE_WINDOW_DAYS ? `還有 ${daysAhead} 天` : null;
}

export function activeCurrentEvents({ now = Date.now(), dataPath } = {}) {
  return loadConfirmedEvents(dataPath)
    .map((event) => ({ event, when: timing(event, now) }))
    .filter((item) => item.when);
}

export function currentEventsContext({ now = Date.now(), dataPath } = {}) {
  const active = activeCurrentEvents({ now, dataPath });
  const lines = [];
  if (active.length) {
    lines.push("MyGO!!!!! 現況（現實中官方公布的行程）：");
    for (const { event, when } of active) {
      const days = event.end && event.end !== event.start ? `${event.start}～${event.end}` : event.start;
      lines.push(`- ${days}｜${event.title}${event.place ? `｜${event.place}` : ""}｜${when}`);
    }
    lines.push("被問到最近或現在的樂團狀況時，可以自然提起上面的行程，例如在準備、期待或剛辦完。只說這裡寫到的事，不要補排練內容、對話、地點細節或結果。");
  } else {
    // "No confirmed schedule" was read as "the band has no activities"
    // (LIVE5: 「目前沒有。」). Say nothing about the schedule instead.
    lines.push("樂團行程這裡沒有提供；不要說有或沒有活動，用這個角色平常的口吻概括近況，說一兩句就停。");
  }
  lines.push("沒寫到的近況，用這個角色平常的口吻概括，說一兩句就停；不要說出具體發生的活動、事件、地點、日期或結果。");
  return lines.join("\n");
}

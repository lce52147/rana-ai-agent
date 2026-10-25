#!/usr/bin/env node
// Follow MyGO!!!!!'s real-world schedule from the official event list.
//
//   node scripts/fetch_current_events.mjs            fetch; new events are added as "pending"
//   node scripts/fetch_current_events.mjs --list     show every event and its status
//   node scripts/fetch_current_events.mjs --approve <id|all-pending>
//   node scripts/fetch_current_events.mjs --reject <id>
//
// Only "confirmed" events reach the characters (extensions/rana-runtime/lore/current_events.js).
// A fetched event never goes live by itself: a person approves it first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = path.join(ROOT, "workspace", "LORE", "current_events.json");
const SOURCE_URL = "https://bang-dream.com/events";
const BAND = "MyGO!!!!!";

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { schema: "rana.current-events.v1", description: "", source: SOURCE_URL, fetchedAt: null, events: [] };
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8").replace(/^﻿/u, ""));
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function text(html) {
  return String(html || "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/&#0?39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

const pad = (value) => String(value).padStart(2, "0");

// 「2026年11月14日(土)・15日(日)」「2026年11月21日(土)」「2026年12月30日(火)～2027年1月5日(月)」
export function parseJapaneseDates(value) {
  const source = String(value || "");
  const full = [...source.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/gu)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!full.length) return null;
  const [y, m, d] = full[0];
  let end = full.length > 1 ? full[full.length - 1] : [y, m, d];
  if (full.length === 1) {
    const tail = source.slice(source.indexOf(`${d}日`) + `${d}日`.length);
    const monthDay = [...tail.matchAll(/(?:(\d{1,2})月)?(\d{1,2})日/gu)].at(-1);
    if (monthDay) end = [y, monthDay[1] ? Number(monthDay[1]) : m, Number(monthDay[2])];
  }
  return { start: `${y}-${pad(m)}-${pad(d)}`, end: `${end[0]}-${pad(end[1])}-${pad(end[2])}` };
}

export function parseEventList(html) {
  const items = [];
  for (const article of String(html || "").split(/<article class="p-live-event-list__item">/u).slice(1)) {
    const href = article.match(/href="([^"]+)"/u)?.[1] || "";
    const title = text(article.match(/p-live-event-list__item-title">([\s\S]*?)<\/div>/u)?.[1]);
    const category = text(article.match(/p-live-event-list__item-category">([\s\S]*?)<\/div>/u)?.[1]);
    const dateText = text(article.match(/item-date">[\s\S]*?<\/h2>\s*<p>([\s\S]*?)<\/p>/u)?.[1]);
    const place = text(article.match(/item-place">[\s\S]*?<\/h2>\s*<p>([\s\S]*?)<\/p>/u)?.[1]);
    const artists = [...article.matchAll(/item-artist-item">([\s\S]*?)<\/span>/gu)].map((m) => text(m[1]));
    const dates = parseJapaneseDates(dateText);
    if (!href || !title || !dates) continue;
    const id = href.replace(/\/+$/u, "").split("/").at(-1);
    items.push({ id, title, category, dateText, ...dates, place, artists, url: href });
  }
  return items;
}

async function fetchEvents() {
  const response = await fetch(SOURCE_URL, { headers: { "user-agent": "Mozilla/5.0 (rana-runtime current-events)" } });
  if (!response.ok) throw new Error(`fetch ${SOURCE_URL} failed: HTTP ${response.status}`);
  const all = parseEventList(await response.text());
  if (!all.length) throw new Error("no events parsed; the page layout may have changed");
  return all.filter((item) => item.artists.includes(BAND));
}

async function main() {
  const args = process.argv.slice(2);
  const data = readData();
  if (args[0] === "--list") {
    for (const event of data.events) console.log(`${event.status.padEnd(9)} ${event.id}  ${event.start}~${event.end}  ${event.title}  @${event.place}`);
    return;
  }
  if (args[0] === "--approve" || args[0] === "--reject") {
    const target = args[1];
    const status = args[0] === "--approve" ? "confirmed" : "rejected";
    let changed = 0;
    for (const event of data.events) {
      if (target === "all-pending" ? event.status === "pending" : event.id === target) {
        event.status = status;
        event.reviewedAt = new Date().toISOString();
        changed += 1;
      }
    }
    writeData(data);
    console.log(`${status}: ${changed}`);
    return;
  }

  const fetched = await fetchEvents();
  const byId = new Map(data.events.map((event) => [event.id, event]));
  let added = 0;
  for (const item of fetched) {
    const existing = byId.get(item.id);
    if (existing) {
      // Keep the reviewer's decision; refresh the facts, and send changed facts back for review.
      const changed = ["title", "start", "end", "place"].some((key) => existing[key] !== item[key]);
      Object.assign(existing, item);
      if (changed && existing.status === "confirmed") existing.status = "pending";
    } else {
      data.events.push({ ...item, status: "pending", fetchedAt: new Date().toISOString() });
      added += 1;
    }
  }
  data.events.sort((a, b) => a.start.localeCompare(b.start));
  data.fetchedAt = new Date().toISOString();
  writeData(data);
  console.log(`MyGO!!!!! events on the official list: ${fetched.length}; new pending: ${added}`);
  for (const event of data.events.filter((item) => item.status === "pending")) {
    console.log(`pending  ${event.id}  ${event.start}~${event.end}  ${event.title}  @${event.place}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

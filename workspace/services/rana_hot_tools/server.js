const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const PORT = Number(process.env.RANA_HOT_TOOLS_PORT || 8091);
const ROOT = __dirname;
const RULES_PATH = path.join(ROOT, "rules.json");
const WORKSPACE_ROOT = path.resolve(ROOT, "..", "..");
const WORKSPACE_MEMORY_PATH = path.join(WORKSPACE_ROOT, "MEMORY.md");
const REMINDERS_PATH = path.join(ROOT, "reminders.json");
const MONITORS_PATH = path.join(ROOT, "monitors.json");
const DEFAULT_LEPRECHAUN_ROOT = "D:\\_Project\\Leprechaun";
const LEPRECHAUN_STRATEGY_VERSION = "cross-sectional-logit-v1";
const MAX_TELEMETRY_AGE_MS = Number(process.env.LEPRECHAUN_MAX_TELEMETRY_AGE_MS || 2 * 60 * 1000);
const LEPRECHAUN_TRIAL_MIN_EVALUATED = Number(process.env.LEPRECHAUN_TRIAL_MIN_EVALUATED || 30);
const LEPRECHAUN_TRIAL_BRIER_MAX = Number(process.env.LEPRECHAUN_TRIAL_BRIER_MAX || 0.30);
const LEPRECHAUN_MAX_TICKERS_PER_QUERY = Number(process.env.LEPRECHAUN_MAX_TICKERS_PER_QUERY || 5);
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.resolve(WORKSPACE_ROOT, "..", "openclaw.json");
const DEFAULT_DISCORD_GUILD_ID = process.env.RANA_DISCORD_GUILD_ID || "1486679037605842944";
const DISCORD_MEMBER_ROLE_CACHE_MS = Number(process.env.RANA_DISCORD_ROLE_CACHE_MS || 60 * 1000);
const cooldowns = new Map();
const discordRoleCache = new Map();
let cachedDiscordToken;
const execFileAsync = promisify(execFile);

function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    console.error(`[rana-hot-tools] failed to read ${path.basename(filePath)}: ${err.message}`);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (_) {
    return "";
  }
}

function normalizeMemoryText(text) {
  return textOf(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isSensitiveMemory(text) {
  return /(token|api[_-]?key|secret|password|discord token|bearer\s+[a-z0-9._-]+)/i.test(text);
}

function isCurrentSessionMemoryQuestion(text) {
  const clean = stripMention(text);
  if (!clean) return false;

  const hasCurrentScope =
    /(?:剛剛|剛才|前面|上一句|這次|這裡|這段|這串|目前|現在|本次|這個\s*session|current\s*session|this\s*chat)/i.test(clean);

  const hasCountOrRecentEvent =
    /(?:幾次|多少次|第幾次|講了|說了|提到|出現|剛說|剛講|前面說|前面講|發生什麼|做了什麼)/i.test(clean);

  return hasCurrentScope && hasCountOrRecentEvent;
}

function isTransientMemoryText(text) {
  const clean = stripMention(text);
  if (!clean) return true;

  return /(?:剛剛|剛才|這次|本次|目前這個|今天這個|debug|quota|額度|排程|scheduled task|music_pipeline_debug_summary|failing test|暫時|等一下再改|這輪|這個 session)/i.test(clean);
}

function appendWorkspaceMemory(text) {
  const clean = normalizeMemoryText(text);
  if (!clean || isSensitiveMemory(clean)) return false;
  let content = fs.existsSync(WORKSPACE_MEMORY_PATH) ? fs.readFileSync(WORKSPACE_MEMORY_PATH, "utf8") : "# MEMORY - 要樂奈的記憶\n";
  if (content.includes(clean)) return false;
  const section = "## 使用者記憶";
  const factsSection = "### 使用者事實";
  const bullet = `* ${clean}\n`;
  if (!content.includes(section)) {
    content = `${content.trimEnd()}\n\n${section}\n\n${factsSection}\n\n${bullet}`;
  } else if (!content.includes(factsSection)) {
    const marker = `${section}\n`;
    const index = content.indexOf(marker) + marker.length;
    content = `${content.slice(0, index)}\n${factsSection}\n\n${bullet}${content.slice(index)}`;
  } else {
    const marker = `${factsSection}\n`;
    const index = content.indexOf(marker) + marker.length;
    const needsBlank = content.slice(index, index + 1) !== "\n";
    content = `${content.slice(0, index)}${needsBlank ? "\n" : ""}${bullet}${content.slice(index)}`;
  }
  fs.writeFileSync(WORKSPACE_MEMORY_PATH, content, "utf8");
  return true;
}

function removeWorkspaceMemory(query) {
  const clean = normalizeMemoryText(query);
  if (!clean) return { removed: 0, items: [] };
  const content = fs.existsSync(WORKSPACE_MEMORY_PATH) ? fs.readFileSync(WORKSPACE_MEMORY_PATH, "utf8") : "";
  const lines = content.split(/\r?\n/);
  const removed = [];
  const kept = lines.filter((line, index) => {
    const item = parseMarkdownMemoryLine(line, WORKSPACE_MEMORY_PATH, index);
    if (!item || !memoryMatches(item.text, clean)) return true;
    removed.push(item);
    return false;
  });
  if (removed.length > 0) fs.writeFileSync(WORKSPACE_MEMORY_PATH, kept.join("\n"), "utf8");
  return { removed: removed.length, items: removed };
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function senderIdOf(payload) {
  return textOf(payload.senderId || payload.sender_id || payload.authorId || payload.userId || payload.requesterId || payload.requester_id);
}

function roleNamesOf(payload) {
  const raw = payload?.roles || payload?.roleNames || payload?.role_names || payload?.memberRoles || payload?.member_roles || [];
  const list = Array.isArray(raw) ? raw : textOf(raw).split(/[,\s，、|/]+/u);
  return list
    .map((item) => typeof item === "string" ? item : textOf(item?.name || item?.label || item?.id))
    .map((item) => item.trim())
    .filter(Boolean);
}

function findDiscordToken(value, pathParts = []) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (typeof child === "string" && key.toLowerCase() === "token" && nextPath.some((part) => /discord/i.test(part))) {
      return child;
    }
    if (child && typeof child === "object") {
      const found = findDiscordToken(child, nextPath);
      if (found) return found;
    }
  }
  return "";
}

function discordBotToken() {
  if (cachedDiscordToken !== undefined) return cachedDiscordToken;
  cachedDiscordToken = textOf(process.env.RANA_DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN);
  if (cachedDiscordToken) return cachedDiscordToken;
  const config = readJson(OPENCLAW_CONFIG_PATH, {});
  cachedDiscordToken = findDiscordToken(config);
  return cachedDiscordToken;
}

function discordGetJson(pathname) {
  const token = discordBotToken();
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "discord.com",
      path: `/api/v10${pathname}`,
      method: "GET",
      timeout: 3500,
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "rana-hot-tools/1.0",
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function discordMemberRoles(userId) {
  if (!userId || !DEFAULT_DISCORD_GUILD_ID) return [];
  const cacheKey = `${DEFAULT_DISCORD_GUILD_ID}:${userId}`;
  const cached = discordRoleCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DISCORD_MEMBER_ROLE_CACHE_MS) return cached.roles;
  const member = await discordGetJson(`/guilds/${DEFAULT_DISCORD_GUILD_ID}/members/${encodeURIComponent(userId)}`);
  const roles = Array.isArray(member?.roles) ? member.roles.map(String).filter(Boolean) : [];
  discordRoleCache.set(cacheKey, { ts: Date.now(), roles });
  return roles;
}

function isOwner(payload, rules) {
  const senderId = senderIdOf(payload);
  const ownerIds = Array.isArray(rules.security?.ownerIds) ? rules.security.ownerIds.map(String) : [];
  return Boolean(senderId && ownerIds.includes(senderId));
}

async function canWriteMemory(payload, rules) {
  return await hasRolePermission(payload, rules, "memoryWriteRoles");
}

async function canDeleteMemory(payload, rules) {
  return await hasRolePermission(payload, rules, "memoryDeleteRoles");
}

async function canUseTools(payload, rules) {
  return await hasAnyRolePermission(payload, rules, ["toolUseRoles", "residentRoles"]);
}

async function hasRolePermission(payload, rules, field) {
  return await hasAnyRolePermission(payload, rules, [field]);
}

async function hasAnyRolePermission(payload, rules, fields) {
  if (isOwner(payload, rules)) return true;
  const allowedRoles = fields.flatMap((field) => Array.isArray(rules.security?.[field])
    ? rules.security[field].map(String)
    : []);
  if (allowedRoles.length === 0) return false;
  const roles = roleNamesOf(payload);
  if (roles.some((role) => allowedRoles.includes(role))) return true;
  const fetchedRoles = await discordMemberRoles(senderIdOf(payload));
  return fetchedRoles.some((role) => allowedRoles.includes(role));
}

function isOwnerOnlyIntent(text) {
  const clean = stripMention(text);
  return isMemoryWriteIntent(clean)
    || isMemoryDeleteIntent(clean)
    || /(提醒|監控|盯著|編隊|小隊|squad|RAG|rag|LORE|lore|prompt|人格|規則|工具設定)/i.test(clean);
}

function ownerOnlyReply() {
  return { handled: true, kind: "security:not_owner", reply: "沒有權限。" };
}

function stripMention(text) {
  return textOf(text)
    .replace(/^\s*<@!?\d+>[:,，、\s]*/i, "")
    .replace(/^\s*@?rana\b[:,，、\s]*/i, "")
    .replace(/^\s*樂奈[:,，、\s]*/, "")
    .trim();
}

function stripQuestionTail(text) {
  return text.replace(/[嗎呢?？。.\s]+$/g, "").trim();
}

function normalizeRecallQuery(text) {
  return stripQuestionTail(textOf(text))
    .replace(/^(?:你|妳)?(?:還)?記得\s*/u, "")
    .replace(/(?:什麼|哪一個|哪個)/gu, "")
    .replace(/(?:這件事|這個|那些|嗎|嘛|呢)$/g, "")
    .trim();
}

function compactMemoryKey(text) {
  return normalizeMemoryText(text)
    .replace(/這個人|這個|那個|這件事|這件|那件/g, "")
    .replace(/[的了嗎嘛呢啊呀喔哦]/g, "")
    .replace(/[，,。.?？!！\s]/g, "")
    .trim();
}

const MEMORY_TERMS = [
  "紫貓",
  "斧王",
  "皓男哥",
  "峰月律",
  "珂朵莉",
  "阿彩",
  "168",
  "酒量",
  "酒量差",
  "容易醉",
  "喝酒",
  "喝一杯",
  "喝一下",
  "男娘",
  "帥哥",
  "早起",
  "不想起床",
  "蕎麥麵",
  "愛吃",
  "喜歡",
];

function memoryTerms(text) {
  const compact = compactMemoryKey(text);
  return MEMORY_TERMS.filter((term) => compact.includes(compactMemoryKey(term)));
}

function memoryMatches(itemText, query) {
  const haystack = normalizeMemoryText(itemText);
  const needle = normalizeMemoryText(query);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const compactHaystack = compactMemoryKey(haystack);
  const compactNeedle = compactMemoryKey(needle);
  if (!compactNeedle) return false;
  if (compactHaystack.includes(compactNeedle)) return true;
  const haystackTerms = memoryTerms(haystack);
  const needleTerms = memoryTerms(needle);
  if (needleTerms.length > 0) {
    const matched = needleTerms.filter((term) => haystackTerms.includes(term));
    const hasSubject = matched.some((term) => /^(?:紫貓|斧王|皓男哥|峰月律|珂朵莉|阿彩|168)$/.test(term));
    const hasPredicate = matched.some((term) => !/^(?:紫貓|斧王|皓男哥|峰月律|珂朵莉|阿彩|168)$/.test(term));
    if (hasSubject
      && /(?:[01]\s*(?:還是|or)\s*[01])|(?:是\s*[01]\s*(?:嗎|呢)?$)/iu.test(needle)
      && /(?:是|=)\s*[01]/u.test(haystack)) return true;
    if (matched.length >= 2) return true;
    if (hasSubject && /(?:是誰|是什麼|什麼人|哪個|哪位)/.test(needle)) return true;
    if (hasSubject && hasPredicate) return true;
    if (/(?:誰|哪個|哪位)/.test(needle) && hasPredicate) return true;
  }
  let cursor = 0;
  for (const char of compactNeedle) {
    cursor = compactHaystack.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += char.length;
  }
  return compactNeedle.length >= 3;
}

function parseMarkdownMemoryLine(line, filePath, index) {
  const match = textOf(line).match(/^\s*[-*]\s+(.+?)\s*$/);
  if (!match) return null;
  let text = match[1]
    .replace(/<!--.*?-->/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+(?:source=[^:]+:\s*)?/, "")
    .trim();
  if (!text || /^Runtime test memories\b/i.test(text)) return null;
  if (isSensitiveMemory(text)) return null;
  return {
    text,
    createdAt: null,
    source: path.relative(WORKSPACE_ROOT, filePath).replace(/\\/g, "/"),
    line: index + 1,
  };
}

function readMarkdownMemories() {
  const items = [];
  const lines = readTextFile(WORKSPACE_MEMORY_PATH).split(/\r?\n/);
  lines.forEach((line, index) => {
    const item = parseMarkdownMemoryLine(line, WORKSPACE_MEMORY_PATH, index);
    if (item) items.push(item);
  });
  return items;
}

function isMemoryWriteIntent(text) {
  const clean = stripMention(text);
  if (!clean) return false;
  return /^(?:現在)?(?:幫我)?(?:記下來|記起來|記住|記下)[\s，,。:：]*(?!嗎|嘛|呢|[?？]).+/.test(clean)
    || /^.+[\s，,。:：]+(?:記下來|記起來|記住|記下)$/.test(clean);
}

function isMemoryDeleteIntent(text) {
  const clean = stripMention(text);
  if (!clean) return false;
  return /^(?:幫我)?(?:忘記|刪掉|刪除|移除|不要記得)\s*(?!嗎|嘛|呢|[?？]).+/.test(clean)
    || /^.+[\s，,。:：]+(?:忘記|刪掉|刪除|移除)$/.test(clean);
}

function extractMemoryText(text) {
  const clean = stripMention(text);
  return clean
    .replace(/^(?:現在)?(?:幫我)?(?:記下來|記起來|記住|記下)[\s，,。:：]*/, "")
    .replace(/[\s，,。:：]*(?:記下來|記起來|記住|記下)$/g, "")
    .trim();
}

function extractMemoryDeleteText(text) {
  const clean = stripMention(text);
  return clean
    .replace(/^(?:幫我)?(?:忘記|刪掉|刪除|移除|不要記得)[\s，,。:：]*/, "")
    .replace(/[\s，,。:：]*(?:忘記|刪掉|刪除|移除)$/g, "")
    .trim();
}

function hasUrl(text) {
  return /https?:\/\/\S+/i.test(text);
}

function parseDelayMs(text) {
  const match = text.match(/(\d+)\s*(秒|分鐘|分|小時|時|天)/);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "秒") return value * 1000;
  if (unit === "分鐘" || unit === "分") return value * 60 * 1000;
  if (unit === "小時" || unit === "時") return value * 60 * 60 * 1000;
  if (unit === "天") return value * 24 * 60 * 60 * 1000;
  return null;
}

function formatDueAt(delayMs) {
  if (!delayMs) return null;
  return new Date(Date.now() + delayMs).toISOString();
}

function renderLocalTime(iso) {
  if (!iso) return "某時";
  return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

function extractReminderText(text) {
  return stripMention(text)
    .replace(/^\d+\s*(秒|分鐘|分|小時|時|天)\s*後\s*/, "")
    .replace(/^(提醒我|叫我|記得提醒我|提醒)\s*/, "")
    .trim() || "醒來。";
}

function handleReminder(text, rules) {
  if (!rules.reminders?.enabled) return null;
  const clean = stripMention(text);
  if (/(提醒清單|提醒列表|有哪些提醒|提醒還有)/.test(clean)) {
    const data = readJson(REMINDERS_PATH, { items: [] });
    const pending = (Array.isArray(data.items) ? data.items : []).filter((item) => !item.done);
    const items = pending.slice(0, 5).map((item) => `${renderLocalTime(item.dueAt)} ${item.text}`).join(" / ");
    return { handled: true, kind: "reminder_list", reply: items ? (rules.reminders.listReply || "提醒。{items}").replace("{items}", items) : "沒有。" };
  }
  if (!/(提醒|叫我)/.test(clean)) return null;
  const delayMs = parseDelayMs(text);
  const data = readJson(REMINDERS_PATH, { items: [] });
  data.items = Array.isArray(data.items) ? data.items : [];
  data.items.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text: extractReminderText(text),
    dueAt: formatDueAt(delayMs),
    createdAt: new Date().toISOString(),
    done: false,
  });
  writeJson(REMINDERS_PATH, data);
  return {
    handled: true,
    kind: "reminder",
    reply: rules.reminders.reply || "嗯。記了。",
    data: { delayMs },
  };
}

function handleMemory(text, rules) {
  if (!rules.memory?.enabled) return null;
  const clean = stripMention(text);
  if (isMemoryDeleteIntent(clean)) {
    const query = normalizeMemoryText(extractMemoryDeleteText(clean));
    if (!query) return { handled: true, kind: "memory_delete_empty", reply: "忘記什麼。" };
    const result = removeWorkspaceMemory(query);
    return {
      handled: true,
      kind: result.removed > 0 ? "memory_delete" : "memory_delete_miss",
      reply: result.removed > 0 ? "嗯。忘了。" : "沒有那個。",
      removed: result.removed,
      items: result.items,
      status: memoryStatus(),
    };
  }
  if (isMemoryWriteIntent(clean)) {
    const value = normalizeMemoryText(extractMemoryText(clean));
    if (!value || isSensitiveMemory(value)) {
      return { handled: true, kind: "memory_rejected", reply: "這個不記。" };
    }
    appendWorkspaceMemory(value);
    return { handled: true, kind: "memory_save", reply: rules.memory.reply || "嗯。記住了。" };
  }
  const recall = clean.match(/^(?:你)?(?:還)?記得\s*(.+)?/);
if (recall && !/^(?:記住|記得提醒)/.test(clean)) {
  if (isCurrentSessionMemoryQuestion(clean)) {
    return {
      handled: true,
      kind: "memory_session_required",
      reply: "這要看目前對話，不是長期記憶。",
      data: {
        ok: true,
        found: false,
        source: "session_required",
        confidence: 0,
        items: [],
        error: null,
      },
    };
  }

  const needle = normalizeRecallQuery(recall[1]);

  if (!needle) {
    return {
      handled: true,
      kind: "memory_recall_empty",
      reply: "問哪件事。",
      data: {
        ok: true,
        found: false,
        source: "memory",
        confidence: 0,
        items: [],
        error: null,
      },
    };
  }

  const items = readMarkdownMemories();
  const matches = [...items]
    .reverse()
    .filter((item) => memoryMatches(item.text, needle))
    .slice(0, 5);

  const found = matches[0] || null;

  if (found) {
    const template = rules.memory.recallReply || "記得。{value}";
    return {
      handled: true,
      kind: "memory_recall",
      reply: template.replace("{value}", found.text),
      data: {
        ok: true,
        found: true,
        source: "memory",
        confidence: 0.8,
        items: matches,
        error: null,
      },
    };
  }

  return {
    handled: true,
    kind: "memory_recall",
    reply: "不記得。",
    data: {
      ok: true,
      found: false,
      source: "memory",
      confidence: 0,
      items: [],
      error: null,
    },
  };
}
}

function memoryStatus() {
  const items = readMarkdownMemories();
  return {
    status: "ok",
    store: path.relative(WORKSPACE_ROOT, WORKSPACE_MEMORY_PATH).replace(/\\/g, "/"),
    markdownItems: items.length,
  };
}

function handleMonitor(text) {
  const clean = stripMention(text);
  if (!/(盯|監看|有變化|新片|新影片|直播|售票|票)/.test(clean)) return null;
  const url = clean.match(/https?:\/\/\S+/i)?.[0]?.replace(/[>\])"'.,]+$/g, "");
  const target = clean.replace(/^(幫我)?(盯|監看)\s*/, "").trim();
  if (!url && !target) return null;
  const data = readJson(MONITORS_PATH, { items: [] });
  data.items = Array.isArray(data.items) ? data.items : [];
  data.items.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    target,
    url: url || null,
    createdAt: new Date().toISOString(),
    enabled: true,
  });
  writeJson(MONITORS_PATH, data);
  return { handled: true, kind: "monitor_save", reply: "嗯。盯著。" };
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function handleUrlSummary(text, rules) {
  if (!rules.urlSummary?.enabled || !hasUrl(text)) return null;
  if (!/(看|摘要|重點|整理|公告)/.test(text)) return null;
  const url = text.match(/https?:\/\/\S+/i)?.[0]?.replace(/[>\])"'.,]+$/g, "");
  if (!url) return null;
  try {
    const html = await fetchText(url);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const body = cleanHtml(desc || html).slice(0, 160);
    const head = cleanHtml(title || "").slice(0, 60);
    return { handled: true, kind: "url_summary", reply: `重點。${head ? `${head}。` : ""}${body}`.slice(0, 220) };
  } catch (err) {
    return { handled: true, kind: "url_summary_error", reply: "看不到。無聊。" };
  }
}

function handleReaction(text, rules) {
  const clean = stripMention(text);
  for (const rule of rules.reactions || []) {
    const patterns = Array.isArray(rule.patterns) ? rule.patterns : [];
    if (patterns.some((pattern) => pattern && clean.toLowerCase().includes(String(pattern).toLowerCase()))) {
      return { handled: true, kind: `reaction:${rule.id || "rule"}`, reply: rule.reply || "嗯。" };
    }
  }
  return null;
}

function locationFromText(text, rules) {
  const clean = stripMention(text);
  const map = {
    "台北": "Taipei",
    "臺北": "Taipei",
    "新北": "New Taipei",
    "桃園": "Taoyuan",
    "台中": "Taichung",
    "臺中": "Taichung",
    "台南": "Tainan",
    "臺南": "Tainan",
    "高雄": "Kaohsiung",
    "香港": "Hong Kong",
    "東京": "Tokyo",
    "大阪": "Osaka",
  };
  for (const [label, value] of Object.entries(map)) {
    if (clean.includes(label)) return value;
  }
  const match = clean.match(/(?:天氣|下雨|會下雨嗎|氣溫)\s*([^\s?？]*)|([^\s?？]+)\s*(?:天氣|會下雨嗎|下雨|氣溫)/);
  const location = stripQuestionTail(match?.[1] || match?.[2] || "")
    .replace(/(?:今天|明天|現在|目前|待會|等等|會)+$/g, "")
    .trim();
  if (!location || /^(今天|明天|現在)$/.test(location)) return rules.weather?.defaultLocation || "Taipei";
  return map[location] || location;
}

async function resolveWeatherPlace(location) {
  const localPlaces = {
    "Taipei": { name: "台北", latitude: 25.0375, longitude: 121.5637 },
    "New Taipei": { name: "新北", latitude: 25.0169, longitude: 121.4628 },
    "Taoyuan": { name: "桃園", latitude: 24.9937, longitude: 121.3009 },
    "Taichung": { name: "台中", latitude: 24.1477, longitude: 120.6736 },
    "Tainan": { name: "台南", latitude: 22.9997, longitude: 120.2270 },
    "Kaohsiung": { name: "高雄", latitude: 22.6273, longitude: 120.3014 },
    "Hong Kong": { name: "香港", latitude: 22.3193, longitude: 114.1694 },
    "Tokyo": { name: "東京", latitude: 35.6762, longitude: 139.6503 },
    "Osaka": { name: "大阪", latitude: 34.6937, longitude: 135.5023 },
  };
  if (localPlaces[location]) return localPlaces[location];
  const geo = JSON.parse(await fetchText(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`, 7000));
  const place = geo.results?.[0];
  if (!place) throw new Error("place not found");
  return {
    name: place.name || location,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

async function handleWeather(text, rules) {
  if (!rules.weather?.enabled) return null;
  if (!/(天氣|下雨|會下雨嗎|氣溫)/.test(text)) return null;
  const location = locationFromText(text, rules);
  try {
    const place = await resolveWeatherPlace(location);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,precipitation&hourly=temperature_2m,apparent_temperature,precipitation_probability&daily=temperature_2m_max,apparent_temperature_max&forecast_days=1&timezone=auto`;
    const data = JSON.parse(await fetchText(url, 7000));
    const temp = Math.round(Number(data.current?.temperature_2m));
    const feels = Math.round(Number(data.current?.apparent_temperature));
    const high = Math.round(Number(data.daily?.temperature_2m_max?.[0]));
    const highFeels = Math.round(Number(data.daily?.apparent_temperature_max?.[0]));
    const times = Array.isArray(data.hourly?.time) ? data.hourly.time : [];
    const currentTime = String(data.current?.time || "");
    const currentHour = currentTime.slice(0, 13);
    const startIndex = Math.max(0, times.findIndex((time) => String(time).slice(0, 13) === currentHour));
    const chance = (data.hourly?.precipitation_probability || []).map(Number);
    const futureChance = chance.slice(startIndex, startIndex + 12).filter(Number.isFinite);
    const rain = futureChance.length ? Math.max(...futureChance) : Number(data.current?.precipitation || 0) > 0 ? 80 : 0;
    const timeLabel = currentTime.includes("T") ? currentTime.split("T")[1] : currentTime;
    const phrase = rain >= 50 ? "會。帶傘。" : (feels >= 36 || highFeels >= 38 || high >= 34) ? "不會。熱。" : temp >= 28 ? "不會。熱。" : "不會。";
    const feelsText = Number.isFinite(feels) ? `，體感${feels}` : "";
    const highText = Number.isFinite(high) ? `，最高${high}` : "";
    const highFeelsText = Number.isFinite(highFeels) ? `，體感最高${highFeels}` : "";
    const rainText = Number.isFinite(rain) ? `，雨${rain}%` : "";
    return { handled: true, kind: "weather", reply: `${phrase}${place.name} ${timeLabel} ${temp}度${feelsText}${highText}${highFeelsText}${rainText}。` };
  } catch (err) {
    return { handled: true, kind: "weather_error", reply: "天氣抓不到。" };
  }
}

function normalizeCurrency(codeOrText) {
  const value = String(codeOrText || "").toUpperCase();
  if (/日圓|日幣|JPY|円/.test(value)) return "JPY";
  if (/台幣|臺幣|TWD|NTD/.test(value)) return "TWD";
  if (/美金|美元|USD/.test(value)) return "USD";
  if (/港幣|HKD/.test(value)) return "HKD";
  if (/人民幣|CNY|RMB/.test(value)) return "CNY";
  if (/歐元|EUR/.test(value)) return "EUR";
  return /^[A-Z]{3}$/.test(value) ? value : "";
}

async function handleCurrency(text, rules) {
  if (!rules.currency?.enabled) return null;
  if (!/(多少台幣|多少臺幣|匯率|日圓|日幣|美金|美元|台幣|JPY|USD|TWD|円)/i.test(text)) return null;
  const amount = Number((text.match(/(\d+(?:\.\d+)?)/) || [])[1]);
  if (!Number.isFinite(amount)) return null;
  const source = normalizeCurrency(text.match(/(?:\d+(?:\.\d+)?)\s*([A-Za-z]{3}|日圓|日幣|円|美金|美元|台幣|臺幣|港幣|人民幣|歐元)/)?.[1] || text);
  const target = normalizeCurrency(text.match(/多少\s*([A-Za-z]{3}|日圓|日幣|円|美金|美元|台幣|臺幣|港幣|人民幣|歐元)/)?.[1]) || rules.currency.defaultTo || "TWD";
  if (!source || source === target) return null;
  try {
    const data = JSON.parse(await fetchText(`https://open.er-api.com/v6/latest/${source}`, 7000));
    const rate = Number(data.rates?.[target]);
    if (!Number.isFinite(rate)) throw new Error("NO_RATE");
    const converted = amount * rate;
    return { handled: true, kind: "currency", reply: `${amount}${source}。約 ${converted.toFixed(converted >= 100 ? 0 : 2)}${target}。` };
  } catch (err) {
    return { handled: true, kind: "currency_error", reply: "匯率抓不到。" };
  }
}

function targetLang(text) {
  if (/日文|日語|Japanese|ja/i.test(text)) return "ja";
  if (/英文|英語|English|en/i.test(text)) return "en";
  if (/中文|繁中|繁體|zh/i.test(text)) return "zh-TW";
  return "zh-TW";
}

async function handleTranslation(text, rules) {
  if (!rules.translation?.enabled) return null;
  if (!/(翻譯|翻成|翻日文|翻英文|translate)/i.test(text)) return null;
  const clean = stripMention(text).replace(/^(翻譯|翻成|翻日文|翻英文|translate)\s*/i, "").trim();
  const q = clean.replace(/^(日文|英文|中文|繁中|繁體)\s*/i, "").trim();
  if (!q) return { handled: true, kind: "translation_empty", reply: "字呢。" };
  try {
    const tl = targetLang(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`;
    const data = JSON.parse(await fetchText(url, 7000));
    const translated = data?.[0]?.map((part) => part?.[0]).join("").trim();
    return { handled: true, kind: "translation", reply: translated ? `嗯。${translated}` : "翻不到。" };
  } catch (err) {
    return { handled: true, kind: "translation_error", reply: "翻不到。" };
  }
}

function leprechaunRoot(rules) {
  return textOf(rules.leprechaun?.root) || DEFAULT_LEPRECHAUN_ROOT;
}

function readLeprechaunTelemetry(rules) {
  return readJson(path.join(leprechaunRoot(rules), "telemetry.json"), null);
}

function readLeprechaunEvaluationSummary(rules) {
  return readJson(path.join(leprechaunRoot(rules), "evaluation_summary.json"), null);
}

function readLeprechaunCandidateRanking(rules) {
  return readJson(path.join(leprechaunRoot(rules), "candidate_ranking.json"), null);
}

function readLeprechaunReliabilityReport(rules) {
  return readJson(path.join(leprechaunRoot(rules), "reliability_report.json"), null);
}

function readLeprechaunResearchViews(rules) {
  return readJson(path.join(leprechaunRoot(rules), "research_views.json"), null);
}

function readLeprechaunPrecisionFrontier(rules) {
  return readJson(path.join(leprechaunRoot(rules), "precision_frontier_report.json"), null);
}

function readLeprechaunResearchConfig(rules) {
  return readJson(path.join(leprechaunRoot(rules), "research_config.json"), null);
}

async function runLeprechaunEvidencePack(rules) {
  const root = leprechaunRoot(rules);
  const { stdout } = await execFileAsync(
    "python",
    ["evidence_pack.py", "--compact", "--output", "evidence_pack.json"],
    { cwd: root, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, env: pythonEnv() },
  );
  const payload = JSON.parse(stdout);
  if (!payload || typeof payload !== "object" || !payload.pack_version) {
    throw new Error("EVIDENCE_PACK_INVALID");
  }
  return payload;
}

function telemetryTrust(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return { ok: false, reason: "telemetry_missing" };
  const generatedAt = Date.parse(telemetry.generated_at || "");
  const source = textOf(telemetry.market_data?.source || telemetry.source);
  const stocks = telemetry.stocks;
  if (!Number.isFinite(generatedAt)) return { ok: false, reason: "generated_at_missing" };
  if (!source) return { ok: false, reason: "source_missing" };
  if (!stocks || typeof stocks !== "object" || Object.keys(stocks).length === 0) {
    return { ok: false, reason: "stocks_missing" };
  }
  const ageMs = Math.max(0, Date.now() - generatedAt);
  if (ageMs > MAX_TELEMETRY_AGE_MS) return { ok: false, reason: "telemetry_stale", ageMs, source };
  return { ok: true, reason: "fresh", ageMs, source };
}

async function runStructuredLeprechaunResearch(tickers, rules, maxTickers = LEPRECHAUN_MAX_TICKERS_PER_QUERY) {
  const root = leprechaunRoot(rules);
  const selectedTickers = tickers.slice(0, Math.max(1, Number(maxTickers) || LEPRECHAUN_MAX_TICKERS_PER_QUERY));
  const { stdout } = await execFileAsync(
    "python",
    ["predictor.py", "--tickers", ...selectedTickers, "--horizon", "5d", "--no-log"],
    { cwd: root, timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: pythonEnv() },
  );
  const payload = JSON.parse(stdout);
  if (!Array.isArray(payload?.predictions) || payload.predictions.length === 0) {
    throw new Error("PREDICTION_EMPTY");
  }
  return payload.predictions;
}

function structuredValidationStatus(prediction, rules, evidencePack) {
  const summary = readLeprechaunEvaluationSummary(rules);
  const strategy = prediction.strategy_version || LEPRECHAUN_STRATEGY_VERSION;
  const metrics = summary?.strategy_metrics?.[strategy] || {};
  const live = evidencePack?.live_validation || {};
  const replay = evidencePack?.source_state?.replay_contract || {};
  const dataQuality = evidencePack?.source_state?.data_quality || {};
  const calibration = evidencePack?.calibration || {};
  const evaluated = Number(metrics.evaluated_count || 0);
  const required = Number(prediction.performance_gate?.required_evaluated_records || 100);
  const pending = Number(metrics.pending_count || 0);
  const nextDue = metrics.next_due_date || prediction.due_date || null;
  return {
    strategy,
    readiness: evidencePack?.readiness || "unknown",
    evaluated: Number(live.evaluated_records ?? evaluated),
    required: Number(live.required_evaluated_records ?? required),
    pending: Number(live.pending_records ?? pending),
    nextDue: live.next_due_date || nextDue,
    replayPassed: replay.passed === true,
    dataQualityTrusted: dataQuality.trusted === true,
    dataQualitySource: dataQuality.source || "unknown",
    calibrationStatus: calibration.status || "unknown",
    blockers: Array.isArray(evidencePack?.blockers) ? evidencePack.blockers : [],
  };
}

function rankingRowFor(ticker, ranking) {
  const rows = Array.isArray(ranking?.all_candidates) ? ranking.all_candidates : [];
  return rows.find((row) => String(row?.ticker || "").toUpperCase() === String(ticker || "").toUpperCase()) || null;
}

function formatRankingContext(prediction, ranking) {
  const row = rankingRowFor(prediction.ticker, ranking);
  const summary = ranking?.summary || {};
  if (!row) {
    const best = summary.best_long_candidate;
    return best ? `相對排序: 目前 watchlist 較乾淨的是 ${best}；${prediction.ticker} 沒有 ranking row。` : "相對排序: ranking 尚未建立。";
  }
  const flags = Array.isArray(row.flags) && row.flags.length ? row.flags.join(", ") : "none";
  const best = summary.best_long_candidate ? `；目前 long watch 第一是 ${summary.best_long_candidate}` : "";
  return `相對排序: ${row.direction}；rank ${row.rank_score}；flags ${flags}${best}`;
}

function reliabilityPriorFor(ticker, reliability) {
  const rows = Array.isArray(reliability?.candidate_priors) ? reliability.candidate_priors : [];
  return rows.find((row) => String(row?.ticker || "").toUpperCase() === String(ticker || "").toUpperCase()) || null;
}

function formatReliabilityContext(prediction, reliability) {
  const prior = reliabilityPriorFor(prediction.ticker, reliability);
  if (!prior) return "歷史 prior: 未建立。";
  if (prior.historical_scope === "not_applicable") return `歷史 prior: ${prior.reason || "不適用"}。`;
  const source = prior.support_source || "unknown";
  const metrics = prior[source] || {};
  if (!metrics.count) return "歷史 prior: 樣本太少，不能讀。";
  const rate = metrics.positive_rate == null ? "N/A" : `${(metrics.positive_rate * 100).toFixed(1)}%`;
  const excess = metrics.avg_excess_return_vs_spy == null ? "N/A" : `${(metrics.avg_excess_return_vs_spy * 100).toFixed(2)}%`;
  return `歷史 prior: ${source}；樣本 ${metrics.count}；正報酬 ${rate}；均值超額SPY ${excess}；${prior.support_sample_status || metrics.sample_status}；不可當 live 勝率。`;
}

function researchViewFor(ticker, views) {
  const rows = Array.isArray(views?.views) ? views.views : [];
  return rows.find((row) => String(row?.ticker || "").toUpperCase() === String(ticker || "").toUpperCase()) || null;
}

function formatResearchViewContext(prediction, views) {
  const view = researchViewFor(prediction.ticker, views);
  if (!view) return "研究觀點: 尚未建立。";
  const sentence = view.plain_language ? `；${view.plain_language}` : "";
  return `研究觀點: ${view.tier}；${view.action_policy}${sentence}`;
}

function formatResearchViewContext(prediction, views) {
  const view = researchViewFor(prediction.ticker, views);
  const abstain = views?.abstain;
  const stance = views?.overall_stance ? `；${views.overall_stance}` : "";
  const abstainText = abstain?.required ? `；暫不進場：${abstain.reason || "證據不足"}` : "";
  if (!view) return `研究觀點: 尚未建立${stance}${abstainText}。`;
  const sentence = view.plain_language ? `；${view.plain_language}` : "";
  return `研究觀點: ${view.tier}；${view.action_policy}${stance}${abstainText}${sentence}`;
}

function clampNumber(value, minValue, maxValue) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maxValue, Math.max(minValue, number));
}

function priceRangeText(values) {
  if (!Array.isArray(values)) return null;
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length === 0) return null;
  if (finite.length === 1) return money(finite[0]);
  return `${money(Math.min(...finite))}-${money(Math.max(...finite))}`;
}

function buildResearchPricePlan(prediction) {
  const directEntry = priceRangeText(prediction.entry_zone);
  const stopValue = Number(prediction.stop_loss);
  const directStop = Number.isFinite(stopValue) && stopValue > 0 ? money(stopValue) : null;
  const directTarget = priceRangeText(prediction.take_profit);
  if (directEntry || directStop || directTarget) {
    return {
      entry: directEntry || "N/A",
      stop: directStop || "N/A",
      target: directTarget || "N/A",
      note: "\u7814\u7a76\u50f9\u4f4d\uff1b\u975e\u8cb7\u8ce3\u6307\u4ee4\u3002",
    };
  }

  const indicators = prediction.indicators || {};
  const price = Number(prediction.price);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      entry: "N/A",
      stop: "N/A",
      target: "N/A",
      note: "\u50f9\u683c\u4e0d\u8db3\u3002",
    };
  }

  const ma5 = Number(indicators.ma5);
  const ma20 = Number(indicators.ma20);
  const rsi14 = Number(indicators.rsi14);
  const ret20 = Number(indicators.ret_20d);
  const volatility = clampNumber(indicators.volatility_30d_annualized, 0.2, 0.9) || 0.35;
  const riskUnit = Math.max(price * 0.035, price * Math.min(0.09, Math.max(0.025, volatility / 10)));

  if (prediction.bias === "bearish") {
    const pressureLow = Number.isFinite(ma5) ? Math.max(price, ma5) : price * 1.025;
    const pressureHigh = Number.isFinite(ma20) ? Math.max(pressureLow, ma20) : price * 1.055;
    const reclaim = Number.isFinite(ma20) ? ma20 * 1.01 : price * 1.04;
    return {
      entry: `\u4e0d\u8ffd\uff1b\u8f49\u5f37\u89c0\u5bdf ${money(reclaim)}`,
      stop: money(price - riskUnit),
      target: `${money(pressureLow)}-${money(pressureHigh)} \u58d3\u529b\u5340`,
      note: "\u504f\u7a7a\uff1b\u975e\u505a\u7a7a\u5efa\u8b70\u3002",
    };
  }

  const hotMove = (Number.isFinite(ret20) && ret20 > 0.12) || (Number.isFinite(rsi14) && rsi14 >= 68);
  const entryLow = prediction.bias === "bullish" && !hotMove ? price * 0.985 : price * 0.97;
  const entryHigh = prediction.bias === "bullish" && !hotMove ? price * 1.005 : price * 0.99;
  const stopByRisk = price - riskUnit;
  const stopByMa20 = Number.isFinite(ma20) ? ma20 * 0.97 : stopByRisk;
  const stop = Math.max(Math.min(stopByRisk, price * 0.97), Math.min(stopByMa20, price * 0.98));
  const targetLow = price + riskUnit * (prediction.bias === "bullish" ? 1.2 : 1.0);
  const targetHigh = price + riskUnit * (prediction.bias === "bullish" ? 2.0 : 1.5);
  return {
    entry: `${money(entryLow)}-${money(entryHigh)}`,
    stop: money(stop),
    target: `${money(targetLow)}-${money(targetHigh)}`,
    note: hotMove
      ? "\u5df2\u6f32\u904e\uff1b\u7b49\u56de\u6e2c\u3002"
      : "\u7814\u7a76\u50f9\u4f4d\u3002",
  };
}

function formatResearchPricePlan(prediction) {
  const plan = buildResearchPricePlan(prediction);
  return `\u50f9\u4f4d: \u89c0\u5bdf\u5340 ${plan.entry}\uff5c\u5931\u6548 ${plan.stop}\uff5c\u76ee\u6a19/\u58d3\u529b ${plan.target}\u3002${plan.note}`;
}

function formatForecastGateLine(prediction) {
  const gate = prediction.forecast_gate || {};
  const grade = gate.grade || "N/A";
  const mode = gate.mode === "production_validated" ? "正式驗證" : "試用預測";
  const warnings = Array.isArray(gate.warnings) ? gate.warnings : [];
  const warningText = warnings.includes("high_volatility")
    ? "波動大"
    : warnings.includes("below_backtested_frontier")
      ? "未達最佳 frontier"
      : warnings.includes("confidence_not_calibrated")
        ? "未校準"
        : "可追蹤";
  return `預測: ${mode}｜等級 ${grade}｜信心 ${gate.confidence == null ? "N/A" : `${Math.round(Number(gate.confidence) * 100)}%`}｜${warningText}。`;
}

function gateBlockerLabel(value) {
  const labels = {
    insufficient_out_of_sample_records: "\u6a23\u672c\u5916\u4e0d\u8db3",
    execution_costs_not_modeled: "\u6210\u672c\u6a21\u578b\u672a\u5b8c\u6210",
    benchmark_comparison_missing: "SPY benchmark \u672a\u5b8c\u6210",
    benchmark_not_outperforming: "\u672a\u8dd1\u8d0f SPY",
    insufficient_setup_candidates: "setup \u5019\u9078\u4e0d\u8db3",
    setup_win_rate_too_low: "setup \u52dd\u7387\u4e0d\u8db3",
    setup_win_rate_confidence_too_low: "\u52dd\u7387\u4fe1\u8cf4\u4e0d\u8db3",
    setup_profit_factor_too_low: "profit factor \u4e0d\u8db3",
    setup_not_outperforming_spy: "setup \u672a\u8dd1\u8d0f SPY",
    confidence_not_calibrated: "confidence \u672a\u6821\u6e96",
    confidence_calibration_insufficient: "\u6821\u6e96\u4e0d\u8db3",
    no_shadow_strategy_ready_for_promotion: "shadow \u7b56\u7565\u672a\u9054\u6649\u5347\u7d1a",
    data_quality_not_trusted: "\u8cc7\u6599\u54c1\u8cea\u672a\u4fe1\u4efb",
    live_gate_closed: "驗證未完成",
  };
  return labels[value] || String(value || "\u672a\u77e5");
}

function formatGateOptimization(evidencePack) {
  const live = evidencePack?.live_validation || evidencePack?.source_state?.status_report?.live_validation_gate || {};
  const progress = live.progress || {};
  const checklist = live.validation_checklist || {};
  const tasks = [];
  const evaluated = progress.evaluated_records || (
    Number.isFinite(Number(live.evaluated_records)) && Number.isFinite(Number(live.required_evaluated_records))
      ? `${live.evaluated_records}/${live.required_evaluated_records}`
      : ""
  );
  if (checklist.enough_out_of_sample_records === false || live.reason === "insufficient_out_of_sample_records") {
    tasks.push(`\u7d2f\u7a4d\u6a23\u672c\u5916\u7d50\u679c ${evaluated || "\u6a23\u672c"}`);
  }
  const setup = progress.setup_candidates || (
    Number.isFinite(Number(live.setup_candidate_count)) && Number.isFinite(Number(live.required_setup_candidates))
      ? `${live.setup_candidate_count}/${live.required_setup_candidates}`
      : ""
  );
  if (checklist.enough_setup_candidates === false) {
    tasks.push(`\u7d2f\u7a4d\u9032\u5834\u578b\u6a23\u672c ${setup || "\u6a23\u672c"}`);
  }
  if (checklist.setup_positive_rate_high_enough === false || checklist.setup_profit_factor_high_enough === false) {
    tasks.push("\u6536\u7dca\u7be9\u9078\uff0c\u770b\u52dd\u7387\u8207\u640d\u76ca\u6bd4");
  }
  const blockers = Array.isArray(evidencePack?.blockers) ? evidencePack.blockers : [];
  if (blockers.includes("confidence_calibration_insufficient") || checklist.confidence_calibrated === false) {
    tasks.push("\u88dc confidence \u6821\u6e96");
  }
  const nextDue = live.next_due_date || progress.next_setup_candidate_due_date || progress.next_due_date;
  if (nextDue) tasks.push(`\u4e0b\u6b21\u53ef\u7d50\u7b97 ${nextDue} \u7f8e\u80a1\u6536\u76e4\u5f8c`);
  return tasks.length ? tasks.slice(0, 4).join("\uff1b") : "\u66ab\u7121\u65b0\u963b\u64cb";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function trialGateStatus(predictions, evidencePack, rules) {
  const first = Array.isArray(predictions) ? predictions[0] : null;
  const gate = first?.performance_gate || {};
  const strategy = gate.strategy_version || evidencePack?.strategy_version || LEPRECHAUN_STRATEGY_VERSION;
  const summary = readLeprechaunEvaluationSummary(rules);
  const metrics = summary?.strategy_metrics?.[strategy] || {};
  const live = evidencePack?.live_validation || evidencePack?.source_state?.status_report?.live_validation_gate || {};
  const dataQuality = evidencePack?.source_state?.data_quality || {};
  const replay = evidencePack?.source_state?.replay_contract || {};
  const evaluated = finiteNumber(metrics.evaluated_count) ?? finiteNumber(live.evaluated_records) ?? finiteNumber(gate.evaluated_records) ?? 0;
  const required = finiteNumber(live.required_evaluated_records) ?? finiteNumber(gate.required_evaluated_records) ?? 100;
  const hitRate = finiteNumber(metrics.hit_rate);
  const brier = finiteNumber(metrics.brier_score) ?? finiteNumber(live.brier_score) ?? finiteNumber(gate.brier_score);
  const excess = finiteNumber(metrics.avg_net_excess_return_vs_spy) ?? finiteNumber(live.avg_net_excess_return_vs_spy) ?? finiteNumber(gate.avg_net_excess_return_vs_spy);
  const costsIncluded = metrics.execution_costs_included === true || live.execution_costs_included === true || gate.costs_and_slippage_included === true;
  const benchmarkIncluded = metrics.benchmark_comparison_included === true || live.benchmark_comparison_included === true || gate.benchmark_comparison_included === true;
  const dataTrusted = dataQuality.trusted === true;
  const replayPassed = replay.passed === true;
  const productionOpen = gate.eligible === true || live.eligible_for_entry_exit_opinion === true;
  const trialOpen = !productionOpen
    && evaluated >= LEPRECHAUN_TRIAL_MIN_EVALUATED
    && brier != null
    && brier <= LEPRECHAUN_TRIAL_BRIER_MAX
    && costsIncluded
    && benchmarkIncluded
    && dataTrusted
    && replayPassed;
  const blockers = [];
  if (evaluated < LEPRECHAUN_TRIAL_MIN_EVALUATED) blockers.push(`trial samples ${evaluated}/${LEPRECHAUN_TRIAL_MIN_EVALUATED}`);
  if (brier == null || brier > LEPRECHAUN_TRIAL_BRIER_MAX) blockers.push(`Brier ${brier == null ? "N/A" : brier.toFixed(3)}/${LEPRECHAUN_TRIAL_BRIER_MAX.toFixed(3)}`);
  if (!costsIncluded) blockers.push("\u6210\u672c\u672a\u7d0d\u5165");
  if (!benchmarkIncluded) blockers.push("SPY \u6bd4\u8f03\u672a\u7d0d\u5165");
  if (!dataTrusted) blockers.push("\u8cc7\u6599\u54c1\u8cea\u672a\u901a\u904e");
  if (!replayPassed) blockers.push("replay \u5408\u7d04\u672a\u901a\u904e");
  const warnings = [];
  if (hitRate == null) warnings.push("\u547d\u4e2d\u7387\u672a\u5b8c\u6210");
  if (excess == null || excess <= 0) warnings.push(`vs SPY ${excess == null ? "N/A" : percentText(excess)}`);
  const setupCount = finiteNumber(live.setup_candidate_count) ?? finiteNumber(gate.setup_candidate_count) ?? finiteNumber(metrics.setup_candidate_count);
  const requiredSetup = finiteNumber(live.required_setup_candidates) ?? finiteNumber(gate.required_setup_candidates) ?? 30;
  if (setupCount == null || setupCount < requiredSetup) warnings.push(`setup ${setupCount ?? 0}/${requiredSetup}`);
  return {
    strategy,
    productionOpen,
    trialOpen,
    trialMode: productionOpen ? "production_open" : trialOpen ? "trial_research_open" : "closed",
    evaluated,
    required,
    hitRate,
    brier,
    excess,
    costsIncluded,
    benchmarkIncluded,
    dataTrusted,
    replayPassed,
    blockers,
    warnings,
  };
}

function formatEvidenceGateLine(prediction, evidencePack, gateReasonLabels) {
  const gate = prediction.performance_gate || {};
  const readiness = evidencePack?.readiness || (gate.eligible ? "entry_exit_allowed" : "research_only");
  const blockers = Array.isArray(evidencePack?.blockers) && evidencePack.blockers.length
    ? evidencePack.blockers.slice(0, 3).map(gateBlockerLabel).join("\u3001")
    : (gate.eligible ? "\u7121" : gateBlockerLabel(gate.reason));
  const state = gate.eligible ? "\u901a\u904e" : "\u672a\u5b8c\u6210";
  const reason = gate.eligible ? "" : `\uff0f${gateReasonLabels[gate.reason] || gateBlockerLabel(gate.reason)}`;
  return `\u9a57\u8b49: ${state}${reason}\uff1b${readiness}\uff1b${blockers}`;
}

function formatResearchGateSummary(predictions, evidencePack, rules) {
  const first = Array.isArray(predictions) ? predictions[0] : null;
  const gate = first?.performance_gate || {};
  const trial = trialGateStatus(predictions, evidencePack, rules);
  const progress = [];
  if (Number.isFinite(Number(gate.evaluated_records)) && Number.isFinite(Number(gate.required_evaluated_records))) {
    progress.push(`\u8ffd\u8e64\u6a23\u672c ${gate.evaluated_records}/${gate.required_evaluated_records}`);
  }
  if (trial.hitRate != null) progress.push(`\u76ee\u524d\u547d\u4e2d ${percentText(trial.hitRate)}\uff0c\u4f46\u6a23\u672c\u9084\u5c0f`);
  const blockers = Array.isArray(evidencePack?.blockers) && evidencePack.blockers.length
    ? evidencePack.blockers.slice(0, 3).map(gateBlockerLabel).join("\u3001")
    : (gate.eligible ? "\u7121" : gateBlockerLabel(gate.reason));
  const mode = gate.eligible
    ? "\u6b63\u5f0f\u9a57\u8b49\u901a\u904e\uff1b\u53ef\u7d66\u5b8c\u6574\u9032\u51fa\u5834\u7814\u7a76"
    : trial.trialOpen
      ? "\u8a66\u7528\u9810\u6e2c\u53ef\u7528\uff1b\u53ef\u6e2c\u7814\u7a76\u9810\u6e2c\u8207\u50f9\u4f4d"
      : "\u53ea\u80fd\u7d66\u89c0\u5bdf\u6458\u8981";
  const warningLine = trial.warnings.length ? `\u8a66\u7528\u9650\u5236: ${trial.warnings.slice(0, 3).join("\uff1b")}\u3002` : "\u8a66\u7528\u9650\u5236: \u4e0d\u5f97\u8aaa\u6210\u6295\u8cc7\u5efa\u8b70\u3002";
  return [
    `\u72c0\u614b: ${mode}\uff1b${progress.join("\uff1b") || "\u6a23\u672c\u9084\u5c0f"}\u3002`,
    `${warningLine}`,
    `\u6b63\u5f0f\u9a57\u8b49: ${gate.eligible ? "\u901a\u904e" : `\u672a\u5b8c\u6210\uff1b${blockers}`}\u3002\u4e0d\u662f\u4e0b\u55ae\u6307\u4ee4\u3002`,
  ].join("\n");
}

function formatTrialGateOnlyReply(evidencePack, rules) {
  const trial = trialGateStatus([], evidencePack, rules);
  const live = evidencePack?.live_validation || evidencePack?.source_state?.status_report?.live_validation_gate || {};
  const authoredTrial = evidencePack?.trial_research_gate || {};
  const nextActions = (Array.isArray(authoredTrial.next_actions) && authoredTrial.next_actions.length
    ? authoredTrial.next_actions
    : [formatGateOptimization(evidencePack)]
  ).slice(0, 2).map((action) => String(action).replace(/[。；;]+$/u, ""));
  const blockers = Array.isArray(evidencePack?.blockers) && evidencePack.blockers.length
    ? evidencePack.blockers.slice(0, 4).map(gateBlockerLabel).join("\u3001")
    : "\u7121";
  const requiredSetup = finiteNumber(live.required_setup_candidates) ?? 30;
  const setup = Number.isFinite(Number(live.setup_candidate_count))
    ? `${live.setup_candidate_count}/${requiredSetup}`
    : "N/A";
  const lines = [
    "\u7f8e\u80a1\u3002\u5148\u770b\u8cc7\u6599\u3002",
    trial.trialOpen ? "\u8a66\u7528\u9810\u6e2c\u53ef\u7528\u3002\u53ef\u4ee5\u505a\u7814\u7a76\u9810\u6e2c\u8207\u50f9\u4f4d\u60c5\u5883\uff0c\u4e0d\u662f\u4e0b\u55ae\u6307\u4ee4\u3002" : "\u8a66\u7528\u9810\u6e2c\u672a\u5b8c\u6210\u3002\u53ea\u80fd\u770b\u89c0\u5bdf\u6458\u8981\u3002",
    `\u9a57\u8b49: ${trial.evaluated}/${trial.required}\uff1b\u547d\u4e2d ${trial.hitRate == null ? "N/A" : percentText(trial.hitRate)}\uff1b\u9032\u5834\u6a23\u672c ${setup}\u3002`,
    `Brier ${trial.brier == null ? "N/A" : trial.brier.toFixed(3)}\uff1bSPY ${trial.excess == null ? "N/A" : percentText(trial.excess, 2)}\uff1b\u8cc7\u6599 ${trial.dataTrusted ? "\u901a\u904e" : "\u672a\u901a\u904e"}\uff1breplay ${trial.replayPassed ? "\u901a\u904e" : "\u672a\u901a\u904e"}\u3002`,
    `\u6b63\u5f0f\u9a57\u8b49: ${trial.productionOpen ? "\u901a\u904e" : `\u672a\u5b8c\u6210\uff1b${blockers}`}\u3002`,
    `\u4e0b\u4e00\u6b65: ${nextActions.join("\uff1b")}\u3002`,
    trial.trialOpen
      ? `\u8a66\u7528\u9650\u5236: ${trial.warnings.slice(0, 4).join("\uff1b") || "\u4e0d\u5f97\u8aaa\u6210\u6295\u8cc7\u5efa\u8b70"}\u3002`
      : `\u672a\u958b\u539f\u56e0: ${trial.blockers.slice(0, 4).join("\uff1b") || "\u689d\u4ef6\u4e0d\u8db3"}\u3002`,
  ];
  return lines.join("\n");
}

function formatNews30dLine(indicators) {
  const news = indicators.news_30d || {};
  if (news.status === "unavailable") return "消息: 近30日新聞來源抓不到；不補故事。";
  if (!news.headline_count) return "消息: 近30日沒有可用新聞催化。";
  const tone = Number(news.tone_score || 0);
  const toneText = tone >= 2 ? "偏利多" : tone <= -2 ? "偏利空" : "中性/混雜";
  const direct = Number(news.direct_headline_count || 0);
  const sector = Number(news.sector_headline_count || 0);
  const scopeText = direct > 0
    ? `直接 ${direct} 則`
    : sector > 0
      ? `產業背景 ${sector} 則`
      : "一般市場背景";
  const catalysts = news.catalysts && typeof news.catalysts === "object"
    ? Object.entries(news.catalysts).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 2).map(([name]) => name).join("、")
    : "";
  const first = Array.isArray(news.headlines) && news.headlines[0]?.title ? `；${news.headlines[0].title}` : "";
  return `消息: 近30日 ${scopeText}；${toneText}${catalysts ? `；主題 ${catalysts}` : ""}${first}`;
}

function formatCandle30dLine(indicators) {
  const candle = indicators.candle_30d || {};
  if (candle.status !== "available") return "走勢: 30日K線資料不足。";
  const phaseLabels = {
    breakout: "突破",
    breakdown: "跌破",
    near_high_low_volume: "接近30日高點但量不足",
    near_low: "接近30日低點",
    possible_accumulation: "可能承接",
    possible_distribution: "可能派發",
    uptrend: "上升趨勢",
    downtrend: "下降趨勢",
    range: "區間整理",
  };
  const ret = candle.ret_30d == null ? "N/A" : percentText(Number(candle.ret_30d), 2);
  const pos = candle.close_position_30d == null ? "N/A" : `${Math.round(Number(candle.close_position_30d) * 100)}%`;
  const vol = candle.volume_trend_5d_vs_20d == null ? "N/A" : `${Number(candle.volume_trend_5d_vs_20d).toFixed(2)}x`;
  return `走勢: 30日 ${phaseLabels[candle.phase] || candle.phase || "未知"}；30D ${ret}；區間位置 ${pos}；5日量/20日量 ${vol}`;
}

function formatIntegratedStockView(prediction) {
  const indicators = prediction.indicators || {};
  const candle = indicators.candle_30d || {};
  const news = indicators.news_30d || {};
  const signal = [];
  const caution = [];

  if (prediction.bias === "bullish") signal.push("偏多");
  else if (prediction.bias === "bearish") signal.push("偏弱");
  else signal.push("盤整");

  if (candle.phase === "breakout") signal.push("30日突破");
  else if (candle.phase === "possible_accumulation") signal.push("有承接");
  else if (candle.phase === "uptrend") signal.push("趨勢向上");
  else if (candle.phase === "breakdown") caution.push("跌破30日區間");
  else if (candle.phase === "possible_distribution") caution.push("放量但收弱");
  else if (candle.phase === "near_high_low_volume") caution.push("高位量不足");
  else if (candle.phase === "near_low") caution.push("貼近30日低位");

  const newsTone = Number(news.tone_score || 0);
  if (news.headline_count > 0 && newsTone >= 2) signal.push("消息偏利多");
  else if (news.headline_count > 0 && newsTone <= -2) caution.push("消息偏利空");
  else if (news.headline_count > 0) signal.push("消息中性");
  else caution.push("近30日新聞不足");
  if (Number(news.headline_count || 0) > 0 && Number(news.direct_headline_count || 0) <= 0) {
    caution.push("缺少公司直接消息");
  }

  const volumeTrend = Number(candle.volume_trend_5d_vs_20d);
  if (Number.isFinite(volumeTrend) && volumeTrend >= 1.15) signal.push("短線量能放大");
  else if (Number.isFinite(volumeTrend) && volumeTrend < 0.8) caution.push("短線量縮");

  const riskText = caution.length ? caution.join("、") : "沒有明顯紅旗，但仍要等確認";
  return `綜合: ${signal.join("、")}。風險: ${riskText}。`;
}

function formatStockDataLine(prediction) {
  const indicators = prediction.indicators || {};
  const news = indicators.news_30d || {};
  const asOf = String(prediction.data_as_of || "").slice(0, 10) || "N/A";
  const direct = Number(news.direct_headline_count || 0);
  const sector = Number(news.sector_headline_count || 0);
  const newsText = direct > 0 ? `直接新聞 ${direct} 則` : sector > 0 ? `產業新聞 ${sector} 則` : "新聞不足";
  return `資料: 美股日線至 ${asOf}；${newsText}。`;
}

function formatBacktestedSignalLine(prediction) {
  const signal = prediction.indicators?.backtested_signal || {};
  const frontier = signal.frontier || {};
  if (signal.status === "matches_best_frontier") {
    const rate = Number(frontier.min_validation_test_positive_rate);
    const validation = Number(frontier.validation_count);
    const test = Number(frontier.test_count);
    const pf = Number(frontier.test_profit_factor);
    return `\u56de\u6e2c: \u6709\u908a\uff1b\u6700\u4f4e\u547d\u4e2d ${Number.isFinite(rate) ? percentText(rate) : "N/A"}\uff1b\u6a23\u672c ${Number.isFinite(validation) && Number.isFinite(test) ? `${validation}/${test}` : "N/A"}\uff1bPF ${Number.isFinite(pf) ? pf.toFixed(2) : "N/A"}\u3002`;
  }
  if (signal.status === "below_best_frontier") {
    const failed = Array.isArray(signal.failed_checks) && signal.failed_checks.length ? signal.failed_checks.join("、") : "條件不足";
    return `\u56de\u6e2c: \u4e0d\u5920\u4e7e\u6de8\uff1b\u5f31\u9ede ${failed}\u3002`;
  }
  return "\u56de\u6e2c: frontier \u6c92\u9192\uff1b\u4e0d\u8aaa\u52dd\u7387\u3002";
}

function formatStructuredResearchReply(prediction, rules, evidencePack, ranking, reliability, views) {
  const indicators = prediction.indicators || {};
  const gate = prediction.performance_gate || {};
  const eventRisk = prediction.event_risk || {};
  const decisionLabels = {
    OBSERVE_ONLY: "\u89c0\u5bdf",
    TRIAL_FORECAST: "試用預測",
    SETUP_CANDIDATE: "\u7814\u7a76\u5019\u9078",
    HOLD: "\u7e7c\u7e8c\u89c0\u5bdf",
    WAIT: "\u7b49\u5f85",
    AVOID: "\u907f\u958b",
  };
  const biasLabels = { bullish: "\u504f\u591a", bearish: "\u504f\u7a7a", neutral: "\u76e4\u6574" };
  const eventLabels = {
    clear: "\u7121\u8fd1\u671f\u8ca1\u5831",
    event_within_horizon: "\u8ca1\u5831\u843d\u5728\u7814\u7a76\u671f\u5167",
    unavailable: "\u8ca1\u5831\u8cc7\u6599\u4e0d\u53ef\u7528",
  };
  const riskLabels = { high: "\u9ad8", medium: "\u4e2d", low: "\u4f4e" };
  const gateReasonLabels = {
    insufficient_out_of_sample_records: "\u6a23\u672c\u5916\u7d00\u9304\u4e0d\u8db3",
    execution_costs_not_modeled: "\u6210\u672c\u6a21\u578b\u672a\u5b8c\u6210",
    benchmark_comparison_missing: "\u5c1a\u672a\u5b8c\u6210 SPY \u540c\u671f\u6bd4\u8f03",
    benchmark_not_outperforming: "\u6263\u6210\u672c\u5f8c\u5c1a\u672a\u8dd1\u8d0f SPY",
    insufficient_setup_candidates: "\u9032\u5834\u5019\u9078\u8a0a\u865f\u6a23\u672c\u4e0d\u8db3",
    setup_win_rate_too_low: "\u9032\u5834\u5019\u9078\u52dd\u7387\u4e0d\u8db3",
    setup_win_rate_confidence_too_low: "\u9032\u5834\u5019\u9078\u52dd\u7387\u4fe1\u8cf4\u5340\u9593\u4e0d\u8db3",
    setup_profit_factor_too_low: "\u9032\u5834\u5019\u9078 profit factor \u4e0d\u8db3",
    setup_not_outperforming_spy: "\u9032\u5834\u5019\u9078\u5c1a\u672a\u8dd1\u8d0f SPY",
    confidence_not_calibrated: "\u4fe1\u5fc3\u5206\u6578\u672a\u6821\u6e96",
    evaluation_summary_missing: "\u7e3e\u6548\u6458\u8981\u4e0d\u53ef\u7528",
  };
  const observed = [
    `${prediction.price}`,
    `5D ${indicators.ret_5d == null ? "N/A" : `${(indicators.ret_5d * 100).toFixed(2)}%`}`,
    `20D ${indicators.ret_20d == null ? "N/A" : `${(indicators.ret_20d * 100).toFixed(2)}%`}`,
    `MA20 ${indicators.ma20 == null ? "N/A" : indicators.ma20}`,
  ].join("\uff5c");
  const conclusion = prediction.bias === "bullish"
    ? "\u504f\u591a\u89c0\u5bdf\uff0c\u4f46\u7b49\u4f4d\u7f6e\u3002"
    : prediction.bias === "bearish"
      ? "\u504f\u5f31\uff0c\u4e0d\u8ffd\u3002"
      : "\u76e4\u6574\uff0c\u7b49\u66f4\u660e\u78ba\u8a0a\u865f\u3002";
  return [
    `${prediction.ticker}: ${decisionLabels[prediction.decision] || prediction.decision}\uff0f${biasLabels[prediction.bias] || "\u672a\u77e5"}\uff0f\u98a8\u96aa ${riskLabels[prediction.risk] || "\u672a\u77e5"}`,
    formatStockDataLine(prediction),
    formatForecastGateLine(prediction),
    formatBacktestedSignalLine(prediction),
    formatIntegratedStockView(prediction),
    formatNews30dLine(indicators),
    formatCandle30dLine(indicators),
    formatResearchPricePlan(prediction),
    `\u89c0\u5bdf: ${observed}`,
    `\u9650\u5236: ${eventLabels[eventRisk.status] || "\u8cc7\u6599\u4e0d\u53ef\u7528"}\uff1b\u7814\u7a76\u9810\u6e2c\uff0c\u4e0d\u662f\u4e0b\u55ae\u3002`,
    `\u52d5\u4f5c: ${conclusion}`,
  ].join("\n");
}

function readLeprechaunCommand(rules) {
  return readJson(path.join(leprechaunRoot(rules), "command.json"), { squad: [] });
}

function writeLeprechaunCommand(rules, payload) {
  writeJson(path.join(leprechaunRoot(rules), "command.json"), payload);
}

function normalizeTicker(value) {
  const ticker = String(value || "").replace(/^\$/, "").trim().toUpperCase();
  return /^[A-Z0-9.]{1,8}$/.test(ticker) ? ticker : "";
}

function extractTickers(text) {
  const raw = text.match(/\$?[A-Za-z][A-Za-z0-9.]{0,7}/g) || [];
  const blocked = new Set([
    "RANA", "LEPRECHAUN", "PLAY", "VOLUME", "JOIN", "LEAVE", "SKIP",
    "ENTRY", "POINT", "POINTS", "STOCK", "STOCKS", "MARKET", "DASHBOARD",
    "LIVE", "MYGO", "CRYCHIC", "RING", "AVE", "MUJICA"
  ]);
  const explicit = raw.filter((token) => token.startsWith("$") || token === token.toUpperCase());
  return [...new Set(explicit.map(normalizeTicker).filter((ticker) => ticker && !blocked.has(ticker)))];
}

function hasExplicitStockIntent(text) {
  return /(\u5206\u6790|\u63a8\u85a6|\u5efa\u8b70|\u503c\u5f97|\u54ea\u6a94|\u54ea\u5e7e\u6a94|\u6383|\u6383\u63cf|\u9810\u6e2c|\u56de\u6e2c|\u6301\u5009|\u9032\u5834|\u8cb7\u5165|\u53ef\u4ee5\u9032|\u80fd\u9032|\u80a1\u7968|\u7f8e\u80a1|\u79d1\u6280\u80a1|\u534a\u5c0e\u9ad4|\u8cc7\u5b89|\u80a1\u50f9|\u50f9\u91cf|\u6230\u60c5|\u76e4\u9762|stock|stocks|ticker|predict|recommend|scan|backtest|entry|buy|Leprechaun)/i.test(text);
}

function hasTickerLookIntent(text) {
  const lookIntent = /(?:\u6211\u8981\u770b|\u6211\u60f3\u770b|\u5e6b\u6211\u770b|\u770b\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\u76ef\u4e00\u4e0b|\u89c0\u5bdf|\u7814\u7a76|\u770b|\u67e5)/;
  return lookIntent.test(textOf(text)) && extractTickers(text).length > 0;
}

function hasBroadStockScanIntent(text) {
  return /(推薦|建議|值得|可以進|能進|進場|買入|買哪|哪些|哪幾檔|哪個|比較乾淨|乾淨|候選|觀察|掃|掃描|科技股|半導體|資安|盤面|市場|戰情|watch|recommend|scan|candidate|clean|buy)/i.test(text);
}

function percentText(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "N/A";
}

function formatLeprechaunScanReply(evidencePack, views, precision, rules) {
  const rows = Array.isArray(views?.views) ? views.views : [];
  const goodTiers = new Set(["clean_watch", "thin_watch", "high_risk_watch"]);
  const candidates = rows
    .filter((row) => row?.direction === "long_watch" && goodTiers.has(row?.tier))
    .slice(0, 5);
  const blockers = Array.isArray(evidencePack?.blockers) ? evidencePack.blockers : [];
  const trial = trialGateStatus([], evidencePack, rules);
  const best = precision?.best_frontier_variant || {};
  const validationRate = best?.validation?.positive_rate;
  const testRate = best?.test?.positive_rate;
  const frontier = Number.isFinite(validationRate) && Number.isFinite(testRate)
    ? `frontier 約 ${percentText(validationRate)} / ${percentText(testRate)}。不是 live 勝率。`
    : "frontier 還不能讀成勝率。";
  const candidateText = candidates.length
    ? candidates.map((row, index) => `${index + 1}. ${row.ticker}：${row.tier}；${row.action_policy}。${row.plain_language || ""}`).join("\n")
    : "沒有乾淨到可以說的候選。";
  return [
    "\u7f8e\u80a1\u3002\u8cc7\u6599\u5148\u8aaa\u3002\u7814\u7a76\u9810\u6e2c\uff0c\u4e0d\u662f\u4e0b\u55ae\u3002",
    `狀態: ${trial.trialOpen ? "試用觀察版" : "僅能觀察"}；${blockers.length ? blockers.map(gateBlockerLabel).join("、") : "無明顯限制"}。`,
    trial.trialOpen ? "試用: 可看研究預測與價位情境；不是買賣指令。" : "試用: 還沒開。",
    `候選:\n${candidateText}`,
    `驗證: ${frontier}`,
    "動作: 先觀察。驗證不足，只給研究預測。"
  ].join("\n");
}

function formatLeprechaunScanReplyV2(evidencePack, views, precision, rules) {
  const rows = Array.isArray(views?.views) ? views.views : [];
  const goodTiers = new Set(["clean_watch", "thin_watch", "high_risk_watch"]);
  const candidates = rows
    .filter((row) => row?.direction === "long_watch" && goodTiers.has(row?.tier))
    .slice(0, 5);
  const blockers = Array.isArray(evidencePack?.blockers) ? evidencePack.blockers : [];
  const trial = trialGateStatus([], evidencePack, rules);
  const best = precision?.best_frontier_variant || {};
  const validationRate = best?.validation?.positive_rate;
  const testRate = best?.test?.positive_rate;
  const frontier = Number.isFinite(validationRate) && Number.isFinite(testRate)
    ? `frontier 約 ${percentText(validationRate)} / ${percentText(testRate)}。不是 live 勝率。`
    : "frontier 還不能讀成勝率。";
  const candidateText = candidates.length
    ? candidates.map((row, index) => `${index + 1}. ${row.ticker}：${row.tier}；${row.action_policy}。${row.plain_language || ""}`).join("\n")
    : "沒有乾淨到可以說的候選。";
  return [
    "美股。資料先說。研究預測，不是下單。",
    `狀態: ${trial.trialOpen ? "試用觀察版" : "僅能觀察"}；${blockers.length ? blockers.map(gateBlockerLabel).join("、") : "無明顯限制"}。`,
    trial.trialOpen ? "試用: 可看研究預測與價位情境；不是買賣指令。" : "試用: 還沒開。",
    `候選:\n${candidateText}`,
    `驗證: ${frontier}`,
    trial.trialOpen ? "動作: 可測研究預測。正式交易驗證未完成，不下單。" : "動作: 先觀察。驗證不足，只給研究預測。",
  ].join("\n");
}

function defaultRecommendationTickers(rules) {
  const config = readLeprechaunResearchConfig(rules) || {};
  const tickers = Array.isArray(config.tickers) ? config.tickers : [];
  const cleaned = tickers.map(normalizeTicker).filter(Boolean);
  return cleaned.length ? cleaned : ["NVDA", "AMD", "TSM", "AVGO", "MU", "MRVL", "ORCL", "CIEN", "GLW", "PLTR", "SOFI", "INTC"];
}

function forecastGradeScore(grade) {
  return { A: 4, B: 3, C: 2, D: 1 }[String(grade || "").toUpperCase()] || 0;
}

function recommendationScore(prediction) {
  const gate = prediction.forecast_gate || {};
  const signal = prediction.indicators?.backtested_signal || {};
  const biasScore = prediction.bias === "bullish" ? 8.0 : prediction.bias === "neutral" ? 3.0 : -5.0;
  const riskPenalty = prediction.risk === "high" ? 1.2 : prediction.risk === "medium" ? 0.35 : 0;
  const frontierBonus = signal.status === "matches_best_frontier" ? 1.0 : 0;
  const momentum = Number(prediction.indicators?.ret_20d || 0) + Number(prediction.indicators?.ret_5d || 0) * 0.5;
  return forecastGradeScore(gate.grade) * 1.0
    + biasScore
    + Number(prediction.confidence || 0)
    + frontierBonus
    - riskPenalty
    + Number(prediction.score || 0) * 0.35
    + momentum * 4.0;
}

function topReasons(prediction) {
  const labels = {
    price_above_ma20: "站上 MA20",
    price_below_ma20: "低於 MA20",
    short_trend_above_mid_trend: "短線趨勢較強",
    short_trend_below_mid_trend: "短線趨勢弱",
    mid_trend_above_long_trend: "中期趨勢向上",
    mid_trend_not_confirmed: "中期未確認",
    positive_5d_momentum: "5D 動能正",
    negative_5d_momentum: "5D 動能弱",
    outperforming_spy_20d: "20D 贏 SPY",
    not_outperforming_spy_20d: "20D 輸 SPY",
    outperforming_qqq_20d: "20D 贏 QQQ",
    news_30d_positive_catalyst_direct: "近30日直接消息偏利多",
    news_30d_negative_catalyst_direct: "近30日直接消息偏利空",
    candle_30d_breakout: "30日突破",
    candle_30d_possible_accumulation: "可能承接",
    candle_30d_breakdown: "30日跌破",
    candle_30d_possible_distribution: "可能派發",
  };
  return (Array.isArray(prediction.reasons) ? prediction.reasons : [])
    .filter((reason) => !String(reason).includes("performance_gate"))
    .slice(0, 8)
    .map((reason) => labels[reason] || String(reason).replace(/^news_30d_/, "news "))
    .slice(0, 3)
    .join("、") || "訊號不足";
}

function formatRecommendationLine(prediction, index) {
  const gate = prediction.forecast_gate || {};
  const grade = gate.grade || "N/A";
  const confidence = Number.isFinite(Number(prediction.confidence)) ? `${Math.round(Number(prediction.confidence) * 100)}%` : "N/A";
  const biasText = prediction.bias === "bullish" ? "偏多" : prediction.bias === "bearish" ? "偏弱" : "盤整";
  const action = prediction.bias === "bullish"
    ? "可進候選"
    : prediction.bias === "neutral"
      ? "等回測進場"
      : "不急著進";
  const plan = buildResearchPricePlan(prediction);
  return [
    `#${index} ${prediction.ticker}｜${action}｜${biasText}｜等級 ${grade}｜信心 ${confidence}`,
    `價位: 觀察 ${plan.entry}｜失效 ${plan.stop}｜目標/壓力 ${plan.target}`,
    `理由: ${topReasons(prediction)}。`,
  ].join("\n");
}

async function runLeprechaunRecommendations(rules, limit = 5) {
  const tickers = defaultRecommendationTickers(rules);
  const predictions = await runStructuredLeprechaunResearch(tickers, rules, tickers.length);
  const candidates = predictions
    .filter((prediction) => {
      const signal = prediction.indicators?.cross_sectional_signal || {};
      return prediction.strategy_version === LEPRECHAUN_STRATEGY_VERSION
        && signal.status === "current"
        && signal.strategy_version === LEPRECHAUN_STRATEGY_VERSION
        && signal.selected === true
        && signal.risk_eligible === true;
    })
    .sort((a, b) => {
      const aRank = Number(a.indicators?.cross_sectional_signal?.rank ?? Number.MAX_SAFE_INTEGER);
      const bRank = Number(b.indicators?.cross_sectional_signal?.rank ?? Number.MAX_SAFE_INTEGER);
      return aRank - bRank;
    })
    .slice(0, Math.max(1, limit));
  return {
    strategyVersion: LEPRECHAUN_STRATEGY_VERSION,
    predictions,
    candidates,
    productionOpen: predictions.some((prediction) => prediction.performance_gate?.eligible === true),
  };
}

function formatLeprechaunRecommendations(result) {
  const predictions = Array.isArray(result?.predictions) ? result.predictions : [];
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const currentSignals = predictions.filter((prediction) => prediction.indicators?.cross_sectional_signal?.status === "current");
  if (candidates.length === 0) {
    if (currentSignals.length === 0) {
      return [
        `美股。${result?.strategyVersion || LEPRECHAUN_STRATEGY_VERSION} 的當期訊號不可用。`,
        "不使用舊排序補猜，也不提供買入名單。",
      ].join("\n");
    }
    const blockedTopK = currentSignals
      .filter((prediction) => {
        const signal = prediction.indicators?.cross_sectional_signal || {};
        return Number(signal.rank) <= Number(signal.top_k || 0) && signal.risk_eligible === false;
      })
      .sort((a, b) => Number(a.indicators.cross_sectional_signal.rank) - Number(b.indicators.cross_sectional_signal.rank))
      .map((prediction) => {
        const signal = prediction.indicators.cross_sectional_signal;
        return `${prediction.ticker}（rank ${signal.rank}；${(signal.risk_blockers || []).join(", ") || "risk gate rejected"}）`;
      });
    return [
      `美股。${result.strategyVersion} 今天沒有通過風險門檻的 Top-${currentSignals[0]?.indicators?.cross_sectional_signal?.top_k || 2} 候選。`,
      blockedTopK.length ? `被拒絕: ${blockedTopK.join("、")}。` : "沒有可用候選。",
      "不補位、不沿用舊排名。正式實盤 gate 尚未開啟，沒有買入建議。",
    ].join("\n");
  }
  const lines = candidates.map((prediction, index) => {
    const signal = prediction.indicators.cross_sectional_signal;
    const score = Number.isFinite(Number(signal.probability)) ? Number(signal.probability).toFixed(3) : "N/A";
    const plan = buildResearchPricePlan(prediction);
    return [
      `#${index + 1} ${prediction.ticker}｜cross-sectional rank ${signal.rank}｜排名分數 ${score}`,
      `研究價位: 觀察 ${plan.entry}｜失效 ${plan.stop}｜目標/壓力 ${plan.target}`,
    ].join("\n");
  });
  return [
    `美股。${result.strategyVersion} 當期研究候選。`,
    result.productionOpen
      ? "正式 gate 已開啟；仍需依風險限制判斷。"
      : "正式實盤 gate 尚未開啟；以下不是買入建議。",
    ...lines,
  ].join("\n");
}

function formatStockLine(symbol, stock) {
  if (!stock) return `${symbol} \u6c92\u6709\u53ef\u7528\u8cc7\u6599\u3002`;
  const price = stock.price == null ? "N/A" : stock.price;
  const chg = stock.chg || "N/A";
  const state = stock.verdict || "UNKNOWN";
  return `${symbol} ${price} ${chg}\u3002\u65e5\u7dda\u8b8a\u52d5\u72c0\u614b ${state}\uff08\u975e\u9810\u6e2c\uff09\u3002`;
}

function pct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function avg(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function min(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? Math.min(...clean) : null;
}

function max(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? Math.max(...clean) : null;
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}
async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("NO_DATA");
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const meta = result.meta || {};
  const lastTimestamp = Array.isArray(result.timestamp) ? result.timestamp.at(-1) : null;
  const validCloses = closes.filter((value) => Number.isFinite(value));
  if (!validCloses.length) throw new Error("NO_PRICE");
  const price = Number(meta.regularMarketPrice ?? validCloses.at(-1));
  const prev = Number(meta.previousClose ?? meta.regularMarketPreviousClose ?? validCloses.at(-2) ?? validCloses.at(-1));
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const recentHigh = max(highs.slice(-20));
  const recentLow = min(lows.slice(-20));
  const ma20 = avg(validCloses.slice(-20));
  const ma50 = avg(validCloses.slice(-50));
  const medVol = median(volumes.slice(-30));
  const lastVol = volumes.filter((value) => Number.isFinite(value)).at(-1);
  const volRatio = medVol ? lastVol / medVol : null;
  return {
    symbol,
    price,
    changePct,
    recentHigh,
    recentLow,
    ma20,
    ma50,
    volRatio,
    source: "Yahoo chart / 3mo / 1d",
    asOf: Number.isFinite(lastTimestamp) ? new Date(lastTimestamp * 1000).toISOString() : null,
  };
}

function buildEntryPlan(data) {
  const price = data.price;
  const support = data.recentLow;
  const resistance = data.recentHigh;
  const ma20 = data.ma20;
  const ma50 = data.ma50;
  const trend = ma20 && ma50 ? (ma20 > ma50 ? "\u504f\u591a" : ma20 < ma50 ? "\u504f\u5f31" : "\u76e4\u6574") : "\u672a\u77e5";
  const pullback = support && ma20 ? avg([support, ma20]) : support || ma20;
  const breakout = resistance ? resistance * 1.01 : null;
  const stop = support ? support * 0.97 : null;
  const chaseRisk = resistance && price > resistance * 0.98 ? "\u8ffd\u9ad8\u98a8\u96aa" : "\u7b49\u4f4d\u7f6e";
  return {
    trend,
    support,
    resistance,
    pullback,
    breakout,
    stop,
    chaseRisk,
  };
}

function money(value) {
  return Number.isFinite(value) ? value.toFixed(value >= 100 ? 2 : 3) : "N/A";
}

function formatResearchReply(data) {
  const plan = buildEntryPlan(data);
  const vol = data.volRatio ? ` \u91cf${data.volRatio.toFixed(1)}x` : "";
  const asOf = data.asOf ? renderLocalTime(data.asOf) : "時間未提供";
  return [
    `${data.symbol}: ${plan.trend}\uff1b${plan.chaseRisk}${vol}`,
    `\u89c0\u5bdf: ${money(data.price)} ${pct(data.changePct)}\uff1bMA20 ${money(data.ma20)}\uff1bMA50 ${money(data.ma50)}`,
    `\u98a8\u96aa: 20\u65e5\u5340\u9593 ${money(data.recentLow)} - ${money(data.recentHigh)}`,
    `\u50f9\u4f4d: \u56de\u6e2c\u89c0\u5bdf ${money(plan.pullback)}\uff1b\u7a81\u7834\u78ba\u8a8d ${money(plan.breakout)}\u3002`,
    "\u4e0d\u78ba\u5b9a: \u53ea\u6709\u65e5\u7dda\u898f\u5247\uff1b\u4e0d\u542b\u8ca1\u5831\u3001\u4e8b\u4ef6\u6216\u5373\u6642 order flow\u3002",
    `\u8cc7\u6599: ${data.source}\uff1b\u622a\u81f3 ${asOf}`,
  ].join("\n");
}

async function handleLeprechaun(text, rules) {
  if (!rules.leprechaun?.enabled) return null;
  const clean = stripMention(text);
  const mentionsLeprechaun = /leprechaun|\u6230\u60c5|\u76e4\u9762|\u5e02\u5834|\u80a1\u7968|\u7f8e\u80a1|\u79d1\u6280\u80a1|\u9032\u5834|\u8cb7\u5165|\u63a8\u85a6|\u7de8\u968a|\u5075\u5bdf|\u96f7\u666e|\u5c0f\u968a|dashboard/i.test(clean);
  const explicitStockIntent = hasExplicitStockIntent(clean) || hasTickerLookIntent(clean) || /leprechaun|dashboard|\u7de8\u968a|\u5c0f\u968a|squad|\u6230\u60c5\u677f|\u5100\u8868\u677f/i.test(clean);
  const tickers = extractTickers(clean);
  const telemetry = readLeprechaunTelemetry(rules);

  if (/dashboard|\u5100\u8868\u677f|\u6230\u60c5\u677f|\u9762\u677f/i.test(clean) && /leprechaun|\u6230\u60c5|\u76e4\u9762|dashboard|\u5100\u8868\u677f|\u6230\u60c5\u677f|\u9762\u677f/i.test(clean)) {
    return {
      handled: true,
      kind: "leprechaun_dashboard",
      reply: rules.leprechaun.dashboardUrl || "http://127.0.0.1:8000/tactical_preview.html",
    };
  }

  if (explicitStockIntent && /(\u7de8\u968a|\u5c0f\u968a|squad)/i.test(clean) && tickers.length > 0) {
    const maxSquad = Number(rules.leprechaun.maxSquad || 6);
    const squad = tickers.slice(0, Math.max(1, maxSquad));
    writeLeprechaunCommand(rules, { squad });
    return { handled: true, kind: "leprechaun_squad", reply: `\u55ef\u3002\u7de8\u968a\u3002${squad.join("\u3001")}\u3002` };
  }

  if (explicitStockIntent && tickers.length === 0 && /(gate|\u72c0\u614b|\u9032\u5ea6|\u9a57\u8b49|\u52dd\u7387|\u8a66\u7528)/i.test(clean)) {
    try {
      return {
        handled: true,
        kind: "leprechaun_status",
        reply: "現在不看開關。直接用預測排序、價位區、失效價、目標區來測。",
      };
    } catch (err) {
      console.error(`[rana-hot-tools] leprechaun status failed: ${err.message}`);
      return {
        handled: true,
        kind: "leprechaun_data_unavailable",
        reply: "\u7f8e\u80a1\u9a57\u8b49\u8cc7\u6599\u6293\u53d6\u5931\u6557\u3002",
      };
    }
  }

  if (explicitStockIntent && tickers.length === 0 && /(\u63a8\u85a6|\u5efa\u8b70|\u503c\u5f97|\u53ef\u4ee5\u9032|\u80fd\u9032|\u9032\u5834|\u8cb7\u5165|\u8cb7\u54ea|recommend|buy|entry)/i.test(clean)) {
    try {
      const recommendations = await runLeprechaunRecommendations(rules, 5);
      return {
        handled: true,
        kind: "leprechaun_recommend",
        reply: formatLeprechaunRecommendations(recommendations),
      };
    } catch (err) {
      console.error(`[rana-hot-tools] leprechaun recommendation failed: ${err.message}`);
      return {
        handled: true,
        kind: "leprechaun_data_unavailable",
        reply: "美股資料抓取失敗。不是沒資料，是工具那邊沒跑通。",
      };
    }
  }

  if (explicitStockIntent && tickers.length === 0 && hasBroadStockScanIntent(clean)) {
    try {
      const evidencePack = await runLeprechaunEvidencePack(rules);
      const views = readLeprechaunResearchViews(rules);
      const precision = readLeprechaunPrecisionFrontier(rules);
      return {
        handled: true,
        kind: "leprechaun_scan",
        reply: formatLeprechaunScanReplyV2(evidencePack, views, precision, rules),
      };
    } catch (err) {
      console.error(`[rana-hot-tools] leprechaun scan failed: ${err.message}`);
      return {
        handled: true,
        kind: "leprechaun_data_unavailable",
        reply: "推薦清單產生失敗。要重跑 Leprechaun 預測資料。",
      };
    }
  }

  if (explicitStockIntent && tickers.length > 0) {
    try {
      const evidencePack = await runLeprechaunEvidencePack(rules);
      const ranking = readLeprechaunCandidateRanking(rules);
      const reliability = readLeprechaunReliabilityReport(rules);
      const views = readLeprechaunResearchViews(rules);
      const predictions = await runStructuredLeprechaunResearch(tickers, rules);
      return {
        handled: true,
        kind: "leprechaun_ticker",
        reply: `\u7f8e\u80a1\u3002\u8cc7\u6599\u5148\u8aaa\u3002\u7814\u7a76\u9810\u6e2c\uff0c\u4e0d\u662f\u4e0b\u55ae\u3002\n${formatResearchGateSummary(predictions, evidencePack, rules)}\n\n${predictions.map((prediction) => formatStructuredResearchReply(prediction, rules, evidencePack, ranking, reliability, views)).join("\n\n")}`,
      };
    } catch (err) {
      console.error(`[rana-hot-tools] structured stock research failed: ${err.message}`);
      return {
        handled: true,
        kind: "leprechaun_data_unavailable",
        reply: "\u80a1\u7968\u8cc7\u6599\u6c92\u9192\u3002\u4e0d\u80fd\u88dc\u6545\u4e8b\u3002",
      };
    }
    const lines = [];
    for (const ticker of tickers.slice(0, 3)) {
      try {
        lines.push(formatResearchReply(await fetchYahooChart(ticker)));
      } catch (err) {
        lines.push(`${ticker}\n\u8cc7\u6599: Yahoo \u884c\u60c5\u5931\u6557\u3002\n\u4e0d\u78ba\u5b9a: \u4e0d\u80fd\u7528\u820a telemetry \u88dc\u5224\u65b7\u3002\n\u52d5\u4f5c: \u4e0d\u5f62\u6210\u89c0\u9ede\u3002`);
      }
    }
    return { handled: true, kind: "leprechaun_ticker", reply: `\u7f8e\u80a1\u3002\u8cc7\u6599\u5148\u8aaa\u3002\u7814\u7a76\u9810\u6e2c\uff0c\u4e0d\u662f\u4e0b\u55ae\u3002\n${lines.join("\n\n")}` };
  }

  if (explicitStockIntent && mentionsLeprechaun) {
    const trust = telemetryTrust(telemetry);
    let evidencePack = null;
    try {
      evidencePack = await runLeprechaunEvidencePack(rules);
    } catch (err) {
      console.error(`[rana-hot-tools] evidence pack refresh failed: ${err.message}`);
    }
    if (!trust.ok) {
      return {
        handled: true,
        kind: "leprechaun_data_unavailable",
        reply: "戰情資料過期或來源不明。不能形成觀點。",
      };
    }
    const stocks = telemetry?.stocks || {};
    const squad = readLeprechaunCommand(rules).squad || Object.keys(stocks).slice(0, 6);
    const lines = squad.slice(0, 4).map((ticker) => formatStockLine(ticker, stocks[ticker]));
    if (lines.length === 0) return { handled: true, kind: "leprechaun_empty", reply: "\u6230\u60c5\u6c92\u9192\u3002" };
    const ranking = readLeprechaunCandidateRanking(rules);
    const rankingSummary = evidencePack?.source_state?.candidate_ranking || ranking?.summary || {};
    const reliabilitySummary = evidencePack?.source_state?.reliability_report || {};
    const viewsSummary = evidencePack?.source_state?.research_views || readLeprechaunResearchViews(rules) || {};
    const stance = viewsSummary.overall_stance || "unknown_stance";
    const abstain = viewsSummary.abstain || {};
    const abstainLine = abstain.required ? `暫不進場: ${abstain.reason || "證據不足"}。${abstain.detail || ""}` : "暫不進場: 否。";
    const viewLineNew = viewsSummary.best_research_watch
      ? `研究觀點: ${viewsSummary.best_research_watch} ${viewsSummary.best_research_tier || "watch"}；${stance}；不可當買賣建議。`
      : `研究觀點: 尚未建立；${stance}。`;
    const bestLine = rankingSummary.best_long_candidate ? `觀察順位: ${rankingSummary.best_long_candidate} rank ${rankingSummary.best_long_rank_score ?? "N/A"}。` : "觀察順位: ranking 尚未建立。";
    const supportedLine = reliabilitySummary.best_supported_long_candidate ? `歷史 prior: ${reliabilitySummary.best_supported_long_candidate} support ${reliabilitySummary.best_supported_value ?? "N/A"}；不可當 live 勝率。` : "歷史 prior: 尚未建立。";
    const verificationLine = evidencePack?.readiness ? `驗證: ${evidencePack.readiness}；${(evidencePack.blockers || []).join(", ") || "no blockers"}。` : "驗證: evidence pack 不可用。";
    return { handled: true, kind: "leprechaun_summary", reply: `${lines.join(" ")}\n${viewLineNew}\n${abstainLine}\n${bestLine}\n${supportedLine}\n${verificationLine}` };
    const best = rankingSummary.best_long_candidate ? `觀察順位: ${rankingSummary.best_long_candidate} rank ${rankingSummary.best_long_rank_score ?? "N/A"}。` : "觀察順位: ranking 尚未建立。";
    const supported = reliabilitySummary.best_supported_long_candidate ? `歷史 prior: ${reliabilitySummary.best_supported_long_candidate} support ${reliabilitySummary.best_supported_value ?? "N/A"}；不可當 live 勝率。` : "歷史 prior: 尚未建立。";
    const viewLine = viewsSummary.best_research_watch ? `研究觀點: ${viewsSummary.best_research_watch} ${viewsSummary.best_research_tier || "watch"}；不可當買賣建議。` : "研究觀點: 尚未建立。";
    const verification = evidencePack?.readiness ? `驗證: ${evidencePack.readiness}；${(evidencePack.blockers || []).join(", ") || "no blockers"}。` : "驗證: evidence pack 不可用。";
    return { handled: true, kind: "leprechaun_summary", reply: `${lines.join(" ")}\n${viewLine}\n${best}\n${supported}\n${verification}` };
  }

  return null;
}
function handleFallback(text, rules) {
  return { handled: false, kind: "pass", reply: "" };
}

async function decide(payload) {
  const rules = readJson(RULES_PATH, { fallbacks: [], defaultReply: "無聊。" });
  const text = textOf(payload.body || payload.content || payload.text);
  if (!isOwner(payload, rules) && isOwnerOnlyIntent(text)) {
    const clean = stripMention(text);
    const allowedMemoryWrite = isMemoryWriteIntent(clean) && await canWriteMemory(payload, rules);
    const allowedMemoryDelete = isMemoryDeleteIntent(clean) && await canDeleteMemory(payload, rules);
    if (!allowedMemoryWrite && !allowedMemoryDelete) {
      return ownerOnlyReply();
    }
  }
  return await Promise.resolve(handleMemory(text, rules))
    .then((result) => result || handleReminder(text, rules))
    .then(async (result) => result || await handleLeprechaun(text, rules))
    .then((result) => result || handleMonitor(text))
    .then((result) => result || handleReaction(text, rules))
    .then(async (result) => result || await handleWeather(text, rules))
    .then(async (result) => result || await handleCurrency(text, rules))
    .then(async (result) => result || await handleTranslation(text, rules))
    .then(async (result) => result || await handleUrlSummary(text, rules))
    .then((result) => result || handleFallback(text, rules));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const rules = readJson(RULES_PATH, {});
    return send(res, 200, {
      status: "ok",
      rulesVersion: rules.version || null,
      leprechaunStrategyVersion: LEPRECHAUN_STRATEGY_VERSION,
      memory: memoryStatus(),
    });
  }
  if (req.method === "GET" && req.url === "/memory/status") {
    return send(res, 200, memoryStatus());
  }
  if (req.method === "POST" && req.url === "/stock/research") {
    const payload = await parseBody(req);
    const rules = readJson(RULES_PATH, {});
    if (senderIdOf(payload) && !isOwner(payload, rules) && !await canUseTools(payload, rules)) {
      return send(res, 403, ownerOnlyReply());
    }
    const text = textOf(payload.query || payload.text || payload.body || payload.content);
    const decision = await handleLeprechaun(text, rules);
    return send(res, 200, decision || { handled: false, kind: "leprechaun_pass", reply: "" });
  }
  if (req.method === "POST" && req.url === "/memory/remember") {
    const payload = await parseBody(req);
    const rules = readJson(RULES_PATH, {});
    if (senderIdOf(payload) && !await canWriteMemory(payload, rules)) {
      return send(res, 403, ownerOnlyReply());
    }
    const rawText = textOf(payload.text || payload.value);
    const text = normalizeMemoryText(isMemoryWriteIntent(rawText) ? extractMemoryText(rawText) : rawText);
    if (!text || isSensitiveMemory(text)) {
      return send(res, 400, { handled: true, kind: "memory_rejected", reply: "這個不記。" });
    }
    appendWorkspaceMemory(text);
    return send(res, 200, { handled: true, kind: "memory_save", reply: "嗯。記住了。", status: memoryStatus() });
  }
  if (req.method === "POST" && req.url === "/memory/delete") {
    const payload = await parseBody(req);
    const rules = readJson(RULES_PATH, {});
    if (senderIdOf(payload) && !await canDeleteMemory(payload, rules)) {
      return send(res, 403, ownerOnlyReply());
    }
    const rawText = textOf(payload.query || payload.text || payload.value);
    const query = normalizeMemoryText(isMemoryDeleteIntent(rawText) ? extractMemoryDeleteText(rawText) : rawText);
    if (!query) {
      return send(res, 400, { handled: true, kind: "memory_delete_empty", reply: "忘記什麼。" });
    }
    const result = removeWorkspaceMemory(query);
    return send(res, 200, {
      handled: true,
      kind: result.removed > 0 ? "memory_delete" : "memory_delete_miss",
      reply: result.removed > 0 ? "嗯。忘了。" : "沒有那個。",
      removed: result.removed,
      items: result.items,
      status: memoryStatus(),
    });
  }
if (req.method === "POST" && req.url === "/memory/recall") {
  const payload = await parseBody(req);
  const rawQuery = textOf(payload.query || payload.text);

  if (isCurrentSessionMemoryQuestion(rawQuery)) {
    return send(res, 200, {
      ok: true,
      handled: true,
      kind: "memory_session_required",
      found: false,
      hit: false,
      source: "session_required",
      confidence: 0,
      query: normalizeRecallQuery(rawQuery),
      item: null,
      items: [],
      matches: [],
      error: null,
      reply: "這是目前對話範圍，不是長期記憶。",
    });
  }

  const needle = normalizeRecallQuery(rawQuery);

  if (!needle) {
    return send(res, 200, {
      ok: true,
      handled: true,
      kind: "memory_recall_empty",
      found: false,
      hit: false,
      source: "memory",
      confidence: 0,
      query: "",
      item: null,
      items: [],
      matches: [],
      error: null,
      reply: "問哪件事。",
    });
  }

  const items = readMarkdownMemories();

  const matches = [...items]
    .reverse()
    .filter((item) => memoryMatches(item.text, needle))
    .slice(0, 5);

  const found = matches[0] || null;

  console.log(
    `[rana-hot-tools] memory_recall found=${Boolean(found)} query="${needle}" matches=${matches.length}`
  );

  return send(res, 200, {
    ok: true,
    handled: true,
    kind: "memory_recall",
    found: Boolean(found),
    hit: Boolean(found),
    source: "memory",
    confidence: found ? 0.8 : 0,
    query: needle,
    item: found,
    items: matches,
    matches,
    error: null,
  });
}
  if (req.method === "POST" && req.url === "/decide") {
    const payload = await parseBody(req);
    const decision = await decide(payload);
    console.log(`[rana-hot-tools] kind=${decision.kind} text="${stripMention(textOf(payload.body || payload.content || payload.text)).slice(0, 160)}"`);
    return send(res, 200, decision);
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[rana-hot-tools] listening on http://127.0.0.1:${PORT}`);
});

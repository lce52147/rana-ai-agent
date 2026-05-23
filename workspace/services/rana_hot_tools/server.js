const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.RANA_HOT_TOOLS_PORT || 8091);
const ROOT = __dirname;
const RULES_PATH = path.join(ROOT, "rules.json");
const MEMORY_PATH = path.join(ROOT, "memory.json");
const REMINDERS_PATH = path.join(ROOT, "reminders.json");
const MONITORS_PATH = path.join(ROOT, "monitors.json");
const DEFAULT_LEPRECHAUN_ROOT = "D:\\_Project\\Leprechaun";
const cooldowns = new Map();

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`[rana-hot-tools] failed to read ${path.basename(filePath)}: ${err.message}`);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function stripMention(text) {
  return text.replace(/^\s*@?rana\b[:,，、\s]*/i, "").replace(/^\s*樂奈[:,，、\s]*/, "").trim();
}

function stripQuestionTail(text) {
  return text.replace(/[嗎呢?？。.\s]+$/g, "").trim();
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
  const recall = clean.match(/^(?:你)?(?:還)?記得\s*(.+)?/);
  if (recall && !/^(?:記住|記得提醒)/.test(clean)) {
    const needle = stripQuestionTail(textOf(recall[1]).trim());
    const memory = readJson(MEMORY_PATH, { items: [] });
    const items = Array.isArray(memory.items) ? memory.items : [];
    const found = [...items].reverse().find((item) => !needle || textOf(item.text).includes(needle));
    if (found) {
      const template = rules.memory.recallReply || "記得。{value}";
      return { handled: true, kind: "memory_recall", reply: template.replace("{value}", found.text) };
    }
    return { handled: true, kind: "memory_recall", reply: "不記得。" };
  }
  const remember = clean.match(/^(?:記住|記得)\s+(.+)/);
  if (remember) {
    const memory = readJson(MEMORY_PATH, { items: [] });
    memory.items = Array.isArray(memory.items) ? memory.items : [];
    memory.items.push({ text: remember[1].trim(), createdAt: new Date().toISOString() });
    writeJson(MEMORY_PATH, memory);
    return { handled: true, kind: "memory_save", reply: rules.memory.reply || "嗯。記住了。" };
  }
  return null;
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
  const match = clean.match(/(?:天氣|下雨|會下雨嗎|氣溫)\s*([^\s?？]*)|([^\s?？]+)\s*(?:天氣|會下雨嗎|下雨|氣溫)/);
  const location = stripQuestionTail(match?.[1] || match?.[2] || "")
    .replace(/(?:今天|明天|現在|目前|待會|等等|會)+$/g, "")
    .trim();
  if (!location || /^(今天|明天|現在)$/.test(location)) return rules.weather?.defaultLocation || "Taipei";
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,precipitation&hourly=precipitation_probability&forecast_days=1&timezone=auto`;
    const data = JSON.parse(await fetchText(url, 7000));
    const temp = Math.round(Number(data.current?.temperature_2m));
    const chance = (data.hourly?.precipitation_probability || []).map(Number).filter(Number.isFinite);
    const rain = chance.length ? Math.max(...chance.slice(0, 12)) : Number(data.current?.precipitation || 0) > 0 ? 80 : 0;
    const phrase = rain >= 50 ? "會。帶傘。" : temp >= 28 ? "不會。熱。" : "不會。";
    return { handled: true, kind: "weather", reply: `${phrase}${place.name} ${temp}度。` };
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
    "ENTRY", "POINT", "POINTS", "STOCK", "STOCKS", "MARKET", "DASHBOARD"
  ]);
  return [...new Set(raw.map(normalizeTicker).filter((ticker) => ticker && !blocked.has(ticker)))];
}

function formatStockLine(symbol, stock) {
  if (!stock) return `${symbol} 沒資料。`;
  const price = stock.price == null ? "N/A" : stock.price;
  const chg = stock.chg || "N/A";
  const verdict = stock.verdict || "UNKNOWN";
  return `${symbol} ${price} ${chg}。${verdict}。`;
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
  const validCloses = closes.filter((value) => Number.isFinite(value));
  if (!validCloses.length) throw new Error("NO_PRICE");
  const price = Number(meta.regularMarketPrice ?? validCloses.at(-1));
  const prev = Number(meta.chartPreviousClose ?? validCloses.at(-2) ?? validCloses.at(-1));
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const recentHigh = max(highs.slice(-20));
  const recentLow = min(lows.slice(-20));
  const ma20 = avg(validCloses.slice(-20));
  const ma50 = avg(validCloses.slice(-50));
  const medVol = median(volumes.slice(-30));
  const lastVol = volumes.filter((value) => Number.isFinite(value)).at(-1);
  const volRatio = medVol ? lastVol / medVol : null;
  return { symbol, price, changePct, recentHigh, recentLow, ma20, ma50, volRatio };
}

function buildEntryPlan(data) {
  const price = data.price;
  const support = data.recentLow;
  const resistance = data.recentHigh;
  const ma20 = data.ma20;
  const ma50 = data.ma50;
  const trend = ma20 && ma50 ? (ma20 > ma50 ? "偏多" : ma20 < ma50 ? "偏空" : "整理") : "未知";
  const pullback = support && ma20 ? avg([support, ma20]) : support || ma20;
  const breakout = resistance ? resistance * 1.01 : null;
  const stop = support ? support * 0.97 : null;
  const chaseRisk = resistance && price > resistance * 0.98 ? "追高風險" : "等位置";
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

function formatEntryReply(data) {
  const plan = buildEntryPlan(data);
  const vol = data.volRatio ? `量${data.volRatio.toFixed(1)}x。` : "";
  return `${data.symbol} ${money(data.price)} ${pct(data.changePct)}。${plan.trend}。觀察 ${money(plan.pullback)} / 突破 ${money(plan.breakout)}。守 ${money(plan.stop)}。${vol}${plan.chaseRisk}。`;
}

async function handleLeprechaun(text, rules) {
  if (!rules.leprechaun?.enabled) return null;
  const clean = stripMention(text);
  const mentionsLeprechaun = /leprechaun|戰情|盤面|市場|股票|編隊|偵察|雷普|小隊|dashboard/i.test(clean);
  const tickers = extractTickers(clean);
  const telemetry = readLeprechaunTelemetry(rules);

  if (/dashboard|儀表板|戰情板|面板/i.test(clean) && /leprechaun|戰情|盤面|dashboard|儀表板|戰情板|面板/i.test(clean)) {
    return {
      handled: true,
      kind: "leprechaun_dashboard",
      reply: rules.leprechaun.dashboardUrl || "http://127.0.0.1:8000/tactical_preview.html",
    };
  }

  if (/(編隊|小隊|squad)/i.test(clean) && tickers.length > 0) {
    const maxSquad = Number(rules.leprechaun.maxSquad || 6);
    const squad = tickers.slice(0, Math.max(1, maxSquad));
    writeLeprechaunCommand(rules, { squad });
    return { handled: true, kind: "leprechaun_squad", reply: `嗯。編隊。${squad.join("、")}。` };
  }

  if (tickers.length > 0) {
    const lines = [];
    for (const ticker of tickers.slice(0, 3)) {
      try {
        lines.push(formatEntryReply(await fetchYahooChart(ticker)));
      } catch (_) {
        const stocks = telemetry?.stocks || {};
        lines.push(formatStockLine(ticker, stocks[ticker]));
      }
    }
    return { handled: true, kind: "leprechaun_ticker", reply: lines.join(" ") };
  }

  if (mentionsLeprechaun) {
    const stocks = telemetry?.stocks || {};
    const squad = readLeprechaunCommand(rules).squad || Object.keys(stocks).slice(0, 6);
    const lines = squad.slice(0, 4).map((ticker) => formatStockLine(ticker, stocks[ticker]));
    if (lines.length === 0) return { handled: true, kind: "leprechaun_empty", reply: "戰情沒醒。" };
    return { handled: true, kind: "leprechaun_summary", reply: lines.join(" ") };
  }

  return null;
}

function handleFallback(text, rules) {
  const clean = stripMention(text);
  for (const rule of rules.fallbacks || []) {
    const patterns = Array.isArray(rule.patterns) ? rule.patterns : [];
    if (patterns.some((pattern) => pattern && clean.toLowerCase().includes(String(pattern).toLowerCase()))) {
      return { handled: true, kind: `fallback:${rule.id || "rule"}`, reply: rule.reply || rules.defaultReply || "無聊。" };
    }
  }
  return { handled: true, kind: "fallback:default", reply: rules.defaultReply || "無聊。" };
}

function decide(payload) {
  const rules = readJson(RULES_PATH, { fallbacks: [], defaultReply: "無聊。" });
  const text = textOf(payload.body || payload.content || payload.text);
  return Promise.resolve(handleMemory(text, rules))
    .then((result) => result || handleReminder(text, rules))
    .then((result) => result || handleMonitor(text))
    .then((result) => result || handleReaction(text, rules))
    .then(async (result) => result || await handleWeather(text, rules))
    .then(async (result) => result || await handleCurrency(text, rules))
    .then(async (result) => result || await handleTranslation(text, rules))
    .then(async (result) => result || await handleUrlSummary(text, rules))
    .then(async (result) => result || await handleLeprechaun(text, rules))
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
    return send(res, 200, { status: "ok", rulesVersion: rules.version || null });
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

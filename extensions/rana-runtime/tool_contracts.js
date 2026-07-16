const URL_RE = /https?:\/\/\S+/i;
const AUDIO_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com|bilibili\.com|b23\.tv|soundcloud\.com)\/\S+/i;

const RANA_NAME_RE = new RegExp("(?:^|\\s)@?(?:rana|\\u6a02\\u5948)(?:#\\d{4})?(?=\\s|$|[,.!?;:\\u3002\\uff0c\\uff1f\\uff01])", "i");
const PLAY_VERB_RE = new RegExp("(?:play|queue\\s+up|\\u64ad\\u653e|\\u64a5\\u653e|\\u9ede\\u6b4c|\\u653e\\u4e00\\u4e0b|\\u653e\\s*)", "i");
const PLAY_COMMAND_RE = new RegExp(
  "(?:^|\\s)(?:@?(?:rana|\\u6a02\\u5948)(?:#\\d{4})?\\s*)?(?:(?:\\u5e6b\\u6211|\\u8acb)\\s*)?(?:(?:play|p)\\s+(.+)|(?:\\u64ad\\u653e|\\u64a5\\u653e|\\u9ede\\u6b4c|\\u653e\\u4e00\\u4e0b|\\u653e)\\s*(.+))",
  "i"
);
const BILIBILI_HINT_RE = new RegExp("(?:bilibili|bili|b23|B\\u7ad9|\\u54d4\\u54e9\\u54d4\\u54e9)", "i");

const PROTECTED_BARE_NOUNS = new Set([
  "ave mujica",
  "avemujica",
  "bang dream",
  "bandori",
  "crychic",
  "haneoka",
  "mygo",
  "mygo!!!!!",
  "ring",
  "tsukinomori",
  "\u6a02\u5948",
  "\u611b\u97f3",
  "\u723d\u4e16",
  "\u71c8",
  "\u7acb\u5e0c",
  "\u7766",
  "\u4f60",
  "\u6211",
  "\u4ed6",
  "\u5979",
]);

const DURABLE_MEMORY_SUBJECT_RE = /(?:\u7d2b\u8c93|168|\u65a7\u738b|\u7693\u7537\u54e5|\u963f\u5f69|\u5cf0\u6708\u5f8b|\u963f\u525b|\u6e2c\u8a66\u6b0a\u9650)/u;
const INSUFFICIENT_PLAY_TARGET_RE = /^(?:一首歌|一首|歌|音樂|歌曲|隨便一首|隨便放|something|music)$/iu;
const INSUFFICIENT_MEMORY_TEXT_RE = /^(?:一件事|這件事|某件事|一些事|一個東西|東西|something)$/iu;

export function firstText(value) {
  return typeof value === "string" ? value : "";
}

export function extractUserMessageText(value) {
  const text = firstText(value);
  if (!text) return "";
  const block = text.match(/UNTRUSTED Discord message body\s*\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/u);
  if (block?.[1]?.trim()) return block[1].trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ranaLine = [...lines].reverse().find((line) => isRanaMention(line));
  const candidate = ranaLine || text;
  // OpenClaw prefixes prompt text with a runtime timestamp; its GMT token is not a ticker.
  return candidate.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/u, "");
}

export function isRanaMention(text) {
  return RANA_NAME_RE.test(firstText(text));
}

export function stripRanaMention(text) {
  return extractUserMessageText(text)
    .replace(/<@!?\d+>/g, "")
    .replace(RANA_NAME_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMetaLanguageToolDiscussion(text) {
  const clean = stripRanaMention(text);
  if (!clean) return false;
  const hasToolWord = /(?:tool|tools|hot-tools|play|queue|skip|stock|ticker|music|memory|route|routing)/i.test(clean)
    || /(?:\u64ad\u653e|\u64a5\u653e|\u6b4c\u66f2|\u7f8e\u80a1|\u80a1\u7968|\u8a18\u61b6)/u.test(clean);
  const hasMetaMarker = /(?:\u4e0d\u8a72|\u4e0d\u8981|\u70ba\u4ec0\u9ebc|\u600e\u9ebc|\u89f8\u767c|\u8abf\u7528|\u95dc\u9375\u5b57|keyword|not music|not stock)/iu.test(clean);
  return hasToolWord && hasMetaMarker;
}

export function isPlainKeyword(value) {
  const text = firstText(value).trim();
  return Boolean(text && !URL_RE.test(text));
}

export function hasBilibiliHint(text) {
  return BILIBILI_HINT_RE.test(firstText(text));
}

export function stripSourceHint(text) {
  return firstText(text).replace(BILIBILI_HINT_RE, " ").replace(/\s+/g, " ").trim();
}

export function isMusicSourceUrl(url) {
  return AUDIO_URL_RE.test(firstText(url));
}

export function eventWasMentioned(event) {
  return event?.was_mentioned === true || event?.wasMentioned === true || event?.metadata?.was_mentioned === true || event?.discord?.was_mentioned === true;
}

export function hasExplicitPlayIntent(text) {
  return Boolean(parsePlayRequest({ body: text, content: text }));
}

export function parsePlayRequest(event) {
  const candidates = [firstText(event?.body), firstText(event?.content)].map(extractUserMessageText).filter(Boolean);
  for (const text of candidates) {
    if (isMetaLanguageToolDiscussion(text)) return null;
    const command = text.match(PLAY_COMMAND_RE);
    if (!command) continue;
    const target = firstText(command[1] || command[2]).trim().replace(/[>\])"'.,]+$/g, "");
    if (!target || INSUFFICIENT_PLAY_TARGET_RE.test(target)) continue;
    const url = target.match(URL_RE)?.[0]?.replace(/[>\])"'.,]+$/g, "");
    if (url && isMusicSourceUrl(url)) return { url, query: null, display: url };
    const source = hasBilibiliHint(text) || hasBilibiliHint(target) ? "bilibili" : "youtube";
    const query = stripSourceHint(target).replace(/^["'「『]+|["'」』]+$/g, "").trim();
    if (query) return { url: null, query, display: query, source };
  }
  return null;
}

export function parseControlRequest(event) {
  const text = [firstText(event?.body), firstText(event?.content)].map(extractUserMessageText).filter(Boolean).join("\n");
  if (!text) return null;
  const clean = stripRanaMention(text);
  if (!clean || isMetaLanguageToolDiscussion(clean)) return null;

  if (/^(?:join|\u9032\u4f86|\u52a0\u5165)\s*$/iu.test(clean) || /(?:join|voice|vc|\u9032\u4f86|\u52a0\u5165).*(?:voice|vc|\u8a9e\u97f3|\u983b\u9053)|(?:\u9032\u4f86\u6211\u9019\u500b\u983b\u9053)/iu.test(clean)) return { kind: "join" };
  if (/^(?:leave|disconnect|\u96e2\u958b|\u51fa\u53bb)\s*$/iu.test(clean) || /(?:leave|disconnect|\u96e2\u958b|\u51fa\u53bb).*(?:voice|vc|\u8a9e\u97f3|\u983b\u9053)|(?:\u96e2\u958b\u9019\u500b\u983b\u9053)/iu.test(clean)) return { kind: "leave" };
  if (/^(?:queue|\u5217\u8868|\u6b4c\u55ae|\u9084\u6709\u54ea\u4e9b\u6b4c|\u6b4c\u66f2\u5217\u8868)\s*[?\uff1f]?$/iu.test(clean)) return { kind: "queue" };
  if (/^(?:next|\u4e0b\u4e00\u9996)\s*$/iu.test(clean)) return { kind: "next" };
  const volumeSet = clean.match(/^(?:volume|vol|\u97f3\u91cf)\s*(?:=|:|\u8a2d(?:\u6210)?|to)?\s*(\d{1,3})\s*%?$/iu);
  if (volumeSet) return { kind: "volume", volume: Number(volumeSet[1]) };
  if (/^(?:volume\?|vol\?|\u97f3\u91cf\u591a\u5c11|\u73fe\u5728\u97f3\u91cf)\s*[?\uff1f]?$/iu.test(clean)) return { kind: "volume_query" };
  if (/^(?:volume down|vol down|\u5c0f\u8072|\u964d\u97f3\u91cf)\s*$/iu.test(clean)) return { kind: "volume", delta: -10 };
  if (/^(?:volume up|vol up|\u5927\u8072|\u52a0\u97f3\u91cf)\s*$/iu.test(clean)) return { kind: "volume", delta: 10 };
  if (/^(?:mute|\u975c\u97f3)\s*$/iu.test(clean)) return { kind: "volume", volume: 0 };
  const skip = clean.match(/^(?:skip|\u8df3\u904e|\u62ff\u6389)(?:\s*(?:\u9019\u4e00\u9996|current)|\s+(.+))?\s*$/iu);
  if (skip) return { kind: "skip", query: firstText(skip[1]).trim() || null };
  if (/^(?:stop|\u505c\u4e0b|\u505c)$/iu.test(clean)) return { kind: "stop" };
  return null;
}

export function normalizeBareNoun(value) {
  return firstText(value).trim().replace(/[。！？!?,.:;]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function isProtectedBareNoun(value) {
  return PROTECTED_BARE_NOUNS.has(normalizeBareNoun(value));
}

export function extractStockLikeTickers(text) {
  const raw = firstText(text).match(/\$?[A-Za-z][A-Za-z0-9.]{0,7}/g) || [];
  const blocked = new Set(["RANA", "LEPRECHAUN", "PLAY", "VOLUME", "JOIN", "LEAVE", "SKIP", "ENTRY", "POINT", "POINTS", "STOCK", "STOCKS", "MARKET", "DASHBOARD", "LIVE", "MYGO", "CRYCHIC", "RING", "AVE", "MUJICA"]);
  return [...new Set(raw
    .filter((token) => token.startsWith("$") || token === token.toUpperCase())
    .map((token) => token.replace(/^\$/, "").toUpperCase())
    .filter((token) => /^[A-Z0-9.]{1,8}$/.test(token) && !blocked.has(token)))];
}

export function hasTickerLookIntent(text) {
  const clean = firstText(text);
  if (extractStockLikeTickers(clean).length === 0) return false;
  return /(?:stock|ticker|analysis|predict|entry|buy|sell|scan)/i.test(clean)
    || /(?:\u7f8e\u80a1|\u80a1\u7968|\u5206\u6790|\u9810\u6e2c|\u9032\u5834|\u8cb7\u5165|\u8ce3\u51fa|\u63a8\u85a6|\u67e5)/u.test(clean);
}

export function hasExplicitStockIntent(text) {
  const clean = extractUserMessageText(text);
  return /(?:stock|stocks|ticker|predict|scan|backtest|entry|buy|sell|candidate|leprechaun)/i.test(clean)
    || /(?:\u7f8e\u80a1|\u80a1\u7968|\u5206\u6790|\u9810\u6e2c|\u9032\u5834|\u8cb7\u5165|\u8ce3\u51fa|\u63a8\u85a6|候\u9078|標\u7684)/u.test(clean);
}

export function isExplicitWebSearchIntent(text) {
  const clean = stripRanaMention(extractUserMessageText(text));
  if (!clean || isMetaLanguageToolDiscussion(clean)) return false;
  const explicitSearch = /(?:查一下|幫我查|查詢|搜尋|上網找|網路上找|lookup|search)/iu.test(clean);
  if (!explicitSearch) return false;
  const subject = clean.replace(/(?:請|麻煩)?\s*(?:幫我)?\s*(?:查一下|查詢|搜尋|上網找|網路上找|lookup|search)/giu, "").trim();
  return subject.length >= 2;
}

export function hasSufficientStockIntent(text) {
  const clean = extractUserMessageText(text);
  if (!(hasExplicitStockIntent(clean) || hasTickerLookIntent(clean))) return false;
  if (extractStockLikeTickers(clean).length > 0) return true;
  return /(?:scan|scanner|candidate|candidates|market-wide|全市場|美股市場|掃描|候選|標的)/iu.test(clean);
}

export function isCurrentSessionMemoryQuestion(text) {
  const clean = stripRanaMention(text);
  if (/(?:\u525b\u525b|\u4e0a\u9762|\u524d\u9762).*(?:\u8ab0\u554f|\u8ab0\u8aaa|\u8ab0\u6253|\u554f\u4e86\u4ec0\u9ebc|\u8aaa\u4e86\u4ec0\u9ebc)/u.test(clean)) return true;
  return /(?:session|\u525b\u525b|\u9019\u6bb5|\u76ee\u524d\u5c0d\u8a71|\u73fe\u5728\u9019\u500b)/iu.test(clean)
    && /(?:\u8a18\u5f97|\u8a18\u61b6|\u6211\u8aaa)/u.test(clean);
}

export function isExplicitMemoryIntent(text) {
  const clean = stripRanaMention(text);
  if (!clean) return false;
  const rememberCommand = clean.match(/^(?:\u5e6b\u6211)?(?:\u8a18\u4f4f|\u8a18\u4e0b)\s*(.+)$/u);
  if (rememberCommand?.[1]?.trim()) return !INSUFFICIENT_MEMORY_TEXT_RE.test(rememberCommand[1].trim());
  if (/^(?:\u8a18\u5f97)[\s\uff0c,]+.+/u.test(clean)) return true;
  if (/^(?:\u4ee5\u5f8c\u8981)?(?:\u8a18\u5f97)\s*.+/u.test(clean)) return true;
  if (/^.+\s*(?:\u5e6b\u6211)?(?:\u8a18\u4f4f|\u8a18\u4e0b)$/u.test(clean)) return true;
  if (/(?:\u4f60\u8a18\u5f97|\u9084\u8a18\u5f97|\u8a18\u5f97).+(?:\u55ce|\u55ce？|\?)/u.test(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:\u9152\u91cf|\u5bb9\u6613\u9189|\u559d\u9152|\u559d\u4e00\u676f|\u559d\u4e00\u4e0b|\u5f88\u6703\u559d|\u7537\u5a18|\u5e25\u54e5|\u65e9\u8d77|\u4e0d\u60f3\u8d77\u5e8a|\u8d77\u5e8a|\u854e\u9ea5\u9eb5|\u611b\u5403|\u559c\u6b61|\u662f\s*[01]|\u9084\u662f\s*[01])/u.test(clean)
    && /(?:\u884c\u4e0d\u884c|\u6703\u4e0d\u6703|\u662f\u4e0d\u662f|\u771f\u7684|\u70ba\u5565|\u70ba\u4ec0\u9ebc|\u70ba\u4f55|\u5c0d\u5427|\u9084\u8a18\u5f97|\u6709\u8a18\u4f4f|\u8a18\u5f97|\u4e4b\u524d|\u4e0a\u6b21|\u600e\u6a23|\u5982\u4f55|\u55ce|\?)/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (/(?:\u8ab0).*(?:\u9152\u91cf|\u5bb9\u6613\u9189|\u559d\u9152|\u7537\u5a18|\u5e25\u54e5|\u65e9\u8d77|\u4e0d\u60f3\u8d77\u5e8a|\u854e\u9ea5\u9eb5|\u611b\u5403|\u559c\u6b61)/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:\u9152\u91cf|\u5bb9\u6613\u9189|\u559d\u9152|\u7537\u5a18|\u662f\u4ec0\u9ebc\u4eba|\u662f\u8ab0|\u662f\u4ec0\u9ebc)/u.test(clean)
    && /(?:\u600e\u6a23|\u5982\u4f55|\u55ce|\?)?$/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:\u662f\u4ec0\u9ebc|\u662f\u8ab0|\u662f\u4e0d\u662f(?:\u73c2\u6735\u8389|\u7537\u5a18|\u5e25\u54e5|1)|\u600e\u6a23|\u5982\u4f55|\?)$/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (/\u559c\u597d/u.test(clean) && /(?:\u600e\u6a23|\u5982\u4f55|\u662f\u4ec0\u9ebc|\u591a\u5c11|\u55ce|\?)$/u.test(clean) && !isCurrentSessionMemoryQuestion(clean)) return true;
  return false;
}

export function parseMemoryRememberRequest(text) {
  const clean = stripRanaMention(text);
  if (!clean || isCurrentSessionMemoryQuestion(clean)) return null;
  let match = clean.match(/^(?:\u5e6b\u6211)?(?:\u8a18\u4f4f|\u8a18\u4e0b)\s*(.+)$/u);
  if (match?.[1]?.trim() && !INSUFFICIENT_MEMORY_TEXT_RE.test(match[1].trim())) return { action: "remember", text: match[1].trim() };
  match = clean.match(/^(?:\u8a18\u5f97)[\s\uff0c,]+(.+)$/u);
  if (match?.[1]?.trim() && !INSUFFICIENT_MEMORY_TEXT_RE.test(match[1].trim())) return { action: "remember", text: match[1].trim() };
  match = clean.match(/^(?:\u4ee5\u5f8c\u8981)?(?:\u8a18\u5f97)\s*(.+)$/u);
  if (match?.[1]?.trim() && !INSUFFICIENT_MEMORY_TEXT_RE.test(match[1].trim())) return { action: "remember", text: match[1].trim() };
  match = clean.match(/^(.+?)\s*(?:\u5e6b\u6211)?(?:\u8a18\u4f4f|\u8a18\u4e0b)$/u);
  if (match?.[1]?.trim() && !INSUFFICIENT_MEMORY_TEXT_RE.test(match[1].trim())) return { action: "remember", text: match[1].trim() };
  return null;
}

export function parseMemoryDeleteRequest(text) {
  const clean = stripRanaMention(text);
  if (!clean || isCurrentSessionMemoryQuestion(clean)) return null;
  let match = clean.match(/^(?:幫我)?(?:忘記|刪掉|刪除|移除|不要記得)\s*(.+)$/u);
  if (match?.[1]?.trim()) return { action: "forget", text: match[1].trim() };
  match = clean.match(/^(.+?)\s*(?:忘記|刪掉|刪除|移除)$/u);
  if (match?.[1]?.trim()) return { action: "forget", text: match[1].trim() };
  return null;
}

export function parseMemoryRecallRequest(text) {
  const clean = stripRanaMention(text).replace(/\s+/g, " ").trim();
  if (!clean || isCurrentSessionMemoryQuestion(clean) || parseMemoryRememberRequest(text) || parseMemoryDeleteRequest(text)) return null;
  let match = clean.match(/^(?:你|妳)?(?:還)?記得\s*((?:我|我的|使用者).+?)(?:嗎)?[?？]?$/u);
  if (match?.[1]?.trim()) {
    const subject = match[1].replace(/(?:什麼|哪一個|哪個)/gu, "").trim();
    if (subject) return { action: "recall", text: clean, subject };
  }
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:\u662f\u4ec0\u9ebc|\u662f\u8ab0|\u662f\u4e0d\u662f(?:\u73c2\u6735\u8389|\u7537\u5a18|\u5e25\u54e5|1)|\u600e\u6a23|\u5982\u4f55|\?)$/u.test(clean)) {
    const subject = clean.match(DURABLE_MEMORY_SUBJECT_RE)?.[0] || clean;
    return { action: "recall", text: clean, subject };
  }
  match = clean.match(/^(?:\u4f60)?(?:\u78ba\u5b9a|\u78ba\u8a8d)\s*(?:\u662f)?\s*([^\s\u55ce?？]{1,12})(?:\u55ce)?[?？]?$/u);
  if (match?.[1]?.trim()) {
    const subject = match[1].trim();
    if (!subject || isProtectedBareNoun(subject)) return null;
    return { action: "recall", text: clean, subject };
  }
  if (/(?:\u8ab0).*(?:\u9152\u91cf|\u5bb9\u6613\u9189|\u559d\u9152|\u7537\u5a18|\u5e25\u54e5|\u65e9\u8d77|\u4e0d\u60f3\u8d77\u5e8a|\u854e\u9ea5\u9eb5|\u611b\u5403|\u559c\u6b61)/u.test(clean)) {
    return { action: "recall", text: clean, subject: clean };
  }
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean) && /(?:\u5230\u5e95)?\u662f\s*[01]\s*(?:\u9084\u662f|or)\s*[01]/iu.test(clean)) {
    return { action: "recall", text: clean, subject: clean };
  }
  return null;
}

export function isExplicitHotToolIntent(text) {
  const clean = stripRanaMention(text);
  if (!clean || isMetaLanguageToolDiscussion(clean) || isCurrentSessionMemoryQuestion(clean)) return false;
  if (hasSufficientStockIntent(clean)) return true;
  if (isExplicitMemoryIntent(clean) || parseMemoryDeleteRequest(clean)) return true;
  if (/(?:ocr|dashboard|leprechaun|\u5929\u6c23|\u7ffb\u8b6f|\u6458\u8981|\u63d0\u9192)/iu.test(clean)) return true;
  return false;
}

export function expectedToolForText(text) {
  const clean = stripRanaMention(extractUserMessageText(text));
  if (!clean || isMetaLanguageToolDiscussion(clean)) return null;
  if (hasSufficientStockIntent(clean)) return "rana_stock_research";
  if ((isExplicitMemoryIntent(clean) || parseMemoryDeleteRequest(clean) || parseMemoryRecallRequest(clean)) && !isCurrentSessionMemoryQuestion(clean)) return "rana_memory";
  if (parsePlayRequest({ body: text, content: text })) return "rana_play_music";
  return null;
}

export const __test = {
  eventWasMentioned,
  expectedToolForText,
  extractUserMessageText,
  extractStockLikeTickers,
  hasExplicitPlayIntent,
  hasExplicitStockIntent,
  hasSufficientStockIntent,
  isExplicitHotToolIntent,
  hasTickerLookIntent,
  isCurrentSessionMemoryQuestion,
  isExplicitMemoryIntent,
  isExplicitWebSearchIntent,
  isMetaLanguageToolDiscussion,
  isPlainKeyword,
  isProtectedBareNoun,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
  parseMemoryDeleteRequest,
  parseControlRequest,
  parsePlayRequest,
};

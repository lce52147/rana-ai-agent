const URL_RE = /https?:\/\/\S+/i;
const MUSIC_SOURCE_HOSTS = Object.freeze(["youtube.com", "youtu.be", "bilibili.com", "b23.tv", "soundcloud.com"]);

const RANA_NAME_RE = new RegExp("(?:^|\\s)@?(?:rana|\\u6a02\\u5948)(?:#\\d{4})?(?=\\s|$|[,.!?;:\\u3002\\uff0c\\uff1f\\uff01])", "i");
const RANA_BOT_MENTION_RE = /<@!?1202969643162013776>/;
const CONTROL_ADDRESS_MENTION_RE = /^(?:\s*(?:<@!?\d+>|@(?:rana|\u6a02\u5948|\u9ad8\u677e\u71c8|\u71c8|\u5343\u65e9\u611b\u97f3|\u611b\u97f3|\u9577\u5d0e\u723d\u4e16|\u723d\u4e16|\u690e\u540d\u7acb\u5e0c|\u7acb\u5e0c)(?:#\d{4})?)(?=\s|$|[,.!?;:\u3002\uFF0C\uFF1F\uFF01\u3001]))+/iu;
const LEADING_AGENT_ADDRESS_RE = /^\s*(?:<@!?\d+>|@(?:rana|\u6a02\u5948|\u9ad8\u677e\u71c8|\u71c8|\u5343\u65e9\u611b\u97f3|\u611b\u97f3|\u9577\u5d0e\u723d\u4e16|\u723d\u4e16|\u690e\u540d\u7acb\u5e0c|\u7acb\u5e0c)(?:#\d{4})?)(?=\s|$|[,.!?;:\u3002\uff0c\uff1f\uff01\u3001])[,\uFF0C\u3001:\s]*/iu;
// Music command parsing is owned by current_turn_tool_contract.js.
const BILIBILI_HINT_RE = /(?:\bbilibili\b|\bbili\b|\bb23\b|B站|嗶哩嗶哩)/iu;

import {
  isCurrentTurnToolAuthorized,
  isMissingMusicTarget,
  parseMusicCommand,
  parseMusicControlCommand,
  parseStockCommand,
  resolveCurrentTurnToolSurface,
} from "./current_turn_tool_contract.js";

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
  "\u8c50\u5ddd\u7965\u5b50",
  "\u7965\u5b50",
  "\u82e5\u8449\u7766",
  "mortis",
  "\u7950\u5929\u5bfa\u306b\u3083\u3080",
  "\u306b\u3083\u3080",
  "\u4e09\u89d2\u521d\u83ef",
  "\u521d\u83ef",
  "\u516b\u5e61\u6d77\u9234",
  "\u6d77\u9234",
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
  const value = firstText(text);
  return RANA_BOT_MENTION_RE.test(value) || RANA_NAME_RE.test(value);
}

export function stripRanaMention(text) {
  return extractUserMessageText(text)
    // Strip exactly one leading addressed Agent mention/name. Later Discord
    // mentions may be the durable-memory subject and must remain intact.
    .replace(LEADING_AGENT_ADDRESS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeControlAddress(text) {
  let clean = extractUserMessageText(text);
  let match = CONTROL_ADDRESS_MENTION_RE.exec(clean);
  while (match) {
    clean = clean.slice(match[0].length);
    match = CONTROL_ADDRESS_MENTION_RE.exec(clean);
  }
  return clean.replace(/^\s+|\s+$/g, "");
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
  const raw = firstText(url).trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.replace(/\.$/u, '').toLowerCase();
    return MUSIC_SOURCE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch (_) {
    return false;
  }
}

export function eventWasMentioned(event) {
  return event?.was_mentioned === true || event?.wasMentioned === true || event?.metadata?.was_mentioned === true || event?.discord?.was_mentioned === true;
}

export function hasExplicitPlayIntent(text) {
  return Boolean(parseMusicCommand(text));
}

export function parseMissingPlayTargetRequest(event) {
  const candidates = [firstText(event?.body), firstText(event?.content)].map(extractUserMessageText).filter(Boolean);
  for (const text of candidates) {
    if (isMissingMusicTarget(text)) {
      return { reason: "missing_target" };
    }
  }
  return null;
}

export function parsePlayRequest(event) {
  const candidates = [firstText(event?.body), firstText(event?.content)].map(extractUserMessageText).filter(Boolean);
  for (const text of candidates) {
    const command = parseMusicCommand(text);
    if (!command) continue;
    const target = command.target;
    const url = target.match(URL_RE)?.[0]?.replace(/[>\])"'.,]+$/g, "");
    const queue_mode = command.queue_mode === "next" ? "next" : "append";
    if (url) {
      if (isMusicSourceUrl(url)) return { url, query: null, display: url, queue_mode };
      // Explicit play syntax does not authorize arbitrary URL fetching.
      return null;
    }
    const source = hasBilibiliHint(text) || hasBilibiliHint(target) ? "bilibili" : "youtube";
    const query = stripSourceHint(target).replace(/^["'「『]+|["'」』]+$/g, "").trim();
    if (query) return { url: null, query, display: query, source, queue_mode };
  }
  return null;
}

export function parseControlRequest(event) {
  const candidates = [...new Set(
    [firstText(event?.body), firstText(event?.content)].map(extractUserMessageText).filter(Boolean),
  )];
  for (const text of candidates) {
    const control = parseMusicControlCommand(text);
    if (control) return control;
  }
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
  const blocked = new Set(["RANA", "LEPRECHAUN", "PLAY", "VOLUME", "JOIN", "LEAVE", "SKIP", "ENTRY", "POINT", "POINTS", "STOCK", "STOCKS", "MARKET", "DASHBOARD", "LIVE", "MYGO", "CRYCHIC", "RING", "AVE", "MUJICA", "US", "USA", "NYSE", "NASDAQ"]);
  return [...new Set(raw
    .filter((token) => token.startsWith("$") || token === token.toUpperCase())
    .map((token) => token.replace(/^\$/, "").toUpperCase())
    .filter((token) => /^[A-Z0-9.]{1,8}$/.test(token) && !blocked.has(token)))];
}

export function hasTickerLookIntent(text) {
  const clean = firstText(text);
  if (extractStockLikeTickers(clean).length === 0) return false;
  return /(?:stock|ticker|analysis|predict|entry|buy|sell|scan)/i.test(clean)
    || /(?:\u7f8e\u80a1|\u80a1\u7968|\u5206\u6790|\u9810\u6e2c|\u9032\u5834|\u8cb7\u5165|\u8ce3\u51fa|\u8cb7|\u8ce3|\u63a8\u85a6|\u67e5)/u.test(clean);
}

export function hasExplicitStockIntent(text) {
  return Boolean(parseStockCommand(text));
}

const EXPLICIT_WEB_COMMAND_RE = /(?:幫我|帮我)\s*(?:查詢|查询|查一下|查|找)|(?:查詢|查询|查一下|搜尋|搜索|搜一下|上網找|上网找|網路上找|网络上找|网上找)|(?:look\s+up|search(?:\s+for)?|web\s+search(?:\s+for)?)/iu;
const WEB_RESPONSE_INSTRUCTION_RE = /(?:\s+|[，,。；;：:]\s*)(?=(?:請你|请你|請直接|请直接|直接回答|直接回覆|直接回复|回答時|回答时|回覆時|回复时|不要|別|别|只要|請勿|请勿))/u;

function cleanWebSubject(value) {
  return firstText(value)
    .trim()
    .replace(/^[，,。；;：:\s]+|[？?。.!！；;]+$/gu, "")
    .trim();
}

/**
 * Canonical current-turn Web request parser. All runtime owners must consume
 * this result instead of maintaining their own search-intent/query regexes.
 */
export function parseExplicitWebRequest(text) {
  const clean = normalizeControlAddress(extractUserMessageText(text));
  if (!clean || isMetaLanguageToolDiscussion(clean)) return null;
  const match = EXPLICIT_WEB_COMMAND_RE.exec(clean);
  if (!match) return null;

  const tail = clean.slice(match.index + match[0].length).trim();
  if (!tail) return null;
  const split = tail.search(WEB_RESPONSE_INSTRUCTION_RE);
  const subject = cleanWebSubject(split >= 0 ? tail.slice(0, split) : tail);
  const responseInstruction = split >= 0 ? tail.slice(split).trim() : "";
  if (subject.length < 2) return null;

  return { explicit: true, subject, responseInstruction };
}

export function isExplicitWebSearchIntent(text) {
  return Boolean(parseExplicitWebRequest(text));
}

const EXPLICIT_US_STOCK_CONTEXT_RE = /(?:美股|美國(?:股票|股市|證券市場)|US(?:\s|-)?stocks?|U\.S\.(?:\s+)?stocks?|NASDAQ|NYSE)/iu;

export function hasExplicitUsStockContext(text) {
  return EXPLICIT_US_STOCK_CONTEXT_RE.test(extractUserMessageText(text));
}

export function hasSufficientStockIntent(text) {
  return Boolean(parseStockCommand(text));
}

const EXPLICIT_FINANCE_CONTEXT_RE = /(?:股票|美股|台股|港股|陸股|股價|財報|投資|持股|個股|標的|市場掃描|全市場|ETF|基金|期貨|選擇權|ticker|stocks?|shares?|equity|market-wide)/iu;
const PURCHASE_CLASSIFIER_RE = "(?:隻|支|個|款|種|台|臺|組|副|張|件|雙|顆|本|把|套|罐|瓶|包|條|盒|杯|座)";
const ORDINARY_PURCHASE_REQUEST_RE = new RegExp(
  `(?:買|購買|選|挑|推薦|比較)[^。！？!?]{0,24}(?:哪(?:一)?${PURCHASE_CLASSIFIER_RE}?|一${PURCHASE_CLASSIFIER_RE}|這(?:兩|幾|\\d+)${PURCHASE_CLASSIFIER_RE}?|那(?:兩|幾|\\d+)${PURCHASE_CLASSIFIER_RE}?)`
  + `|(?:哪(?:一)?${PURCHASE_CLASSIFIER_RE}?|這(?:兩|幾|\\d+)${PURCHASE_CLASSIFIER_RE}?|那(?:兩|幾|\\d+)${PURCHASE_CLASSIFIER_RE}?)[^。！？!?]{0,24}(?:買|購買|選|挑|推薦|比較好)`,
  "u",
);

function cleanPurchaseSubject(value) {
  return firstText(value)
    .trim()
    .replace(/^(?:的|這個|那個)\s*/u, "")
    .replace(/(?:比較好|好一點|比較適合|適合|要買|值得買|推薦|呢|啊|嗎|？|\?)$/u, "")
    .trim();
}

export function ordinaryPurchaseChoiceSubject(text) {
  const clean = stripRanaMention(extractUserMessageText(text));
  if (!clean || hasSufficientStockIntent(clean) || EXPLICIT_FINANCE_CONTEXT_RE.test(clean)) return "";
  if (!ORDINARY_PURCHASE_REQUEST_RE.test(clean)) return "";

  const afterClassifier = clean.match(
    new RegExp(`(?:哪(?:一)?|一)${PURCHASE_CLASSIFIER_RE}[\\s]*([^，。！？!?]{1,20})`, "u"),
  );
  const after = cleanPurchaseSubject(afterClassifier?.[1]);
  if (after) return after;

  const beforeVerb = clean.match(
    new RegExp(`(?:這|那)(?:兩|幾|\\d+)${PURCHASE_CLASSIFIER_RE}?[\\s]*([^，。！？!?]{1,20}?)(?:買|購買|選|挑)`, "u"),
  );
  const before = cleanPurchaseSubject(beforeVerb?.[1]);
  if (before) return before;

  const genericAfter = clean.match(
    new RegExp(`(?:哪(?:一)?)(?!${PURCHASE_CLASSIFIER_RE})[\\s]*([^，。！？!?]{1,20})`, "u"),
  );
  return cleanPurchaseSubject(genericAfter?.[1]) || "候選物件";
}

export function isOrdinaryPurchaseChoice(text) {
  const clean = stripRanaMention(extractUserMessageText(text));
  if (!clean || hasSufficientStockIntent(clean) || EXPLICIT_FINANCE_CONTEXT_RE.test(clean)) return false;
  return ORDINARY_PURCHASE_REQUEST_RE.test(clean);
}

export function isCurrentSessionMemoryQuestion(text) {
  const clean = stripRanaMention(text);
  if (/(?:\u525b\u525b|\u4e0a\u9762|\u524d\u9762).*(?:\u8ab0\u554f|\u8ab0\u8aaa|\u8ab0\u6253|\u554f\u4e86\u4ec0\u9ebc|\u8aaa\u4e86\u4ec0\u9ebc)/u.test(clean)) return true;
  return /(?:session|\u525b\u525b|\u9019\u6bb5|\u76ee\u524d\u5c0d\u8a71|\u73fe\u5728\u9019\u500b)/iu.test(clean)
    && /(?:\u8a18\u5f97|\u8a18\u61b6|\u6211\u8aaa)/u.test(clean);
}

function validMemoryRememberPayload(value) {
  const text = firstText(value).replace(/^[\s，,：:]+|[\s，,。！？!?]+$/gu, "").trim();
  if (!text || INSUFFICIENT_MEMORY_TEXT_RE.test(text)) return "";
  if (/^(?:我|你|妳|他|她|它|好|好的|知道|知道了|記得|記住|記住了|收到|收到啦)$/u.test(text)) return "";
  if (/^(?:我|你|妳)(?:已經|已经|有)?(?:記住|记住|記得|记得)(?:了)?$/u.test(text)) return "";
  return text;
}

const MEMORY_PERSONA_NAME_SRC = "(?:要?樂奈|楽奈|Rana|rana|高松燈|燈|Tomori|tomori|千早愛音|愛音|Anon|anon|長崎爽世|爽世|そよ|Soyo|soyo|椎名立希|立希|Taki|taki)(?:ちゃん|醬|酱|桑|さん)?";
const CROSS_MEMORY_PATTERNS = [
  new RegExp(`(?:記到|記在|記進|寫到|寫進|存到|存進|放到|放進|加到|加進)\\s*(${MEMORY_PERSONA_NAME_SRC})\\s*(?:的)?(?:長期)?(?:記憶(?!力|體)|那邊|那裡|裡面)`, "iu"),
  new RegExp(`這是\\s*(${MEMORY_PERSONA_NAME_SRC})\\s*的(?:長期)?記憶(?!力|體)`, "iu"),
  new RegExp(`(?:幫|替|給)\\s*(${MEMORY_PERSONA_NAME_SRC})\\s*(?:記住|記下)`, "iu"),
];
const BARE_REMEMBER_RE = /^(?:請(?:你|妳)?)?(?:你|妳)?(?:幫我)?(?:記住|記下|記起來)(?:一下|看看)?[。！!？?…\s]*$/u;
const BARE_FORGET_RE = /^(?:請(?:你|妳)?)?(?:幫我)?(?:忘記|忘掉|刪掉)(?:一下)?[。！!？?…\s]*$/u;
const BARE_RECALL_RE = /^(?:你|妳)?(?:還)?記得(?:嗎)?[。！!？?…\s]*$/u;
const BULK_FORGET_RES = [
  /^(?:所有人?|全部|全都|通通|一切|大家|每個人|整個|所有的?|全部的?)(?:人的?|的)?(?:記憶|記錄|紀錄|事情|東西|內容|資料)?(?:都|通通|全都)?(?:忘掉|忘記|刪掉|刪除)?$/u,
  /^(?:清空|清除|重置|重設|洗掉|歸零)(?:所有|全部|整個)?(?:的)?(?:記憶|記錄|紀錄|資料)$/u,
  /^(?:reset|clear|wipe)(?:all)?(?:my)?memor(?:y|ies)$/iu,
];

export function isBulkMemoryDeleteTarget(value) {
  const compact = firstText(value).replace(/[\s，,。！!？?]+/gu, "");
  if (!compact || compact.length > 14) return false;
  return BULK_FORGET_RES.some((re) => re.test(compact));
}

function parseCrossMemoryTarget(clean) {
  for (const pattern of CROSS_MEMORY_PATTERNS) {
    const match = clean.match(pattern);
    if (!match) continue;
    const payload = (clean.split(/[：:]/u).slice(1).join(":") || "").trim();
    return { action: "remember_cross", target: match[1], text: payload };
  }
  return null;
}

function parseMemoryRememberClean(clean) {
  if (!clean) return null;
  const cross = parseCrossMemoryTarget(clean);
  if (cross) return cross;
  if (BARE_REMEMBER_RE.test(clean)) return { action: "remember", text: "", empty: true };
  const patterns = [
    /^(?:請(?:你|妳)?)?(?:你|妳)?(?:要|得|需要|必須|必须)?\s*(?:幫我)?(?:記住|記下)[\s，,：:]+(.+)$/u,
    /^(?:請(?:你|妳)?)?(?:幫我)?(?:記住|記下)\s*(.+)$/u,
    /^(?:記得)[\s，,]+(.+)$/u,
    /^(?:以後要)?(?:記得)\s*(.+)$/u,
    /^(?:你|妳)?(?:可以|能|能不能|可不可以)(?:幫我)?\s*(?:記住|記下)\s*(.+?)(?:嗎)?[?？]?$/u,
    /^(?:(?:拜託|麻煩)(?:你|妳)?(?:幫我)?|(?:你|妳)幫我)\s*(?:記住|記下)\s*(.+?)(?:好嗎|可以嗎)?[?？]?$/u,
    /^(?:.+?)[，,\s]+(?:幫我)?(?:記住|記下)\s+(.+)$/u,
    /^(.+?)\s*(?:幫我)?(?:記住|記下)$/u,
    /^(.+?)\s*(?:記住了|記下了)[。！!]?$/u,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const payload = validMemoryRememberPayload(match?.[1] || "");
    if (payload) return { action: "remember", text: payload };
  }
  return null;
}


function normalizeMemoryTargetId(value) {
  const text = firstText(value).trim();
  const match = text.match(/^(?:<@!?)?(\d{15,25})>?$/u);
  return match?.[1] || "";
}

const MEMORY_ANAPHORIC_SUBJECT_RE = /^(他|她|這人|这人|這個人|这个人|那人|那個人|那个人)(?=\s|是|的|會|会|有|喜歡|喜欢|討厭|讨厌|$)/u;

function memoryTargetBinding(text, options = {}) {
  const value = firstText(text).trim();
  const literalId = value.match(/<@!?(\d{15,25})>/u)?.[1] || "";
  if (literalId) {
    return { id: literalId, aliases: [`<@${literalId}>`], source: "explicit_id", anaphoric: false };
  }

  const currentId = normalizeMemoryTargetId(options?.currentExplicitTargetId);
  const previousId = normalizeMemoryTargetId(options?.previousExplicitTargetId);
  const currentAliases = Array.isArray(options?.currentExplicitTargetAliases)
    ? options.currentExplicitTargetAliases.map(firstText).map((item) => item.trim()).filter(Boolean)
    : [];
  const previousAliases = Array.isArray(options?.previousExplicitTargetAliases)
    ? options.previousExplicitTargetAliases.map(firstText).map((item) => item.trim()).filter(Boolean)
    : [];
  const anaphoric = MEMORY_ANAPHORIC_SUBJECT_RE.test(value);
  if (anaphoric) {
    const id = currentId || previousId;
    return {
      id,
      aliases: currentId ? currentAliases : previousAliases,
      source: currentId ? "current_explicit_target" : previousId ? "previous_explicit_target" : "unresolved_anaphora",
      anaphoric: true,
    };
  }

  if (currentId) {
    const lowered = value.toLocaleLowerCase();
    const aliasHit = currentAliases.find((alias) => alias && lowered.includes(alias.toLocaleLowerCase()));
    const handleHit = value.match(/@[A-Za-z0-9_.-]{2,32}/u)?.[0] || "";
    if (aliasHit || handleHit) {
      return { id: currentId, aliases: currentAliases, source: "current_explicit_target", anaphoric: false };
    }
  }
  return { id: "", aliases: [], source: "none", anaphoric: false };
}

function bindMemoryTargetText(text, binding) {
  const value = firstText(text).trim();
  if (!binding?.id) return value;
  const canonical = `<@${binding.id}>`;
  if (MEMORY_ANAPHORIC_SUBJECT_RE.test(value)) {
    return value.replace(MEMORY_ANAPHORIC_SUBJECT_RE, `${canonical} `).replace(/\s+/gu, " ").trim();
  }
  if (value.includes(canonical) || value.includes(`<@!${binding.id}>`)) {
    return value.replace(`<@!${binding.id}>`, canonical);
  }
  for (const alias of [...(binding.aliases || [])].sort((a, b) => String(b).length - String(a).length)) {
    if (!alias || alias === canonical) continue;
    if (value.includes(alias)) return value.replace(alias, canonical);
  }
  const handle = value.match(/@[A-Za-z0-9_.-]{2,32}/u)?.[0] || "";
  return handle ? value.replace(handle, canonical) : value;
}

function withMemoryTargetBinding(parsed, options = {}) {
  if (!parsed) return null;
  const binding = memoryTargetBinding(parsed.text || parsed.subject || "", options);
  if (binding.anaphoric && !binding.id) {
    return { ...parsed, unresolvedTarget: true, targetSource: binding.source };
  }
  if (!binding.id) return parsed;
  return {
    ...parsed,
    text: bindMemoryTargetText(parsed.text, binding),
    ...(parsed.subject ? { subject: `<@${binding.id}>` } : {}),
    targetId: binding.id,
    targetAliases: [...new Set(binding.aliases || [])],
    targetSource: binding.source,
  };
}

export function isExplicitMemoryIntent(text) {
  const clean = stripRanaMention(text);
  if (!clean || isCurrentSessionMemoryQuestion(clean)) return false;
  if (parseMemoryRememberClean(clean)) return true;
  if (/(?:你記得|還記得|記得).+(?:嗎|嗎？|\?)/u.test(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:酒量|容易醉|喝酒|喝一杯|喝一下|很會喝|男娘|帥哥|早起|不想起床|起床|蕎麥麵|愛吃|喜歡|是\s*[01]|還是\s*[01])/u.test(clean)
    && /(?:行不行|會不會|是不是|真的|為啥|為什麼|為何|對吧|還記得|有記住|記得|之前|上次|怎樣|如何|嗎|\?)/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (/(?:誰).*(?:酒量|容易醉|喝酒|男娘|帥哥|早起|不想起床|蕎麥麵|愛吃|喜歡)/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:酒量|容易醉|喝酒|男娘|是什麼人|是誰|是什麼)/u.test(clean)
    && /(?:怎樣|如何|嗎|\?)?$/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (DURABLE_MEMORY_SUBJECT_RE.test(clean)
    && /(?:是什麼|是誰|是不是(?:珂朵莉|男娘|帥哥|1)|怎樣|如何|\?)$/u.test(clean)
    && !isCurrentSessionMemoryQuestion(clean)) return true;
  if (/喜好/u.test(clean) && /(?:怎樣|如何|是什麼|多少|嗎|\?)$/u.test(clean) && !isCurrentSessionMemoryQuestion(clean)) return true;
  return false;
}

export function parseMemoryRememberRequest(text, options = {}) {
  const clean = stripRanaMention(text);
  if (!clean || isCurrentSessionMemoryQuestion(clean)) return null;
  return withMemoryTargetBinding(parseMemoryRememberClean(clean), options);
}

export function parseMemoryDeleteRequest(text, options = {}) {
  const clean = stripRanaMention(text);
  if (!clean || isCurrentSessionMemoryQuestion(clean)) return null;
  if (BARE_FORGET_RE.test(clean)) return { action: "forget", text: "" };
  let match = clean.match(/^(?:請(?:你|妳)?)?(?:幫我)?(?:忘記|刪掉|刪除|移除|不要記得)\s*(.+)$/u);
  if (match?.[1]?.trim()) {
    if (isBulkMemoryDeleteTarget(match[1])) return { action: "forget_bulk", text: match[1].trim() };
    return withMemoryTargetBinding({ action: "forget", text: match[1].trim() }, options);
  }
  match = clean.match(/^(.+?)\s*(?:忘記|刪掉|刪除|移除)$/u);
  if (match?.[1]?.trim()) {
    if (isBulkMemoryDeleteTarget(match[1])) return { action: "forget_bulk", text: match[1].trim() };
    return withMemoryTargetBinding({ action: "forget", text: match[1].trim() }, options);
  }
  // Standalone clear commands only (never the bare target words such as "大家").
  const compact = firstText(clean).replace(/[\s，,。！!？?]+/gu, "");
  if (BULK_FORGET_RES.slice(1).some((re) => re.test(compact))
    || (/(?:忘掉|忘記|刪掉|刪除)$/u.test(compact) && BULK_FORGET_RES[0].test(compact))) return { action: "forget_bulk", text: clean };
  return null;
}

export function parseMemoryRecallRequest(text, options = {}) {
  const clean = stripRanaMention(text).replace(/\s+/g, " ").trim();
  if (!clean || isCurrentSessionMemoryQuestion(clean) || parseMemoryRememberRequest(text, options) || parseMemoryDeleteRequest(text, options)) return null;
  if (BARE_RECALL_RE.test(clean)) return { action: "recall", text: "", subject: "" };

  const initialBinding = memoryTargetBinding(clean, options);
  if (initialBinding.anaphoric && /(?:是誰|是谁|是怎樣的人|是怎样的人|是什麼人|是什么人|怎樣|怎样|如何|什麼人|什么人|記得|记得|知道)(?:嗎|吗|呢)?[?？。.]?$/u.test(clean)) {
    if (!initialBinding.id) {
      return { action: "recall", text: clean, subject: "", implicit: true, unresolvedTarget: true, targetSource: initialBinding.source };
    }
    return {
      action: "recall",
      text: bindMemoryTargetText(clean, initialBinding),
      subject: `<@${initialBinding.id}>`,
      implicit: true,
      targetId: initialBinding.id,
      targetAliases: [...new Set(initialBinding.aliases || [])],
      targetSource: initialBinding.source,
    };
  }

  const explicitUserRef = clean.match(/(?:<@!?\d{15,25}>|@[A-Za-z0-9_.-]{2,32})/u)?.[0] || "";
  if (explicitUserRef && /(?:是誰|是谁|是怎樣的人|是怎样的人|是什麼人|是什么人|怎樣|怎样|如何|什麼人|什么人|記得|记得|知道)(?:嗎|吗|呢)?[?？。.]?$/u.test(clean)) {
    const binding = memoryTargetBinding(clean, options);
    return binding.id
      ? { action: "recall", text: bindMemoryTargetText(clean, binding), subject: `<@${binding.id}>`, implicit: true, targetId: binding.id, targetAliases: [...new Set(binding.aliases || [])], targetSource: binding.source }
      : { action: "recall", text: clean, subject: explicitUserRef, implicit: true };
  }

  // Plain「X 是誰」is not sufficient authority for durable Memory.
  // Explicit Discord ids/@handles and bounded anaphoric targets were handled
  // above; legacy durable subjects are handled below. Leaving arbitrary plain
  // identity questions to TurnPlan prevents Memory from stealing canonical
  // characters while preserving stable-id user-defined-person recall.
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
  hasExplicitUsStockContext,
  hasSufficientStockIntent,
  isOrdinaryPurchaseChoice,
  ordinaryPurchaseChoiceSubject,
  isExplicitHotToolIntent,
  hasTickerLookIntent,
  isCurrentSessionMemoryQuestion,
  isExplicitMemoryIntent,
  isExplicitWebSearchIntent,
  parseExplicitWebRequest,
  isMetaLanguageToolDiscussion,
  isPlainKeyword,
  isProtectedBareNoun,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
  parseMemoryDeleteRequest,
  parseControlRequest,
  parseMissingPlayTargetRequest,
  parsePlayRequest,
  parseMusicCommand,
  parseMusicControlCommand,
  parseStockCommand,
  isCurrentTurnToolAuthorized,
  resolveCurrentTurnToolSurface,
};

export {
  isCurrentTurnToolAuthorized,
  parseMusicCommand,
  parseMusicControlCommand,
  parseStockCommand,
  resolveCurrentTurnToolSurface,
};

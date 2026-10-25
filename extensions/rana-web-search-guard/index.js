import { parseExplicitWebRequest } from '../rana-runtime/tool_contracts.js';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TRACE_ROOT = process.platform === 'win32'
  ? 'C:\\tmp\\rana-web-search-guard'
  : '/tmp/rana-web-search-guard';
const statesByRun = new Map();
const statesBySession = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

const MATCHA_REWARD_CUE_RE = /(?:給你|送你|請你吃)\s*(?:一份|一個|一杯)?\s*抹茶(?:芭菲|聖代|甜點)/u;
const PROACTIVE_EXTERNAL_FACT_RE = /(?:天氣|下雨|降雨|雨勢|氣溫|溫度|股價|價格|匯率|比分|賽果|航班|班機|營業|開門|庫存|塞車|路況|新聞|消息|weather|rain|temperature|price|stock|quote|exchange rate|score|flight|traffic|news)/iu;
const PROACTIVE_CURRENT_SCOPE_RE = /(?:現在|目前|今天|今日|此刻|即時|最新|now|currently|today|latest)/iu;
const PROACTIVE_QUESTION_RE = /(?:有沒有|是否|是不是|會不會|多少|幾|什麼|哪|如何|怎樣|嗎|呢|[？?])/u;
const PROACTIVE_PERSONA_SELF_RE = /(?:妳|你|樂奈|Rana).{0,16}(?:現在|目前|今天|今日|正在).{0,24}(?:在|有|沒有|沒|是|不是|去了|沒去|做了|沒做|吃了|喝了|練團|練習)/iu;
const PROACTIVE_MUSIC_ACTION_RE = /(?:播放|撥放|放歌|點歌|停止播放|停歌|下一首|跳過|切歌|音量|加入.{0,8}(?:語音|voice|vc)|離開.{0,8}(?:語音|voice|vc))/iu;
const PROACTIVE_TICKER_RE = /(?:^|[^A-Za-z])\$?[A-Z]{1,5}(?:[^A-Za-z]|$)/u;

function parseMatchaRewardWebRequest(value) {
  const text = extractUserText(value);
  if (!text || !MATCHA_REWARD_CUE_RE.test(text)) return null;
  const subject = text
    .replace(MATCHA_REWARD_CUE_RE, ' ')
    .replace(/^[\s，,、。:：;；]+/u, '')
    .trim();
  if (!subject || PROACTIVE_MUSIC_ACTION_RE.test(subject)) return null;
  if (PROACTIVE_PERSONA_SELF_RE.test(subject)) return null;
  if (!PROACTIVE_CURRENT_SCOPE_RE.test(subject) || !PROACTIVE_QUESTION_RE.test(subject)) return null;
  if (!PROACTIVE_EXTERNAL_FACT_RE.test(subject) && !PROACTIVE_TICKER_RE.test(subject)) return null;
  return { subject, authorization: 'matcha_reward_current_fact' };
}

function firstText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return firstText(value.content);
  if (typeof value.message === 'string') return value.message;
  return '';
}

function extractUserText(prompt) {
  const text = firstText(prompt);
  const markers = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/gi)];
  const imageBlock = text.match(/\[Image\]\s*User text:\s*([\s\S]*?)(?:\r?\nDescription:|$)/i);
  let selected = imageBlock?.[1] || markers.at(-1)?.[1] || text;
  return selected
    .replace(/^\s*To send an image back, use the message tool[^\r\n]*(?:\r?\n)?/gim, '')
    .replace(/\[media attached:\s*[^\]]+\]\s*/gi, '')
    .replace(/^\s*\[Discord[^\]]+\]\s*[^:\r\n]{1,160}:\s*/i, '')
    .replace(/<@!?\d{17,20}>/g, '')
    .replace(/@(?:Rana|樂奈)(?:#\d+)?/gi, '')
    .trim();
}

function hasImage(prompt) {
  return /\[media attached:|<media:image>|\[Image\]/i.test(firstText(prompt));
}

function compact(value, limit = 280) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseToolResult(value) {
  if (!value) return null;
  if (value?.details && typeof value.details === 'object') return value.details;
  if (Array.isArray(value?.results)) return value;
  const text = firstText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.details && typeof parsed.details === 'object') return parsed.details;
    return parsed;
  } catch {
    return null;
  }
}

function normalizedEvidenceText(value) {
  return String(value || '')
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, ' ')
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, ' ')
    .replace(/Source:\s*Web Search|---/gi, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

export function assessDefinitionEvidence(term, toolResult) {
  const payload = parseToolResult(toolResult);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const needle = normalizedEvidenceText(term);
  if (!needle || !results.length) {
    return { supported: false, resultCount: results.length, exactMatches: 0, definitionalMatches: 0 };
  }

  let exactMatches = 0;
  let definitionalMatches = 0;
  const definitionCue = /(?:\u662f|\u6307|\u610f\u601d|\u7a31\u547c|\u5b9a\u7fa9|means?|refers?\s+to|defined?\s+as)/iu;
  for (const result of results) {
    const source = `${result?.title || ''}\n${result?.snippet || ''}`;
    if (!normalizedEvidenceText(source).includes(needle)) continue;
    exactMatches += 1;
    if (definitionCue.test(source)) definitionalMatches += 1;
  }

  return {
    supported: definitionalMatches >= 1 || exactMatches >= 2,
    resultCount: results.length,
    exactMatches,
    definitionalMatches,
  };
}

function isDefinitionQuestion(value) {
  return /(?:\u4ec0\u9ebc\u610f\u601d|\u4ec0\u4e48\u610f\u601d|\u662f\u4ec0\u9ebc|\u662f\u4ec0\u4e48|\u610f\u601d|meaning|define)/iu.test(String(value || ''));
}

export function isEvidenceBoundedAnswer(value) {
  return /(?:\u67e5\u4e0d\u5230|\u6c92\u6709\u627e\u5230|\u672a\u627e\u5230|\u6c92\u6709\u56fa\u5b9a|\u7121\u6cd5\u78ba\u8a8d|\u641c\u5c0b\u7d50\u679c.{0,24}(?:\u4e0d\u8db3|\u6c92\u6709|\u7121\u6cd5)|\u53ef\u80fd|\u63a8\u6e2c|\u63a8\u6e2c|\u7fa4\u5167\u7528\u8a9e|no (?:fixed|reliable|public) definition|results? (?:do not|does not|did not) establish)/iu.test(String(value || ''));
}

function cleanTerm(value) {
  return compact(value, 80)
    .replace(/^[「『“"'【\[]+|[」』”"'】\]]+$/g, '')
    .replace(/^(?:(?:請|麻煩|幫我|跟我|告訴我|說說|解釋(?:一下)?|查(?:一下)?|搜尋(?:一下)?)\s*)+/u, '')
    .trim();
}

function plausibleTerm(term) {
  const value = cleanTerm(term);
  if (value.length < 2 || value.length > 50) return false;
  if (/^(?:這|那|他|她|它|這個|那個|意思|問題|東西|事情|什麼|为什么|為什麼)$/u.test(value)) return false;
  return /[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

export function extractExplicitSearchSubject(value) {
  return parseExplicitWebRequest(extractUserText(value))?.subject || "";
}

export function looksLikePortalListAnswer(value) {
  const text = compact(value, 5000);
  const urls = text.match(/https?:\/\/[^\s)\]]+/giu) || [];
  return urls.length >= 2
    || /(?:可以|可)(?:參考|查看|到).{0,24}(?:網站|網頁|論壇)|(?:以下|這些).{0,12}(?:網站|來源|連結)|建議.{0,24}(?:網站|查看|參考)/u.test(text);
}

export function looksLikeTaskDeflectionAnswer(value) {
  const text = compact(value, 5000);
  return /(?:你)?(?:可以|可)(?:自己)?(?:去|到).{0,36}(?:看(?:看)?|查(?:看)?|找|參考)|(?:完整|詳細).{0,24}(?:請|可以|可).{0,24}(?:到|去).{0,24}(?:網站|論壇|網頁|看|查)|(?:那邊|那裡|那里).{0,16}(?:有|都有|整理)/u.test(text);
}

function webEvidenceCorpus(toolResult) {
  const payload = parseToolResult(toolResult);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map((result) => [result?.title, result?.snippet, result?.siteName].filter(Boolean).join("\n")).join("\n");
}

function quotedFragments(value) {
  const text = String(value || "");
  const out = [];
  const patterns = [/「([^」]{4,})」/gu, /『([^』]{4,})』/gu, /“([^”]{4,})”/gu, /"([^"\n]{4,})"/gu];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match?.[1]) out.push(match[1]);
  }
  return [...new Set(out)];
}

export function assessLookupAnswerGrounding(term, answer, toolResult) {
  const corpus = webEvidenceCorpus(toolResult);
  const evidence = normalizedEvidenceText(corpus);
  if (!evidence) {
    return { supported: false, unsupportedQuotes: [], unsupportedLyrics: [], reason: "no_result_evidence" };
  }

  const unsupportedQuotes = quotedFragments(answer).filter((fragment) => {
    const normalized = normalizedEvidenceText(fragment);
    return normalized.length >= 6 && !evidence.includes(normalized);
  });

  const unsupportedLyrics = [];
  if (/(?:歌詞|歌词|lyrics?)/iu.test(String(term || ""))) {
    for (const segment of String(answer || "").split(/[\n。！？!?]+/u)) {
      const trimmed = segment.trim();
      if (!trimmed || /[「」『』“”"]/.test(trimmed)) continue;
      if (!/[ぁ-んァ-ヶー]/u.test(trimmed)) continue;
      const normalized = normalizedEvidenceText(trimmed);
      if (normalized.length >= 8 && !evidence.includes(normalized)) unsupportedLyrics.push(trimmed);
    }
  }

  return {
    supported: unsupportedQuotes.length === 0 && unsupportedLyrics.length === 0,
    unsupportedQuotes: unsupportedQuotes.slice(0, 4),
    unsupportedLyrics: unsupportedLyrics.slice(0, 4),
    reason: unsupportedQuotes.length || unsupportedLyrics.length ? "answer_exceeds_current_web_evidence" : "bounded",
  };
}

export function detectLookupIntent(prompt) {
  if (hasImage(prompt)) return { active: false, reason: 'image_turn' };
  const text = extractUserText(prompt);
  if (!text) return { active: false, reason: 'empty' };

  const explicitRequest = parseExplicitWebRequest(text);
  const proactiveRequest = parseMatchaRewardWebRequest(text);
  const authorizedRequest = explicitRequest || proactiveRequest;
  const explicitSearch = Boolean(explicitRequest);
  const proactiveSearch = Boolean(proactiveRequest);
  const authorizedSearch = Boolean(authorizedRequest);
  const patterns = [
    /(?:說說|告訴我|解釋(?:一下)?|說明(?:一下)?)?\s*[「『“"']?(.{2,50}?)[」』”"']?\s*(?:是什麼意思|是什么意思|是啥意思|啥意思|代表什麼|代表什么|指什麼|指什么|怎麼理解|怎么理解)\s*[？?。.!！]*$/u,
    /^(?:什麼是|什么是)\s*[「『“"']?(.{2,50}?)[」』”"']?\s*[？?。.!！]*$/u,
    /^[「『“"']?(.{2,50}?)[」』”"']?\s*(?:是誰|是谁|是什麼|是什么)\s*[？?。.!！]*$/u,
  ];

  let term = '';
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      term = cleanTerm(match[1]);
      break;
    }
  }

  if (authorizedSearch && authorizedRequest?.subject) {
    term = authorizedRequest.subject;
  }

  if (!plausibleTerm(term)) return { active: false, reason: 'not_lookup', text };
  return {
    active: true,
    explicitSearch,
    proactiveSearch,
    authorizedSearch,
    authorization: explicitSearch ? 'explicit_lookup' : proactiveSearch ? 'matcha_reward_current_fact' : 'none',
    term,
    query: authorizedSearch ? term.replace(/"/g, '') : `"${term.replace(/"/g, '')}"`,
    text,
  };
}

export function looksUnsearchedUnknown(answer) {
  const text = compact(answer, 2000);
  if (!text) return false;
  return /(?:我(?:不熟|沒聽過|没听过|不知道|不清楚)|這詞(?:我)?不熟|这个词(?:我)?不熟|不知道(?:這|这)?(?:是|指)|無法確認|无法确认|查不到|沒有(?:找到)?資料|没有(?:找到)?资料|可能是.{0,16}(?:群內|群内|圈內|圈内|社群|內部|内部)用語)/u.test(text);
}

function runKey(event, ctx) {
  return String(event?.runId || ctx?.runId || '');
}

function sessionKey(event, ctx) {
  return String(ctx?.sessionKey || event?.sessionKey || '');
}

function prune(now = Date.now()) {
  for (const [key, state] of statesByRun) {
    if (now - state.createdAt > STATE_TTL_MS) statesByRun.delete(key);
  }
  for (const [key, state] of statesBySession) {
    if (now - state.createdAt > STATE_TTL_MS) statesBySession.delete(key);
  }
}

function remember(event, ctx, state) {
  prune();
  const r = runKey(event, ctx);
  const s = sessionKey(event, ctx);
  if (r) statesByRun.set(r, state);
  if (s) statesBySession.set(s, state);
}

function findState(event, ctx) {
  prune();
  const r = runKey(event, ctx);
  const s = sessionKey(event, ctx);
  return (r && statesByRun.get(r)) || (s && statesBySession.get(s)) || null;
}

function deleteState(event, ctx) {
  const r = runKey(event, ctx);
  const s = sessionKey(event, ctx);
  if (r) statesByRun.delete(r);
  if (s) statesBySession.delete(s);
}

async function trace(stage, state, extra = {}) {
  try {
    await mkdir(TRACE_ROOT, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      stage,
      term: state?.intent?.term || '',
      query: state?.intent?.query || '',
      webSearchCalled: Boolean(state?.webSearchCalled),
      ...extra,
    });
    await appendFile(path.join(TRACE_ROOT, 'web-search-guard.jsonl'), `${line}\n`, 'utf8');
  } catch {}
}

function assistantText(event) {
  const candidates = [
    event?.assistantText,
    event?.assistantTexts,
    event?.lastAssistant,
    event?.message,
    event?.response,
    event?.output,
    event?.content,
  ];
  return candidates.map(firstText).filter(Boolean).join('\n').trim();
}

export function registerWebSearchGuard(api) {
  api.on('before_prompt_build', async (event, ctx) => {
    const intent = detectLookupIntent(event?.prompt);
    // Generic identity/definition questions are not web authorization.
    // Authorization comes from explicit lookup wording or the narrow matcha-reward
    // + mutable external-current-fact trigger.
    if (!intent.active || !intent.authorizedSearch) return;
    const state = {
      createdAt: Date.now(),
      intent,
      definitionQuestion: isDefinitionQuestion(intent.text),
      webSearchCalled: false,
      webSearchCompleted: false,
      webSearchResult: null,
      definitionEvidence: null,
      retryIssued: false,
    };
    remember(event, ctx, state);
    await trace('lookup_detected', state, { explicitSearch: intent.explicitSearch, proactiveSearch: intent.proactiveSearch, authorization: intent.authorization });
    return {
      appendSystemContext: [
        'Rana web lookup rule for this turn:',
        `The user is asking for current external information about ${JSON.stringify(intent.term)}.`,
        `This turn authorizes web_search via ${intent.authorization}. Use only the normalized search subject below; do not include Persona gifts, mentions, or the search command itself in query.`,
        `Normalized query: ${JSON.stringify(intent.query)}.`,
        'After searching, answer the requested information directly from concrete result facts. A list of websites or links is not a completed answer.',
        'If the completed results do not contain enough concrete facts, say the search results are insufficient. Do not invent values or current conditions.',
      ].join('\n'),
    };
  }, { priority: 1200, timeoutMs: 10_000 });

  api.on('before_tool_call', async (event, ctx) => {
    if (String(event?.toolName || '').toLowerCase() !== 'web_search') return;
    const state = findState(event, ctx);
    if (!state || state?.intent?.authorizedSearch !== true) {
      return {
        block: true,
        blockReason: "web_search requires authorized current-turn lookup intent",
      };
    }
    const requestedQuery = compact(event?.params?.query, 300).replace(/^['"]|['"]$/g, '');
    const normalizedQuery = compact(state.intent.query, 300).replace(/^['"]|['"]$/g, '');
    if (requestedQuery !== normalizedQuery) {
      return {
        block: true,
        blockReason: `web_search query must exactly match normalized current-turn subject: ${normalizedQuery}`,
      };
    }
    state.webSearchCalled = true;
    await trace('web_search_called', state, { params: { query: requestedQuery } });
  }, { priority: 1000, timeoutMs: 10_000 });

  api.on('after_tool_call', async (event, ctx) => {
    if (String(event?.toolName || '').toLowerCase() !== 'web_search') return;
    const state = findState(event, ctx);
    if (!state) return;
    state.webSearchCompleted = true;
    state.webSearchResult = event?.result ?? null;
    state.definitionEvidence = assessDefinitionEvidence(state.intent.term, event?.result);
    await trace('web_search_completed', state, {
      error: compact(event?.error, 400),
      definitionEvidence: state.definitionEvidence,
    });
  }, { priority: 1000, timeoutMs: 10_000 });

  api.on('before_agent_finalize', async (event, ctx) => {
    const state = findState(event, ctx);
    if (!state) return;
    const answer = assistantText(event);
    const missingSearch = !state.webSearchCalled
      && (state.intent.authorizedSearch || looksUnsearchedUnknown(answer));
    const unsupportedDefinition = state.webSearchCalled
      && state.webSearchCompleted
      && state.definitionQuestion
      && state.definitionEvidence?.supported === false
      && !isEvidenceBoundedAnswer(answer);
    const portalList = state.webSearchCalled
      && state.webSearchCompleted
      && state.intent.authorizedSearch
      && looksLikePortalListAnswer(answer);
    const taskDeflection = state.webSearchCalled
      && state.webSearchCompleted
      && state.intent.authorizedSearch
      && looksLikeTaskDeflectionAnswer(answer);
    const grounding = state.webSearchCalled && state.webSearchCompleted
      ? assessLookupAnswerGrounding(state.intent.term, answer, state.webSearchResult)
      : { supported: true, unsupportedQuotes: [], unsupportedLyrics: [] };
    const unsupportedGrounding = state.webSearchCalled
      && state.webSearchCompleted
      && grounding.supported === false
      && grounding.reason === 'answer_exceeds_current_web_evidence';
    const needsRetry = !state.retryIssued
      && (missingSearch || unsupportedDefinition || portalList || taskDeflection || unsupportedGrounding);
    await trace('before_finalize', state, {
      needsRetry,
      missingSearch,
      unsupportedDefinition,
      portalList,
      taskDeflection,
      unsupportedGrounding,
      grounding,
      definitionEvidence: state.definitionEvidence,
      answerPreview: compact(answer, 500),
    });
    if (!needsRetry) return;
    state.retryIssued = true;
    const id = runKey(event, ctx) || sessionKey(event, ctx) || state.intent.term;
    const completionFailure = portalList || taskDeflection;
    const reason = unsupportedGrounding
      ? 'The draft contains quoted/lyric material that is not present in the completed current-turn web_search evidence.'
      : completionFailure
        ? 'The draft deflected the user to websites/links instead of completing the requested lookup from the results.'
        : unsupportedDefinition
          ? 'Search results did not establish the requested term definition, but the draft presented an unsupported definition as fact.'
          : 'A lookup answer attempted to finalize without using the available web_search tool.';
    const instruction = unsupportedGrounding
      ? [
          'Do not run another search. Use only the already completed current-turn web_search results.',
          'Delete every quotation, lyric line, numeric/current fact, or concrete detail that those results do not actually contain.',
          'Do not continue partial lyrics or quotations from model memory. If the result only contains a snippet, answer only from that snippet and say the search result is incomplete when necessary.',
        ].join(' ')
      : completionFailure
        ? [
            'Do not run another search. Use only the already completed web_search results.',
            'Answer the requested information directly from concrete facts present in those results; do not tell the user to go to a website, forum, link, or portal to finish the task.',
            'If the completed results do not contain enough concrete facts, state that the search results are insufficient. Do not invent missing details.',
          ].join(' ')
        : unsupportedDefinition
          ? [
              `The completed web_search did not establish a fixed public definition for ${JSON.stringify(state.intent.term)}.`,
              'Revise the answer without another search: explicitly say the public results did not establish a fixed definition.',
              'Any possible contextual reading must be labeled as inference, not fact. Do not invent examples, usage rules, or a community consensus.',
            ].join(' ')
          : [
              `Call web_search now for the normalized query ${JSON.stringify(state.intent.query)}.`,
              'Do not answer from memory and do not repeat that you are unfamiliar with the term before searching.',
              'Use the search result to answer. If no trustworthy result is found, explicitly say the public search was insufficient.',
            ].join(' ');
    return {
      action: 'revise',
      reason,
      retry: {
        instruction,
        idempotencyKey: `rana-web-search-${(unsupportedDefinition || unsupportedGrounding) ? 'grounding-' : ''}${id}`,
        maxAttempts: 1,
      },
    };
  }, { priority: 1400, timeoutMs: 15_000 });

  api.on('message_sending', async (event, ctx) => {
    const state = findState(event, ctx);
    if (!state || !state.webSearchCompleted || !state.intent.authorizedSearch) return;
    const answer = assistantText(event);
    const grounding = assessLookupAnswerGrounding(state.intent.term, answer, state.webSearchResult);
    const violatesCompletion = looksLikePortalListAnswer(answer) || looksLikeTaskDeflectionAnswer(answer);
    const violatesGrounding = grounding.supported === false
      && grounding.reason === 'answer_exceeds_current_web_evidence';
    if (!violatesCompletion && !violatesGrounding) return;
    await trace('message_sending_fail_closed', state, {
      violatesCompletion,
      violatesGrounding,
      grounding,
      answerPreview: compact(answer, 500),
    });
    return { content: '搜尋結果沒有足夠的具體資料，不能亂說。' };
  }, { priority: -900, timeoutMs: 10_000 });

  api.on('agent_end', async (event, ctx) => {
    const state = findState(event, ctx);
    if (state) await trace('agent_end', state, { success: event?.success !== false });
    deleteState(event, ctx);
  }, { priority: -1000, timeoutMs: 10_000 });
}

const plugin = {
  id: 'rana-web-search-guard',
  name: 'Rana Web Search Guard',
  description: 'Allows OpenClaw web_search only for explicit current-turn lookup requests and grounds the resulting answer.',
  register(api) {
    registerWebSearchGuard(api);
  },
};

export default plugin;

export const __test = {
  extractUserText,
  assistantText,
  assessLookupAnswerGrounding,
  looksLikeTaskDeflectionAnswer,
  parseMatchaRewardWebRequest,
};

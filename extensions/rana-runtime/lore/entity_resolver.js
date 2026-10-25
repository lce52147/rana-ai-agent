import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTITY_PATH = path.resolve(MODULE_DIR, "..", "..", "..", "workspace", "LORE", "generated", "rag", "canonical_entities.json");
const CONTEXT_TTL_MS = 15 * 60 * 1000;
const sessionEntities = new Map();
let cache = { mtimeMs: 0, data: null };

export function normalizeAlias(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function loadCanonicalEntities() {
  const stat = fs.statSync(ENTITY_PATH);
  if (!cache.data || cache.mtimeMs !== stat.mtimeMs) {
    cache = {
      mtimeMs: stat.mtimeMs,
      data: JSON.parse(fs.readFileSync(ENTITY_PATH, "utf8")),
    };
  }
  return cache.data;
}

function publicEntity(entity, matchedAlias = "", source = "alias") {
  return {
    entity_id: entity.entityId,
    canonical_id: entity.canonicalId,
    canonical_name: entity.canonicalName,
    matched_alias: matchedAlias,
    source,
  };
}

const SHORT_ALIAS_LEFT_CONTEXT = new Set(["跟", "和", "與", "与", "對", "对", "叫", "是", "為", "为", "認", "识", "識", "熟", "過", "在", "於", "于", "之", "的", "陪", "找", "給", "给", "讓", "让", "幫", "帮", "教", "問", "问"]);
const SHORT_ALIAS_RIGHT_CONTEXT = new Set(["是", "有", "在", "跟", "和", "與", "与", "的", "嗎", "吗", "呢", "吧", "呀", "喔", "哦", "你", "妳", "家", "交", "幫", "帮", "熟", "認", "识", "識", "談", "说", "說", "去", "過", "做", "買", "买", "看", "問", "问", "互", "那", "這", "这", "哪", "誰", "谁", "什", "別", "别", "還", "还", "或", "以", "前", "後", "后", "常", "最", "現", "现", "今", "昨", "明", "本", "次", "為", "为", "從", "从", "沒", "没", "不", "醬", "酱", "陪", "找", "一"]);

function isHan(value) {
  return Boolean(value && /\p{Script=Han}/u.test(value));
}

// The right-hand check only applies where the alias is also the start of an
// ordinary word: 小X nicknames (小希望, 小愛心) and single-character names.
// Two-character given names (愛音, 爽世, 立希) are followed by ordinary verbs
// and adverbs (爽世平常…, 立希排練…) and must not need a whitelisted next char.
// Contextual aliases (燈) instead reject their known compounds (燈光, 燈泡).
function shortHanAliasMatches(source, name, { contextual = false, blockedNext = "" } = {}) {
  const rightGuard = !contextual && ([...name].length === 1 || name.startsWith("小"));
  for (let start = source.indexOf(name); start >= 0; start = source.indexOf(name, start + 1)) {
    const end = start + name.length;
    const previous = source[start - 1] || "";
    const next = source[end] || "";
    const relationLeft = /(?:記得|记得|提到|想起|想到|覺得|觉得|認為|认为|關於|关于|對於|对于|怎麼看|怎么看|怎樣看|怎样看|如何看)$/u.test(source.slice(Math.max(0, start - 8), start));
    const leftBoundary = start === 0 || !isHan(previous) || SHORT_ALIAS_LEFT_CONTEXT.has(previous) || relationLeft
      || (contextual && CONTEXTUAL_RELATION_LEFT_RE.test(source.slice(Math.max(0, start - 8), start)));
    if (!leftBoundary) continue;
    if (contextual) {
      if (next && blockedNext.includes(next)) continue;
      return true;
    }
    if (!rightGuard) return true;
    const nicknameFollow = name.startsWith("小") && /^(?:你|妳|今天|明天|昨天|最近|現在|目前|有|沒有|沒|在哪|在嗎|呢|嗎|吗|吧|呀|喔|哦)/u.test(source.slice(end));
    if (!next || !isHan(next) || SHORT_ALIAS_RIGHT_CONTEXT.has(next) || nicknameFollow) return true;
  }
  return false;
}

export function aliasMatchesText(text, alias, options = {}) {
  const source = String(text || "").normalize("NFKC");
  const name = String(alias || "").trim().normalize("NFKC");
  if (!name) return false;
  const hanShort = [...name].length <= 2 && /\p{Script=Han}/u.test(name);
  if (hanShort) return shortHanAliasMatches(source, name, options);
  return normalizeAlias(source).includes(normalizeAlias(name));
}

const CONTEXTUAL_PERSON_CUE_RE = /(?:是誰|是谁|認識|认识|關係|关系|相處|相处|互動|互动|一起|陪|說過|说过|講過|讲过|寫歌|写歌|寫詞|写词|作詞|作词|歌詞|歌词|唱歌|樂團|乐团|團裡|团里|練習|练习|排練|排练|以前|那次|記得|记得|發生|发生|醬|酱|ちゃん|さん)/u;
// 「燈把石頭收起來」: a lamp is never the agent of 把.
const CONTEXTUAL_ACTION_RE = /^(?:把|拿|帶|带|送|給|给|拿給|拿给|打翻|撿|捡|說|说|講|讲|寫|写|唱|跑|走|來|来|去|做|帶著|带着|看|問|问|教|幫|帮|陪|等|吃|喝|撿到|捡到)/u;
const CONTEXTUAL_RELATION_LEFT_RE = /(?:跟|和|與|与|對|对|給|给|問|问|提到|記得|记得|那次|當時|当时|以前)$/u;
const CONTEXTUAL_OBJECT_AFTER_RE = /(?:跟|和|與|与|對|对|給|给|陪|幫|帮|讓|让|替|向)$/u;
const CONTEXTUAL_CONTINUATION_RE = /^(?:後|后|後來|后来|以後|以后|再|才|就|又)/u;
const CONTEXTUAL_MEMBER_LINK_RE = /(?:跟|和|與|与|對|对|陪|幫|帮|一起|及|還有|还有)/u;

// A contextual alias is also an ordinary word (燈 = lamp, 野貓 = stray cat).
// It names the character only when the sentence is visibly about a person:
// another member is named, a person-relation word or suffix appears, or the
// alias is used vocatively (野貓，過來 / 燈呢？).
function contextualAliasHasPersonCue(text, alias, otherMemberMentioned) {
  const source = String(text || "").normalize("NFKC");
  const name = String(alias || "").trim().normalize("NFKC");
  for (let start = source.indexOf(name); start >= 0; start = source.indexOf(name, start + 1)) {
    const previous = source[start - 1] || "";
    const after = source.slice(start + name.length);
    const left = source.slice(Math.max(0, start - 8), start);
    if (isHan(previous) && !SHORT_ALIAS_LEFT_CONTEXT.has(previous) && !CONTEXTUAL_RELATION_LEFT_RE.test(left)) continue;
    if (CONTEXTUAL_OBJECT_AFTER_RE.test(left) && CONTEXTUAL_CONTINUATION_RE.test(after)) return true;
    if (CONTEXTUAL_ACTION_RE.test(after)) return true;
    if (CONTEXTUAL_PERSON_CUE_RE.test(`${left}${name}${after.slice(0, 18)}`)) return true;
    if (otherMemberMentioned && CONTEXTUAL_MEMBER_LINK_RE.test(`${left}${name}${after.slice(0, 18)}`)) return true;
    if (/^呢/u.test(after)) return true;
    if (start === 0 && /^[，,！!～~、]/u.test(after)) return true;
  }
  return false;
}

function entityAliasMatch(entity, text, { contextual, otherMemberMentioned = false }) {
  const contextualSet = new Set(entity.contextualAliases || []);
  return [...entity.aliases]
    .filter((alias) => contextualSet.has(alias) === contextual)
    .sort((left, right) => normalizeAlias(right).length - normalizeAlias(left).length)
    .find((alias) => aliasMatchesText(text, alias, contextual
      ? { contextual: true, blockedNext: entity.contextualAliasBlockedNext?.[alias] || "" }
      : {})
      && (!contextual || contextualAliasHasPersonCue(text, alias, otherMemberMentioned)));
}

export function resolveEntityMentions(text, options = {}) {
  const entities = loadCanonicalEntities().entities;
  const found = new Map();

  for (const entity of entities) {
    const matchedAlias = entityAliasMatch(entity, text, { contextual: false });
    if (matchedAlias) found.set(entity, matchedAlias);
  }
  const otherMemberMentioned = found.size > 0;
  for (const entity of entities) {
    if (found.has(entity)) continue;
    const matchedAlias = entityAliasMatch(entity, text, { contextual: true, otherMemberMentioned });
    if (matchedAlias) found.set(entity, matchedAlias);
  }
  const matches = entities
    .filter((entity) => found.has(entity))
    .map((entity) => publicEntity(entity, found.get(entity)));

  for (const forced of options.forcedEntityIds || []) {
    const entity = entities.find((item) => item.entityId === forced || item.canonicalId === forced);
    if (entity && !matches.some((item) => item.entity_id === entity.entityId)) {
      matches.push(publicEntity(entity, "", "vision"));
    }
  }

  if (options.sessionKey && /(?:她|他|那個人|這個人|那位|這位)/u.test(String(text || ""))) {
    const remembered = recallResolvedEntities(options.sessionKey);
    for (const item of remembered) {
      if (!matches.some((match) => match.entity_id === item.entity_id)) {
        matches.push({ ...item, source: "session_pronoun" });
      }
    }
  }

  return matches;
}

export function rememberResolvedEntities(sessionKey, entities) {
  const key = String(sessionKey || "").trim();
  if (!key || !Array.isArray(entities) || entities.length === 0) return;
  sessionEntities.set(key, {
    updatedAt: Date.now(),
    entities: entities.map((item) => ({ ...item })),
  });
}

export function recallResolvedEntities(sessionKey) {
  const key = String(sessionKey || "").trim();
  const item = sessionEntities.get(key);
  if (!item || Date.now() - item.updatedAt > CONTEXT_TTL_MS) {
    if (item) sessionEntities.delete(key);
    return [];
  }
  return item.entities.map((entity) => ({ ...entity }));
}

export function clearResolvedEntities(scope) {
  const key = String(scope || "").trim();
  if (!key) return;
  sessionEntities.delete(key);
  for (const storedKey of sessionEntities.keys()) {
    if (storedKey.startsWith(`${key}|user:`)) sessionEntities.delete(storedKey);
  }
}

export const __test = { normalizeAlias, aliasMatchesText, resolveEntityMentions };

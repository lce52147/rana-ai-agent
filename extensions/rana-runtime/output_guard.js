import { readFileSync } from "node:fs";
import {
  firstText,
  hasExplicitPlayIntent,
  isCurrentSessionMemoryQuestion,
  isExplicitMemoryIntent,
  expectedToolForText,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
} from "./tool_contracts.js";
import {
  consumeRecentToolEvidence,
  consumeRecentToolOutcome,
  isRecentDirectMention,
  recentDiscordText,
} from "./context_store.js";

const DISCORD_REPLY_MAX_CHARS = 1800;
const CHARACTER_IMPRESSIONS_URL = new URL(
  "../../workspace/LORE/runtime/06_Rana_Character_Impressions.json",
  import.meta.url,
);

function loadConservativePersonAliases(readFile = readFileSync) {
  const parsed = JSON.parse(readFile(CHARACTER_IMPRESSIONS_URL, "utf8"));
  const conservative = (parsed?.characters || []).filter((item) =>
    ["unknown", "seen_not_close"].includes(String(item?.recognitionLevel || "")));
  const aliases = conservative.flatMap((item) => [
    item?.canonicalName,
    ...(item?.aliases || []),
  ]).map((value) =>
    String(value || "").normalize("NFKC").toLocaleLowerCase("zh-Hant").trim()
  ).filter((value) => value.length >= 2);
  if (!aliases.length) throw new Error("Rana conservative-person aliases are missing from character impressions");
  return [...new Set(aliases)].sort((a, b) => b.length - a.length);
}

const CONSERVATIVE_PERSON_ALIASES = loadConservativePersonAliases();

const SIMPLIFIED_TO_TRADITIONAL = new Map([
  ["无", "無"], ["没", "沒"], ["吗", "嗎"], ["这", "這"], ["说", "說"],
  ["乐", "樂"], ["奈", "奈"], ["会", "會"], ["发", "發"], ["声", "聲"],
  ["记", "記"], ["忆", "憶"], ["资", "資"], ["料", "料"], ["买", "買"],
]);

export function toTraditionalLite(text) {
  return firstText(text).replace(/[无没吗这说乐会发声记忆资买]/g, (ch) => SIMPLIFIED_TO_TRADITIONAL.get(ch) || ch);
}

function outgoingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string" ? item : firstText(item?.text))
      .filter(Boolean)
      .join("\n");
  }
  return firstText(value?.text) || firstText(value?.content);
}

export function sanitizeRanaTone(text) {
  const clean = toTraditionalLite(text).trim();
  if (/Context limit exceeded|reset our conversation|compaction buffer|reserveTokensFloor/i.test(clean)) {
    return "頭撞到上限了。再一次。";
  }

  let normalized = clean
    .replace(/```(?:plaintext|text)?\s*NO_REPLY\.?\s*```/gi, "")
    .replace(/^NO_REPLY\.?\s*/i, "")
    .replace(/\bNO_REPLY\.?\b/gi, "")
    .replace(/\[\[reply_to_current\]\]/gi, "")
    .trim();

  normalized = normalized
    .replace(/對(?:要)?樂奈而言/gu, "對我來說")
    .replace(/(?:要)?樂奈認為/gu, "我覺得")
    .replace(/(?:要)?樂奈對([^，。\n]{1,40})的印象/gu, "我對$1的印象")
    .replace(/(?:要)?樂奈覺得/gu, "我覺得")
    .replace(/(?:要)?樂奈知道/gu, "我知道")
    .replace(/(?:要)?樂奈記得/gu, "我記得");

  if (!normalized) return "\u7121\u804a\u3002";
  if (normalized.length <= DISCORD_REPLY_MAX_CHARS) return normalized;
  const clipped = normalized.slice(0, DISCORD_REPLY_MAX_CHARS);
  const boundary = Math.max(
    clipped.lastIndexOf("\u3002"),
    clipped.lastIndexOf("\uff01"),
    clipped.lastIndexOf("\uff1f"),
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );
  return (boundary >= 24 ? clipped.slice(0, boundary + 1) : clipped).trim();
}

function looksLikePlaybackSuccess(text) {
  return /(?:Now playing|queued|playing)/i.test(text)
    || /(?:\u5f48\u4e86|\u64ad\u4e86|\u6b63\u5728\u64ad\u653e|\u5df2\u52a0\u5165|\u6392\u4e86|\u6392\u9032|\u958b\u59cb\u64ad)/u.test(text);
}

function looksLikeMemoryRememberSuccess(text) {
  return /(?:saved|remembered)/i.test(text)
    || /(?:\u8a18\u4f4f\u4e86|\u8a18\u4e0b\u4e86|\u5df2\u8a18\u4f4f|\u5e6b\u4f60\u8a18)/u.test(text);
}

function leaksInternalText(text) {
  return /(?:tool_call|before_dispatch|message_sending|source_text|llm_hint|system prompt|persona|routing|rana-music-tools|rana_hot_tools|sidecar|pre-dispatch|dispatch|NO_REPLY)/i.test(text)
    || /(?:查(?:一下)?記憶|查詢記憶|呼叫工具|調用工具|工具回傳|正在查|查資料庫|內部流程|內部動作)/u.test(text);
}

function leaksRanaDataLanguage(text) {
  return /(?:recognitionLevel|memoryAnchors|allowedKnowledge|allowedReactionStyle|forbiddenExpansion|canonicalId|canonicalName|sourceRefs|rana_character_impressions|rana_person_context|rana_lore)/i.test(text)
    || /(?:認知層級|互動層級|記憶錨點|外層(?:關係|脈絡|資料)|單次記憶|形成印象|資料欄位|事件索引|研究摘要|根據(?:劇情|設定|資料|研究)|依據(?:是|為|來自)|官方設定顯示)/u.test(text)
    || /(?:^|\n)#{1,3}\s*(?:Rana Runtime Core|Rana First-Person Knowledge|Rana Remembered People|Rana Speech Style|CHARACTER_CORE)/iu.test(text);
}

function exposesInternalFailureWording(text) {
  return /(?:工具(?:沒抓到資料|失敗|出錯)|搜尋(?:失敗|出錯))/u.test(text);
}

function hideMemoryProvenance(text) {
  const clean = firstText(text).trim();
  if (/^(?:根據|依照|照著)(?:我的)?記憶(?:裡|中)?[，,：:]?\s*/u.test(clean)) {
    return clean.replace(/^(?:根據|依照|照著)(?:我的)?記憶(?:裡|中)?[，,：:]?\s*/u, "").trim();
  }
  if (/^(?:在)?(?:我的)?記憶(?:裡|中)(?:沒有|沒)(?:關於)?/u.test(clean)
    || /^(?:沒有|沒)有(?:關於)?.{0,80}(?:記憶|資料|資訊)/u.test(clean)) {
    return "不知道。";
  }
  return clean;
}

function overclaimsConservativePerson(sourceText, replyText) {
  const source = firstText(sourceText).normalize("NFKC").toLocaleLowerCase("zh-Hant");
  if (!CONSERVATIVE_PERSON_ALIASES.some((alias) => source.includes(alias))) return false;
  const reply = firstText(replyText);
  if (/(?:不熟|不知道|可能見過|沒有(?:確定的)?印象|不太認得)/u.test(reply)) return false;
  return /(?:我認識|我記得|是我朋友|我們很熟|跟她很熟|常常跟她|和她一起|跟她一起)/u.test(reply);
}

function looksLikeBrokenPunctuation(text) {
  const compact = firstText(text).replace(/\s+/g, "");
  if (compact.length < 12) return false;
  if (/^[?？!！.。…~～、,，;；:：]+$/u.test(compact)) return true;
  const questionMarks = (compact.match(/[?？]/gu) || []).length;
  return questionMarks >= 8 && compact.replace(/[?？]/gu, "").length <= 3;
}

export function guardOutgoingMessage(content, contextHint) {
  const text = outgoingText(content).trim();
  if (!text) return undefined;

  const sourceText = recentDiscordText(contextHint);
  const stripped = text
    .replace(/```(?:plaintext|text)?\s*NO_REPLY\.?\s*```/gi, "")
    .replace(/^NO_REPLY\.?\s*/i, "")
    .replace(/\bNO_REPLY\.?\b/gi, "")
    .replace(/\[\[reply_to_current\]\]/gi, "")
    .trim();
  const boundarySafe = hideMemoryProvenance(stripped);

  if (!stripped) {
    if (isRecentDirectMention(contextHint)) return { content: "\u7121\u804a\u3002" };
    return { cancel: true };
  }

  if (looksLikeBrokenPunctuation(boundarySafe)) return { content: "剛剛卡住了。再說一次。" };

  if (leaksRanaDataLanguage(boundarySafe)) return { content: "剛剛卡住了。再說一次。" };

  if (looksLikePlaybackSuccess(boundarySafe) && (!hasExplicitPlayIntent(sourceText) || !consumeRecentToolEvidence("rana_play_music", "", contextHint))) {
    return { content: "\u4e0d\u884c\u3002\u6c92\u6709\u771f\u7684\u64ad\u8d77\u4f86\u3002" };
  }

  if (expectedToolForText(sourceText) === "rana_stock_research") {
    const stockOutcome = consumeRecentToolOutcome("rana_stock_research", "research", contextHint);
    if (!stockOutcome.found || !stockOutcome.ok) return { content: "股票資料沒醒。不能亂說。" };
  }

  const isMemoryRememberRequest = Boolean(parseMemoryRememberRequest(sourceText)) && !isCurrentSessionMemoryQuestion(sourceText);
  const memoryRememberOutcome = consumeRecentToolOutcome("rana_memory", "remember", contextHint);
  if (isMemoryRememberRequest) {
    if (!memoryRememberOutcome.found || !memoryRememberOutcome.ok) {
      return { content: "\u4e0d\u884c\u3002\u6c92\u6709\u771f\u7684\u8a18\u8d77\u4f86\u3002" };
    }
  } else if (looksLikeMemoryRememberSuccess(boundarySafe) && (!isExplicitMemoryIntent(sourceText) || isCurrentSessionMemoryQuestion(sourceText) || !memoryRememberOutcome.found || !memoryRememberOutcome.ok)) {
    return { content: "\u4e0d\u884c\u3002\u6c92\u6709\u771f\u7684\u8a18\u8d77\u4f86\u3002" };
  }

  if (leaksInternalText(boundarySafe)) return { content: "剛剛卡住了。再說一次。" };

  if (overclaimsConservativePerson(sourceText, boundarySafe)) {
    return { content: "不熟。可能見過。" };
  }

  const isMemoryRecallRequest = expectedToolForText(sourceText) === "rana_memory"
    && Boolean(parseMemoryRecallRequest(sourceText))
    && !isCurrentSessionMemoryQuestion(sourceText);
  if (isMemoryRecallRequest && !consumeRecentToolEvidence("rana_memory", "recall", contextHint)) {
    return { content: "\u5361\u4f4f\u4e86\u3002\u518d\u554f\u4e00\u6b21\u3002" };
  }

  if (exposesInternalFailureWording(boundarySafe)) return { content: "查不到。不能亂說。" };

  const cleaned = sanitizeRanaTone(boundarySafe);
  if (cleaned !== text) return { content: cleaned };
  return undefined;
}

export const __test = {
  guardOutgoingMessage,
  sanitizeRanaTone,
  toTraditionalLite,
  looksLikeBrokenPunctuation,
  leaksRanaDataLanguage,
  hideMemoryProvenance,
  loadConservativePersonAliases,
  overclaimsConservativePerson,
};

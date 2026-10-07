import { firstText } from "./tool_contracts.js";
import { recentDiscordText } from "./context_store.js";

const FOOD_TERM_PATTERN =
  /(?:抹茶|蛋糕|芭菲|聖代|布蕾|巧克力|提拉米蘇|冰淇淋|冰沙|甜甜圈|泡芙|可麗餅|麻糬|羊羹|餅乾|鬆餅|麵包|奶酪|奶凍|甜點|蕎麥麵)/gu;

const SIMPLE_PREFERENCE_CUE =
  /(?:想吃|喜歡|比較喜歡|怎麼看|哪個|選哪|還是|都想吃|全部都想吃|全都要)/u;

const DETAILED_FOOD_INTENT =
  /(?:詳細|仔細|深入|分析|評測|評論|介紹|推薦|比較(?:差異|優缺點)|營養|熱量|食譜|配方|做法|怎麼做|製作方式)/u;

const ASSISTANT_EXPANSION_MARKERS =
  /(?:你覺得|你想|哪個最|要不要|全部都想吃嗎|不過我比較想選|口感|綿密|酥脆|層次|搭配|適合(?:夏天|冬天)|推薦|最近窮|沒錢|想問)/u;

function outgoingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : firstText(item?.text)))
      .filter(Boolean)
      .join("\n");
  }
  return firstText(value?.text) || firstText(value?.content);
}

function foodTermCount(text) {
  return [...firstText(text).matchAll(FOOD_TERM_PATTERN)].length;
}

function sentenceCount(text) {
  return firstText(text)
    .split(/[。！？!?\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
}

export function isSimpleFoodPreferenceTurn(sourceText) {
  const source = firstText(sourceText).normalize("NFKC").trim();
  if (!source || DETAILED_FOOD_INTENT.test(source)) return false;

  const foods = foodTermCount(source);
  const longFoodList = source.length >= 48 && foods >= 4;
  const explicitSimplePreference = SIMPLE_PREFERENCE_CUE.test(source) && foods >= 2;
  return longFoodList || explicitSimplePreference;
}

function preferredCanonicalChoice(sourceText) {
  const source = firstText(sourceText);
  if (/抹茶芭菲/u.test(source)) return "抹茶芭菲";
  if (/抹茶聖代/u.test(source)) return "抹茶聖代";
  if (/蕎麥麵/u.test(source)) return "蕎麥麵";
  if (/抹茶/u.test(source)) return "抹茶";
  return "";
}

function replyNeedsBounding(replyText) {
  const reply = firstText(replyText).trim();
  if (!reply) return false;
  return (
    reply.length > 48 ||
    sentenceCount(reply) > 2 ||
    /[？?]/u.test(reply) ||
    ASSISTANT_EXPANSION_MARKERS.test(reply)
  );
}

export function rewriteSimpleFoodPreference(sourceText, replyText) {
  if (!isSimpleFoodPreferenceTurn(sourceText)) return null;
  if (!replyNeedsBounding(replyText)) return null;

  const choice = preferredCanonicalChoice(sourceText);
  return choice ? `${choice}。` : "好多。想吃。";
}

export function guardPreferenceMessage(content, contextHint) {
  const sourceText = recentDiscordText(contextHint);
  const replyText = outgoingText(content).trim();
  const replacement = rewriteSimpleFoodPreference(sourceText, replyText);
  if (!replacement || replacement === replyText) return undefined;
  return { content: replacement };
}

export const __test = {
  foodTermCount,
  sentenceCount,
  replyNeedsBounding,
  preferredCanonicalChoice,
};

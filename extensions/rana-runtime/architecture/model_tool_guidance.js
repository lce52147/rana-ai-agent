import { buildUnifiedTurnPlan } from "./turn_plan.js";

const JAPANESE_KANA_RE = /[\u3040-\u30ff]/u;
const JAPANESE_NICKNAME_RE = /(?:りっきー|にゃむ|立希|ちゃん|さん)/u;
const USER_LANGUAGE_APPEND = "本題請使用使用者的語言回答；日文只保留專有名詞，其他內容不要改用日文。";

export function shouldAppendUserLanguageInstruction(prompt) {
  const text = String(prompt ?? "");
  return JAPANESE_KANA_RE.test(text) || JAPANESE_NICKNAME_RE.test(text);
}
/**
 * Prompt guidance is reserved for an already-grounded tool action.
 * Ordinary conversation receives no extra system text from this module.
 */
export function buildModelToolGuidance(promptOrPlan) {
  const plan = promptOrPlan && typeof promptOrPlan === "object" && promptOrPlan.version
    ? promptOrPlan
    : buildUnifiedTurnPlan(promptOrPlan);
  const tool = plan?.tool || { requested: false, kind: "none", arguments: {} };
  if (!tool.requested) return undefined;

  if (tool.kind === "web") {
    const webRequest = tool.arguments?.web || {};
    return [
      `先呼叫 web_search，query 只使用 ${JSON.stringify(String(webRequest.subject || "").trim())}。`,
      ...(webRequest.responseInstruction
        ? [`使用者的回答格式要求是 ${JSON.stringify(webRequest.responseInstruction)}；這是回答指示，不是搜尋 query。`]
        : []),
      "取得結果後直接回答使用者真正詢問的資訊；網站名稱、入口頁、論壇名稱與連結清單本身不算完成答案。",
      "只能把本輪 web_search 實際結果支持的內容當成搜尋所得；不得用模型既有記憶補成來源沒有提供的具體現況。",
      "若搜尋結果沒有足夠的具體資料，直接說搜尋結果不足。",
    ].join("\n");
  }

  if (tool.kind === "memory") {
    // Explicit durable-memory operations are handled by pre-dispatch before model generation.
    return undefined;
  }

  if (tool.kind === "music_play") {
    const play = tool.arguments?.playRequest || {};
    const target = play.url || play.query || plan.currentUser;
    return `先呼叫 rana_play_music；播放目標是 ${JSON.stringify(target)}。只有工具成功後才能說已播放或已加入，不得回答自己沒有播放能力。`;
  }

  if (tool.kind === "stock") {
    return "先呼叫 rana_stock_research；數值、狀態與結論只能使用工具實際結果。";
  }

  if (tool.kind === "vision") {
    return "本輪只有在目前 TurnPlan 已授權且存在可信的當輪圖片時才能使用 rana_analyze_image；只依工具實際結果回答。";
  }

  return undefined;
}

export function registerModelToolGuidance(api) {
  api.on("before_prompt_build", async (event, ctx) => {
    const plan = buildUnifiedTurnPlan(event?.prompt);
    const explicitGuidance = buildModelToolGuidance(plan);
    const result = {};
    if (explicitGuidance) result.prependSystemContext = explicitGuidance;
    if (shouldAppendUserLanguageInstruction(event?.prompt)) {
      result.appendContext = USER_LANGUAGE_APPEND;
    }
    return Object.keys(result).length ? result : undefined;
  }, { priority: 1300 });
}

export const __test = { buildModelToolGuidance, shouldAppendUserLanguageInstruction, USER_LANGUAGE_APPEND };


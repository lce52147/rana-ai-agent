import {
  expectedToolForText,
  extractUserMessageText,
  firstText,
  isExplicitWebSearchIntent,
  parseMemoryRecallRequest,
  parseMemoryRememberRequest,
  stripRanaMention,
} from "../tool_contracts.js";

function compact(value) {
  return firstText(value).replace(/\s+/g, " ").trim();
}

const EVENT_DIRECTION_CONTRACT = "敘述事件時保留動作者、受動者與先後方向；不能把『對方對我做了某事』改成『我對對方做了某事』。人物問題不能補 Core Files 沒有寫的樂團或職位。只有使用者問生日時才能使用生日索引。不確定就少說，不要反轉或補完。";

function withEventDirectionContract(guidance) {
  return guidance ? `${EVENT_DIRECTION_CONTRACT}\n${guidance}` : EVENT_DIRECTION_CONTRACT;
}

export function buildModelToolGuidance(prompt) {
  const userText = extractUserMessageText(prompt);

  if (isExplicitWebSearchIntent(userText)) {
    return withEventDirectionContract(`必須先呼叫工具：ollama_web_search({ "query": ${JSON.stringify(stripRanaMention(userText))} })。工具結果只是證據；等結果後再用自己的話短句回答，不要編造最新資訊，也不要提搜尋或工具。`);
  }

  const expectedTool = expectedToolForText(userText);
  const clean = compact(stripRanaMention(userText));
  if (!expectedTool) return EVENT_DIRECTION_CONTRACT;

  if (expectedTool === "rana_memory") {
    const remember = parseMemoryRememberRequest(clean);
    const recall = parseMemoryRecallRequest(clean);
    const action = remember ? "remember" : recall ? "recall" : "recall";
    const text = remember?.text || recall?.text || clean;
    return withEventDirectionContract(`必須先呼叫工具：rana_memory({ "action": "${action}", "text": ${JSON.stringify(text)} })。第一個輸出只能是 tool call。等工具結果後再回覆。只把工具實際回傳的內容寫成自然短句，不要說「記憶裡」、「查記憶」或任何內部流程。`);
  }

  if (expectedTool === "rana_play_music") {
    return withEventDirectionContract("使用 rana_play_music。等工具結果後再回覆；只依實際回傳狀態說是否已播放、加入或失敗，不得假稱成功，也不要提內部工具。");
  }

  if (expectedTool === "rana_stock_research") {
    return withEventDirectionContract("使用 rana_stock_research。等工具結果後再回覆；只用工具實際資料，不得補造數據、評分、來源或執行狀態。");
  }
  return EVENT_DIRECTION_CONTRACT;
}

export function registerModelToolGuidance(api) {
  api.on("before_prompt_build", async (event) => {
    const guidance = buildModelToolGuidance(event?.prompt);
    if (!guidance) return;
    return { prependSystemContext: guidance };
  }, { priority: 1000 });
}

export const __test = { buildModelToolGuidance };

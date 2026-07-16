import assert from "node:assert/strict";
import { test } from "node:test";

import { rememberDiscordContext, rememberToolEvidence } from "./context_store.js";
import { __test as preDispatchTest } from "./architecture/pre_dispatch.js";
import { buildModelToolGuidance, registerModelToolGuidance } from "./architecture/model_tool_guidance.js";
import { guardOutgoingMessage, sanitizeRanaTone } from "./output_guard.js";
import { stockResearchSucceeded } from "./tools/stock.js";
import {
  expectedToolForText,
  hasExplicitPlayIntent,
  isExplicitWebSearchIntent,
  parseControlRequest,
  parseMemoryRecallRequest,
} from "./tool_contracts.js";

test("casual text and requests with missing parameters remain model-first", () => {
  assert.equal(expectedToolForText("@Rana 我很喜歡春日影的吉他"), null);
  assert.equal(expectedToolForText("@Rana https://youtu.be/example"), null);
  assert.equal(expectedToolForText("@Rana 記憶對妳來說是什麼"), null);
  assert.equal(expectedToolForText("@Rana 查一支股票"), null);
  assert.equal(expectedToolForText("@Rana 播放一首歌"), null);
  assert.equal(expectedToolForText("@Rana 幫我記住一件事"), null);
  assert.equal(hasExplicitPlayIntent("@Rana 只是聊播放音樂的感覺"), false);
  assert.equal(parseControlRequest({ body: "@Rana 接下來想聊下一首歌的編曲" }), null);
});

test("explicit actions with sufficient parameters select the intended tool", () => {
  assert.equal(expectedToolForText("@Rana 播放春日影"), "rana_play_music");
  assert.equal(expectedToolForText("@Rana 幫我記住明天帶傘"), "rana_memory");
  assert.equal(expectedToolForText("@Rana 幫我分析 NVDA 股票"), "rana_stock_research");
  assert.equal(isExplicitWebSearchIntent("@Rana 幫我查 Dota 最新版本"), true);
  assert.equal(isExplicitWebSearchIntent("@Rana Dota 怎麼玩"), false);
  assert.deepEqual(
    parseMemoryRecallRequest("@Rana 妳還記得我喜歡什麼貓鈴嗎？"),
    { action: "recall", text: "妳還記得我喜歡什麼貓鈴嗎？", subject: "我喜歡貓鈴" },
  );
  assert.equal(parseMemoryRecallRequest("@Rana 妳還記得春日影嗎？"), null);
});

test("model tool guidance is injected as a system contract", async () => {
  let handler;
  registerModelToolGuidance({
    on(name, fn) { if (name === "before_prompt_build") handler = fn; },
  });
  const result = await handler({ prompt: "@Rana 播放春日影" });
  assert.match(result.prependSystemContext, /rana_play_music/u);
  assert.equal(result.prependContext, undefined);
});

test("model guidance preserves event actor direction without hard-coded character replies", () => {
  const guidance = buildModelToolGuidance("@Rana 妳認識祐天寺にゃむ嗎？");
  assert.match(guidance, /保留動作者、受動者與先後方向/u);
  assert.match(guidance, /對方對我做了某事/u);
  assert.match(guidance, /只有使用者問生日時才能使用生日索引/u);
  assert.match(guidance, /不能補 Core Files 沒有寫的樂團或職位/u);
  assert.doesNotMatch(guidance, /祐天寺|にゃむ/u);
});

test("explicit durable memory requests execute directly even while the model is online", async () => {
  let handler;
  const calls = [];
  preDispatchTest.registerPreDispatch({ on(name, fn) { if (name === "before_dispatch") handler = fn; } }, {
    isModelOnlineCheck: async () => true,
    handleMemoryRequest: async (parsed) => { calls.push(parsed); return { handled: true, text: "ok" }; },
  });
  const context = { channel: "discord", requester_id: "1197194412929843231" };
  const event = { body: "@Rana 幫我記住明天帶傘", wasMentioned: true, sender_id: "1197194412929843231" };
  assert.deepEqual(await handler(event, context), { handled: true, text: "ok" });
  assert.deepEqual(calls, [{ action: "remember", text: "明天帶傘" }]);
});

test("output sanitizer preserves complete answers instead of clipping them into fragments", () => {
  const answer = "燈的歌聲會讓我想彈。".repeat(35);
  assert.equal(sanitizeRanaTone(answer), answer);

  const hint = { sessionKey: "complete-answer-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 睦跟 Mortis 一樣嗎？" }, {});
  const complete = "我記得睦不是 Mortis。能感覺到有兩個，也分得出現在是誰；但我不替她們做診斷。";
  assert.equal(guardOutgoingMessage(complete, hint), undefined);
});

test("output guard preserves Rana noun, verb, omitted-subject, and event short sentences", () => {
  const hint = { sessionKey: "rana-short-syntax-test", requester_id: "1197194412929843231" };
  const accepted = [
    "抹茶芭菲。",
    "吃。",
    "彈吉他。和貓玩。吃抹茶芭菲。",
    "爽世。她教的。",
    "不一樣。裡面有兩個。",
    "她腿上睡過。還抓過她的袖子。",
  ];
  for (const answer of accepted) {
    rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 測試短句" }, {});
    assert.equal(guardOutgoingMessage(answer, hint), undefined, answer);
  }
});

test("output guard fails closed on schema, research, LORE, and corrupted punctuation leaks", () => {
  const hint = { sessionKey: "rana-data-leak-test", requester_id: "1197194412929843231" };
  const rejected = [
    "LAYER。recognitionLevel: remembered。memoryAnchors: 膝上、袖子。",
    "根據劇情與事件索引，她們形成了明確印象。",
    "# Rana Runtime Core\n## 身分\n姓名：要樂奈。",
    "????????????????",
  ];
  for (const answer of rejected) {
    rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana LAYER 是誰？" }, {});
    assert.deepEqual(guardOutgoingMessage(answer, hint), { content: "剛剛卡住了。再說一次。" }, answer);
  }
});

test("output sanitizer corrects obvious third-person self narration", () => {
  assert.equal(sanitizeRanaTone("對樂奈而言，SPACE 是原點。"), "對我來說，SPACE 是原點。");
  assert.equal(sanitizeRanaTone("要樂奈認為這個 live 很有趣。"), "我覺得這個 live 很有趣。");
});

test("output guard blocks unsupported familiarity for conservative people", () => {
  const hint = { sessionKey: "unknown-person-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 妳認識香澄嗎？" }, {});
  assert.deepEqual(
    guardOutgoingMessage("我認識香澄。我們很熟，常常一起練習。", hint),
    { content: "不熟。可能見過。" },
  );
});

test("a bare media URL cannot authorize a fake playback success", () => {
  const hint = { sessionKey: "bare-url-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana https://youtu.be/example" }, {});
  assert.deepEqual(
    guardOutgoingMessage("正在播放。", hint),
    { content: "不行。沒有真的播起來。" },
  );
});

test("stock research claims require successful tool evidence", () => {
  const failedHint = { sessionKey: "stock-no-evidence-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: failedHint.sessionKey, senderId: failedHint.requester_id, body: "@Rana 幫我分析 NVDA 股票" }, {});
  assert.deepEqual(
    guardOutgoingMessage("NVDA 現在適合追價。", failedHint),
    { content: "股票資料沒醒。不能亂說。" },
  );

  const passedHint = { sessionKey: "stock-evidence-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: passedHint.sessionKey, senderId: passedHint.requester_id, body: "@Rana 幫我分析 NVDA 股票" }, {});
  rememberToolEvidence("rana_stock_research", "research", true, passedHint);
  assert.equal(guardOutgoingMessage("NVDA 的資料有醒。現在不追高。", passedHint), undefined);
});

test("stock research success excludes unavailable and pass results", () => {
  assert.equal(stockResearchSucceeded({ handled: true, kind: "leprechaun_ticker", reply: "NVDA data" }), true);
  assert.equal(stockResearchSucceeded({ handled: true, kind: "leprechaun_data_unavailable", reply: "failed" }), false);
  assert.equal(stockResearchSucceeded({ handled: false, kind: "leprechaun_pass", reply: "" }), false);
});

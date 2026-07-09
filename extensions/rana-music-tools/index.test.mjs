import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "./index.js";

const user = "376320922484867073";

function event(body, extra = {}) {
  return { body, content: body, senderId: user, ...extra };
}

test("ordinary lore nouns do not route into music", () => {
  for (const text of ["@Rana CRYCHIC", "@Rana MyGO!!!!!", "@Rana Ave Mujica"]) {
    assert.equal(__test.parsePlayRequest(event(text)), null);
    assert.equal(__test.parseControlRequest(event(text)), null);
  }
});

test("ordinary conversation about music words stays model-first", () => {
  const text = "@Rana CRYCHIC 是什麼？不是要播放。";
  assert.equal(__test.isMetaLanguageToolDiscussion(text), true);
  assert.equal(__test.parsePlayRequest(event(text)), null);
  assert.equal(__test.parseControlRequest(event(text)), null);
});

test("ordinary chat does not enter tools when model is online", () => {
  assert.deepEqual(
    __test.classifyPreDispatch(event("@Rana 爽世說要買抹茶蛋糕"), {}, { modelOnline: true }),
    { kind: "model", routeText: "@Rana 爽世說要買抹茶蛋糕" }
  );
  assert.equal(__test.expectedToolForText("@Rana 爽世說要買抹茶蛋糕"), null);
});

test("mention gate accepts provider metadata but not plain name chatter", () => {
  assert.equal(
    __test.classifyPreDispatch(event("你怎麼看", { was_mentioned: true }), {}, { modelOnline: true }).kind,
    "model"
  );
  assert.equal(
    __test.classifyPreDispatch(event("樂奈好乖"), {}, { modelOnline: true }).kind,
    "pass"
  );
  assert.equal(
    __test.classifyPreDispatch(event("播放 春日影"), {}, { modelOnline: false }).kind,
    "pass"
  );
});

test("explicit tool intents map to model-callable tools", () => {
  assert.equal(__test.expectedToolForText("@Rana 播放 https://www.youtube.com/watch?v=-KfW_JkKfmk"), "rana_play_music");
  assert.equal(__test.expectedToolForText("@Rana 記住 紫貓酒量差"), "rana_memory");
  assert.equal(__test.expectedToolForText("@Rana 美股 INTC NVDA QCOM 分析"), "rana_stock_research");
});

test("model-online explicit tools are not executed by pre-dispatch", () => {
  for (const text of [
    "@Rana 播放 https://www.youtube.com/watch?v=-KfW_JkKfmk",
    "@Rana 記住 紫貓酒量差",
    "@Rana 美股 INTC NVDA QCOM 分析",
  ]) {
    assert.equal(__test.classifyPreDispatch(event(text), {}, { modelOnline: true }).kind, "model");
  }
});

test("offline fallback may execute explicit tools only after target gate", () => {
  assert.equal(__test.classifyPreDispatch(event("@Rana 播放 春日影"), {}, { modelOnline: false }).kind, "offline_play");
  assert.equal(__test.classifyPreDispatch(event("@Rana 美股 INTC 分析"), {}, { modelOnline: false }).kind, "offline_hot_tool");
  assert.equal(__test.classifyPreDispatch(event("播放 春日影"), {}, { modelOnline: false }).kind, "pass");
});

test("explicit audio URL may route to play", () => {
  const parsed = __test.parsePlayRequest(event("@Rana 播放 https://www.youtube.com/watch?v=-KfW_JkKfmk"));
  assert.equal(parsed?.url, "https://www.youtube.com/watch?v=-KfW_JkKfmk");
  assert.equal(parsed?.query, null);
});

test("explicit keyword play may route to music search", () => {
  const parsed = __test.parsePlayRequest(event("@Rana 播放 春日影"));
  assert.equal(parsed?.query, "春日影");
  assert.equal(parsed?.source, "youtube");
});

test("stock never routes to music", () => {
  const text = "@Rana 美股 LIVE 分析";
  assert.equal(__test.expectedToolForText(text), "rana_stock_research");
  assert.equal(__test.parsePlayRequest(event(text)), null);
});

test("current-session questions do not use long-term memory", () => {
  const text = "@Rana 你還記得剛剛我說什麼嗎？";
  assert.equal(__test.isCurrentSessionMemoryQuestion(text), true);
  assert.equal(__test.expectedToolForText(text), null);
  assert.equal(__test.isExplicitHotToolIntent(text), false);
});

test("durable memory recall still maps to rana_memory", () => {
  assert.equal(__test.expectedToolForText("@Rana 你還記得紫貓酒量嗎？"), "rana_memory");
});

test("output guard blocks fake playback on ordinary chat", () => {
  __test.rememberDiscordContext(event("@Rana CRYCHIC"), {});
  assert.deepEqual(
    __test.guardOutgoingMessage("要樂奈正在播放 CRYCHIC。"),
    { content: "那不是播放指令。別亂彈。" }
  );
});

test("output guard blocks fake memory success", () => {
  __test.rememberDiscordContext(event("@Rana 你還記得剛剛我說什麼嗎？"), {});
  assert.deepEqual(
    __test.guardOutgoingMessage("嗯。記住了。"),
    { content: "這要看目前對話。不是長期記憶。" }
  );
});

test("output guard sanitizes internal details but is not primary router", () => {
  __test.rememberDiscordContext(event("@Rana 爽世說要買抹茶蛋糕"), {});
  assert.deepEqual(
    __test.guardOutgoingMessage("系統補充：tool_call source_text llm_hint"),
    { content: "不說那個。" }
  );
  assert.equal(__test.classifyPreDispatch(event("@Rana 爽世說要買抹茶蛋糕"), {}, { modelOnline: true }).kind, "model");
});

test("output guard does not alter unrelated ordinary chat", () => {
  __test.rememberDiscordContext(event("@Rana 有抹茶芭菲嗎"), {});
  assert.equal(__test.guardOutgoingMessage("嗯。樂奈在。有抹茶芭菲嗎?"), undefined);
});

test("NO_REPLY sentinel is never exposed", () => {
  __test.rememberDiscordContext(event("@Rana 洗碗"), {});
  assert.deepEqual(
    __test.guardOutgoingMessage("NO_REPLY\n無聊。"),
    { content: "無聊。" }
  );
});

test("internal context-limit text is converted to sleep fallback", () => {
  assert.equal(
    __test.sanitizeRanaTone("Context limit exceeded. I've reset our conversation."),
    "在睡覺... 剛剛頭撞到上限。"
  );
});

test("timeout and unavailable sidecar errors do not claim playback success", () => {
  for (const message of [
    "request timeout (45000ms): http://127.0.0.1:8080/api/play",
    "voice bridge offline",
    "Lavalink session not established",
    "Extraction OK but playback failed",
  ]) {
    const reply = __test.ranaError(message);
    assert.match(reply, /^不行。/);
    assert.doesNotMatch(reply, /(?:彈了|排了|正在播放|正在為.*播放)/);
    assert.doesNotMatch(reply, /(?:127\.0\.0\.1|api\/play|ValidationError|stack)/);
  }
});

test("slow play pending requires queue or current-track evidence", () => {
  assert.equal(__test.hasPlaybackEvidence({}), false);
  assert.equal(__test.hasPlaybackEvidence({ queued: 0 }), false);
  assert.equal(__test.hasPlaybackEvidence({ queued: 2 }), true);
  assert.equal(__test.hasPlaybackEvidence({ current: { title: "春日影" } }), true);
});

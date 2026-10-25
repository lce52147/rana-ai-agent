import http from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMemoryCandidates, __test as extractorTest } from "./auto_extractor.js";

test("collector keeps the last ordered user to assistant pair and only assistant text blocks", () => {
  const result = extractorTest.collectTurn({ messages: [
    { role: "user", content: "舊問題", __openclaw: { senderId: "111" } },
    { role: "assistant", content: [{ type: "text", text: "舊回答" }] },
    { role: "user", content: [{ type: "text", text: "新問題" }], __openclaw: { senderId: "222" } },
    { role: "toolResult", content: [{ type: "text", text: "工具輸出" }] },
    { role: "assistant", content: [{ type: "thinking", text: "內部推理" }, { type: "text", text: "新回答" }] },
  ] }, {});
  assert.deepEqual({ user: result.user, assistant: result.assistant, userId: result.userId }, { user: "新問題", assistant: "新回答", userId: "222" });
  assert.doesNotMatch(result.assistant, /內部推理/u);
});

test("collector gives live senderId precedence over transcript metadata", () => {
  const result = extractorTest.collectTurn({
    senderId: "333",
    messages: [
      { role: "user", content: "問題", __openclaw: { senderId: "222" } },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
    ],
  }, {});
  assert.equal(result.userId, "333");
});

test("failed assistant messages do not consume the pending user turn", () => {
  const result = extractorTest.collectTurn({ messages: [
    { type: "message", message: { role: "user", content: "問題", __openclaw: { senderId: "444" } } },
    { type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "失敗" }] } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "重試成功" }] } },
  ] }, {});
  assert.equal(result.user, "問題");
  assert.equal(result.assistant, "重試成功");
  assert.equal(result.userId, "444");
});

test("collector falls back through the live session index to a transcript", () => {
  const result = extractorTest.collectTurn({ sessionKey: "agent:taki:discord:channel:900000000000000007" }, { agentId: "taki" });
  assert.ok(result.user.length > 0);
  assert.ok(result.assistant.length > 0);
});

test("busy probe recognizes explicit in-flight state", () => {
  assert.equal(extractorTest.probeBusy({ slots: [{ is_processing: true }] }), true);
  assert.equal(extractorTest.probeBusy({ status: "ok" }), false);
});

test("extractor tolerates the observed OOGG response latency", async (t) => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [{ kind: "preference", subject: "", content: "晚上整理播放清單", confidence: 0.9 }] }) } }] }));
    }, 2400);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const previousUrl = process.env.RANA_MEMORY_EXTRACTOR_URL;
  process.env.RANA_MEMORY_EXTRACTOR_URL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const result = await extractMemoryCandidates({ user: "我喜歡晚上整理播放清單。", assistant: "收到。" });
    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 1);
  } finally {
    if (previousUrl === undefined) delete process.env.RANA_MEMORY_EXTRACTOR_URL;
    else process.env.RANA_MEMORY_EXTRACTOR_URL = previousUrl;
  }
});

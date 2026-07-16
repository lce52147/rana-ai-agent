import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberDiscordContext, rememberToolEvidence } from "./context_store.js";
import { guardOutgoingMessage } from "./output_guard.js";
import { __test as memoryTest } from "./tools/memory.js";

test("security:not_owner normalizes to an explicit failed memory contract", () => {
  const outcome = memoryTest.normalizeMemoryToolResult("remember", null, new Error('{"handled":true,"kind":"security:not_owner","reply":"只有給我抹茶芭菲才可以叫我忘記。"}'));
  assert.equal(outcome.success, false);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.kind, "security:not_owner");
});

test("malformed memory result is never successful", () => {
  const outcome = memoryTest.normalizeMemoryToolResult("remember", { unexpected: true });
  assert.equal(outcome.success, false);
  assert.equal(outcome.status, "error");
});

test("saved user facts are recalled from Rana's second-person viewpoint", () => {
  assert.equal(memoryTest.ranaMemoryRecallText("我喜歡藍色貓鈴"), "你喜歡藍色貓鈴。");
  assert.equal(memoryTest.ranaMemoryRecallText("我的生日是七月十五日"), "你的生日是七月十五日。");
});

test("failed remember evidence blocks remembered-success wording", () => {
  const hint = { sessionKey: "memory-failure-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 記住紫貓酒量差" }, {});
  rememberToolEvidence("rana_memory", "remember", false, hint);
  assert.deepEqual(guardOutgoingMessage("嗯。記住了。", hint), { content: "不行。沒有真的記起來。" });
});

test("explicit memory success still allows the normal Rana reply", () => {
  const hint = { sessionKey: "memory-success-test", requester_id: "1197194412929843231" };
  rememberDiscordContext({ sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 記住皓男哥是帥哥" }, {});
  rememberToolEvidence("rana_memory", "remember", true, hint);
  assert.equal(guardOutgoingMessage("嗯。記住了。", hint), undefined);
});

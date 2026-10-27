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

// output_guard is observe-only (anti-cheat invariant): a failed remember is
// handled by the tool result contract above, never by rewriting model text.
test("failed remember evidence does not trigger a post-generation rewrite", () => {
  const hint = { agentId: "main", accountId: "default", sessionKey: "memory-failure-test", requester_id: "900000000000000002" };
  rememberDiscordContext({ agentId: "main", accountId: "default", sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 記住小陳喜歡吃拉麵" }, {});
  rememberToolEvidence("rana_memory", "remember", false, hint);
  assert.equal(guardOutgoingMessage("嗯。記住了。", hint), undefined);
});

test("explicit memory success still allows the normal Rana reply", () => {
  const hint = { agentId: "main", accountId: "default", sessionKey: "memory-success-test", requester_id: "900000000000000002" };
  rememberDiscordContext({ agentId: "main", accountId: "default", sessionKey: hint.sessionKey, senderId: hint.requester_id, body: "@Rana 記住阿明喜歡咖哩" }, {});
  rememberToolEvidence("rana_memory", "remember", true, hint);
  assert.equal(guardOutgoingMessage("嗯。記住了。", hint), undefined);
});

test("memory write roles authorize explicit writes from the module-root rules path", () => {
  assert.equal(/workspace[\\/]services[\\/]rana_hot_tools[\\/]rules\.json$/.test(memoryTest.rulesPath), true);
  assert.equal(memoryTest.memoryWritePermission({ senderId: "555555555555555555", roles: ["900000000000000004"] }, {}), true);
  assert.equal(memoryTest.memoryWritePermission({ senderId: "555555555555555555" }, {}), false);
});

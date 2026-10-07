import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { __test as runtimeTest } from "../index.js";
import { classifyPreDispatch } from "./pre_dispatch.js";

test("Rana runtime has no custom before_model_resolve model override", async () => {
  const registrations = [];
  plugin.register({
    on(name, callback, options) {
      registrations.push({ name, callback, options });
    },
    registerTool() {},
    logger: { warn() {} },
  });

  const modelResolveHandlers = registrations.filter(
    ({ name }) => name === "before_model_resolve",
  );
  for (const { callback } of modelResolveHandlers) {
    const result = await callback({ prompt: "offline OOGG regression probe" }, {});
    assert.equal(Object.hasOwn(result || {}, "providerOverride"), false);
    assert.equal(Object.hasOwn(result || {}, "modelOverride"), false);
  }
});

test("offline OOGG keeps deterministic predispatch classification", () => {
  assert.deepEqual(
    classifyPreDispatch(
      { body: "@Rana 現在想彈吉他嗎？", wasMentioned: true, sender_id: "1197194412929843231" },
      { channel: "discord" },
      { modelOnline: false },
    ),
    { kind: "model", routeText: "@Rana 現在想彈吉他嗎？" },
  );
});

test("message_sending guard hint preserves event metadata and hook context", () => {
  const event = { content: "hello", channel: "discord", messageId: "m-1" };
  const ctx = { sessionKey: "session-1", accountId: "tomori", channel: "discord" };

  assert.deepEqual(runtimeTest.messageSendingContextHint(event, ctx), {
    sessionKey: "session-1",
    accountId: "tomori",
    channel: "discord",
    content: "hello",
    messageId: "m-1",
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPreDispatch, registerOfflineModelSelection } from "./pre_dispatch.js";

function registerSelection(isModelOnlineCheck) {
  let handler;
  registerOfflineModelSelection({
    on(name, callback) {
      if (name === "before_model_resolve") handler = callback;
    },
  }, { isModelOnlineCheck });
  return handler;
}

test("offline OOGG selects the configured Gemini standby model", async () => {
  const handler = registerSelection(async () => false);
  assert.deepEqual(await handler({ prompt: "@Rana 抹茶芭菲還有嗎" }), {
    providerOverride: "google",
    modelOverride: "gemini-3.1-flash-lite",
  });
});

test("online OOGG leaves the primary model unchanged", async () => {
  const handler = registerSelection(async () => true);
  assert.equal(await handler({ prompt: "@Rana 抹茶芭菲還有嗎" }), undefined);
});

test("ordinary targeted text reaches standby model resolution when OOGG is offline", () => {
  assert.deepEqual(
    classifyPreDispatch(
      { body: "@Rana 現在想彈吉他嗎？", wasMentioned: true, sender_id: "1197194412929843231" },
      { channel: "discord" },
      { modelOnline: false },
    ),
    { kind: "model", routeText: "@Rana 現在想彈吉他嗎？" },
  );
});

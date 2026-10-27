import assert from "node:assert/strict";
import { test } from "node:test";
import { guardOutgoingMessage, toTraditionalLite } from "./output_guard.js";

test("outgoing language guard converts simplified Chinese to Taiwan Traditional Chinese", () => {
  assert.equal(
    toTraditionalLite("我会先确认她是否需要休息，再用温和但坚定的方式引导她找到节奏。"),
    "我會先確認她是否需要休息，再用溫和但堅定的方式引導她找到節奏。",
  );
});

// output_guard is observe-only (anti-cheat invariant): language is set by the
// persona prompt, and the outbound boundary never rewrites model text.
test("non-Rana bot outputs are not rewritten at the outbound boundary", () => {
  for (const botId of ["anon", "soyo", "taki", "tomori"]) {
    assert.equal(
      guardOutgoingMessage(
        "如果燈卡住，我会先确认，再调整练习感觉。",
        { sessionKey: "agent:" + botId + ":language-guard-test" },
      ),
      undefined,
      botId,
    );
  }
});

test("already Traditional output is left unchanged for non-Rana bots", () => {
  const text = "高松燈。MyGO!!!!!的主唱。";
  assert.equal(
    guardOutgoingMessage(text, { sessionKey: "agent:tomori:language-guard-clean" }),
    undefined,
  );
});

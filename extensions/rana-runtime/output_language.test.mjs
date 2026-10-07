import assert from "node:assert/strict";
import { test } from "node:test";
import { guardOutgoingMessage, toTraditionalLite } from "./output_guard.js";

test("outgoing language guard converts simplified Chinese to Taiwan Traditional Chinese", () => {
  assert.equal(
    toTraditionalLite("我会先确认她是否需要休息，再用温和但坚定的方式引导她找到节奏。"),
    "我會先確認她是否需要休息，再用溫和但堅定的方式引導她找到節奏。",
  );
});

test("all four non-Rana bot outputs are converted at the outbound boundary", () => {
  for (const botId of ["anon", "soyo", "taki", "tomori"]) {
    assert.deepEqual(
      guardOutgoingMessage(
        "如果燈卡住，我会先确认，再调整练习感觉。",
        { sessionKey: "agent:" + botId + ":language-guard-test" },
      ),
      { content: "如果燈卡住，我會先確認，再調整練習感覺。" },
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

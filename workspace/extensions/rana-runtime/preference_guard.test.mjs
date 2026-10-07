import assert from "node:assert/strict";
import { test } from "node:test";

import { rememberDiscordContext } from "./context_store.js";
import {
  guardPreferenceMessage,
  isSimpleFoodPreferenceTurn,
  rewriteSimpleFoodPreference,
} from "./preference_guard.js";

test("long food lists are classified as simple preference turns", () => {
  const source =
    "@Rana 我想吃抹茶蛋糕 抹茶巧克力 抹茶巴斯克 抹茶提拉米蘇 抹茶冰淇淋 抹茶蕎麥麵 抹茶泡芙";
  assert.equal(isSimpleFoodPreferenceTurn(source), true);
});

test("explicit detailed food analysis bypasses the hard gate", () => {
  const source = "@Rana 詳細分析抹茶蛋糕和抹茶芭菲的口感差異";
  assert.equal(isSimpleFoodPreferenceTurn(source), false);
});

test("assistant-style preference expansion is bounded", () => {
  const source =
    "@Rana 我想吃抹茶蛋糕 抹茶巧克力 抹茶巴斯克 抹茶提拉米蘇 抹茶冰淇淋 抹茶芭菲";
  const reply = "抹茶蛋糕、抹茶布蕾……全部都想吃嗎？不過我比較想選一個，你覺得哪個最特別？";
  assert.equal(rewriteSimpleFoodPreference(source, reply), "抹茶芭菲。");
});

test("already-short Rana preference replies pass unchanged", () => {
  const source = "@Rana 抹茶蛋糕跟抹茶芭菲，你怎麼看？";
  assert.equal(rewriteSimpleFoodPreference(source, "抹茶芭菲。冰的比較好。"), null);
});

test("message_sending guard uses the current Discord source text", () => {
  const hint = {
    sessionKey: "preference-hard-gate-test",
    requester_id: "1197194412929843231",
  };
  rememberDiscordContext(
    {
      sessionKey: hint.sessionKey,
      senderId: hint.requester_id,
      body:
        "@Rana 我想吃抹茶蛋糕 抹茶巧克力 抹茶巴斯克 抹茶提拉米蘇 抹茶冰淇淋 抹茶芭菲",
    },
    {},
  );

  assert.deepEqual(
    guardPreferenceMessage(
      "抹茶蛋糕、抹茶布蕾……全部都想吃嗎？不過我比較想選一個，你覺得哪個最特別？",
      hint,
    ),
    { content: "抹茶芭菲。" },
  );
});

test("unrelated long answers are not clipped", () => {
  const source = "@Rana SPACE 對妳來說是什麼？";
  const reply = "小時候一直在那裡。外婆在。吉他也在。";
  assert.equal(rewriteSimpleFoodPreference(source, reply), null);
});

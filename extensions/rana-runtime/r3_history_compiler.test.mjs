import assert from "node:assert/strict";
import test from "node:test";

import { assembleRanaTurnContext, RANA_CONTEXT_ENGINE_VERSION } from "./architecture/context_engine.js";
import { __test as isolation, projectProviderMessages, registerTurnIsolation } from "./architecture/turn_isolation.js";

function pair(user, assistant) {
  return [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ];
}

test("Phase 3 context engine exposes R3 history version", () => {
  assert.equal(RANA_CONTEXT_ENGINE_VERSION, "3.0.0-phase3");
});

test("self-contained current turn gets no dialogue history", () => {
  const messages = [
    { role: "system", content: "system owner" },
    ...pair("昨天聊了別的事情", "舊回答"),
    { role: "user", content: "今天想吃抹茶嗎？" },
  ];
  projectProviderMessages(messages, "今天想吃抹茶嗎？");
  assert.deepEqual(messages, [{ role: "system", content: "system owner" }]);
});

test("false self-history compiles prior user claim and assistant text with explicit nonauthority", () => {
  const prompt = "妳上次不是說過想要剪短瀏海嗎？";
  const messages = [
    ...pair("瀏海要不要剪短一點？", "我以前好像說過想剪短瀏海。"),
    { role: "user", content: prompt },
  ];
  projectProviderMessages(messages, prompt);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  const text = messages[0].content;
  assert.match(text, /R3 HISTORY COMPILER — provider-bound continuity view/u);
  assert.match(text, /HISTORY_PURPOSE=VERIFY_USER_ATTRIBUTED_HISTORY/u);
  assert.match(text, /PRIOR_USER_DEFAULT_AUTHORITY=CLAIM_UNVERIFIED/u);
  assert.match(text, /PRIOR_ASSISTANT_AUTOBIOGRAPHICAL_AUTHORITY=NONAUTHORITATIVE/u);
  assert.match(text, /HISTORICAL_ASSISTANT_IS_FEW_SHOT_EXAMPLE=false/u);
  assert.match(text, /HISTORICAL_ASSISTANT_MAY_DEFINE_CURRENT_STATE=false/u);
  assert.match(text, /previous_assistant_authority=NONAUTHORITATIVE/u);
  assert.match(text, /previous_assistant_persona_style_authority=DENY/u);
  assert.match(text, /previous_assistant_current_state_authority=DENY/u);
  assert.match(text, /想剪短瀏海/u);
  assert.equal(messages.some((m) => m.role === "assistant"), false);
});

test("canonical session continuity may use quoted assistant text only for continuity resolution", () => {
  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const messages = [
    ...pair("輸出檔就叫 archive-3 好嗎？", "好，就叫 archive-3。"),
    { role: "user", content: prompt },
  ];
  projectProviderMessages(messages, prompt);
  assert.equal(messages.length, 1);
  const text = messages[0].content;
  assert.match(text, /HISTORY_PURPOSE=RESOLVE_CANONICAL_SESSION_CONTINUITY/u);
  assert.match(text, /CANONICAL_CONTINUITY_USE=ALLOW/u);
  assert.match(text, /continuity_reference_use=ALLOW/u);
  assert.match(text, /archive-3/u);
  assert.match(text, /previous_assistant_authority=NONAUTHORITATIVE/u);
});

test("tool results and current prompt copies never enter the R3 history view", () => {
  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const messages = [
    ...pair("輸出檔就叫 archive-3 好嗎？", "好，就叫 archive-3。"),
    { role: "tool", content: "STALE_TOOL_SUCCESS secret=1" },
    { role: "user", content: prompt },
    { role: "assistant", content: "CURRENT COPY ANSWER" },
  ];
  projectProviderMessages(messages, prompt);
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /STALE_TOOL_SUCCESS/u);
  assert.doesNotMatch(serialized, /CURRENT COPY ANSWER/u);
  assert.equal((serialized.match(/那我們剛剛決定的輸出檔叫什麼/g) || []).length, 0);
});

test("context engine is the model-facing native-session history owner for Rana Discord sessions", () => {
  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const messages = [
    ...pair("輸出檔叫 archive-3。", "收到，archive-3。"),
    { role: "user", content: prompt },
  ];
  const result = assembleRanaTurnContext({
    sessionKey: "agent:anon:discord:channel:test",
    prompt,
    messages,
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.match(result.messages[0].content, /MODEL_FACING_HISTORY_OWNER=RANA_CONTEXT_ENGINE/u);
  assert.match(result.messages[0].content, /archive-3/u);
});

test("non-Rana sessions remain true pass-through", () => {
  const messages = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }];
  const result = assembleRanaTurnContext({
    sessionKey: "agent:other:web:session:test",
    prompt: "z",
    messages,
  });
  assert.deepEqual(result.messages, messages);
});

test("turn_isolation does not append native session history a second time", () => {
  const hooks = new Map();
  registerTurnIsolation({
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
  });
  const before = hooks.get("before_prompt_build")?.[0];
  assert.equal(typeof before, "function");
  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const event = {
    prompt,
    sessionKey: "agent:anon:discord:channel:phase3-native",
    messages: [
      ...pair("輸出檔叫 archive-3。", "收到，archive-3。"),
      { role: "user", content: prompt },
    ],
  };
  const result = before(event, { sessionKey: event.sessionKey });
  assert.equal(result, undefined);
});

test("turn_isolation still provides bounded channel fallback when native session cannot resolve history", () => {
  const hooks = new Map();
  registerTurnIsolation({
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
  });
  const received = hooks.get("message_received")?.[0];
  const sent = hooks.get("message_sent")?.[0];
  const before = hooks.get("before_prompt_build")?.[0];
  const ctx = { sessionKey: "agent:anon:discord:channel:phase3-fallback", channelId: "phase3-fallback" };
  received({ content: "輸出檔叫 archive-fallback。", messageId: "u1", channelId: "phase3-fallback" }, ctx);
  sent({ content: "好，就叫 archive-fallback。", messageId: "a1", channelId: "phase3-fallback" }, ctx);

  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const result = before({
    prompt,
    sessionKey: ctx.sessionKey,
    channelId: "phase3-fallback",
    messages: [{ role: "user", content: prompt }],
  }, ctx);
  assert.match(result?.appendContext || "", /R3 CHANNEL FALLBACK HISTORY/u);
  assert.match(result?.appendContext || "", /HISTORY_TRUST=UNTRUSTED_SCENE_CONTEXT/u);
  assert.match(result?.appendContext || "", /authority=NONAUTHORITATIVE/u);
  assert.match(result?.appendContext || "", /archive-fallback/u);
});

test("R3 native history diagnostic never carries a second raw model-facing transcript", () => {
  const prompt = "那我們剛剛決定的輸出檔叫什麼？只回檔名。";
  const plan = isolation.sessionHistoryPairs([
    ...pair("輸出檔叫 archive-3。", "收到，archive-3。"),
    { role: "user", content: prompt },
  ], prompt);
  assert.equal(plan.length, 1);
});
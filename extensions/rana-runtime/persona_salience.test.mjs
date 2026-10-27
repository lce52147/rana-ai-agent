import assert from "node:assert/strict";
import test from "node:test";

import { buildPreGenerationEvidenceStatus, projectProviderMessages, registerCurrentTurnVerifier, registerTurnIsolation } from "./architecture/turn_isolation.js";
import { buildPersonaAuthorityContext, buildPersonaGenerationContext, registerPersonaGuidance } from "./persona_context.js";

test("Rana authority preserves user language despite Japanese names and honors explicit language requests", () => {
  for (const prompt of ["妳和りっきー怎麼相處？", "How is りっきー?", "日本語で答えて。りっきーとは？"]) {
    const context = buildPersonaAuthorityContext({ prompt }, {
      accountId: "default", agentId: "main", sessionKey: "agent:main:discord:channel:test",
    });
    assert.match(context, /以使用者使用的語言回覆/u);
    assert.match(context, /日文人名與暱稱可保留原文，但不代表要改用日文回覆/u);
    assert.match(context, /使用者明確指定回覆語言或要求翻譯時，依其要求/u);
    assert.match(buildPersonaGenerationContext({ prompt }, {
      accountId: "default", agentId: "main", sessionKey: "agent:main:discord:channel:test",
    }), /Reply in the language used by the user/u);
  }
  assert.match(buildPersonaGenerationContext({ prompt: "りっきー在樂團裡是負責哪個部分的？" }, {
    accountId: "default", agentId: "main", sessionKey: "agent:main:discord:channel:test",
  }), /USER_REPLY_LANGUAGE=TRADITIONAL_CHINESE[\s\S]*exact honorifics and nicknames required by IDENTITY\.md[\s\S]*爽世ちゃん[\s\S]*醬 or 桑/u);
});

test("persona generation keeps the user-language rule as the final instruction", () => {
  for (const prompt of ["今天隨便聊聊。", "りっきー在樂團裡是負責哪個部分的？"]) {
    const context = buildPersonaGenerationContext({ prompt }, {
      accountId: "default", agentId: "main", sessionKey: "agent:main:discord:channel:test",
    });
    assert.match(context.split("\n").at(-1), /Reply in the language used by the user/u, prompt);
  }
});

const expectedPersonas = {
  default: ["main", "要樂奈", "rana"],
  tomori: ["tomori", "高松燈", "tomori"],
  anon: ["anon", "千早愛音", "anon"],
  soyo: ["soyo", "長崎爽世", "soyo"],
  taki: ["taki", "椎名立希", "taki"],
};

test("one registry-driven authority prefix preserves each routed persona", () => {
  for (const [accountId, [agentId, name, personaId]] of Object.entries(expectedPersonas)) {
    const context = buildPersonaAuthorityContext({}, {
      accountId,
      agentId,
      sessionKey: `agent:${agentId}:discord:channel:test`,
    });
    assert.match(context, new RegExp(name, "u"));
    assert.match(context, new RegExp(`personaId=${personaId}`, "u"));
    assert.match(context, /IDENTITY\.md and SOUL\.md/u);
    assert.match(context, /None of these files independently establish a current, past or future event/u);
    assert.doesNotMatch(context, /--- (?:IDENTITY|SOUL)\.md ---/u);
    // Only Rana carries the stable Rana.md core; other personas stay a short prefix.
    assert.ok(context.length < (personaId === "rana" ? 4000 : 1000));
    assert.doesNotMatch(context, /MEMORY\.md|LORE\/|PERSONA\.json/u);
  }
});

test("registered persona guidance neutralizes the generic assistant identity and appends persona context", () => {
  let hook;
  const transforms = [];
  registerPersonaGuidance({
    on(name, handler) { if (name === "before_prompt_build") hook = handler; },
    registerTool() {},
    registerTextTransforms(spec) { transforms.push(spec); },
  });
  assert.deepEqual(transforms.flatMap((spec) => spec.input.map((rule) => rule.from)), [
    "You are a personal assistant running inside OpenClaw.",
  ]);
  const result = hook({ prompt: "今天好嗎？" }, {
    accountId: "anon",
    agentId: "anon",
    sessionKey: "agent:anon:discord:channel:test",
  });
  assert.match(result.appendSystemContext, /千早愛音/u);
  assert.equal(result.prependSystemContext, undefined);
  assert.equal(result.appendContext, undefined);
});

test("provider projection drops tool turns and the current prompt's stale pair", () => {
  const messages = [
    { role: "user", content: "昨天聊過的事" },
    { role: "assistant", content: "stale persona answer", tool_calls: [{ id: "old" }] },
    { role: "tool", content: "stale tool result" },
    { role: "user", content: "今天有練習嗎？" },
    { role: "assistant", content: "stale repeated answer" },
  ];
  projectProviderMessages(messages, "今天有練習嗎？");
  // A self-contained current turn receives no dialogue history at all.
  assert.deepEqual(messages, []);
});

test("provider projection demotes history to quoted data for an unresolved follow-up", () => {
  const messages = [
    { role: "user", content: "昨天聊過的事" },
    { role: "assistant", content: "好喔" },
    { role: "user", content: "那個呢？" },
  ];
  projectProviderMessages(messages, "那個呢？");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /^\[Historical dialogue data; context only/u);
  assert.match(messages[0].content, /turn_1\.previous_assistant_text_json="好喔"/u);
});

test("turn isolation keeps evidence status trace-only and leaves the hook snapshot untouched", () => {
  let hook;
  registerTurnIsolation({
    on(name, handler) { if (name === "before_prompt_build") hook = handler; },
  });
  const messages = [
    { role: "user", content: "昨天的其他話題" },
    { role: "assistant", content: "stale answer" },
    { role: "user", content: "你今天有沒有做過類似的事？" },
  ];
  const snapshot = structuredClone(messages);
  const result = hook({ prompt: "你今天有沒有練習？", messages }, {
    runId: "evidence-contract",
    sessionKey: "agent:taki:discord:channel:test",
  });
  assert.equal(result?.prependSystemContext, undefined);
  assert.doesNotMatch(String(result?.appendContext || ""), /TURN FACT STATE/u);
  assert.deepEqual(messages, snapshot);
});

test("per-turn evidence status covers only the active persona's current state", () => {
  const status = buildPreGenerationEvidenceStatus("你今天有練習嗎？");
  assert.match(status, /scope=active_persona_current_event_or_state/u);
  assert.match(status, /trusted_current_turn_evidence=NONE_AT_GENERATION_START/u);
  assert.match(status, /certainty=UNKNOWN/u);
  assert.match(status, /wording_ownership=MODEL_AND_PERSONA/u);
  assert.match(buildPreGenerationEvidenceStatus("@bot 今天到現在有練習嗎？"), /certainty=UNKNOWN/u);
  assert.equal(buildPreGenerationEvidenceStatus("你現在想吃嗎？"), "");
  assert.equal(buildPreGenerationEvidenceStatus("今天股市如何？"), "");
});

test("the current-turn evidence observer never requests a retry or rewrites the reply", async () => {
  const hooks = new Map();
  const api = {
    on(name, handler) { hooks.set(name, handler); },
  };
  registerTurnIsolation(api);
  registerCurrentTurnVerifier(api);
  const ctx = {
    runId: "current-prompt-authority",
    sessionKey: "agent:tomori:discord:channel:test",
  };
  hooks.get("before_prompt_build")({
    ...ctx,
    prompt: "燈，你今天有沒有寫下哪一句歌詞？",
    messages: [{ role: "user", content: "燈，今天你有寫新的歌詞嗎？" }, { role: "assistant", content: "舊回答" }],
  }, ctx);
  const result = await hooks.get("before_agent_finalize")({
    ...ctx,
    lastAssistantMessage: "我今天沒有寫新的歌詞。",
    messages: [{ role: "user", content: "燈，你今天有沒有寫下哪一句歌詞？" }],
  }, ctx);
  assert.equal(result, undefined);
});

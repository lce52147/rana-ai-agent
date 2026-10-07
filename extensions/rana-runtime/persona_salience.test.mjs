import assert from "node:assert/strict";
import test from "node:test";

import { buildPreGenerationEvidenceStatus, projectProviderMessages, registerCurrentTurnVerifier, registerTurnIsolation } from "./architecture/turn_isolation.js";
import { buildPersonaAuthorityContext, registerPersonaGuidance } from "./persona_context.js";

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
    assert.match(context, /personal assistant.*runtime function only/u);
    assert.match(context, /does not prove.*event happened today or now/u);
    assert.doesNotMatch(context, /--- (?:IDENTITY|SOUL)\.md ---/u);
    assert.ok(context.length < 1000);
    assert.doesNotMatch(context, /MEMORY\.md|LORE\/|PERSONA\.json/u);
  }
});

test("registered persona guidance uses system prefix without fabricating relationship context", () => {
  let hook;
  registerPersonaGuidance({
    on(name, handler) { if (name === "before_prompt_build") hook = handler; },
    registerTool() {},
  });
  const result = hook({ prompt: "今天好嗎？" }, {
    accountId: "anon",
    agentId: "anon",
    sessionKey: "agent:anon:discord:channel:test",
  });
  assert.match(result.prependSystemContext, /千早愛音/u);
  assert.equal(result.appendContext, undefined);
});

test("provider projection removes stale answers and duplicate current prompts only", () => {
  const messages = [
    { role: "user", content: "昨天聊過的事" },
    { role: "assistant", content: "stale persona answer", tool_calls: [{ id: "old" }] },
    { role: "tool", content: "stale tool result" },
    { role: "user", content: "今天有練習嗎？" },
    { role: "assistant", content: "stale repeated answer" },
  ];
  projectProviderMessages(messages, "今天有練習嗎？");
  assert.deepEqual(messages, [{
    role: "user",
    content: "[Historical user turn; context only, not current-turn evidence]\n昨天聊過的事",
  }]);
});

test("current-turn authority treats an unsupported question as ABSENT rather than NEGATIVE", () => {
  let hook;
  registerTurnIsolation({
    on(name, handler) { if (name === "before_prompt_build") hook = handler; },
  });
  const messages = [
    { role: "user", content: "昨天的其他話題" },
    { role: "assistant", content: "stale answer" },
    { role: "user", content: "你今天有沒有做過類似的事？" },
  ];
  const result = hook({ prompt: "你今天有沒有練習？", messages }, {
    runId: "evidence-contract",
    sessionKey: "agent:taki:discord:channel:test",
  });
  assert.match(result.prependSystemContext, /問句、沒有使用者陳述或可信工具結果/u);
  assert.match(result.prependSystemContext, /event_evidence=ABSENT、speaker_certainty=UNKNOWN/u);
  assert.match(result.prependSystemContext, /不得自行選擇有或沒有/u);
  assert.match(result.appendContext, /requested_claim=active_speaker_current_event_or_state/u);
  assert.match(result.appendContext, /direct_question_reply=REQUIRED; NO_REPLY=INVALID/u);
  assert.match(result.prependSystemContext, /不能輸出 NO_REPLY/u);
  assert.deepEqual(messages, []);
});

test("per-turn evidence status excludes preferences, third-party facts, and grounded results", () => {
  const firstPass = buildPreGenerationEvidenceStatus("你今天有練習嗎？", []);
  assert.match(firstPass, /evidence_status=ABSENT/u);
  assert.doesNotMatch(firstPass, /current_request=/u);
  const retry = buildPreGenerationEvidenceStatus("你今天有練習嗎？", [], { includeCurrentRequest: true });
  assert.match(retry, /current_request="你今天有練習嗎？"/u);
  assert.match(buildPreGenerationEvidenceStatus("@bot 今天到現在有練習嗎？", []), /evidence_status=ABSENT/u);
  assert.equal(buildPreGenerationEvidenceStatus("你現在想吃嗎？", []), "");
  assert.equal(buildPreGenerationEvidenceStatus("今天股市如何？", []), "");
  assert.equal(buildPreGenerationEvidenceStatus("你今天有練習嗎？", [{ toolName: "calendar" }]), "");
});

test("retry keeps the exact current prompt instead of the latest historical user turn", async () => {
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
  const firstMessages = [
    { role: "user", content: "燈，今天你有寫新的歌詞嗎？" },
    { role: "assistant", content: "舊回答" },
  ];
  hooks.get("before_prompt_build")({
    ...ctx,
    prompt: "燈，你今天有沒有寫下哪一句歌詞？",
    messages: firstMessages,
  }, ctx);
  const revision = await hooks.get("before_agent_finalize")({
    ...ctx,
    lastAssistantMessage: "我今天沒有寫新的歌詞。",
    messages: [{ role: "user", content: "燈，你今天有沒有寫下哪一句歌詞？" }],
  }, ctx);
  assert.equal(revision.action, "revise");
  const retryMessages = [{ role: "user", content: "燈，今天你有寫新的歌詞嗎？" }];
  const retry = hooks.get("before_prompt_build")({
    ...ctx,
    prompt: revision.retry.instruction,
    messages: retryMessages,
  }, ctx);
  assert.deepEqual(retryMessages, []);
  assert.match(retry.appendContext, /current_request="燈，你今天有沒有寫下哪一句歌詞？"/u);
  assert.doesNotMatch(retry.appendContext, /current_request="燈，今天你有寫新的歌詞嗎？"/u);
});

test("a verifier retry keeps a preference request even when ABSENT status does not apply", () => {
  let hook;
  registerTurnIsolation({
    on(name, handler) { if (name === "before_prompt_build") hook = handler; },
  });
  const ctx = {
    runId: "preference-retry-grounding",
    sessionKey: "agent:main:discord:channel:test",
  };
  const firstMessages = [{ role: "user", content: "昨天的話題" }];
  hook({
    ...ctx,
    prompt: "@bot 桌上有冰抹茶，你現在想喝嗎？",
    messages: firstMessages,
  }, ctx);
  const retryMessages = [{ role: "user", content: "昨天的話題" }];
  const retry = hook({
    ...ctx,
    prompt: "CURRENT-TURN EVIDENCE REVIEW（本輪唯一一次修正；不是回答模板）：",
    messages: retryMessages,
  }, ctx);
  assert.deepEqual(retryMessages, []);
  assert.match(retry.appendContext, /current_request="桌上有冰抹茶，你現在想喝嗎？"/u);
  assert.doesNotMatch(retry.appendContext, /evidence_status=ABSENT/u);
});

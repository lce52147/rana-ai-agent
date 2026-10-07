import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { r as resolveDiscordMessageText } from "../../npm/projects/openclaw-discord-c0892df945/node_modules/@openclaw/discord/dist/message-utils-B_3yA5bN.js";
import { __test as isolation, registerCurrentTurnVerifier, registerTurnIsolation } from "./architecture/turn_isolation.js";
import { __test as music } from "../rana-music-tools/tools/music.js";
import { buildPersonaAuthorityContext, registerPersonaGuidance } from "./persona_context.js";
import { registerPersonaLoreTool } from "./persona_lore.js";
import { isTargetedEvent } from "./architecture/pre_dispatch.js";

const trusted = (accountId, requesterSenderId = "1197194412929843231") => ({
  agentId: accountId === "default" ? "main" : accountId,
  sessionKey: `agent:${accountId}:discord:channel:test`,
  requesterSenderId,
  accountId,
  deliveryContext: { channel: "discord", to: "1495319712370917396", accountId },
});

test("Discord self routing mention is stripped while other mentions remain", () => {
  const message = {
    content: "<@!100> 請問 <@200> 怎麼辦",
    mentionedUsers: [
      { id: "100", username: "self", globalName: "Self Bot" },
      { id: "200", username: "other", globalName: "Other Person" },
    ],
  };
  assert.equal(resolveDiscordMessageText(message, { stripMentionUserId: "100" }), "請問 @Other Person 怎麼辦");
  assert.equal(resolveDiscordMessageText(message), "@Self Bot 請問 @Other Person 怎麼辦");
});

test("trusted inbound metadata preserves the direct-mention routing fact", () => {
  const inboundMeta = readFileSync(
    "C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/dist/typing-mode-C35PNSLH.js",
    "utf8",
  );
  const groupContext = readFileSync(
    "C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/dist/get-reply-OTG64ybi.js",
    "utf8",
  );
  assert.match(inboundMeta, /was_mentioned: typeof ctx\.WasMentioned === "boolean"/u);
  assert.match(groupContext, /wasMentioned: sessionCtx\.WasMentioned \?\? ctx\.WasMentioned/u);
  assert.match(groupContext, /current inbound event directly addressed this bot/u);
  assert.equal(
    isTargetedEvent(
      { cleanedBody: "有抹茶芭菲耶，你想吃嗎？" },
      { agentId: "main", accountId: "default", sessionKey: "agent:main:discord:channel:test", chatType: "channel", wasMentioned: true },
      "有抹茶芭菲耶，你想吃嗎？",
    ),
    true,
  );
});

test("provider projection keeps generic five-agent user context but removes stale authority", () => {
  for (const accountId of ["default", "tomori", "anon", "soyo", "taki"]) {
    const messages = [
      { role: "user", content: "上一輪播放這個 URL https://old.invalid" },
      { role: "assistant", content: "BAD OLD ANSWER", tool_calls: [{ id: "old" }] },
      { role: "tool", tool_call_id: "old", content: "OLD SUCCESS source_text=https://old.invalid" },
      { role: "user", content: "現在請正常聊天" },
    ];
    isolation.projectProviderMessages(messages, "現在請正常聊天");
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /Historical user turn/);
    assert.doesNotMatch(serialized, /BAD OLD ANSWER|OLD SUCCESS/);
    assert.equal(messages.some((message) => message.tool_calls?.length), false);
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /Historical user turn/u);
    assert.doesNotMatch(serialized, /Historical assistant turn omitted/u);
    assert.equal(messages.some((message) => message.role === "tool"), false);
    assert.equal(isolation.resolveTrustedInvocationContext(trusted(accountId)).ok, true);
  }
});

test("registered before_prompt_build hook mutates the provider-bound array in place", () => {
  let handler;
  registerTurnIsolation({ on(name, fn) { if (name === "before_prompt_build") handler = fn; } });
  const messages = [
    { role: "assistant", content: "stale assistant" },
    { role: "user", content: "current" },
  ];
  const result = handler({ prompt: "current", messages }, {});
  assert.deepEqual(messages, []);
  assert.match(result.prependSystemContext, /CURRENT-TURN AUTHORITY/);
  assert.equal(result.appendSystemContext, undefined);
  assert.match(result.prependSystemContext, /event_evidence=ABSENT、speaker_certainty=UNKNOWN/u);
  assert.match(result.prependSystemContext, /問句、沒有使用者陳述或可信工具結果/u);
  assert.match(result.prependSystemContext, /不能輸出 NO_REPLY/u);
  assert.match(result.prependSystemContext, /只有當使用者是在詢問目前 Bot 自己的/u);
  assert.match(result.prependSystemContext, /不能自行補成做了，也不能自行斷言沒做/u);
  assert.match(result.prependSystemContext, /只限制可宣稱的現實事實，不指定角色應使用的句型、措辭或固定答案/u);
});

test("pre-generation evidence status is scoped to unsupported self-state questions", () => {
  const status = isolation.buildPreGenerationEvidenceStatus("你今天有練習嗎？", []);
  assert.match(status, /requested_claim=active_speaker_current_event_or_state/u);
  assert.match(status, /evidence_status=ABSENT/u);
  assert.match(status, /speaker_certainty=UNKNOWN/u);
  assert.equal(isolation.buildPreGenerationEvidenceStatus("你現在想吃嗎？", []), "");
  assert.equal(isolation.buildPreGenerationEvidenceStatus("今天股市如何？", []), "");
  assert.equal(isolation.buildPreGenerationEvidenceStatus("你今天有練習嗎？", [{ toolName: "calendar" }]), "");
});

test("persona authority is one generic registry-driven system prefix for all five bots", () => {
  const expected = {
    default: "要樂奈",
    tomori: "高松燈",
    anon: "千早愛音",
    soyo: "長崎爽世",
    taki: "椎名立希",
  };
  for (const [accountId, canonicalName] of Object.entries(expected)) {
    const context = buildPersonaAuthorityContext({}, trusted(accountId));
    assert.match(context, new RegExp(canonicalName, "u"));
    assert.match(context, /personal assistant.*runtime function only/u);
    assert.match(context, /IDENTITY\.md and SOUL\.md/u);
    assert.match(context, /does not prove.*event happened today or now/u);
    assert.doesNotMatch(context, /mustMention|requiredAddress|固定答案/u);
  }
});

test("trusted tool context wins over model fields and ambiguity fails closed", () => {
  const actual = trusted("soyo");
  const resolved = isolation.resolveTrustedInvocationContext(actual);
  assert.equal(resolved.accountId, "soyo");
  assert.equal(resolved.sessionKey, "agent:soyo:discord:channel:test");
  const route = music.routeFromParams({ bot_id: "rana", requester_id: "bad", session_key: "bad" }, resolved);
  assert.equal(route.botId, "soyo");
  assert.equal(route.sessionKey, actual.sessionKey);
  const missing = isolation.resolveTrustedInvocationContext({ agentId: "soyo", accountId: "soyo" }, { requireRequester: true });
  assert.equal(missing.ok, false);
  const ambiguous = isolation.resolveTrustedInvocationContext({ agentId: "soyo", sessionKey: "a", session_key: "b", accountId: "soyo" });
  assert.equal(ambiguous.ok, false);
  const agentAccount = isolation.resolveTrustedInvocationContext({ agentId: "soyo", sessionKey: "s", agentAccountId: "soyo" });
  assert.equal(agentAccount.ok, true);
  assert.equal(agentAccount.accountId, "soyo");
  assert.equal(isolation.trustedContextHint(resolved).channelId, "1495319712370917396");
});

test("persona tools use fifth invocation context instead of model persona/session fields", async () => {
  const tools = {};
  const api = { registerTool(tool) { tools[tool.name] = tool; }, on() {} };
  registerPersonaGuidance(api);
  registerPersonaLoreTool(api);
  const invocation = trusted("tomori");
  const relationship = await tools.persona_relationship_search.execute(
    "call", { query: "樂奈", personaId: "rana", sessionKey: "attacker" }, undefined, undefined, invocation,
  );
  const lore = await tools.persona_lore_search.execute(
    "call", { query: "樂奈", personaId: "rana", sessionKey: "attacker" }, undefined, undefined, invocation,
  );
  assert.doesNotMatch(JSON.stringify(relationship), /existing Rana LORE route/);
  assert.doesNotMatch(JSON.stringify(lore), /Rana LORE/);
  const rejected = await tools.persona_lore_search.execute("call", { query: "x" }, undefined, undefined, {});
  assert.match(JSON.stringify(rejected), /trusted_invocation_context_unavailable/);
});

test("current-turn verifier audit prefilter is generic and transport-neutral", () => {
  assert.equal(isolation.shouldAuditCandidate("<@123456789012345678> 今天有出門嗎？", "今天沒有。"), true);
  assert.equal(isolation.shouldAuditCandidate("桌上有蘋果，你要嗎？", "你有嗎？"), false);
  assert.equal(isolation.shouldAuditCandidate("今天好累。", "今天好累。"), false);
  assert.equal(isolation.shouldAuditCandidate("今天好累。", "我今天也超累。"), true);
  assert.equal(isolation.shouldAuditCandidate("你好", "嗨。"), false);
  assert.equal(isolation.shouldAuditCandidate("要不要吃？", "NO_REPLY"), false);
  assert.equal(isolation.stripTransportAddress("@任意顯示名稱 今天好嗎？"), "今天好嗎？");
});

test("deterministic verifier fallback preserves ABSENT and permits explicit uncertainty", () => {
  const unsupportedNegative = isolation.fallbackEvidenceAudit("你今天有出門嗎？", "今天沒有。", []);
  assert.equal(unsupportedNegative.decision, "REVISE");
  assert.equal(unsupportedNegative.evidenceStatus, "ABSENT");

  const unknown = isolation.fallbackEvidenceAudit("你今天有出門嗎？", "今天的事，我不知道。", []);
  assert.equal(unknown.decision, "ACCEPT");

  const echo = isolation.fallbackEvidenceAudit("今天要開會嗎？", "今天要開會嗎？", []);
  assert.equal(echo.decision, "ACCEPT");
  assert.equal(echo.boundary, "ECHO");
});

test("style-only echo is telemetry, not a runtime output gate", () => {
  const stateEcho = isolation.fallbackEvidenceAudit("今天要開會嗎？", "今天要開會嗎？", []);
  assert.equal(stateEcho.boundary, "ECHO");
  assert.equal(stateEcho.evidenceStatus, "NO_MATERIAL_CLAIM");
  assert.equal(stateEcho.decision, "ACCEPT");

  const preferenceEcho = isolation.fallbackEvidenceAudit("今天想吃甜點嗎？", "今天想吃甜點嗎？", []);
  assert.equal(preferenceEcho.boundary, "ECHO");
  assert.equal(preferenceEcho.evidenceStatus, "NO_MATERIAL_CLAIM");
  assert.equal(preferenceEcho.decision, "ACCEPT");
});

test("semantic verifier consumes UTF-8 current-turn evidence and never returns replacement prose", async () => {
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({
            decision: "REVISE",
            boundary: "MISREAD",
            evidenceStatus: "ABSENT",
            claims: [{ text: "今天沒有。", status: "ABSENT", material: true, reason: "no current evidence" }],
            reason: "unsupported current-state answer",
          }) } }],
        };
      },
    };
  };
  const audit = await isolation.auditCurrentTurnCandidate({
    currentUser: "你今天穿什麼？",
    toolEvidence: [],
    candidate: "今天沒有穿外套。",
  }, { fetchImpl, timeoutMs: 1_000 });
  assert.equal(audit.decision, "REVISE");
  assert.equal(audit.boundary, "MISREAD");
  assert.match(request.messages[1].content, /你今天穿什麼/u);
  assert.equal(Object.hasOwn(audit, "replacement"), false);
  assert.equal(request.response_format.type, "json_schema");
});

test("before_agent_finalize uses OpenClaw native retry budget and never owns outbound delivery", async () => {
  const hooks = {};
  const api = {
    on(name, handler) {
      hooks[name] ||= [];
      hooks[name].push(handler);
    },
  };
  registerTurnIsolation(api);
  registerCurrentTurnVerifier(api, { timeoutMs: 1_000 });

  assert.equal(hooks.message_sending, undefined);
  assert.equal(isolation.MAX_NATIVE_VERIFIER_REVISIONS, 2);

  for (const agentId of ["main", "tomori", "anon", "soyo", "taki"]) {
    const runId = `run-${agentId}-${Date.now()}`;
    const sessionKey = `agent:${agentId}:discord:channel:test`;
    const ctx = { runId, sessionKey, agentId };
    hooks.llm_input[0]({
      runId,
      prompt: "你今天有開會嗎？",
      historyMessages: [{ role: "user", content: "你今天有開會嗎？" }],
    }, ctx);

    const first = await hooks.before_agent_finalize[0]({
      runId,
      sessionKey,
      lastAssistantMessage: "今天沒有開會。",
      messages: [],
    }, ctx);
    assert.equal(first.action, "revise", agentId);
    assert.equal(first.retry.maxAttempts, 2, agentId);
    assert.match(first.retry.instruction, /不是答案模板/u, agentId);
    assert.match(first.retry.instruction, /runtime 不提供標準句、固定措辭或 Persona-specific 答案/u, agentId);
    assert.doesNotMatch(first.retry.instruction, /高松燈|千早愛音|要樂奈|長崎爽世|椎名立希/u, agentId);

    const second = await hooks.before_agent_finalize[0]({
      runId,
      sessionKey,
      lastAssistantMessage: "今天有開會。",
      messages: [],
    }, ctx);
    assert.equal(second.action, "revise", agentId);
    assert.equal(second.retry.maxAttempts, 2, agentId);
    assert.equal(second.retry.idempotencyKey, first.retry.idempotencyKey, agentId);

    const third = await hooks.before_agent_finalize[0]({
      runId,
      sessionKey,
      lastAssistantMessage: "今天沒有開會。",
      messages: [],
    }, ctx);
    assert.equal(third, undefined, agentId);
    hooks.agent_end[0]({ runId }, ctx);
  }
  assert.equal(isolation.turnVerifierState.size, 0);
});

test("retry instruction is not duplicated by before_prompt_build", () => {
  let handler;
  registerTurnIsolation({ on(name, fn) { if (name === "before_prompt_build") handler = fn; } });
  const unrelated = handler({
    runId: "other-run",
    prompt: "普通問題",
    messages: [{ role: "user", content: "普通問題" }],
  }, { runId: "other-run", sessionKey: "agent:rana:other" });
  assert.equal(unrelated.appendContext, undefined);
  assert.doesNotMatch(unrelated.prependSystemContext, /CURRENT-TURN EVIDENCE REVIEW/u);
});

test("before_prompt_build bridges a missing native retry instruction exactly once", async () => {
  const hooks = {};
  const api = { on(name, handler) { (hooks[name] ||= []).push(handler); } };
  registerTurnIsolation(api);
  registerCurrentTurnVerifier(api, { timeoutMs: 1_000 });
  const ctx = { runId: "retry-bridge", sessionKey: "agent:rana:discord:channel:retry-bridge" };

  hooks.llm_input[0]({
    runId: ctx.runId,
    historyMessages: [{ role: "user", content: "今天有出門嗎？" }],
  }, ctx);
  const revise = await hooks.before_agent_finalize[0]({
    runId: ctx.runId,
    sessionKey: ctx.sessionKey,
    lastAssistantMessage: "今天沒有出門。",
    messages: [],
  }, ctx);
  assert.equal(revise.action, "revise");

  // The active bundled retry path ends the first agent pass before rebuilding
  // the retry prompt. The one pending instruction must survive that boundary.
  hooks.agent_end[0]({ runId: ctx.runId }, ctx);
  assert.ok(isolation.turnVerifierState.has(isolation.turnStateKey({}, ctx)));

  const bridged = hooks.before_prompt_build[0]({
    runId: ctx.runId,
    prompt: "今天有出門嗎？",
    messages: [{ role: "user", content: "今天有出門嗎？" }],
  }, ctx);
  assert.match(bridged.prependSystemContext, /CURRENT-TURN EVIDENCE REVIEW/u);
  assert.ok(bridged.prependSystemContext.endsWith(revise.retry.instruction));
  assert.equal(bridged.appendContext, undefined);

  const repeatedPrebuild = hooks.before_prompt_build[0]({
    runId: ctx.runId,
    prompt: "今天有出門嗎？",
    messages: [{ role: "user", content: "今天有出門嗎？" }],
  }, ctx);
  assert.match(repeatedPrebuild.prependSystemContext, /CURRENT-TURN EVIDENCE REVIEW/u);
  assert.equal(repeatedPrebuild.appendContext, undefined);

  await hooks.before_agent_finalize[0]({
    runId: ctx.runId,
    sessionKey: ctx.sessionKey,
    lastAssistantMessage: "NO_REPLY",
    messages: [],
  }, ctx);
  const consumed = hooks.before_prompt_build[0]({
    runId: ctx.runId,
    prompt: "today-current-state-question",
    messages: [{ role: "user", content: "today-current-state-question" }],
  }, ctx);
  assert.doesNotMatch(consumed.prependSystemContext, /CURRENT-TURN EVIDENCE REVIEW/u);
  hooks.agent_end[0]({ runId: ctx.runId }, ctx);
  assert.equal(isolation.turnVerifierState.has(isolation.turnStateKey({}, ctx)), false);
});

test("before_prompt_build captures current user evidence when llm_input is absent", async () => {
  const hooks = {};
  const api = { on(name, handler) { (hooks[name] ||= []).push(handler); } };
  registerTurnIsolation(api);
  registerCurrentTurnVerifier(api, { timeoutMs: 1_000 });
  const ctx = { runId: "prompt-capture", sessionKey: "agent:rana:discord:channel:prompt-capture" };

  hooks.before_prompt_build[0]({
    runId: ctx.runId,
    prompt: "有抹茶芭菲耶，你想吃嗎？",
    messages: [{ role: "user", content: "有抹茶芭菲耶，你想吃嗎？" }],
  }, ctx);
  const revise = await hooks.before_agent_finalize[0]({
    runId: ctx.runId,
    sessionKey: ctx.sessionKey,
    lastAssistantMessage: "有抹茶芭菲耶，你想吃嗎？",
    messages: [],
  }, ctx);
  assert.equal(revise.action, "revise");
  assert.match(revise.retry.instruction, /response_boundary=ECHO/u);
  hooks.agent_end[0]({ runId: ctx.runId }, ctx);
});

test("verifier handoff state survives a cache-busted plugin module reload", async () => {
  const first = await import(`./architecture/turn_isolation.js?handoff=first-${Date.now()}`);
  const second = await import(`./architecture/turn_isolation.js?handoff=second-${Date.now()}`);
  assert.strictEqual(first.__test.turnVerifierState, second.__test.turnVerifierState);
});

test("deterministic evidence violations cannot be accepted by an over-permissive semantic verifier", async () => {
  const hooks = {};
  let classifierCalls = 0;
  const api = { on(name, handler) { (hooks[name] ||= []).push(handler); } };
  registerCurrentTurnVerifier(api, {
    fetchImpl: async () => {
      classifierCalls += 1;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({
            decision: "ACCEPT",
            boundary: "PASS",
            evidenceStatus: "SUPPORTED",
            claims: [],
            reason: "over-permissive",
          }) } }] };
        },
      };
    },
  });
  const ctx = { runId: "negative-run", sessionKey: "agent:rana:discord:channel:negative" };
  hooks.llm_input[0]({ runId: ctx.runId, historyMessages: [{ role: "user", content: "你今天有出門嗎？" }] }, ctx);
  const result = await hooks.before_agent_finalize[0]({
    runId: ctx.runId,
    sessionKey: ctx.sessionKey,
    lastAssistantMessage: "今天沒有出門。",
  }, ctx);
  assert.equal(result.action, "revise");
  assert.equal(classifierCalls, 0);
  assert.match(result.retry.instruction, /ABSENT 不能改寫成肯定，也不能改寫成否定/u);
  assert.match(result.retry.instruction, /runtime 不提供標準句、固定措辭或 Persona-specific 答案/u);
  assert.doesNotMatch(result.retry.instruction, /固定回答|標準答案/u);
  hooks.agent_end[0]({ runId: ctx.runId }, ctx);
});

test("retry instruction stays evidence-scoped and never encodes a Persona answer", () => {
  const instruction = isolation.buildVerifierRetryInstruction({
    decision: "REVISE",
    boundary: "PASS",
    evidenceStatus: "ABSENT",
    claims: [{ text: "今天有去。", status: "ABSENT", material: true, reason: "not supplied" }],
    reason: "unsupported state",
    source: "semantic_verifier",
  }, { currentUser: "你今天有去練團嗎？" });
  assert.match(instruction, /active Persona／IDENTITY／SOUL/u);
  assert.match(instruction, /runtime 不提供標準句、固定措辭或 Persona-specific 答案/u);
  assert.doesNotMatch(instruction, /我想吃|不知道。|高松燈|千早愛音|要樂奈|長崎爽世|椎名立希/u);
});

test("verifier tool evidence and retry state cannot cross session keys", () => {
  const runId = "shared-run-label";
  const left = { runId, sessionKey: "agent:anon:discord:channel:left" };
  const right = { runId, sessionKey: "agent:soyo:discord:channel:right" };
  isolation.rememberVerifierInput({ runId, historyMessages: [{ role: "user", content: "左邊" }] }, left);
  isolation.rememberVerifierInput({ runId, historyMessages: [{ role: "user", content: "右邊" }] }, right);
  isolation.rememberVerifierToolEvidence({ runId, toolName: "example", result: { status: "ok", secret: "do-not-forward" } }, left);
  const leftState = isolation.turnVerifierState.get(isolation.turnStateKey({ runId }, left));
  const rightState = isolation.turnVerifierState.get(isolation.turnStateKey({ runId }, right));
  assert.equal(leftState.currentUser, "左邊");
  assert.equal(rightState.currentUser, "右邊");
  assert.equal(leftState.toolEvidence.length, 1);
  assert.equal(rightState.toolEvidence.length, 0);
  assert.doesNotMatch(leftState.toolEvidence[0].result, /do-not-forward/u);
  isolation.turnVerifierState.delete(isolation.turnStateKey({ runId }, left));
  isolation.turnVerifierState.delete(isolation.turnStateKey({ runId }, right));
});

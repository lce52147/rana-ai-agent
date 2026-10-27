import assert from "node:assert/strict";
import test from "node:test";
import { __test as isolation } from "./architecture/turn_isolation.js";
import { __test as music } from "../rana-music-tools/tools/music.js";
import { registerPersonaGuidance } from "./persona_context.js";
import { registerPersonaLoreTool } from "./persona_lore.js";
import { isTargetedEvent } from "./architecture/pre_dispatch.js";

const agentFor = (accountId) => (accountId === "default" ? "main" : accountId);
const trusted = (accountId, requesterSenderId = "900000000000000002") => ({
  agentId: agentFor(accountId),
  sessionKey: `agent:${agentFor(accountId)}:discord:channel:test`,
  requesterSenderId,
  accountId,
  deliveryContext: { channel: "discord", to: "900000000000000007", accountId },
});

// The Discord mention-stripping and WasMentioned checks that used to live here
// read hash-named files of one OpenClaw build (and an old Discord plugin copy);
// neither exists in the current host install, so only this repo's side of the
// routing fact is tested.
test("a direct-mention routing fact targets the bot even without a name in the text", () => {
  assert.equal(
    isTargetedEvent(
      { cleanedBody: "有抹茶芭菲耶，你想吃嗎？" },
      { agentId: "main", accountId: "default", sessionKey: "agent:main:discord:channel:test", chatType: "channel", wasMentioned: true },
      "有抹茶芭菲耶，你想吃嗎？",
    ),
    true,
  );
});

test("provider projection drops stale tool turns and every account resolves its trusted context", () => {
  for (const accountId of ["default", "tomori", "anon", "soyo", "taki"]) {
    const messages = [
      { role: "user", content: "上一輪播放這個 URL https://old.invalid" },
      { role: "assistant", content: "BAD OLD ANSWER", tool_calls: [{ id: "old" }] },
      { role: "tool", tool_call_id: "old", content: "OLD SUCCESS source_text=https://old.invalid" },
      { role: "user", content: "現在請正常聊天" },
    ];
    isolation.projectProviderMessages(messages, "現在請正常聊天");
    assert.doesNotMatch(JSON.stringify(messages), /BAD OLD ANSWER|OLD SUCCESS/);
    assert.equal(messages.some((message) => message.role === "tool" || message.tool_calls?.length), false);
    assert.equal(isolation.resolveTrustedInvocationContext(trusted(accountId)).ok, true);
  }
});

// Projection details, the evidence status and the persona prefix are covered
// in persona_salience.test.mjs.

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
  assert.equal(isolation.trustedContextHint(resolved).channelId, "900000000000000007");
});

test("persona tools use fifth invocation context instead of model persona/session fields", async () => {
  const tools = {};
  const api = { registerTool(tool) { tools[tool.name] = tool; }, on() {}, registerTextTransforms() {} };
  registerPersonaGuidance(api);
  registerPersonaLoreTool(api);
  const invocation = trusted("tomori");
  // persona_relationship_search was folded into before_prompt_build context.
  assert.equal(tools.persona_relationship_search, undefined);
  const lore = await tools.persona_lore_search.execute(
    "call", { query: "樂奈", personaId: "rana", sessionKey: "attacker" }, undefined, undefined, invocation,
  );
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

// The semantic verifier, its retry instruction and the before_prompt_build
// retry bridge were removed: before_agent_finalize only observes now (see
// turn_isolation_evidence_authority.test.mjs).

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

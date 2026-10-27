import assert from "node:assert/strict";
import test from "node:test";
import {
  __test as isolation,
  registerCurrentTurnVerifier,
} from "./architecture/turn_isolation.js";

test("speaker current-state classifier excludes user self-report and external topics", () => {
  assert.equal(isolation.isActiveSpeakerCurrentStateQuery("今天好累。"), false);
  assert.equal(isolation.isActiveSpeakerCurrentStateQuery("我今天好累，你覺得呢？"), false);
  assert.equal(isolation.isActiveSpeakerCurrentStateQuery("你今天有去練團嗎？"), true);
  assert.equal(isolation.isActiveSpeakerCurrentStateQuery("今天有出門嗎？"), true);
  assert.equal(isolation.isActiveSpeakerCurrentStateQuery("今天股市如何？"), false);
});

test("audit scope ignores style-only user self-report but catches fabricated Persona self-state", () => {
  assert.equal(isolation.shouldAuditCandidate("今天好累。", "辛苦了。"), false);
  assert.equal(isolation.shouldAuditCandidate("今天好累。", "今天好累。"), false);
  assert.equal(isolation.shouldAuditCandidate("今天好累。", "我今天也超累。"), true);
  assert.equal(isolation.shouldAuditCandidate("你今天有去練團嗎？", "不知道。"), true);
});

test("deterministic fallback gates only material unsupported state claims", () => {
  const fabricatedEmpathy = isolation.fallbackEvidenceAudit("今天好累。", "我今天也超累。", []);
  assert.equal(fabricatedEmpathy.decision, "REVISE");
  assert.equal(fabricatedEmpathy.evidenceStatus, "ABSENT");
  assert.equal(fabricatedEmpathy.claims[0].material, true);

  const unsupportedYes = isolation.fallbackEvidenceAudit("你今天有去練團嗎？", "今天有去練團。", []);
  assert.equal(unsupportedYes.decision, "REVISE");
  assert.equal(unsupportedYes.evidenceStatus, "ABSENT");

  const unknown = isolation.fallbackEvidenceAudit("你今天有去練團嗎？", "不知道。", []);
  assert.equal(unknown.decision, "ACCEPT");

  const preference = isolation.fallbackEvidenceAudit("你現在想吃嗎？", "想吃。", []);
  assert.equal(preference.decision, "ACCEPT");
});

// The LLM verifier and its retry instruction (parseVerifierJson,
// buildVerifierRetryInstruction) were removed: the evidence audit above is now
// telemetry only, and before_agent_finalize never asks for a retry.
test("unsupported self-state claims are observed but never revised, cancelled or rewritten", async () => {
  const hooks = {};
  const api = { on(name, handler) { (hooks[name] ||= []).push(handler); } };
  registerCurrentTurnVerifier(api, { timeoutMs: 1000 });
  const runId = `native-finalize-${Date.now()}`;
  const sessionKey = "agent:soyo:discord:channel:test";
  const ctx = { runId, sessionKey, agentId: "soyo" };

  assert.equal(hooks.message_sending, undefined, "verifier must not own outbound delivery cancellation");

  hooks.llm_input[0]({
    runId,
    prompt: "你今天有去練團嗎？",
    historyMessages: [{ role: "user", content: "你今天有去練團嗎？" }],
  }, ctx);

  for (const candidate of ["今天有去練團。", "今天沒有去練團。"]) {
    const result = await hooks.before_agent_finalize[0]({
      runId,
      sessionKey,
      lastAssistantMessage: candidate,
      messages: [],
    }, ctx);
    assert.equal(result, undefined, candidate);
  }
});

test("style-only semantic failure never requests revision", async () => {
  const hooks = {};
  const api = { on(name, handler) { (hooks[name] ||= []).push(handler); } };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: JSON.stringify({
        decision: "REVISE",
        boundary: "GENERIC_SERVICE",
        evidenceStatus: "NO_MATERIAL_CLAIM",
        claims: [],
        reason: "style only",
      }) } }] };
    },
  });
  registerCurrentTurnVerifier(api, { fetchImpl, timeoutMs: 1000 });
  const runId = `style-only-${Date.now()}`;
  const sessionKey = "agent:anon:discord:channel:test";
  const ctx = { runId, sessionKey, agentId: "anon" };
  hooks.llm_input[0]({ runId, prompt: "你今天有去練團嗎？" }, ctx);

  const result = await hooks.before_agent_finalize[0]({
    runId,
    sessionKey,
    lastAssistantMessage: "不確定耶，如果你想聊天我可以陪你。",
    messages: [],
  }, ctx);
  assert.equal(result, undefined);
  assert.equal(hooks.message_sending, undefined);
});

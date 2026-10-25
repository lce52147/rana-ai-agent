import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { buildPersonaLoreContext, buildPersonaLoreEvidenceProjection, searchPersonaLore } from "./persona_lore.js";

test("recent self-activity questions use current-state authority even with a named persona", () => {
  for (const prompt of ["@愛音 最近在忙什麼？", "妳這幾天都把時間花在哪裡？"]) {
    const plan = buildUnifiedTurnPlan(prompt, { personaId: "anon" });
    assert.equal(plan.evidence.kind, "current_state", prompt);
    assert.equal(plan.responseContract.responseFunction, "ANSWER_CURRENT_STATE_KNOWLEDGE_STATUS", prompt);
  }
});

test("recent-time persona projection forbids invented specifics and supplies an as-usual fallback", () => {
  for (const agentId of ["main", "anon", "soyo", "taki", "tomori"]) {
    const { context } = buildPersonaLoreEvidenceProjection(
      { prompt: "最近在做什麼？" },
      { accountId: agentId === "main" ? "default" : agentId, agentId, sessionKey: `agent:${agentId}:persona-lore-test` },
    );
    assert.match(context, /Do not present any of it as recent/u, agentId);
    assert.match(context, /do not say you are busy.*name any current activity, project, study, conversation, plan, practice, work, or errand/u, agentId);
    assert.match(context, /use this character's usual voice to say in one or two short sentences that things are as usual, then stop/u, agentId);
  }
});

test("each v2 Deep LORE corpus has query-specific retrieval", () => {
  for (const personaId of ["anon", "soyo", "taki", "tomori"]) {
    const records = searchPersonaLore(personaId, "MyGO!!!!! 排練");
    assert.ok(records.length > 0, personaId);
    assert.ok(records.every((record) => record.content.length > 0), personaId);
    assert.ok(records.length <= 5, personaId);
  }
});

test("deep LORE context keeps the active speaker fixed", () => {
  const context = buildPersonaLoreContext(
    { query: "MyGO!!!!! 排練" },
    { sessionKey: "agent:tomori:persona-lore-test" },
  );
  assert.match(context, /active speaker: 高松燈/u);
  assert.match(context, /personaId=tomori/u);
  assert.match(context, /Do not use this context to rename the speaker/u);
});

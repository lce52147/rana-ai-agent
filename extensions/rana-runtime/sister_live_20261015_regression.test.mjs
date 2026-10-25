import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTypedAuthorityContext } from "./architecture/turn_context_projection.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { registerLoreGuidance } from "./lore/guidance.js";
import { resolveEntityMentions } from "./lore/entity_resolver.js";
import { buildPersonaLoreEvidenceProjection } from "./persona_lore.js";

// Regressions from the 2026-10-15 sister (Gemma 12B) live run.

let runSeq = 0;
function ranaHook() {
  let handler;
  registerLoreGuidance({
    on(name, fn) { if (name === "before_prompt_build") handler = fn; },
    registerTool() {},
    logger: { warn() {} },
  });
  return async (prompt) => {
    runSeq += 1;
    const runId = `sister-regression-${runSeq}`;
    const ctx = { agentId: "main", accountId: "default", sessionKey: `agent:main:discord:channel:SISTER-REG-${runSeq}`, channel: "discord", provider: "discord", runId };
    const result = await handler({ prompt, channel: "discord", provider: "discord", runId }, ctx);
    return String(result?.appendSystemContext || "");
  };
}

function personaProjection(actor, prompt) {
  return buildPersonaLoreEvidenceProjection({ prompt }, {
    accountId: actor,
    agentId: actor,
    sessionKey: `agent:${actor}:discord:channel:SISTER-REG-${actor}`,
  });
}

test("Rana: own relation events are not overridden by an unresolved instruction", async () => {
  const run = ranaHook();
  for (const prompt of ["你和燈平常如何一起練習？", "你跟立希之間發生過什麼事？"]) {
    const context = await run(prompt);
    assert.match(context, /CONTROLLED DIRECTIONAL RELATION EVENTS/u, prompt);
    assert.match(context, /directional event:/u, prompt);
    assert.doesNotMatch(context, /\bADV\s*[:#\[]/iu, prompt);
    assert.doesNotMatch(context, /UNRESOLVED_ONLY/u, prompt);
    assert.doesNotMatch(context, /You do not know this part/u, prompt);
  }
});

test("Rana: a pair question about two other members gets none of Rana's own events", async () => {
  const run = ranaHook();
  for (const prompt of ["立希跟燈平常怎麼相處的？", "爽世跟燈在團裡怎麼互動？"]) {
    assert.doesNotMatch(await run(prompt), /DIRECTIONAL RELATION EVENTS/u, prompt);
  }
});

test("other personas: relation events win over an insufficient-coverage block", () => {
  const projected = personaProjection("soyo", "爽世跟燈在團裡怎麼互動？");
  assert.equal(projected.coverage?.supported, true);
  assert.match(projected.context, /CONTROLLED DIRECTIONAL RELATION EVENTS/u);
  assert.doesNotMatch(projected.context, /UNRESOLVED_ONLY/u);
});

test("other personas: a recent-time question marks supplied material as past", () => {
  const projected = personaProjection("soyo", "你和愛音最近一起做了什麼？");
  assert.doesNotMatch(projected.context, /DIRECTIONAL RELATION EVENTS/u);
  if (projected.coverage?.supported) {
    assert.match(projected.context, /asking about recent or current time/u);
  }
});

test("contextual 燈 aliases resolve action relations and reject lamp compounds", () => {
  for (const prompt of [
    "那次燈拿巧克力給妳是怎麼回事？",
    "燈送妳OK繃那次發生了什麼？",
    "妳記得燈打翻杯子那次嗎？",
    "妳跟燈以前發生過什麼事？",
    "燈撿石頭那次妳做了什麼？",
    "燈說那是妳的視角，是哪一次？",
  ]) assert.ok(resolveEntityMentions(prompt).some((item) => item.canonical_name === "高松燈"), prompt);
  for (const prompt of ["電燈光很亮", "蠟燈的影子", "燈光很漂亮", "路燈壞了"]) {
    assert.doesNotMatch(JSON.stringify(resolveEntityMentions(prompt)), /高松燈/u, prompt);
  }
});

test("recent/current authority is bounded while historical relation lookup remains available", () => {
  const current = buildUnifiedTurnPlan("最近和爽世排練怎麼配合", { personaId: "rana" });
  assert.equal(current.evidence.kind, "current_state");
  assert.match(buildTypedAuthorityContext(current, {}, {}), /CURRENT_STATE=UNKNOWN/u);
  const historical = buildPersonaLoreEvidenceProjection({ prompt: "妳和燈有一起寫過歌嗎？" }, {
    accountId: "anon",
    agentId: "anon",
    sessionKey: "agent:anon:discord:channel:SISTER-REG-HISTORY",
  });
  assert.match(historical.context, /directional event \[ADV \d+\]/u);
  assert.doesNotMatch(historical.context, /asking about recent or current time/u);
});

test("recent user premises stay unconfirmed and N4/N5 use direct controlled evidence", () => {
  const premise = buildUnifiedTurnPlan("昨天在東京錄完新專輯了嗎？", { personaId: "rana" });
  assert.equal(premise.temporalScope, "past");
  assert.match(buildTypedAuthorityContext(premise, {}, {}), /FACT_SCOPE=USER_EXPLICIT_STATEMENTS_OR_CONTROLLED_EVIDENCE/u);
  const chatApp = buildPersonaLoreEvidenceProjection({ prompt: "誰教你看聊天軟體？" }, {
    accountId: "default",
    agentId: "main",
    sessionKey: "agent:main:discord:channel:SISTER-REG-N4",
  });
  assert.match(chatApp.context, /教她的是爽世，不是愛音/u);
  assert.doesNotMatch(chatApp.context, /not directly supported|You do not know this part/u);
  const roster = buildPersonaLoreEvidenceProjection({ prompt: "樂團裡另外四個人分別是誰？" }, {
    accountId: "default",
    agentId: "main",
    sessionKey: "agent:main:discord:channel:SISTER-REG-N5",
  });
  assert.match(roster.context, /MyGO!!!!! 團員：/u);
  for (const member of ["高松燈", "千早愛音", "長崎爽世", "椎名立希", "要樂奈"]) assert.match(roster.context, new RegExp(member, "u"));
});

// live3 066/068: 「にゃむ是做什麼的」「あのちゃん對妳來說是怎樣的人」 reached Rana with
// no character evidence, so she could only say 不知道.
test("person-description questions under any alias retrieve that person's character evidence", async () => {
  const run = ranaHook();
  for (const [prompt, canonical] of [
    ["にゃむ是做什麼的？", "祐天寺にゃむ"],
    ["あのちゃん對妳來說是怎樣的人？", "千早愛音"],
    ["愛音對妳來說是怎樣的人？", "千早愛音"],
  ]) {
    const plan = buildUnifiedTurnPlan(prompt, { personaId: "main" });
    assert.equal(plan.evidence?.required, true, prompt);
    assert.equal(plan.evidence?.source, "persona_canonical", prompt);
    const context = await run(prompt);
    assert.match(context, new RegExp(`Entity grounding:[\\s\\S]*${canonical}`, "u"), prompt);
    assert.match(context, /Coverage: fact is directly supported/u, prompt);
  }
  for (const prompt of ["妳是怎樣的人？", "燈光是怎樣的？"]) {
    assert.notEqual(buildUnifiedTurnPlan(prompt, { personaId: "main" }).evidence?.kind, "canonical_fact", prompt);
  }
});

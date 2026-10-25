import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { registerTurnToolSurface } from "./tool_surface.js";
import { registerModelToolGuidance, __test as guidanceTest } from "./architecture/model_tool_guidance.js";

const IMAGE = "C:\\Users\\Administrator\\.openclaw\\media\\inbound\\v3-current.png";
const TOOL_NAMES = [
  "read", "rana_play_music", "rana_stop_music", "rana_show_queue", "rana_skip_music",
  "rana_volume_music", "rana_join_voice", "rana_leave_voice", "rana_analyze_image",
  "rana_stock_research", "rana_lore_search", "persona_lore_search", "rana_memory", "web_search",
];

let surfaceHook;
registerTurnToolSurface({ on(name, handler) { if (name === "before_prompt_build") surfaceHook = handler; } });
async function toolsFor(prompt, mediaProvenance) {
  const plan = buildUnifiedTurnPlan(prompt);
  const result = await surfaceHook(
    { prompt, tools: TOOL_NAMES.map((name) => ({ name })), ...(mediaProvenance ? { currentTurnMediaEvidence: mediaProvenance } : {}) },
    { agentId: "main" },
  );
  return { plan, result };
}

test("plan-based tool surface keeps ordinary turns narrow and opens only authorized tool families", async () => {
  assert.deepEqual((await toolsFor("Soyo")).result.toolsAllow, ["read"]);
  assert.deepEqual((await toolsFor("播放 春日影")).result.toolsAllow, ["read", "rana_play_music"]);
  assert.deepEqual((await toolsFor("我想看美股 NVDA")).result.toolsAllow, ["read", "rana_stock_research"]);
  const persona = await toolsFor("燈和妳一起演奏時，最在意她的哪一部分？");
  assert.equal(persona.plan.evidence.source, "persona_canonical");
  assert.deepEqual(persona.result.toolsAllow, ["read", "persona_lore_search"]);
  assert.equal(persona.result.toolsAllow.includes("rana_lore_search"), false);
  assert.equal(persona.result.toolsAllow.includes("rana_memory"), false);
  assert.equal(persona.result.toolsAllow.includes("web_search"), false);
});

test("vision surface requires the current-turn plan and trusted media provenance", async () => {
  const prompt = `幫我看 [media attached: ${IMAGE} (image/png)]`;
  const mediaProvenance = {
    currentTurn: true,
    recordedAt: Date.now(),
    attachments: [{ kind: "image", mimeType: "image/png", path: IMAGE }],
  };
  const allowed = (await toolsFor(prompt, mediaProvenance)).result.toolsAllow;
  assert.deepEqual(allowed, ["read", "rana_analyze_image"]);
  assert.deepEqual((await toolsFor(prompt)).result.toolsAllow, ["read"]);
});

test("model-language guidance appends to the user turn only for Japanese names or kana", async () => {
  assert.equal(guidanceTest.shouldAppendUserLanguageInstruction("普通中文問題"), false);
  assert.equal(guidanceTest.shouldAppendUserLanguageInstruction("立希對妳來說，是會做歌的人嗎？"), true);
  assert.equal(guidanceTest.shouldAppendUserLanguageInstruction("にゃむ在 Ave Mujica 裡演奏哪一種樂器？"), true);

  let hook;
  registerModelToolGuidance({ on(name, handler) { if (name === "before_prompt_build") hook = handler; } });
  const result = await hook({ prompt: "立希對妳來說，是會做歌的人嗎？" }, { agentId: "main" });
  assert.equal(result.prependSystemContext, undefined);
  assert.equal(result.appendContext, guidanceTest.USER_LANGUAGE_APPEND);
  assert.equal(await hook({ prompt: "普通中文問題" }, { agentId: "main" }), undefined);
});



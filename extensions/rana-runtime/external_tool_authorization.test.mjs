import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { getExternalToolAuthorizationRegistry, resolveCurrentTurnToolSurface } from "./current_turn_tool_contract.js";

const OWNER_ID = "rana-lolcoach-test";
const LOL = ["lol_review_latest","lol_review_match","lol_patterns","lol_champion_info","lol_matchup","lol_link","lol_unlink","lol_recent_games"];
const TOOLS = ["read", ...LOL, "web_search", "rana_play_music"];
const registry = getExternalToolAuthorizationRegistry();
registry.owners.delete(OWNER_ID);
registry.registerOwner({ ownerId: OWNER_ID, toolNames: LOL, ttlMs: 120000 });
const plan = buildUnifiedTurnPlan("普通聊天");

function surface(runId, sessionKey = "session") {
  return resolveCurrentTurnToolSurface({ plan, toolNames: TOOLS, agentId: "main", runId, sessionKey }).allowedToolNames;
}

test("registered external owner is hidden on ordinary turns while unknown tools pass through", () => {
  assert.deepEqual(surface("ordinary"), ["read", "web_search"]);
});
test("registered owner keeps only the exact tool authorized for the current run", () => {
  registry.authorize({ ownerId: OWNER_ID, runId: "lol-1", toolName: "lol_matchup", sessionKey: "session" });
  assert.deepEqual(surface("lol-1"), ["read", "lol_matchup", "web_search"]);
  assert.equal(surface("lol-1", "other").includes("lol_matchup"), false);
});
test("same session with a different run id does not inherit authorization", () => {
  assert.equal(surface("lol-2").some((name) => name.startsWith("lol_")), false);
});
test("expired authorization is fail-closed", () => {
  registry.authorize({ ownerId: OWNER_ID, runId: "expired", toolName: "lol_matchup" });
  registry.runs.get(OWNER_ID + "\0expired").recordedAt = Date.now() - 121000;
  assert.equal(surface("expired").some((name) => name.startsWith("lol_")), false);
});
test("controlled Rana family behavior remains plan based", () => {
  const music = resolveCurrentTurnToolSurface({ plan: buildUnifiedTurnPlan("播放 春日影"), toolNames: ["rana_play_music", "rana_stock_research", "read"], runId: "music" }).allowedToolNames;
  assert.deepEqual(music, ["rana_play_music", "read"]);
});


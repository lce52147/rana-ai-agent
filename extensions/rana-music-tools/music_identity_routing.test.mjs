import assert from "node:assert/strict";
import { __test, registerMusicTools } from "./tools/music.js";
import { __test as contextTest } from "../rana-runtime/context_store.js";

const expected = {
  rana: "http://127.0.0.1:8081",
  tomori: "http://127.0.0.1:8082",
  anon: "http://127.0.0.1:8083",
  soyo: "http://127.0.0.1:8084",
  taki: "http://127.0.0.1:8085",
};

for (const [botId, baseUrl] of Object.entries(expected)) {
  const route = __test.routeFromParams({ bot_id: botId });
  assert.equal(route.botId, botId);
  assert.equal(route.baseUrl, baseUrl);
  assert.equal(route.identityError, null);

const eventRoute = __test.routeFromEvent({ botId, sessionKey: `event-${botId}` }, {});
  assert.equal(eventRoute.botId, botId);
  assert.equal(eventRoute.baseUrl, baseUrl);
}

assert.deepEqual(
  __test.currentTurnMusicHint(
    { agentId: "taki", sessionKey: "event-current-session" },
    { agentId: "anon", sessionKey: "ctx-stale-session" },
  ),
  { agentId: "taki", sessionKey: "event-current-session" },
);

assert.equal(__test.routeFromParams({ bot_id: "default" }).baseUrl, expected.rana);
assert.equal(__test.routeFromParams({ bot_id: "main" }).baseUrl, expected.rana);

for (const params of [{}, { bot_id: "" }, { bot_id: "unknown" }, { bot_id: "Rana-not-real" }]) {
  const route = __test.routeFromParams(params);
  assert.equal(route.botId, null);
  assert.equal(route.baseUrl, null);
  assert.equal(route.identityError, "missing or unknown bot identity");
}

const evidenceHint = { requester_id: "routing-test-user", sessionKey: "routing-test-session", botId: "taki" };
assert.equal(__test.recordJoinEvidence({ status: "error" }, evidenceHint, evidenceHint, { botId: "taki", personaId: "taki", sessionKey: evidenceHint.sessionKey }, evidenceHint.requester_id), false);
assert.equal(contextTest.hasRecentToolEvidence("rana_join_voice", "join", evidenceHint), false);
assert.equal(__test.recordJoinEvidence({ status: "joined" }, evidenceHint, evidenceHint, { botId: "taki", personaId: "taki", sessionKey: evidenceHint.sessionKey }, evidenceHint.requester_id), true);
assert.equal(contextTest.hasRecentToolEvidence("rana_join_voice", "join", evidenceHint), true);

const contextA = { botId: "anon", personaId: "anon", sessionKey: "play-session-anon", requester_id: "play-user-anon" };
const contextB = { botId: "taki", personaId: "taki", sessionKey: "play-session-taki", requester_id: "play-user-taki" };
const routeA = __test.routeFromEvent(contextA, {});
const routeB = __test.routeFromParams(contextB);
const hintA = __test.playbackEvidenceHint(contextA, {}, routeA, contextA.requester_id);
const hintB = __test.playbackEvidenceHint(contextB, contextB, routeB, contextB.requester_id);

__test.markPlaybackEvidence({ status: "queued", queued: 1 }, "play", hintA);
assert.equal(contextTest.hasRecentToolEvidence("rana_play_music", "play", hintA), true);
assert.equal(contextTest.hasRecentToolEvidence("rana_play_music", "play", hintB), false);

__test.markPlaybackEvidence({ status: "queued", queued: 1 }, "pending", hintB);
assert.equal(contextTest.hasRecentToolEvidence("rana_play_music", "pending", hintB), true);
assert.equal(contextTest.hasRecentToolEvidence("rana_play_music", "pending", hintA), false);

const registeredTools = [];
const hooks = [];
registerMusicTools({
  on(name, handler) {
    hooks.push({ name, handler });
  },
  registerTool(tool) {
    registeredTools.push(tool);
  },
});

const playGate = hooks.find((hook) => hook.name === "before_tool_call")?.handler;
const playTool = registeredTools.find((tool) => tool.name === "rana_play_music");
assert.equal(typeof playGate, "function");
assert.equal(typeof playTool?.execute, "function");

let registeredToolExecuteCalls = 0;
let sidecarStubCalls = 0;
playTool.execute = async () => {
  registeredToolExecuteCalls += 1;
  sidecarStubCalls += 1;
  return { content: [{ type: "text", text: "sidecar stub" }] };
};

function seedCurrentTurn({ agentId, accountId, sessionKey, requesterId, text }) {
  contextTest.rememberDiscordContext(
    {
      body: text,
      senderId: requesterId,
      channelId: "1494206026390700092",
      guildId: "1486679037605842944",
    },
    {
      agentId,
      accountId,
      sessionKey,
      channelId: "1494206026390700092",
      guildId: "1486679037605842944",
    },
  );
}

function playEvent(agentId, sessionKey, params = {}) {
  return {
    toolName: "rana_play_music",
    agentId,
    sessionKey,
    params,
  };
}

async function invokeThroughGate(event, ctx) {
  const decision = await playGate(event, ctx);
  if (decision?.block) return decision;
  return playTool.execute(undefined, event.params || {}, undefined, undefined, {});
}

const takiAgentId = "taki";
const takiAccountId = "taki";
const negativeSession = "agent:taki:discord:channel:1494206026390700092:music-negative";
seedCurrentTurn({
  agentId: takiAgentId,
  accountId: takiAccountId,
  sessionKey: negativeSession,
  requesterId: "111111111111111111",
  text: "RiNG LIVE 提到春日影和 NVDA",
});
const ringDecision = await invokeThroughGate(
  playEvent(takiAgentId, negativeSession, { query: "春日影", source_text: "播放春日影" }),
  { agentId: takiAgentId, sessionKey: negativeSession },
);
assert.deepEqual(ringDecision, {
  block: true,
  blockReason: "rana_play_music requires explicit current-turn playback intent",
});

for (const [suffix, text] of [["song", "春日影"], ["stock", "NVDA"], ["name", "RiNG LIVE"]]) {
  const sessionKey = `agent:taki:discord:channel:1494206026390700092:music-bare-${suffix}`;
  seedCurrentTurn({
    agentId: takiAgentId,
    accountId: takiAccountId,
    sessionKey,
    requesterId: `11111111111111111${suffix === "song" ? "2" : suffix === "stock" ? "3" : "4"}`,
    text,
  });
  const decision = await invokeThroughGate(
    playEvent(takiAgentId, sessionKey, { query: text, source_text: "play spring shadow" }),
    { agentId: takiAgentId, sessionKey },
  );
  assert.equal(decision?.block, true);
}

assert.equal(registeredToolExecuteCalls, 0);
assert.equal(sidecarStubCalls, 0);

for (const [suffix, text] of [["zh", "播放 春日影"], ["en", "play song"]]) {
  const sessionKey = `agent:taki:discord:channel:1494206026390700092:music-positive-${suffix}`;
  seedCurrentTurn({
    agentId: takiAgentId,
    accountId: takiAccountId,
    sessionKey,
    requesterId: `22222222222222222${suffix === "zh" ? "1" : suffix === "en" ? "2" : "3"}`,
    text,
  });
  const event = playEvent(takiAgentId, sessionKey, { query: "春日影", source_text: "RiNG LIVE" });
  assert.equal(Object.hasOwn(event, "toolCallId"), false);
  assert.equal(await playGate(event, { agentId: takiAgentId, sessionKey }), undefined);
}

const englishPlaybackSession = "agent:taki:discord:channel:1494206026390700092:music-positive-spring-shadow";
seedCurrentTurn({
  agentId: takiAgentId,
  accountId: takiAccountId,
  sessionKey: englishPlaybackSession,
  requesterId: "222222222222222224",
  text: "play spring shadow",
});
assert.equal(await playGate(
  playEvent(takiAgentId, englishPlaybackSession, { query: "spring shadow", source_text: "RiNG LIVE" }),
  { agentId: takiAgentId, sessionKey: englishPlaybackSession },
), undefined);

assert.equal((await playGate(
  playEvent(takiAgentId, "", { query: "春日影", source_text: "播放春日影" }),
  { agentId: takiAgentId },
))?.block, true, "missing session must not fall back to active context");

const missingRequesterSession = "agent:taki:discord:channel:1494206026390700092:music-missing-requester";
seedCurrentTurn({
  agentId: takiAgentId,
  accountId: takiAccountId,
  sessionKey: missingRequesterSession,
  requesterId: "",
  text: "播放 春日影",
});
assert.equal((await playGate(
  playEvent(takiAgentId, missingRequesterSession, { query: "春日影" }),
  { agentId: takiAgentId, sessionKey: missingRequesterSession },
))?.block, true, "missing requester must fail closed");

const ambiguousSession = "agent:anon:discord:channel:1494206026390700092:music-ambiguous";
seedCurrentTurn({
  agentId: "anon",
  accountId: "anon",
  sessionKey: ambiguousSession,
  requesterId: "333333333333333331",
  text: "播放 春日影",
});
seedCurrentTurn({
  agentId: "anon",
  accountId: "anon",
  sessionKey: ambiguousSession,
  requesterId: "333333333333333332",
  text: "播放 春日影",
});
assert.equal((await playGate(
  playEvent("anon", ambiguousSession, { query: "春日影" }),
  { agentId: "anon", sessionKey: ambiguousSession },
))?.block, true);

const personaSession = "agent:anon:discord:channel:1494206026390700092:music-persona-isolation";
seedCurrentTurn({
  agentId: "anon",
  accountId: "anon",
  sessionKey: personaSession,
  requesterId: "444444444444444441",
  text: "播放 春日影",
});
assert.equal((await playGate(
  playEvent("taki", personaSession, { query: "春日影" }),
  { agentId: "taki", sessionKey: personaSession },
))?.block, true);

const sessionIsolation = "agent:anon:discord:channel:1494206026390700092:music-session-isolation";
seedCurrentTurn({
  agentId: "anon",
  accountId: "anon",
  sessionKey: sessionIsolation,
  requesterId: "555555555555555551",
  text: "播放 春日影",
});
assert.equal((await playGate(
  playEvent("anon", `${sessionIsolation}-other`, { query: "春日影" }),
  { agentId: "anon", sessionKey: `${sessionIsolation}-other` },
))?.block, true, "a positive request must not authorize another session");

assert.equal(
  (await playGate({ toolName: "rana_stop_music", params: {} }, {}))?.block,
  true,
  "other music controls are also fail-closed without trusted current-turn intent",
);

const stopSession = "agent:anon:discord:channel:1494206026390700092:music-stop-gate";
seedCurrentTurn({
  agentId: "anon",
  accountId: "anon",
  sessionKey: stopSession,
  requesterId: "555555555555555552",
  text: "停止",
});
assert.equal(
  await playGate(
    { toolName: "rana_stop_music", sessionKey: stopSession, params: {} },
    { agentId: "anon", sessionKey: stopSession, currentTurnText: "停止" },
  ),
  undefined,
  "matching explicit current-turn stop intent authorizes the stop tool",
);

console.log("music identity routing: known + missing/unknown + explicit current-turn music gate passed");

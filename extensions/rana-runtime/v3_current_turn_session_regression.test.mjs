import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";

import * as botContext from "./bot_context.js";
import * as contextStore from "./context_store.js";
import * as contracts from "./tool_contracts.js";
import * as preDispatch from "./architecture/pre_dispatch.js";
import * as turnIsolation from "./architecture/turn_isolation.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import * as music from "../rana-music-tools/tools/music.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIST = process.env.OPENCLAW_DIST
  || join(process.env.APPDATA ?? join(process.env.HOME ?? "", "AppData", "Roaming"), "npm", "node_modules", "openclaw", "dist");

// OpenClaw's dist chunks are content-hashed, so find the session reader by
// prefix and its minified export name from the export list.
function installedSessionReader() {
  try {
    const name = readdirSync(OPENCLAW_DIST).find((file) => /^session-utils\.fs-.*\.js$/u.test(file));
    if (!name) return null;
    const file = join(OPENCLAW_DIST, name);
    const alias = readFileSync(file, "utf8").match(/\breadSessionMessagesAsync as (\w+)/u)?.[1];
    return alias ? { file, alias } : null;
  } catch {
    return null;
  }
}
const SESSION_READER = installedSessionReader();

let requesterSequence = 0;

function identity({
  agentId,
  accountId,
  botId,
  personaId,
  requesterId,
  guildId,
  channelId,
  voiceChannelId,
  sessionKey,
}) {
  return {
    agentId,
    accountId,
    botId,
    personaId,
    requesterId,
    guildId,
    channelId,
    voiceChannelId,
    sessionKey,
    chatType: "channel",
    wasMentioned: true,
  };
}

function eventFor({ text, staleText, ...current }) {
  return {
    ...current,
    cleanedBody: text,
    body: staleText ?? text,
    content: staleText ?? text,
    text: staleText ?? text,
  };
}

function uniqueIdentity(overrides = {}) {
  const suffix = randomUUID();
  return identity({
    agentId: "main",
    accountId: "default",
    botId: "rana",
    personaId: "rana",
    requesterId: `${Date.now()}${String(++requesterSequence).padStart(2, "0")}`,
    guildId: `guild-${suffix}`,
    channelId: `channel-${suffix}`,
    voiceChannelId: `voice-${suffix}`,
    sessionKey: `agent:main:discord:channel:${suffix}`,
    ...overrides,
  });
}

test("V3 current turn: a second ordinary turn cannot inherit Music or prior identity", () => {
  const first = uniqueIdentity();
  const firstEvent = eventFor({
    ...first,
    text: "@樂奈 播放 前一回合歌曲",
  });
  const firstDecision = preDispatch.classifyPreDispatch(firstEvent, first, { modelOnline: false });
  assert.equal(firstDecision.kind, "offline_play");
  contextStore.rememberDiscordContext(firstEvent, first);

  const current = uniqueIdentity({
    agentId: "taki",
    accountId: "taki",
    botId: "taki",
    personaId: "taki",
  });
  const secondEvent = eventFor({
    ...current,
    text: "@瀧 普通聊天",
    staleText: "@樂奈 播放 前一回合歌曲",
  });
  assert.notEqual(first.voiceChannelId, secondEvent.voiceChannelId);
  assert.equal(secondEvent.voiceChannelId, current.voiceChannelId);

  const secondDecision = preDispatch.classifyPreDispatch(secondEvent, first, { modelOnline: false });
  assert.equal(secondDecision.routeText, secondEvent.cleanedBody);
  assert.notEqual(secondDecision.kind, "offline_play");
  assert.notEqual(secondDecision.kind, "explicit_play");

  const resolved = botContext.resolveBotContext(secondEvent, first);
  assert.deepEqual(
    {
      agentId: resolved.agentId,
      accountId: resolved.accountId,
      botId: resolved.botId,
      personaId: resolved.personaId,
      sessionKey: resolved.sessionKey,
      requesterId: resolved.requesterId,
      guildId: resolved.guildId,
      channelId: resolved.channelId,
      voiceChannelId: resolved.voiceChannelId,
    },
    {
      agentId: current.agentId,
      accountId: current.accountId,
      botId: current.botId,
      personaId: current.personaId,
      sessionKey: current.sessionKey,
      requesterId: current.requesterId,
      guildId: current.guildId,
      channelId: current.channelId,
      voiceChannelId: current.voiceChannelId,
    },
  );

  const routed = music.__test.routeFromEvent(secondEvent, first);
  assert.deepEqual(
    {
      botId: routed.botId,
      personaId: routed.personaId,
      accountId: routed.accountId,
      sessionKey: routed.sessionKey,
    },
    {
      botId: current.botId,
      personaId: current.personaId,
      accountId: current.accountId,
      sessionKey: current.sessionKey,
    },
  );

  contextStore.rememberDiscordContext(secondEvent, first);
  const snapshot = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });
  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.source_text, secondEvent.cleanedBody);
  assert.equal(snapshot.agent_id, current.agentId);
  assert.equal(snapshot.account_id, current.accountId);
  assert.equal(snapshot.bot_id, current.botId);
  assert.equal(snapshot.persona_id, current.personaId);
  assert.equal(snapshot.session_key, current.sessionKey);
  assert.equal(snapshot.guild_id, current.guildId);
  assert.equal(snapshot.channel_id, current.channelId);
  assert.equal(snapshot.voice_channel_id, current.voiceChannelId);
});

test("V3 current turn: ctx-only stale text cannot dispatch Music or replace the current snapshot", async () => {
  const current = uniqueIdentity();
  const currentEvent = eventFor({
    ...current,
    text: "@樂奈 這是本輪普通文字",
  });
  contextStore.rememberDiscordContext(currentEvent, current);
  const before = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });

  let beforeAgentReply;
  let playCalls = 0;
  preDispatch.__test.registerPreDispatch({
    on(name, handler) {
      if (name === "before_agent_reply") beforeAgentReply = handler;
    },
  }, {
    isModelOnlineCheck: async () => false,
    handlePlayRequest: async () => {
      playCalls += 1;
      return { handled: true, text: "unexpected stale play" };
    },
  });

  const staleContext = {
    ...current,
    body: "@Rana 播放 stale-context-song",
    content: "@Rana 播放 stale-context-song",
    text: "@Rana 播放 stale-context-song",
    wasMentioned: true,
  };
  assert.deepEqual(
    preDispatch.__test.classifyPreDispatch({}, staleContext, { modelOnline: false }),
    { kind: "pass", routeText: "" },
  );
  const result = await beforeAgentReply({}, staleContext);

  assert.equal(result, undefined);
  assert.equal(playCalls, 0);
  const after = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });
  assert.deepEqual(
    {
      fresh: after.fresh,
      source_text: after.source_text,
      updated_at: after.updated_at,
    },
    {
      fresh: before.fresh,
      source_text: before.source_text,
      updated_at: before.updated_at,
    },
  );
});

test("V3 current turn: before_agent_reply carries previous user text into known-people continuation", async () => {
  const current = uniqueIdentity();
  let beforeAgentReply;
  preDispatch.__test.registerPreDispatch({
    on(name, handler) {
      if (name === "before_agent_reply") beforeAgentReply = handler;
    },
  }, {
    isModelOnlineCheck: async () => true,
  });

  const firstEvent = eventFor({
    ...current,
    text: "@樂奈 你認識誰",
  });
  await beforeAgentReply(firstEvent, current);

  const secondEvent = eventFor({
    ...current,
    text: "@樂奈 還有誰",
  });
  await beforeAgentReply(secondEvent, current);

  const snapshot = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });
  assert.equal(snapshot.previous_user_text, firstEvent.cleanedBody);

  const secondDecision = preDispatch.classifyPreDispatch(secondEvent, current, { modelOnline: true });
  assert.equal(secondDecision.turnPlan.evidence.required, true);
  assert.equal(secondDecision.turnPlan.evidence.source, "persona_canonical");
  assert.equal(secondDecision.turnPlan.utteranceAct?.continuationMode, "known_people_inventory_followup");
  assert.notEqual(secondDecision.turnPlan.subject?.type, "scene");

  const preDispatchSource = readFileSync(join(HERE, "architecture", "pre_dispatch.js"), "utf8");
  assert.match(
    preDispatchSource,
    /const turnPlan = buildUnifiedTurnPlan\(routeText, \{[\s\S]*?previousUserText:\s*rememberedContext\?\.previousUserText\s*\|\|\s*""[\s\S]*?\}\);/u,
  );
});

test("V3 known-people paraphrases share inventory planning and follow-up semantics", () => {
  const firstTurns = [
    "你都認識哪些人",
    "你認識哪些人",
    "你認識的人有誰",
    "你都認識誰",
  ];
  for (const text of firstTurns) {
    const plan = buildUnifiedTurnPlan(text, { personaId: "rana" });
    assert.equal(plan.utteranceAct?.subtype, "CANONICAL_EVIDENCE_QUERY", text);
    assert.equal(plan.utteranceAct?.target, "ACTIVE_CHARACTER_IDENTITY", text);
    assert.equal(plan.utteranceAct?.activity, "relationship", text);
    assert.ok(plan.utteranceAct?.predicateAnchors?.some((item) => /認識|认识/u.test(item)), text);
    assert.equal(plan.evidence?.source, "persona_canonical", text);
  }

  const followUps = ["其他呢", "其他人呢", "還有呢", "還有其他人嗎", "還有別人嗎"];
  for (const text of followUps) {
    const plan = buildUnifiedTurnPlan(text, { personaId: "rana", previousUserText: "你認識誰" });
    assert.equal(plan.utteranceAct?.continuationMode, "known_people_inventory_followup", text);
    assert.equal(plan.utteranceAct?.target, "ACTIVE_CHARACTER_IDENTITY", text);
    assert.equal(plan.evidence?.source, "persona_canonical", text);
  }
});

test("V3 current turn: event identity and current-turn Music hint take precedence over ctx", () => {
  const eventIdentity = uniqueIdentity({
    agentId: "taki",
    accountId: "taki",
    botId: "taki",
    personaId: "taki",
    sessionKey: `event-session-${randomUUID()}`,
  });
  const ctxIdentity = uniqueIdentity({
    agentId: "anon",
    accountId: "anon",
    botId: "anon",
    personaId: "anon",
    sessionKey: `ctx-session-${randomUUID()}`,
  });

  const resolved = botContext.resolveBotContext(eventIdentity, ctxIdentity);
  assert.deepEqual(
    {
      agentId: resolved.agentId,
      accountId: resolved.accountId,
      botId: resolved.botId,
      personaId: resolved.personaId,
      sessionKey: resolved.sessionKey,
      requesterId: resolved.requesterId,
      guildId: resolved.guildId,
      channelId: resolved.channelId,
      voiceChannelId: resolved.voiceChannelId,
    },
    {
      agentId: eventIdentity.agentId,
      accountId: eventIdentity.accountId,
      botId: eventIdentity.botId,
      personaId: eventIdentity.personaId,
      sessionKey: eventIdentity.sessionKey,
      requesterId: eventIdentity.requesterId,
      guildId: eventIdentity.guildId,
      channelId: eventIdentity.channelId,
      voiceChannelId: eventIdentity.voiceChannelId,
    },
  );

  assert.deepEqual(music.__test.currentTurnMusicHint(eventIdentity, ctxIdentity), {
    agentId: eventIdentity.agentId,
    sessionKey: eventIdentity.sessionKey,
  });
  assert.equal(music.__test.routeFromEvent(eventIdentity, ctxIdentity).botId, eventIdentity.botId);
});

test("V3 current turn: sessionId-only context is isolated from the active context", () => {
  const active = uniqueIdentity({ sessionKey: `active-session-${randomUUID()}` });
  contextStore.rememberDiscordContext(
    eventFor({ ...active, text: "active-context-source" }),
    active,
  );

  const sessionId = `session-id-only-${randomUUID()}`;
  const unresolved = contextStore.recentContextSnapshot({
    sessionId,
    agentId: active.agentId,
    accountId: active.accountId,
    botId: active.botId,
    personaId: active.personaId,
    requester_id: active.requesterId,
  });
  assert.equal(unresolved.fresh, false);
  assert.equal(unresolved.source_text, "");

  const { sessionKey: _sessionKey, ...sessionOnlyIdentity } = uniqueIdentity({
    sessionKey: "",
  });
  const sessionOnlyEvent = eventFor({
    ...sessionOnlyIdentity,
    sessionId,
    text: "session-id-only-current-source",
  });
  contextStore.rememberDiscordContext(sessionOnlyEvent, {});

  const current = contextStore.recentContextSnapshot({
    sessionId,
    agentId: sessionOnlyIdentity.agentId,
    accountId: sessionOnlyIdentity.accountId,
    botId: sessionOnlyIdentity.botId,
    personaId: sessionOnlyIdentity.personaId,
    requester_id: sessionOnlyIdentity.requesterId,
  });
  assert.equal(current.fresh, true);
  assert.equal(current.source_text, sessionOnlyEvent.cleanedBody);
  assert.equal(current.session_key, sessionId);
});

test("V3 current turn: Memory followed by ordinary chat stores current source text", () => {
  const current = uniqueIdentity();
  const firstEvent = eventFor({
    ...current,
    text: "@樂奈 記住我喜歡抹茶",
  });
  contextStore.rememberDiscordContext(firstEvent, current);

  const secondEvent = eventFor({
    ...current,
    text: "@樂奈 只是普通聊天",
    staleText: "@樂奈 記住我喜歡抹茶",
  });
  const decision = preDispatch.classifyPreDispatch(secondEvent, current, { modelOnline: false });
  assert.equal(decision.routeText, secondEvent.cleanedBody);
  assert.notEqual(decision.kind, "offline_memory");
  assert.notEqual(decision.kind, "offline_hot_tool");

  contextStore.rememberDiscordContext(secondEvent, current);
  const snapshot = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });
  assert.equal(snapshot.source_text, secondEvent.cleanedBody);
});

test("V3 current turn: transport-only mention cannot retain a prior conversational command", () => {
  const current = uniqueIdentity();
  const secondEvent = eventFor({
    ...current,
    text: "<@!99999999999999999>",
    staleText: "<@!99999999999999999> 播放 前一回合歌曲",
  });

  const decision = preDispatch.classifyPreDispatch(secondEvent, current, { modelOnline: false });
  assert.equal(decision.routeText, secondEvent.cleanedBody);
  assert.notEqual(decision.kind, "offline_play");
  assert.notEqual(decision.kind, "explicit_play");
  assert.equal(turnIsolation.__test.stripTransportAddress(secondEvent.cleanedBody), "");
  assert.equal(
    contracts.isCurrentTurnToolAuthorized({
      toolName: "rana_play_music",
      text: secondEvent.cleanedBody,
    }),
    false,
  );

  contextStore.rememberDiscordContext(secondEvent, current);
  const snapshot = contextStore.recentContextSnapshot({
    ...current,
    requester_id: current.requesterId,
  });
  assert.equal(turnIsolation.__test.stripTransportAddress(snapshot.source_text), "");
});

test("existing session lifecycle treats a missing indexed backing file as no readable history", {
  skip: SESSION_READER ? false : "needs the OpenClaw host install (dist/session-utils.fs-*.js)",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rana-session-index-"));
  const storePath = join(dir, "sessions.json");
  const key = "agent:main:discord:channel:900000000000000007";
  const entry = { sessionId: randomUUID(), sessionFile: join(dir, "missing-transcript.jsonl") };
  writeFileSync(storePath, JSON.stringify({ [key]: entry }), "utf8");
  assert.equal(existsSync(entry.sessionFile), false);

  const readSessionMessagesAsync = (await import(pathToFileURL(SESSION_READER.file).href))[SESSION_READER.alias];
  assert.equal(typeof readSessionMessagesAsync, "function");
  const messages = await readSessionMessagesAsync(
    entry.sessionId,
    storePath,
    entry.sessionFile,
    { mode: "recent", maxMessages: 200 },
    "main",
  );
  assert.deepEqual(messages, []);
});

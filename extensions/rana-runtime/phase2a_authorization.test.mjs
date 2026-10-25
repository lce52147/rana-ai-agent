import assert from "node:assert/strict";
import test from "node:test";

import { registerMusicTools } from "../rana-music-tools/tools/music.js";
import { __test as contextTest } from "./context_store.js";
import { hasExplicitPlayIntent, hasSufficientStockIntent } from "./tool_contracts.js";
import { registerStockTool } from "./tools/stock.js";

const CHANNEL_ID = "phase2a-fixture-channel";
const GUILD_ID = "phase2a-fixture-guild";
const REQUESTER_A_ID = "100000000000000001";
const REQUESTER_B_ID = "200000000000000002";

function seedCurrentTurn({ text, agentId = "main", sessionKey, senderId = REQUESTER_A_ID, isDirectMessage = true }) {
  contextTest.rememberDiscordContext(
    {
      body: text,
      senderId,
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      isGroup: !isDirectMessage,
      isDirectMessage,
    },
    {
      agentId,
      sessionKey,
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      chatType: isDirectMessage ? "dm" : "channel",
    },
  );
}

function stockFactoryContext({ sessionKey, senderId = REQUESTER_A_ID, agentId = "main" }) {
  return {
    agentId,
    sessionKey,
    sessionId: `phase2a-stock-factory-${sessionKey}`,
    agentAccountId: "default",
    requesterSenderId: senderId,
    deliveryContext: {
      channel: "discord",
      to: CHANNEL_ID,
      accountId: "default",
    },
  };
}

function hookContext({ toolName, sessionKey, agentId = "main" }) {
  return {
    toolName,
    agentId,
    sessionKey,
    sessionId: `phase2a-${sessionKey}`,
    runId: `run-${sessionKey}`,
    toolCallId: `call-${sessionKey}`,
    channelId: CHANNEL_ID,
  };
}

function registerMusicBoundary() {
  let gate;
  let observedCtx;
  let playTool;

  registerMusicTools({
    on(name, handler) {
      if (name !== "before_tool_call") return;
      gate = async (event, ctx) => {
        observedCtx = ctx;
        return handler(event, ctx);
      };
    },
    registerTool(tool) {
      if (tool.name === "rana_play_music") playTool = tool;
    },
  });

  assert.equal(typeof gate, "function");
  assert.ok(playTool);
  return { gate, playTool, getObservedCtx: () => observedCtx };
}

function registerStockBoundary(options = {}) {
  let gate;
  let observedCtx;
  let stockFactory;
  let registrationOptions;
  let stockTool;

  registerStockTool({
    on(name, handler) {
      if (name !== "before_tool_call") return;
      gate = async (event, ctx) => {
        observedCtx = ctx;
        return handler(event, ctx);
      };
    },
    registerTool(tool, opts) {
      if (typeof tool === "function") {
        stockFactory = tool;
        registrationOptions = opts;
        return;
      }
      if (tool.name === "rana_stock_research") stockTool = tool;
    },
  }, options);

  assert.equal(typeof gate, "function");
  assert.equal(typeof stockFactory, "function");
  assert.deepEqual(registrationOptions, { names: ["rana_stock_research"] });
  stockTool = stockFactory(stockFactoryContext({ sessionKey: "phase2a-stock-boundary" }));
  assert.ok(stockTool);
  assert.equal(stockTool.name, "rana_stock_research");
  return {
    gate,
    stockTool,
    stockFactory,
    registrationOptions,
    getObservedCtx: () => observedCtx,
  };
}

async function invokeThroughGate({ gate, tool, event, ctx }) {
  const decision = await gate(event, ctx);
  if (decision?.block) return decision;
  return tool.execute(undefined, event.params || {}, undefined, undefined);
}

test("phase 2A music authorization is grounded in trusted current-turn text", async () => {
  const boundary = registerMusicBoundary();
  let executeCalls = 0;
  let sidecarCalls = 0;
  boundary.playTool.execute = async () => {
    executeCalls += 1;
    sidecarCalls += 1;
    return { content: [{ type: "text", text: "unexpected execution" }] };
  };

  assert.equal(hasExplicitPlayIntent("播放 春日影"), true);
  assert.equal(hasExplicitPlayIntent("播種"), false);
  assert.equal(hasExplicitPlayIntent("播新聞"), false);

  const negativeTexts = ["RiNG", "LIVE", "播種", "播新聞", "春日影", "NVDA"];
  for (const [index, text] of negativeTexts.entries()) {
    const sessionKey = `phase2a-music-negative-${index}`;
    seedCurrentTurn({ text, sessionKey });
    const result = await invokeThroughGate({
      gate: boundary.gate,
      tool: boundary.playTool,
      event: {
        toolName: "rana_play_music",
        agentId: "main",
        sessionKey,
        params: { query: "春日影", source_text: "播放春日影" },
      },
      ctx: hookContext({ toolName: "rana_play_music", sessionKey }),
    });
    assert.equal(result?.block, true, `bare noun must block: ${text}`);
    assert.equal(executeCalls, 0);
    assert.equal(sidecarCalls, 0);
  }

  const positiveTexts = ["播放 春日影", "play spring shadow"];
  for (const [index, text] of positiveTexts.entries()) {
    const sessionKey = `phase2a-music-positive-${index}`;
    seedCurrentTurn({ text, sessionKey });
    const result = await boundary.gate(
      {
        toolName: "rana_play_music",
        agentId: "main",
        sessionKey,
        params: { query: "春日影", source_text: "RiNG LIVE" },
      },
      hookContext({ toolName: "rana_play_music", sessionKey }),
    );
    assert.equal(result, undefined, `explicit play intent must pass: ${text}`);
  }

  const observedCtx = boundary.getObservedCtx();
  assert.deepEqual(
    Object.keys(observedCtx).sort(),
    ["agentId", "channelId", "runId", "sessionId", "sessionKey", "toolCallId", "toolName"].sort(),
  );
  assert.equal(observedCtx.agentId, "main");
  assert.match(observedCtx.sessionKey, /^phase2a-music-positive-/);
  assert.equal(Object.hasOwn(observedCtx, "source_text"), false);
  console.log(`[phase2a] music before_tool_call ctx keys: ${Object.keys(observedCtx).sort().join(",")}`);

  const missingSession = "phase2a-music-missing-session";
  seedCurrentTurn({ text: "播放 春日影", sessionKey: missingSession });
  const missingResult = await invokeThroughGate({
    gate: boundary.gate,
    tool: boundary.playTool,
    event: {
      toolName: "rana_play_music",
      params: { query: "春日影", source_text: "播放春日影" },
    },
    ctx: { toolName: "rana_play_music", agentId: "main" },
  });
  assert.equal(missingResult?.block, true);
  assert.equal(executeCalls, 0);
  assert.equal(sidecarCalls, 0);

  const ambiguousSession = "phase2a-music-ambiguous";
  seedCurrentTurn({ text: "播放 春日影", sessionKey: ambiguousSession, senderId: REQUESTER_A_ID });
  seedCurrentTurn({ text: "播放 春日影", sessionKey: ambiguousSession, senderId: REQUESTER_B_ID });
  const ambiguousResult = await invokeThroughGate({
    gate: boundary.gate,
    tool: boundary.playTool,
    event: {
      toolName: "rana_play_music",
      agentId: "main",
      sessionKey: ambiguousSession,
      params: { query: "春日影", source_text: "播放春日影" },
    },
    ctx: hookContext({ toolName: "rana_play_music", sessionKey: ambiguousSession }),
  });
  assert.equal(ambiguousResult?.block, true);
  assert.equal(executeCalls, 0);
  assert.equal(sidecarCalls, 0);
});

test("phase 2A stock authorization is a hard trusted-intent gate", async () => {
  const boundary = registerStockBoundary();
  let executeCalls = 0;
  let sidecarCalls = 0;
  boundary.stockTool.execute = async () => {
    executeCalls += 1;
    sidecarCalls += 1;
    return { content: [{ type: "text", text: "unexpected execution" }] };
  };

  assert.equal(hasSufficientStockIntent("我想看美股 INTC"), true);
  assert.equal(hasSufficientStockIntent("我想看美股 QCOM"), true);

  const negativeTexts = ["INTC", "QCOM", "Intel CPU", "Qualcomm 晶片", "LIVE", "RiNG"];
  for (const [index, text] of negativeTexts.entries()) {
    const sessionKey = `phase2a-stock-negative-${index}`;
    seedCurrentTurn({ text, sessionKey });
    const result = await invokeThroughGate({
      gate: boundary.gate,
      tool: boundary.stockTool,
      event: {
        toolName: "rana_stock_research",
        params: { query: "幫我查美股 INTC", tickers: ["INTC"], source_text: "幫我查美股 INTC" },
      },
      ctx: hookContext({ toolName: "rana_stock_research", sessionKey }),
    });
    assert.equal(result?.block, true, `non-intent text must block: ${text}`);
    assert.equal(executeCalls, 0);
    assert.equal(sidecarCalls, 0);
  }

  const positiveTexts = ["我想看美股 INTC", "我想看美股 QCOM"];
  for (const [index, text] of positiveTexts.entries()) {
    const sessionKey = `phase2a-stock-positive-${index}`;
    seedCurrentTurn({ text, sessionKey });
    const result = await boundary.gate(
      {
        toolName: "rana_stock_research",
        params: { query: "INTC", tickers: ["INTC"], source_text: "INTC" },
      },
      hookContext({ toolName: "rana_stock_research", sessionKey }),
    );
    assert.equal(result, undefined, `explicit stock intent must pass: ${text}`);
  }

  const observedCtx = boundary.getObservedCtx();
  assert.deepEqual(
    Object.keys(observedCtx).sort(),
    ["agentId", "channelId", "runId", "sessionId", "sessionKey", "toolCallId", "toolName"].sort(),
  );
  assert.equal(observedCtx.agentId, "main");
  assert.match(observedCtx.sessionKey, /^phase2a-stock-positive-/);
  assert.equal(Object.hasOwn(observedCtx, "source_text"), false);
  console.log(`[phase2a] stock before_tool_call ctx keys: ${Object.keys(observedCtx).sort().join(",")}`);

  const missingSession = "phase2a-stock-missing-session";
  seedCurrentTurn({ text: "我想看美股 INTC", sessionKey: missingSession });
  const missingResult = await invokeThroughGate({
    gate: boundary.gate,
    tool: boundary.stockTool,
    event: {
      toolName: "rana_stock_research",
      agentId: "main",
      sessionKey: missingSession,
      params: { query: "INTC", source_text: "幫我查美股 INTC" },
    },
    ctx: { toolName: "rana_stock_research", agentId: "main" },
  });
  assert.equal(missingResult?.block, true);
  assert.equal(executeCalls, 0);
  assert.equal(sidecarCalls, 0);

  const ambiguousSession = "phase2a-stock-ambiguous";
  seedCurrentTurn({ text: "我想看美股 INTC", sessionKey: ambiguousSession, senderId: REQUESTER_A_ID });
  seedCurrentTurn({ text: "我想看美股 INTC", sessionKey: ambiguousSession, senderId: REQUESTER_B_ID });
  const ambiguousResult = await invokeThroughGate({
    gate: boundary.gate,
    tool: boundary.stockTool,
    event: {
      toolName: "rana_stock_research",
      sessionKey: ambiguousSession,
      params: { query: "INTC", source_text: "幫我查美股 INTC" },
    },
    ctx: hookContext({ toolName: "rana_stock_research", sessionKey: ambiguousSession }),
  });
  assert.equal(ambiguousResult?.block, true);
  assert.equal(executeCalls, 0);
  assert.equal(sidecarCalls, 0);
});

test("phase 2A stock factory carries arbitrary trusted requester context into four-arg execute", async () => {
  const sidecarRequests = [];
  const boundary = registerStockBoundary({
    researchStock: async ({ query, requester_id }) => {
      sidecarRequests.push({ query, requester_id });
      return {
        handled: true,
        kind: "leprechaun_research",
        status: "ok",
        reply: `${query} for ${requester_id}`,
      };
    },
  });

  const requesterASession = "agent:main:discord:dm:stock-factory-requester-a";
  const guildSession = "agent:main:discord:channel:stock-factory-requester-b";
  seedCurrentTurn({ text: "我想看美股 INTC", sessionKey: requesterASession, senderId: REQUESTER_A_ID });
  seedCurrentTurn({ text: "我想看美股 TSLA", sessionKey: guildSession, senderId: REQUESTER_B_ID, isDirectMessage: false });

  const requesterATool = boundary.stockFactory(stockFactoryContext({ sessionKey: requesterASession, senderId: REQUESTER_A_ID }));
  const guildTool = boundary.stockFactory(stockFactoryContext({ sessionKey: guildSession, senderId: REQUESTER_B_ID }));
  assert.equal(requesterATool.execute.length, 4);
  assert.equal(guildTool.execute.length, 4);

  const requesterAResult = await requesterATool.execute(
    "call-stock-factory-a",
    { query: "analyze US stock NVDA", tickers: ["NVDA"], requester_id: REQUESTER_B_ID },
    undefined,
    undefined,
  );
  const guildResult = await guildTool.execute(
    "call-stock-factory-guild",
    { query: "analyze US stock NVDA", tickers: ["NVDA"], requester_id: REQUESTER_A_ID },
    undefined,
    undefined,
  );

  const requesterAPayload = JSON.parse(requesterAResult.content[0].text);
  const guildPayload = JSON.parse(guildResult.content[0].text);
  assert.doesNotMatch(JSON.stringify(requesterAPayload), /trusted_invocation_context_unavailable/u);
  assert.equal(requesterAPayload.kind, "leprechaun_research");
  assert.doesNotMatch(JSON.stringify(guildPayload), /trusted_invocation_context_unavailable/u);
  assert.equal(guildPayload.kind, "leprechaun_research");
  assert.deepEqual(sidecarRequests, [
    { query: "stock INTC analysis", requester_id: REQUESTER_A_ID },
    { query: "stock TSLA analysis", requester_id: REQUESTER_B_ID },
  ]);
});

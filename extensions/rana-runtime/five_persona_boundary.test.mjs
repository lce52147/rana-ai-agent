import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  getPersonaProfile,
  personaForAccount,
} from "./persona_registry.js";
import { resolveBotContext } from "./bot_context.js";
import { __test as memoryTest } from "./tools/memory.js";
import { __test as personaLoreTest } from "./persona_lore.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { isCurrentTurnToolAuthorized } from "./current_turn_tool_contract.js";
import { classifyPreDispatch, isTargetedEvent } from "./architecture/pre_dispatch.js";
import {
  buildPersonaAuthorityContext,
  buildPersonaGenerationContext,
  buildPersonaRelationshipContext,
} from "./persona_context.js";

test("unknown persona/account never falls back to Rana", () => {
  assert.equal(personaForAccount("unknown-account"), null);
  assert.equal(getPersonaProfile("unknown-persona"), null);
});

test("missing identity context and development agent do not resolve a persona", () => {
  assert.equal(resolveBotContext({}, {}), null);
  assert.equal(resolveBotContext({ agentId: "agent" }, { agentId: "agent" }), null);
  assert.equal(resolveBotContext({ agentId: "unknown" }, { accountId: "unknown" }), null);
});

test("all five configured agents resolve only to their own persona", () => {
  const cases = [
    ["main", "default", "rana"],
    ["tomori", "tomori", "tomori"],
    ["anon", "anon", "anon"],
    ["soyo", "soyo", "soyo"],
    ["taki", "taki", "taki"],
  ];

  for (const [agentId, accountId, personaId] of cases) {
    const resolved = resolveBotContext({ agentId, accountId }, {});
    assert.ok(resolved, `${agentId} should resolve`);
    assert.equal(resolved.agentId, agentId);
    assert.equal(resolved.accountId, accountId);
    assert.equal(resolved.botId, personaId);
    assert.equal(resolved.personaId, personaId);
  }
});

test("conflicting explicit persona hints fail closed", () => {
  assert.equal(resolveBotContext({ agentId: "tomori", accountId: "tomori", personaId: "rana" }, {}), null);
  assert.equal(resolveBotContext({ agentId: "main", accountId: "anon" }, {}), null);
});

test("development agent bypasses persona routing and persona prompt surfaces", () => {
  const event = { agentId: "agent", content: "你是誰？", body: "你是誰？" };
  const ctx = { agentId: "agent" };

  assert.equal(isTargetedEvent(event, ctx, event.content), false);
  assert.deepEqual(classifyPreDispatch(event, ctx, { modelOnline: true }), {
    kind: "pass",
    routeText: event.content,
  });
  assert.equal(buildPersonaAuthorityContext(event, ctx), "");
  assert.equal(buildPersonaGenerationContext(event, ctx), "");
  assert.equal(buildPersonaRelationshipContext(event, ctx), "");
});

test("memory scope is derived only from the current resolved five-persona context", () => {
  const scope = memoryTest.memoryScope({
    agentId: "tomori",
    accountId: "tomori",
    sessionKey: "agent:tomori:discord:channel:1",
    guildId: "g",
    channelId: "c",
  });
  assert.deepEqual(scope, {
    bot_id: "tomori",
    persona_id: "tomori",
    account_id: "tomori",
    agent_id: "tomori",
    session_key: "agent:tomori:discord:channel:1",
    guild_id: "g",
    channel_id: "c",
  });
  assert.equal(memoryTest.memoryScope({}), null);
  assert.equal(memoryTest.memoryScope({ agentId: "agent", accountId: "default" }), null);
  assert.equal(memoryTest.memoryScope({ agentId: "tomori", accountId: "anon" }), null);
});

test("memory request identity never borrows a previous requester", () => {
  const current = memoryTest.memoryRequestContext({
    agentId: "anon",
    accountId: "anon",
    requesterId: "123456789012345678",
    roles: ["role-a"],
  }, {});
  assert.equal(current.requester_id, "123456789012345678");
  assert.deepEqual(current.roles, ["role-a"]);
  assert.equal(current.scope.bot_id, "anon");

  assert.equal(memoryTest.memoryRequestContext({ agentId: "anon", accountId: "anon" }, {}), null);
  assert.equal(memoryTest.memoryRequestContext({ agentId: "agent", requesterId: "123456789012345678" }, {}), null);
});

test("hot-tools memory paths match each agent memorySearch workspace and reject unknown scope", async () => {
  const port = 18091 + (process.pid % 700);
  const child = spawn(process.execPath, ["workspace/services/rana_hot_tools/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, RANA_HOT_TOOLS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          if (chunk.includes("listening on")) resolve();
        });
        child.once("exit", (code) => reject(new Error(`hot-tools exited early (${code}): ${stderr}`)));
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("hot-tools test server startup timeout")), 5000);
        timer.unref();
      }),
    ]);

    const expected = new Map([
      ["rana", "MEMORY.md"],
      ["tomori", "../workspace-bots/tomori/MEMORY.md"],
      ["anon", "../workspace-bots/anon/MEMORY.md"],
      ["soyo", "../workspace-bots/soyo/MEMORY.md"],
      ["taki", "../workspace-bots/taki/MEMORY.md"],
    ]);
    for (const [botId, store] of expected) {
      const response = await fetch(`http://127.0.0.1:${port}/memory/status?bot_id=${botId}`);
      assert.equal(response.status, 200, botId);
      assert.equal((await response.json()).store, store, botId);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/memory/status`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/memory/status?bot_id=unknown`)).status, 400);
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});

test("all five personas use the same persona-aware LORE corpus resolver", () => {
  for (const personaId of ["rana", "tomori", "anon", "soyo", "taki"]) {
    const corpus = personaLoreTest.readCorpus(personaId);
    assert.ok(corpus, `${personaId} corpus should resolve`);
    assert.ok(Array.isArray(corpus.all), `${personaId} corpus should expose records`);
    assert.ok(corpus.all.length > 0, `${personaId} corpus should not be empty`);
  }
});

test("Rana canonical turns authorize persona_lore_search instead of the legacy Rana-only tool", () => {
  const plan = buildUnifiedTurnPlan("妳認識祥子嗎？", { personaId: "rana" });
  assert.equal(plan.evidence?.source, "persona_canonical");
  assert.equal(isCurrentTurnToolAuthorized({ toolName: "persona_lore_search", plan, agentId: "main" }), true);
  assert.equal(isCurrentTurnToolAuthorized({ toolName: "rana_lore_search", plan, agentId: "main" }), false);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  compareToolRegistryIds,
  getToolRegistry,
  getToolRegistryEntry,
  TOOL_REGISTRY_IDS,
} from "./tool_registry.js";

const ACTIVE_CONTRACTS = [
  "browser",
  "codex_threads",
  "memory_get",
  "memory_search",
  "node_inference",
  "ollama_web_fetch",
  "ollama_web_search",
  "persona_lore_search",
  "persona_relationship_search",
  "rana_analyze_image",
  "rana_join_voice",
  "rana_leave_voice",
  "rana_lore_search",
  "rana_memory",
  "rana_play_music",
  "rana_show_queue",
  "rana_skip_music",
  "rana_stock_research",
  "rana_stop_music",
  "rana_volume_music",
];

test("unified registry covers every active tool contract", () => {
  assert.deepEqual(compareToolRegistryIds(ACTIVE_CONTRACTS), { missing: [], stale: [] });
  assert.equal(new Set(TOOL_REGISTRY_IDS).size, ACTIVE_CONTRACTS.length);
  assert.equal(getToolRegistry().length, ACTIVE_CONTRACTS.length);
});

test("registry records contracts, isolation, errors, timeout, and one outbound owner", () => {
  for (const entry of getToolRegistry()) {
    assert.equal(entry.registrationStatus, "active");
    assert.ok(entry.toolId);
    assert.ok(entry.pluginId);
    assert.ok(entry.purpose);
    assert.ok(entry.request);
    assert.ok(entry.response);
    assert.ok(Array.isArray(entry.state?.model));
    assert.equal(typeof entry.state?.sharedState, "boolean");
    assert.ok(entry.permissions);
    assert.ok(entry.timeout);
    assert.ok(Array.isArray(entry.errors) && entry.errors.length > 0);
    assert.equal(entry.discord?.owner, "current_bot_persona_output");
    assert.equal(entry.discord?.toolSendsDiscordText, false);
    assert.ok(entry.dependency);
  }
  assert.equal(getToolRegistryEntry("rana_analyze_image")?.pluginId, "rana-vision");
  assert.equal(getToolRegistryEntry("does_not_exist"), null);
});

test("stock registry allows trusted requesters in targeted Discord turns", () => {
  const entry = getToolRegistryEntry("rana_stock_research");
  assert.match(entry.purpose, /any trusted requester.*targeted Discord turn.*explicit current-turn stock intent/iu);
  assert.match(entry.permissions, /any trusted requester.*targeted Discord turn.*explicit current-turn stock intent/iu);
  assert.doesNotMatch(`${entry.purpose} ${entry.permissions} ${entry.state.isolation.join(" ")}`, /direct message|DM context/iu);
});

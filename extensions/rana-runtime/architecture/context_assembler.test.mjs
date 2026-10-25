import assert from "node:assert/strict";
import { test } from "node:test";
import { registerContextAssembler } from "./context_assembler.js";

test("context assembler exposes one before_prompt_build hook and deduplicates sections", async () => {
  const hooks = [];
  const api = { on(name, fn, options) { if (name === "before_prompt_build") hooks.push({ fn, options }); } };
  registerContextAssembler(api);
  api.on("before_prompt_build", () => ({ appendSystemContext: "shared" }), { priority: 10, name: "first" });
  api.on("before_prompt_build", () => ({ appendSystemContext: "shared" }), { priority: 5, name: "second" });
  assert.equal(hooks.length, 1);
  const result = await hooks[0].fn({ prompt: "hello" }, { runId: "assembler-test", sessionKey: "assembler-test" });
  assert.equal(result.appendSystemContext, "shared");
});

test("context assembler preserves prompt fields and applies priority semantics", async () => {
  const hooks = [];
  const api = { on(name, fn, options) { if (name === "before_prompt_build") hooks.push({ fn, options }); } };
  registerContextAssembler(api);
  api.on("before_prompt_build", () => ({
    priority: 10,
    appendContext: "high tail",
    toolsAllow: ["tool.high", "shared"],
    systemPrompt: "high system",
    extraBody: { temperature: 0.2, top_p: 0.9 },
  }), { priority: 10, name: "high" });
  api.on("before_prompt_build", () => ({
    priority: 5,
    appendContext: "low tail",
    toolsAllow: ["shared", "tool.low"],
    systemPrompt: "low system",
    extraBody: { temperature: 0.7, seed: 42 },
  }), { priority: 5, name: "low" });
  const result = await hooks[0].fn({ prompt: "hello" }, { runId: "assembler-fields", sessionKey: "assembler-fields" });
  assert.equal(result.appendContext, "high tail\n\nlow tail");
  assert.deepEqual(result.toolsAllow, ["shared"]);
  assert.equal(result.systemPrompt, "high system");
  assert.deepEqual(result.extraBody, { temperature: 0.2, seed: 42, top_p: 0.9 });
});

test("context assembler drops extraBody.grammar while tools remain visible to the model", async () => {
  const hooks = [];
  const api = { on(name, fn, options) { if (name === "before_prompt_build") hooks.push({ fn, options }); } };
  registerContextAssembler(api);
  api.on("before_prompt_build", () => ({ toolsAllow: ["lol_matchup", "web_search"] }), { priority: 7000, name: "surface" });
  api.on("before_prompt_build", () => ({ extraBody: { grammar: "root ::= [^（(*＊]*", seed: 7 } }), { priority: 1200, name: "isolation" });
  const result = await hooks[0].fn({ prompt: "hello", tools: [{ name: "lol_matchup" }] }, { runId: "assembler-grammar", sessionKey: "assembler-grammar" });
  assert.deepEqual(result.toolsAllow, ["lol_matchup", "web_search"]);
  assert.deepEqual(result.extraBody, { seed: 7 });
  assert.ok(result.__contextTrace.sections.some((section) => section.id === "extra-body-grammar"));
});

test("context assembler keeps extraBody.grammar only when toolsAllow is explicitly empty", async () => {
  const hooks = [];
  const api = { on(name, fn, options) { if (name === "before_prompt_build") hooks.push({ fn, options }); } };
  registerContextAssembler(api);
  api.on("before_prompt_build", () => ({ toolsAllow: [] }), { priority: 7000, name: "surface" });
  api.on("before_prompt_build", () => ({ extraBody: { grammar: "root ::= [^（(*＊]*" } }), { priority: 1200, name: "isolation" });
  const result = await hooks[0].fn({ prompt: "hello" }, { runId: "assembler-grammar-ok", sessionKey: "assembler-grammar-ok" });
  assert.deepEqual(result.toolsAllow, []);
  assert.deepEqual(result.extraBody, { grammar: "root ::= [^（(*＊]*" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { __test as isolation, registerTurnIsolation } from "./architecture/turn_isolation.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";

const sister = {
  modelProviderId: "llama-cpp-sister",
  modelId: "GGO-G12B-thinkoff",
};

test("parenthetical grammar guard is limited to pure sister-model user statements", () => {
  assert.deepEqual(
    isolation.resolveParentheticalGrammarExtraBody(buildUnifiedTurnPlan("今天有點累。"), sister),
    { grammar: "root ::= [^（(*＊]*" },
  );

  for (const text of [
    "請原樣回覆這個檔名：a(1).txt",
    "請原樣回覆：*hello*",
    "請原樣回覆：foo(bar)",
    "請原樣回覆：1 + 2 = 3",
  ]) {
    assert.equal(
      isolation.resolveParentheticalGrammarExtraBody(buildUnifiedTurnPlan(text), sister),
      undefined,
      text,
    );
  }

  // The local OOGG is the same Gemma 12B model and is now covered as well.
  assert.deepEqual(
    isolation.resolveParentheticalGrammarExtraBody(
      buildUnifiedTurnPlan("今天有點累。"),
      { modelProviderId: "llama-cpp", modelId: "OOGG" },
    ),
    { grammar: "root ::= [^（(*＊]*" },
  );
  assert.equal(
    isolation.resolveParentheticalGrammarExtraBody(
      buildUnifiedTurnPlan("請原樣回覆：foo(bar)"),
      { modelProviderId: "llama-cpp", modelId: "OOGG" },
    ),
    undefined,
  );
  // Every other provider/model stays unconstrained.
  for (const other of [
    { modelProviderId: "google", modelId: "gemini-3.1-flash-lite" },
    { modelProviderId: "ollama", modelId: "gemma4:e4b" },
    { modelProviderId: "llama-cpp-vision", modelId: "model\\rana-vision\\Qwen3VL-8B-Instruct-Q4_K_M.gguf" },
    { modelProviderId: "colab-qwen27b", modelId: "Qwen3.8-27B-Q4_K_M" },
    { modelProviderId: "llama-cpp", modelId: "GGO-G12B-thinkoff" },
    { modelProviderId: "llama-cpp-sister", modelId: "OOGG" },
    {},
  ]) {
    assert.equal(
      isolation.resolveParentheticalGrammarExtraBody(buildUnifiedTurnPlan("今天有點累。"), other),
      undefined,
      JSON.stringify(other),
    );
  }
  assert.equal(
    isolation.resolveParentheticalGrammarExtraBody(
      buildUnifiedTurnPlan("今天有點累。"),
      { modelProviderId: "llama-cpp-sister", modelId: "other-model" },
    ),
    undefined,
  );
  // Conversational question about her current state: covered since the guard now spans the four
  // conversational subtypes (R5: stage directions leaked on turns the USER_STATEMENT-only rule missed).
  assert.deepEqual(
    isolation.resolveParentheticalGrammarExtraBody(buildUnifiedTurnPlan("妳現在是在學校嗎？"), sister),
    { grammar: "root ::= [^（(*＊]*" },
  );
});

test("registered before_prompt_build returns the guarded extraBody", () => {
  const hooks = [];
  registerTurnIsolation({
    on(name, handler, options = {}) {
      if (name === "before_prompt_build") hooks.push({ handler, priority: options.priority ?? 0 });
    },
  });
  hooks.sort((a, b) => b.priority - a.priority);

  const run = (prompt, runId) => {
    const event = { runId, prompt, messages: [{ role: "user", content: prompt }] };
    const ctx = {
      runId,
      sessionKey: `agent:main:discord:channel:${runId}`,
      agentId: "main",
      ...sister,
    };
    let extraBody;
    for (const hook of hooks) {
      const result = hook.handler(event, ctx);
      if (result?.extraBody) extraBody = { ...(extraBody ?? {}), ...result.extraBody };
    }
    return extraBody;
  };

  assert.deepEqual(run("今天有點累。", "paren-chat"), { grammar: "root ::= [^（(*＊]*" });
  assert.equal(run("請原樣回覆：foo(bar)", "paren-verbatim"), undefined);
});

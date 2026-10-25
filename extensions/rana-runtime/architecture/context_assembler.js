import { writeGenerationTrace } from "./generation_trace.js";

const states = new WeakMap();

function stateFor(api) {
  let state = states.get(api);
  if (!state) { state = { sections: [], originalOn: api?.on?.bind(api), hookCount: 0, enabled: false }; states.set(api, state); }
  return state;
}

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) || "";
  if (value && typeof value === "object") return firstText(value.text || value.content || value.prompt || value.body);
  return "";
}

function currentText(prompt) {
  const text = firstText(prompt);
  const marker = [...text.matchAll(/UNTRUSTED Discord message body\s*\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT/giu)].at(-1)?.[1];
  return String(marker || text).replace(/<@!?\d+>|@Rana(?:#\d+)?|@樂奈/giu, " ").replace(/^\s*User text:\s*/iu, "").trim();
}

function joinSegments(items) {
  return items.map(firstText).filter(Boolean).join("\n\n");
}

function intersectToolsAllow(restrictions) {
  const lists = restrictions.filter(Array.isArray);
  if (!lists.length) return undefined;
  if (lists.some((list) => list.length === 0)) return [];
  if (lists.some((list) => list.includes("*"))) {
    const concrete = lists.filter((list) => !list.includes("*"));
    if (!concrete.length) return ["*"];
    return [...new Set(concrete.flat())].filter((name) => concrete.every((list) => list.includes(name)));
  }
  return [...new Set(lists[0])].filter((name) => lists.every((list) => list.includes(name)));
}

export function registerContextSection(api, definition) {
  const state = stateFor(api);
  const handler = definition?.handler || definition?.fn;
  if (typeof handler !== "function") return;
  if (state.enabled) {
    state.sections.push({ ...definition, handler, id: String(definition.id || `section-${state.sections.length + 1}`), order: Number(definition.order || 0) });
    return;
  }
  if (typeof state.originalOn === "function") state.originalOn("before_prompt_build", handler, definition.options || { priority: definition.order || 0 });
}

export function registerContextAssembler(api) {
  if (!api || typeof api.on !== "function") throw new Error("OpenClaw hook API unavailable; refusing context assembler.");
  const state = stateFor(api);
  if (state.enabled) return;
  state.enabled = true;
  const originalOn = state.originalOn;
  api.on = (name, fn, options) => {
    if (name === "before_prompt_build") {
      state.hookCount += 1;
      state.sections.push({ id: options?.name || `hook-${state.hookCount}`, order: Number(options?.priority || 0), reason: "existing runtime section", handler: fn, options });
      return undefined;
    }
    return originalOn(name, fn, options);
  };
  originalOn("before_prompt_build", async (event, ctx) => {
    const sections = [...state.sections].sort((a, b) => b.order - a.order || a.id.localeCompare(b.id));
    if (ctx && typeof ctx === "object") ctx.__ranaContextAssembler = true;
    const prepend = []; const append = []; const trace = []; const retrieved = [];
    const prependContext = []; const appendContext = []; const toolsAllow = [];
    let systemPrompt; let promptProfile; let extraBody;
    for (const section of sections) {
      let value;
      try { value = await section.handler(event, ctx); } catch (error) {
        trace.push({ id: section.id, order: section.order, chars: 0, reason: section.reason || "section_error", error: String(error?.message || error) });
        continue;
      }
      const before = prepend.length + append.length;
      if (value?.prependSystemContext) prepend.push(firstText(value.prependSystemContext));
      if (value?.appendSystemContext) append.push(firstText(value.appendSystemContext));
      if (value?.prependContext) prependContext.push(firstText(value.prependContext));
      if (value?.appendContext) appendContext.push(firstText(value.appendContext));
      if (systemPrompt === undefined && value?.systemPrompt !== undefined) systemPrompt = value.systemPrompt;
      if (promptProfile === undefined && value?.promptProfile !== undefined) promptProfile = value.promptProfile;
      if (value?.extraBody && typeof value.extraBody === "object") extraBody = { ...(value.extraBody || {}), ...(extraBody || {}) };
      if (Array.isArray(value?.toolsAllow)) toolsAllow.push(value.toolsAllow);
      const contextTrace = value?.__contextTrace || value?.contextTrace || {};
      if (Array.isArray(contextTrace.retrieved)) retrieved.push(...contextTrace.retrieved);
      const text = [value?.prependSystemContext, value?.appendSystemContext].map(firstText).filter(Boolean).join("\n\n");
      if (text || before !== prepend.length + append.length || value?.promptProfile) trace.push({ id: section.id, order: section.order, chars: text.length, reason: section.reason || "runtime section", ...(contextTrace.retrieval ? { retrieval: contextTrace.retrieval } : {}) });
    }
    const dedupe = (items) => [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
    const mergedToolsAllow = toolsAllow.length ? intersectToolsAllow(toolsAllow) : undefined;
    // llama-server rejects a request that carries both `grammar` and tools
    // ("Cannot use custom grammar constraints with tools"). Only an explicit
    // empty toolsAllow proves the host sends no tools, so the grammar is
    // forwarded in that case alone and dropped otherwise.
    const toolsStillVisible = !(Array.isArray(mergedToolsAllow) && mergedToolsAllow.length === 0);
    if (extraBody && Object.hasOwn(extraBody, "grammar") && toolsStillVisible) {
      const { grammar: _droppedGrammar, ...rest } = extraBody;
      extraBody = Object.keys(rest).length ? rest : undefined;
      trace.push({ id: "extra-body-grammar", order: 0, chars: 0, reason: "grammar dropped: tools remain visible to the model" });
    }
    const result = {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      prependContext: joinSegments(prependContext),
      appendContext: joinSegments(appendContext),
      prependSystemContext: dedupe(prepend).join("\n\n"),
      appendSystemContext: dedupe(append).join("\n\n"),
      ...(promptProfile !== undefined ? { promptProfile } : {}),
      ...(extraBody !== undefined ? { extraBody } : {}),
      ...(mergedToolsAllow !== undefined ? { toolsAllow: mergedToolsAllow } : {}),
      __contextTrace: { retrieved, sections: trace },
    };
    writeGenerationTrace({ phase: "context_assembler", runId: String(ctx?.runId || event?.runId || "") || null, sessionKey: String(ctx?.sessionKey || event?.sessionKey || "") || null, personaId: String(ctx?.agentId || event?.agentId || "") || null, sections: trace, retrievedEntries: retrieved });
    return result;
  }, { priority: 1_000_000, timeoutMs: 20_000, name: "rana-context-assembler" });
}

export const __test = { states, currentText };


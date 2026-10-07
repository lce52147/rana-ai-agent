import test from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";

import { resolveBotContext } from "./bot_context.js";
import { parseMemoryDeleteRequest, parseMemoryRecallRequest, parseMemoryRememberRequest } from "./tool_contracts.js";
import { handleMemoryRequest } from "./tools/memory.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import * as receiptModule from "./architecture/tool_receipt.js";
import * as isolationModule from "./architecture/turn_isolation.js";
import { PERSONA_REPLIES } from "./persona_replies.js";
import { __test as memoryTest } from "./tools/memory.js";
import { __test as personaLoreTest } from "./persona_lore.js";
import { __test as contextStoreTest, rememberDiscordContext } from "./context_store.js";

const PERSONAS = ["rana", "tomori", "anon", "soyo", "taki"];
const NON_RANA = PERSONAS.filter((id) => id !== "rana");

test("Rana keeps her own fixed memory wording; the other four never receive it", () => {
  const rana = memoryTest.memoryReplies("rana");
  assert.equal(rana.unresolvedRecall, "誰？");
  assert.equal(rana.failRemember, "不行。沒有記住。");
  for (const personaId of NON_RANA) {
    const replies = memoryTest.memoryReplies(personaId);
    for (const [key, value] of Object.entries(replies)) {
      if (["recallMiss", "badAction", "failRecall"].includes(key)) continue; // identical, already neutral
      assert.notEqual(value, rana[key], `${personaId}.${key} must not reuse Rana wording`);
    }
  }
  // Unknown / missing persona must not be handed Rana's wording either.
  assert.notEqual(memoryTest.memoryReplies(undefined).failRemember, rana.failRemember);
  assert.notEqual(memoryTest.memoryReplies("unknown").unresolvedRecall, rana.unresolvedRecall);
});

test("Rana's literal persona id is accepted as an explicit agent alias, but never crosses accounts", () => {
  assert.equal(resolveBotContext({ agentId: "rana", accountId: "default" }, {})?.personaId, "rana");
  assert.equal(resolveBotContext({ agentId: "rana", accountId: "anon" }, {}), null);
  assert.equal(resolveBotContext({ agentId: "anon", accountId: "default" }, {}), null);
});

test("unresolved context is never stored or keyed under any persona", () => {
  const stored = rememberDiscordContext({ agentId: "agent", senderId: "123456789012345678", body: "hello" }, { agentId: "agent" });
  assert.equal(stored.personaId, "");
  assert.equal(stored.botId, "");
  assert.match(contextStoreTest.contextKeyFrom({ agentId: "agent" }, {}), /^__no_context_match__\|unresolved\|/u);

  const snapshot = contextStoreTest.recentContextSnapshot({ sessionKey: "agent:nobody:discord:channel:1" });
  assert.equal(snapshot.persona_id, "");
  assert.equal(snapshot.bot_id, "");
  assert.equal(snapshot.agent_id, "");
});

test("every persona (Rana included) resolves its own LORE corpus through the same reader", () => {
  for (const personaId of PERSONAS) {
    const corpus = personaLoreTest.readCorpus(personaId);
    assert.ok(corpus?.all?.length > 0, `${personaId} corpus`);
    // Maintenance/audit sources are not retrievable canon for any persona.
    assert.equal(corpus.all.some((item) => /^research\/(?:16_|18_|20_)/u.test(item.source)), false, `${personaId} audit sources`);
  }
  assert.equal(personaLoreTest.readCorpus("unknown-persona"), null);
});

test("sidecar success wording is Rana's voice and never reaches the other four personas", () => {
  const saved = { handled: true, kind: "memory_save", reply: "嗯。記住了。" };
  const deleted = { handled: true, kind: "memory_delete", reply: "嗯。忘了。", removed: 1 };
  assert.equal(memoryTest.personaSuccessReply("remember", saved, "rana"), "嗯。記住了。");
  assert.equal(memoryTest.normalizeMemoryToolResult("remember", saved, undefined, "rana").reply, "嗯。記住了。");
  for (const personaId of NON_RANA) {
    assert.notEqual(memoryTest.personaSuccessReply("remember", saved, personaId), "嗯。記住了。", personaId);
    assert.notEqual(memoryTest.personaSuccessReply("delete", deleted, personaId), "嗯。忘了。", personaId);
    const outcome = memoryTest.normalizeMemoryToolResult("remember", saved, undefined, personaId);
    assert.equal(outcome.success, true, personaId);
    assert.notEqual(outcome.reply, "嗯。記住了。", personaId);
    assert.notEqual(outcome.result.reply, "嗯。記住了。", personaId);
  }
});

test("every persona owns a complete fixed-reply table and none of the other four reuses Rana's wording", () => {
  const keys = Object.keys(PERSONA_REPLIES.rana).sort();
  for (const personaId of NON_RANA) {
    const table = PERSONA_REPLIES[personaId];
    assert.deepEqual(Object.keys(table).sort(), keys, `${personaId} keys`);
    for (const key of keys) {
      assert.ok(table[key], `${personaId}.${key} is empty`);
      assert.notEqual(table[key], PERSONA_REPLIES.rana[key], `${personaId}.${key} reuses Rana wording`);
    }
  }
  // The four non-Rana tables must also differ from each other for the approved core sentences.
  for (const key of ["remembered", "forgotten", "failRemember", "noPermission"]) {
    assert.equal(new Set(NON_RANA.map((id) => PERSONA_REPLIES[id][key])).size, NON_RANA.length, key);
  }
});

test("hot-tools rejects sensitive memory in Chinese/Japanese and token-shaped text, without writing (unknown scope guards the write)", async () => {
  const port = 19091 + (process.pid % 500);
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
        child.stdout.on("data", (chunk) => { if (chunk.includes("listening on")) resolve(); });
        child.once("exit", (code) => reject(new Error(`hot-tools exited early (${code}): ${stderr}`)));
      }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("startup timeout")), 5000); timer.unref(); }),
    ]);
    const post = async (text) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory/remember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, bot_id: "unknown" }),
      });
      return { status: response.status, body: await response.json() };
    };
    for (const text of ["我的密碼是測試用", "我的密码是测试用", "我的 API key 是測試用", "我的 token 是測試用", `信用卡號是${"4111".repeat(4)}`, "パスワードはテスト", "口令：測試用",
      `key ${"sk"}-${"a".repeat(24)}`, `${"M".repeat(24)}.${"G".repeat(6)}.${"a".repeat(30)}`]) {
      const { status, body } = await post(text);
      assert.equal(status, 400, text);
      assert.equal(body.kind, "memory_rejected", text);
    }
    // Ordinary text is not treated as sensitive (it only fails later, on the unknown scope).
    const ok = await post("測試詞是LN01");
    assert.equal(ok.body.kind, "memory_scope_invalid");
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});

test("polite 請(你) prefix is recognised for remember and forget, and does not turn ordinary sentences into memory writes", () => {
  for (const text of ["請你記住 測試詞是 LN936101", "請記住 測試詞是 LN936101", "記住 測試詞是 LN936101"]) {
    const parsed = parseMemoryRememberRequest(text);
    assert.equal(parsed?.action, "remember", text);
    assert.match(parsed.text, /測試詞是 LN936101/u, text);
  }
  for (const text of ["請你忘記 LN936101", "請忘記 LN936101", "忘記 LN936101"]) {
    const parsed = parseMemoryDeleteRequest(text);
    assert.ok(parsed, text);
    assert.match(JSON.stringify(parsed), /LN936101/u, text);
  }
  assert.equal(parseMemoryRememberRequest("請你記得帶傘"), null);
});

async function closedPort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port; // nothing listens here any more, so connecting is refused (ECONNREFUSED)
}

async function probeModelOnline(env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", 'import("./architecture/pre_dispatch.js").then((m) => m.isModelOnline()).then((v) => console.log("RESULT=" + v))'], {
    cwd: path.join(process.cwd(), "extensions", "rana-runtime"),
    env: { ...process.env, RANA_MODEL_HEALTH_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  await once(child, "exit");
  return out.match(/RESULT=(true|false)/u)?.[1];
}

test("model is online when the primary is down but a local/LAN fallback answers; offline only when none answers", async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upPort = server.address().port;
  const deadA = await closedPort();
  const deadB = await closedPort();
  const deadC = await closedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rana-health-"));
  const writeConfig = (name, fallbackBase) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({
      agents: { defaults: { model: { primary: "primary/x", fallbacks: ["fb/y", "cloud/z"] } } },
      models: { providers: {
        primary: { baseUrl: `http://127.0.0.1:${deadA}/v1` },
        fb: { baseUrl: fallbackBase },
        cloud: { baseUrl: "https://example.invalid/v1" },
      } },
    }));
    return file;
  };
  try {
    assert.equal(await probeModelOnline({ OPENCLAW_CONFIG_PATH: writeConfig("up.json", `http://127.0.0.1:${upPort}/v1`) }), "true");
    assert.equal(await probeModelOnline({ OPENCLAW_CONFIG_PATH: writeConfig("down.json", `http://127.0.0.1:${deadB}/v1`) }), "false");
    // An explicit override is exclusive: the configured fallback is ignored.
    assert.equal(await probeModelOnline({ OPENCLAW_CONFIG_PATH: writeConfig("up2.json", `http://127.0.0.1:${upPort}/v1`), RANA_MODEL_HEALTH_URL: `http://127.0.0.1:${deadC}/v1/models` }), "false");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bare memory commands, cross-persona writes and bulk forgets are recognised (and ordinary text is not)", () => {
  for (const text of ["記住", "記住！", "請你記住", "幫我記住", "請你記下"]) {
    const parsed = parseMemoryRememberRequest(text);
    assert.equal(parsed?.action, "remember", text);
    assert.equal(parsed.text, "", text);
  }
  assert.match(parseMemoryRememberRequest("記住，明天要交報告").text, /明天要交報告/u);
  assert.deepEqual(parseMemoryDeleteRequest("忘記"), { action: "forget", text: "" });
  assert.deepEqual(parseMemoryRecallRequest("你記得"), { action: "recall", text: "", subject: "" });

  for (const text of ["把這個記到樂奈的記憶：X1", "幫我記住 這是燈的記憶：X2", "記到愛音那邊 X3", "幫爽世記住 X4", "幫我記住 這是立希的記憶：X5"]) {
    assert.equal(parseMemoryRememberRequest(text)?.action, "remember_cross", text);
  }
  assert.equal(parseMemoryRememberRequest("記住 樂奈喜歡抹茶")?.action, "remember");
  assert.equal(parseMemoryRememberRequest("記住 這是樂奈的記憶力很好")?.action, "remember");

  for (const text of ["忘記全部", "忘記所有人的記憶", "全部忘掉", "請你忘記所有記憶", "清空記憶", "reset memory", "忘記 大家的記憶"]) {
    assert.equal(parseMemoryDeleteRequest(text)?.action, "forget_bulk", text);
  }
  assert.equal(parseMemoryDeleteRequest("忘記 測試詞")?.action, "forget");
  assert.equal(parseMemoryDeleteRequest("忘記 所有人都喜歡貓這件事")?.action, "forget");
  assert.equal(parseMemoryDeleteRequest("大家"), null);
  assert.equal(parseMemoryDeleteRequest("全部"), null);
});

test("runtime answers those commands itself with the speaker's own wording, without touching the sidecar", async () => {
  const seats = [["rana", "main", "default"], ["tomori", "tomori", "tomori"], ["anon", "anon", "anon"], ["soyo", "soyo", "soyo"], ["taki", "taki", "taki"]];
  for (const [persona, agentId, accountId] of seats) {
    const event = { agentId, accountId };
    const table = PERSONA_REPLIES[persona];
    assert.equal((await handleMemoryRequest({ action: "forget_bulk", text: "全部" }, event, {}, ""))?.text, table.refuseBulkForget, persona);
    assert.equal((await handleMemoryRequest({ action: "remember", text: "", empty: true }, event, {}, ""))?.text, table.rememberEmpty, persona);
    const other = persona === "rana" ? "燈" : "樂奈";
    assert.equal((await handleMemoryRequest({ action: "remember_cross", target: other, text: "X" }, event, {}, ""))?.text, table.refuseCrossMemory, persona);
  }
  // Writing to your own memory by name is an ordinary remember; with no content it asks for content.
  assert.equal((await handleMemoryRequest({ action: "remember_cross", target: "愛音ちゃん", text: "" }, { agentId: "anon", accountId: "anon" }, {}, ""))?.text, PERSONA_REPLIES.anon.rememberEmpty);
});

test("hot-tools refuses bulk memory deletes on its own (defence in depth)", async () => {
  const port = 19591 + (process.pid % 300);
  const child = spawn(process.execPath, ["workspace/services/rana_hot_tools/server.js"], {
    cwd: process.cwd(), env: { ...process.env, RANA_HOT_TOOLS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { if (chunk.includes("listening on")) resolve(); });
        child.once("exit", (code) => reject(new Error(`hot-tools exited early (${code}): ${stderr}`)));
      }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("startup timeout")), 5000); timer.unref(); }),
    ]);
    const post = async (query) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory/delete`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, bot_id: "unknown" }),
      });
      return response.json();
    };
    for (const query of ["全部", "所有人的記憶", "清空記憶", "reset memory"]) assert.equal((await post(query)).kind, "memory_bulk_rejected", query);
    assert.equal((await post("測試詞")).kind, "memory_scope_invalid");
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});

test("stable school/class questions route to persona_profile; location and activity questions keep their routing", () => {
  const positives = ["你現在讀哪間學校、哪個年級班級？", "你現在讀哪間學校、幾年級幾班？", "你讀哪間學校、哪個年級？", "你現在是哪個班？",
    "你是幾班？", "你讀哪間學校？", "你現在讀哪間學校？", "你現在幾年級？"];
  for (const text of positives) {
    for (const personaId of ["anon", "rana", "tomori"]) {
      assert.equal(buildUnifiedTurnPlan(text, { personaId }).evidence.source, "persona_profile", `${personaId} ${text}`);
    }
  }
  const untouched = ["你現在在學校嗎？", "你現在在學校還是在家？", "你在教室嗎？", "你現在在哪裡？", "你今天在學校做了什麼？",
    "你現在累嗎？", "你現在是什麼擔當？", "你現在在上課嗎？", "你放學了嗎？"];
  for (const text of untouched) {
    assert.notEqual(buildUnifiedTurnPlan(text, { personaId: "anon" }).evidence.source, "persona_profile", text);
  }
});

test("tool receipts: memory results carry a typed receipt; the generator only receives semantics (no sample sentences)", async () => {
  const event = { agentId: "anon", accountId: "anon" };
  const bulk = await handleMemoryRequest({ action: "forget_bulk", text: "全部" }, event, {}, "");
  assert.deepEqual(bulk.receipt, { action: "FORGET", status: "REFUSED_BULK" });
  const cross = await handleMemoryRequest({ action: "remember_cross", target: "樂奈", text: "X" }, event, {}, "");
  assert.deepEqual(cross.receipt, { action: "REMEMBER", status: "REFUSED_OTHER_PERSONA" });
  const empty = await handleMemoryRequest({ action: "remember", text: "", empty: true }, event, {}, "");
  assert.deepEqual(empty.receipt, { action: "REMEMBER", status: "EMPTY" });
  // Fixed wording is unchanged (fallback path).
  assert.equal(bulk.text, PERSONA_REPLIES.anon.refuseBulkForget);

  for (const key of Object.keys(receiptModule.__test.STATUS_TABLE)) {
    const [action, status] = key.split("/");
    const block = receiptModule.renderToolReceipt({ tool: "rana_memory", action, status });
    assert.match(block, new RegExp(`ACTION=${action}`, "u"), key);
    assert.match(block, new RegExp(`STATUS=${status}`, "u"), key);
    assert.match(block, /OPERATION_ALREADY_EXECUTED_BY_RUNTIME=TRUE/u, key);
    assert.match(block, /TOOL_CALLS=DENY/u, key);
    assert.match(block, /PARENTHETICAL_ROLEPLAY_ACTION=DENY/u, key);
    assert.doesNotMatch(block, /[\u3040-\u30ff\u4e00-\u9fff]/u, `${key}: no natural-language sample text in a receipt`);
  }
  assert.equal(receiptModule.renderToolReceipt({ action: "REMEMBER", status: "NOPE" }), "");
});

test("tool receipts: recorded per persona, consumed once, expire, and never cross personas", () => {
  const anon = { agentId: "anon", accountId: "anon" };
  const taki = { agentId: "taki", accountId: "taki" };
  assert.equal(receiptModule.recordToolReceipt(anon, {}, { action: "REMEMBER", status: "SAVED" }), true);
  assert.equal(receiptModule.consumeToolReceipt(taki, {}), null);
  assert.equal(receiptModule.consumeToolReceipt(anon, {})?.status, "SAVED");
  assert.equal(receiptModule.consumeToolReceipt(anon, {}), null);            // consumed once
  receiptModule.recordToolReceipt(anon, {}, { action: "FORGET", status: "FORGOTTEN" });
  assert.equal(receiptModule.consumeToolReceipt(anon, {}, Date.now() + receiptModule.__test.RECEIPT_TTL_MS + 5_000), null); // expired
  assert.equal(receiptModule.recordToolReceipt({}, {}, { action: "REMEMBER", status: "SAVED" }), false);          // unresolved persona
});

test("tool receipts: the prompt hook injects the receipt for the right persona only, and the flag defaults to off", () => {
  const handlers = [];
  receiptModule.registerToolReceiptContext({ on: (name, handler) => handlers.push([name, handler]) });
  assert.equal(handlers[0][0], "before_prompt_build");
  const anon = { agentId: "anon", accountId: "anon" };
  receiptModule.recordToolReceipt(anon, {}, { tool: "rana_memory", action: "REMEMBER", status: "SAVED" });
  assert.equal(handlers[0][1]({ agentId: "soyo", accountId: "soyo" }, {}), undefined);
  assert.match(handlers[0][1](anon, {}).appendSystemContext, /STATUS=SAVED/u);
  assert.equal(handlers[0][1](anon, {}), undefined);
  const saved = process.env.RANA_TOOL_RECEIPT_VOICE;
  delete process.env.RANA_TOOL_RECEIPT_VOICE;
  try {
    assert.equal(receiptModule.toolReceiptVoiceEnabled(), false);
    process.env.RANA_TOOL_RECEIPT_VOICE = "1";
    assert.equal(receiptModule.toolReceiptVoiceEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.RANA_TOOL_RECEIPT_VOICE; else process.env.RANA_TOOL_RECEIPT_VOICE = saved;
  }
});

test("recall returns the newest matching user memory, not the oldest (isolated copy of hot-tools, no real memory files touched)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rana-recall-"));
  const toolsDir = path.join(tmp, "openclaw", "workspace", "services", "rana_hot_tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.cpSync(path.join(process.cwd(), "workspace", "services", "rana_hot_tools"), toolsDir, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  const port = 19891 + (process.pid % 100);
  const child = spawn(process.execPath, ["server.js"], { cwd: toolsDir, env: { ...process.env, RANA_HOT_TOOLS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { if (chunk.includes("listening on")) resolve(); });
        child.once("exit", (code) => reject(new Error(`hot-tools exited early (${code}): ${stderr}`)));
      }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("startup timeout")), 5000); timer.unref(); }),
    ]);
    const post = async (route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_id: "tomori", ...body }) })).json();
    assert.equal((await post("/memory/remember", { text: "我的測試詞是舊值OLD" })).handled, true);
    assert.equal((await post("/memory/remember", { text: "我的測試詞是新值NEW" })).handled, true);
    const recall = await post("/memory/recall", { query: "我的測試詞" });
    assert.equal(recall.found, true);
    assert.match(recall.item.text, /新值NEW/u, "newest entry must come first");
    assert.match(recall.items[1].text, /舊值OLD/u);
    // The temp tree is the only place anything was written.
    assert.ok(fs.existsSync(path.join(tmp, "openclaw", "workspace-bots", "tomori", "MEMORY.md")));
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("'which school / which class' phrased with 在 is a stable-profile question; 'am I at school now' is not", () => {
  for (const text of ["你現在在哪間學校？", "你在哪間學校？", "你在哪個班級？", "你現在在哪個班？"]) {
    for (const personaId of ["anon", "rana", "taki"]) {
      assert.equal(buildUnifiedTurnPlan(text, { personaId }).evidence.source, "persona_profile", `${personaId} ${text}`);
    }
  }
  for (const text of ["你現在在學校嗎？", "你現在在學校還是在家？", "你在教室嗎？", "你現在在哪裡？", "你現在在哪個教室？", "你現在在哪間學校的教室？"]) {
    assert.notEqual(buildUnifiedTurnPlan(text, { personaId: "anon" }).evidence.source, "persona_profile", text);
  }
});

test("bracket grammar covers conversational physical-contact / emotional turns, never task turns", () => {
  const fn = (isolationModule.__test || isolationModule).resolveParentheticalGrammarExtraBody;
  const sister = { modelProviderId: "llama-cpp-sister", modelId: "GGO-G12B-thinkoff" };
  const oogg = { modelProviderId: "llama-cpp", modelId: "OOGG" };
  const protectedTurns = ["摸摸頭", "抱抱", "親親", "牽手", "陪我一下", "今天好累", "剛剛被主管罵了", "你今天過得怎麼樣", "需要抱抱", "我有點難過", "拍拍我", "摸摸我的頭", "給我一個擁抱"];
  for (const text of protectedTurns) {
    for (const ctx of [sister, oogg]) {
      assert.deepEqual(fn(buildUnifiedTurnPlan(text, { personaId: "anon" }), ctx), { grammar: "root ::= [^（(*＊]*" }, `${ctx.modelProviderId} ${text}`);
    }
  }
  const taskTurns = ["請原樣回覆：foo(bar)", "請原樣回覆這個檔名：a(1).txt", "請幫我算 3*4", "幫我翻譯 hello (world)",
    "這個函式 f(x)=x*(x+1) 怎麼寫", "幫我列出三件事，用（1）（2）（3）標號", "把 (1) 改成 (2)", "給我一個建議"];
  for (const text of taskTurns) {
    assert.equal(fn(buildUnifiedTurnPlan(text, { personaId: "anon" }), sister), undefined, text);
  }
  // Other providers are never constrained, whatever the turn.
  assert.equal(fn(buildUnifiedTurnPlan("摸摸頭", { personaId: "anon" }), { modelProviderId: "google", modelId: "gemini-3.1-flash-lite" }), undefined);
});

test("relationship / event / identity questions that name a canonical entity require evidence; ordinary chat does not", () => {
  const needEvidence = ["睦跟 Mortis 一樣嗎", "祥子是朋友嗎", "誰教你看聊天軟體", "Mortis 的指尖很硬嗎", "是 Mortis 帶你去 SPACE 嗎",
    "你跟睦交換過名字嗎", "你和 Mortis 是怎麼到 SPACE 舊址附近的？", "LAYER 是誰", "你覺得立希是什麼樣的人", "你怎麼看爽世"];
  for (const text of needEvidence) {
    for (const personaId of ["rana", "anon", "taki"]) {
      const evidence = buildUnifiedTurnPlan(text, { personaId }).evidence;
      assert.equal(evidence.required, true, `${personaId} ${text}`);
      assert.equal(evidence.source, "persona_canonical", `${personaId} ${text}`);
    }
  }
  const stayOrdinary = ["今天好累", "摸摸頭", "你今天吃了什麼", "誰叫你不早說", "你覺得今天天氣好嗎", "你餓了嗎", "謝謝你陪我", "需要抱抱", "你的貓可愛嗎", "你在睡覺嗎"];
  for (const text of stayOrdinary) {
    assert.notEqual(buildUnifiedTurnPlan(text, { personaId: "anon" }).evidence.source, "persona_canonical", text);
  }
});

test("R13: 'give me a hug' style imperatives are character-agency requests; deliverable requests stay tasks", () => {
  for (const text of ["給我一個擁抱", "你給我一個擁抱好不好", "請給我一個擁抱", "給我抱抱", "給我一個吻", "可以給我一個擁抱嗎"]) {
    const p = buildUnifiedTurnPlan(text, { personaId: "anon" });
    assert.equal(p.utteranceAct.subtype, "INTERPERSONAL_REQUEST", text);
    assert.equal(p.taskContract.required, false, text);
  }
  for (const text of ["給我一個摘要", "給我一個例子", "給我一個答案", "給我一份報告", "給我一個建議", "給我一個擁抱的英文翻譯", "給我一個吻的英文怎麼說"]) {
    assert.notEqual(buildUnifiedTurnPlan(text, { personaId: "anon" }).utteranceAct.subtype, "INTERPERSONAL_REQUEST", text);
  }
});

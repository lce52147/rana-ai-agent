import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACE = path.join(ROOT, "workspace");
const OPENCLAW_CONFIG = path.join(ROOT, "openclaw.json");
const NATIVE_RUNTIME = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];

function read(relativePath) {
  return readFileSync(path.join(WORKSPACE, relativePath), "utf8");
}

test("Rana text runtime keeps the seven native Core files", () => {
  const manifest = JSON.parse(read("LORE/LORE_MANIFEST.json"));
  const config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
  const heartbeat = config?.agents?.defaults?.heartbeat;
  const heartbeatDisabled = heartbeat?.every === "0m"
    && heartbeat?.includeSystemPromptSection === false;

  assert.deepEqual(manifest.nativeRuntime, NATIVE_RUNTIME);
  for (const file of NATIVE_RUNTIME) {
    const filePath = path.join(WORKSPACE, file);
    assert.equal(existsSync(filePath), true, `${file} must exist`);
    if (file === "HEARTBEAT.md" && heartbeatDisabled) continue;
    assert.ok(read(file).trim(), file);
  }
  assert.equal(existsSync(path.join(WORKSPACE, "BOOTSTRAP.md")), false);
});

test("Core files separate persona, identity, tools, user, and memory", () => {
  const agents = read("AGENTS.md");
  const soul = read("SOUL.md");
  const tools = read("TOOLS.md");
  const identity = read("IDENTITY.md");
  const user = read("USER.md");
  const memory = read("MEMORY.md");

  assert.match(agents, /File responsibilities|Conversation|Speaker and scene grounding/u);
  assert.match(soul, /聲音或吉他細節/u);
  assert.match(identity, /MyGO!!!!! 的吉他手/u);
  assert.match(user, /慣用語言：繁體中文/u);
  assert.match(user, /普通對話中持續成立的互動偏好/u);
  assert.match(memory, /群內設定/u);
  assert.match(tools, /真正的權限.*runtime JS/u);
});

test("workspace guidance no longer contains output schemas or test-shaped answer contracts", () => {
  const core = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].map(read).join("\n");
  assert.doesNotMatch(core, /required_subjects|answer_shape|recognitionLevel|memoryAnchors|sourceRefs|每句只寫一個人|輸出句數必須|mode=known/u);
  assert.doesNotMatch(core, /llama-cpp|Gemini|providerOverride/u);
});

test("AGENTS does not duplicate canonical alias lists or fixed reply examples", () => {
  const agents = read("AGENTS.md");
  assert.doesNotMatch(agents, /祐天寺若麥[\s\S]*喵夢[\s\S]*Nyamu/u);
  assert.doesNotMatch(agents, /逢床.*什麼？/u);
  assert.doesNotMatch(agents, /早.*早。/u);
});

test("SOUL keeps variable-length natural speech instead of a fixed sentence count", () => {
  const soul = read("SOUL.md");
  assert.match(soul, /長短.*不是固定字數/u);
  assert.match(soul, /話可以很短.*多說幾句/u);
  assert.doesNotMatch(soul, /1[–-]3|一到兩句|每句只能/u);
});

test("TOOLS matches the strict explicit US-stock gate", () => {
  const tools = read("TOOLS.md");
  assert.match(tools, /美股.*美國股市.*US stock.*NYSE.*NASDAQ/u);
  assert.match(tools, /ticker.*全市場掃描/u);
  assert.match(tools, /普通商品.*不能轉成股票請求/u);
});

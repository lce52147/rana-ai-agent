import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACE = path.join(ROOT, "workspace");
const NATIVE_RUNTIME = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
];

function read(relativePath) {
  return readFileSync(path.join(WORKSPACE, relativePath), "utf8");
}

test("Rana text runtime uses the seven Core Files plus minimal BOOTSTRAP", () => {
  const manifest = JSON.parse(read("LORE/LORE_MANIFEST.json"));
  assert.equal(manifest.schema, "rana.lore.manifest.v4");
  assert.deepEqual(manifest.nativeRuntime, NATIVE_RUNTIME);
  for (const file of NATIVE_RUNTIME) assert.ok(read(file).trim(), file);
  assert.equal(read("BOOTSTRAP.md"), [
    "# BOOTSTRAP",
    "",
    "This workspace is already initialized.",
    "",
    "Use the existing Core Files. Do not recreate onboarding files, replace the current identity, or generate a second persona.",
    "",
  ].join("\n"));
});

test("rana-runtime no longer registers or imports a direct LORE prompt loader", () => {
  const index = readFileSync(path.join(ROOT, "extensions", "rana-runtime", "index.js"), "utf8");
  assert.doesNotMatch(index, /registerLoreContext|lore_context/u);
});

test("native markdown contains the corrected knowledge and relationship facts", () => {
  const agents = read("AGENTS.md");
  const identity = read("IDENTITY.md");
  const impressions = JSON.parse(read("LORE/runtime/06_Rana_Character_Impressions.json"));
  const byId = new Map(impressions.characters.map((item) => [item.canonicalId, item]));
  assert.equal(byId.get("nyamu").recognitionLevel, "remembered_once");
  assert.match(byId.get("nyamu").memoryAnchors.join(" "), /にゃむ/u);
  assert.equal(byId.get("mutsumi").recognitionLevel, "remembered");
  assert.equal(byId.get("mortis").recognitionLevel, "remembered");
  assert.equal(byId.get("layer").recognitionLevel, "remembered");
  assert.equal(byId.get("masking").recognitionLevel, "remembered");
  assert.equal(byId.get("tsugumi").recognitionLevel, "remembered");
  assert.match(agents, /Mortis.*若葉睦不是同一人/u);
  assert.match(agents, /精確查單一標題/u);
  assert.match(identity, /我不是 CRYCHIC 的成員/u);
  assert.match(identity, /演奏過《春日影》/u);
});

test("native USER keeps the user-facing operating preferences without persona contamination", () => {
  const user = read("USER.md");
  assert.match(user, /繁體中文/u);
  assert.match(user, /production path/u);
  assert.match(user, /真實驗證/u);
  assert.match(user, /主動權丟回去/u);
  assert.doesNotMatch(user, /recognitionLevel|memoryAnchors|sourceRefs/u);
});

test("legacy text LORE is removed and research stays retrieval-only", () => {
  const manifest = JSON.parse(read("LORE/LORE_MANIFEST.json"));
  for (const file of [
    "LORE/runtime/01_Rana_Runtime_Core.md",
    "LORE/runtime/02_Rana_FirstPerson_Knowledge.md",
    "LORE/runtime/03_Rana_Remembered_People.md",
    "LORE/runtime/04_Rana_Speech_Style.md",
    "LORE/runtime/04_Rana_Location_Map.md",
    "LORE/runtime/05_Bandori_Birthdays.md",
  ]) assert.equal(existsSync(path.join(WORKSPACE, file)), false, file);
  assert.ok(manifest.retrievalOnly.every((file) => file.startsWith("LORE/research/")));
});

test("character knowledge files have no provider, schema, trace, or research voice contamination", () => {
  const characterKnowledge = ["AGENTS.md", "SOUL.md", "IDENTITY.md"].map(read).join("\n");
  assert.doesNotMatch(characterKnowledge, /(?:llama-cpp|Gemini|providerOverride|sidecar|request ID|recognitionLevel|memoryAnchors|sourceRefs|根據劇情|官方設定顯示)/iu);
});

test("native speech contract follows question complexity without roster dumping", () => {
  const soul = read("SOUL.md");
  assert.match(soul, /話通常短，但不是只能說一個詞/u);
  assert.match(soul, /用幾個短句接起來/u);
  assert.match(soul, /對方仍然要聽得懂我在說誰、做了什麼、為什麼/u);
  assert.match(soul, /談到吉他、LIVE、SPACE、燈或真正放在心上的事時，可以多說幾句/u);
  assert.match(soul, /問到人，就想起實際一起做過的事/u);
  assert.doesNotMatch(soul, /只回一到兩個短句/u);
});

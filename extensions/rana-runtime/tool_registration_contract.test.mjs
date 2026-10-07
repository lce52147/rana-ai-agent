import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("./", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

test("runtime manifest and source register the controlled Rana tools", async () => {
  const manifest = await readJson("openclaw.plugin.json");
  assert.deepEqual(manifest.contracts?.tools, [
    "rana_memory",
    "rana_lore_search",
    "rana_stock_research",
    "persona_relationship_search",
    "persona_lore_search",
  ]);

  const indexSource = await readText("index.js");
  assert.match(indexSource, /registerMemoryTool\(api\)/u);
  assert.match(indexSource, /registerLoreGuidance\(api\)/u);
  assert.match(indexSource, /registerStockTool\(api\)/u);
});

test("runtime does not declare unrelated music, vision, or web tools as its own", async () => {
  const manifest = await readJson("openclaw.plugin.json");
  const declared = new Set(manifest.contracts?.tools || []);
  for (const tool of [
    "rana_play_music",
    "rana_analyze_image",
    "ollama_web_search",
    "ollama_web_fetch",
  ]) {
    assert.equal(declared.has(tool), false, tool);
  }
});

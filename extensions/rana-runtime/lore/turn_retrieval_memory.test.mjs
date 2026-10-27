import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rana-memory-retrieval-"));
process.env.RANA_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");
const { insertMemory, closeMemoryStore, MEMORY_AVAILABLE } = await import("../memory/store.js");
const { retrieveTurnContext } = await import("./turn_retrieval.js");

test("a 「X是誰」 question still sees the user's saved memory about X", { skip: !MEMORY_AVAILABLE }, async () => {
  assert.equal(insertMemory({ bot_id: "rana", user_id: "u-memory-test", kind: "fact", content: "阿光是吉他社的學長", source: "explicit", confidence: 1 }).ok, true);
  const result = await retrieveTurnContext({ personaId: "rana", query: "阿光是誰", userId: "u-memory-test" });
  assert.ok(result.trace.memorySelected.length === 1, JSON.stringify(result.trace.candidates));
  assert.match(result.text, /阿光是吉他社的學長/u);
  const other = await retrieveTurnContext({ personaId: "rana", query: "阿光是誰", userId: "u-other" });
  assert.doesNotMatch(other.text, /阿光是吉他社的學長/u);
  closeMemoryStore();
});

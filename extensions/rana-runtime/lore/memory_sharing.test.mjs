import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rana-shared-memory-"));
process.env.RANA_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");

// A database created before author_id existed.
const old = new DatabaseSync(process.env.RANA_MEMORY_DB_PATH);
old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, ts INTEGER NOT NULL, source_message_id TEXT, source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, superseded_by TEXT, embedding_hash TEXT);
  INSERT INTO memories VALUES ('old-1', 'rana', 'u-old', 'fact', '', '喜歡貓', 1, NULL, 'explicit', 1, NULL, NULL);`);
old.close();

const { insertMemory, listMemories, isSelfMemoryText, closeMemoryStore } = await import("../memory/store.js");

test("memories about the speaker are personal, everything else is shared", () => {
  assert.equal(isSelfMemoryText("我喜歡抹茶"), true);
  assert.equal(isSelfMemoryText("我的生日是三月"), true);
  assert.equal(isSelfMemoryText("my birthday is in March"), true);
  assert.equal(isSelfMemoryText("阿光是吉他社的學長"), false);
  assert.equal(isSelfMemoryText("我們伺服器的吉祥物是貓"), false);
});

test("an old database gains author_id, backfilled from user_id", () => {
  const rows = listMemories({ botId: "rana", userId: "u-old" });
  assert.equal(rows.find((row) => row.id === "old-1").author_id, "u-old");
});

test("a shared memory is visible to everyone and still records who taught it", () => {
  const saved = insertMemory({ bot_id: "rana", user_id: null, author_id: "u-teacher", kind: "fact", content: "阿光是吉他社的學長", source: "explicit", confidence: 1 });
  assert.equal(saved.ok, true);
  assert.equal(saved.item.author_id, "u-teacher");
  assert.equal(saved.item.user_id, null);
  assert.ok(listMemories({ botId: "rana", userId: "u-someone-else" }).some((row) => row.content === "阿光是吉他社的學長"));
  const personal = insertMemory({ bot_id: "rana", user_id: "u-teacher", kind: "preference", content: "我喜歡抹茶", source: "explicit" });
  assert.equal(personal.item.author_id, "u-teacher");
  assert.ok(!listMemories({ botId: "rana", userId: "u-someone-else" }).some((row) => row.content === "我喜歡抹茶"));
  closeMemoryStore();
});

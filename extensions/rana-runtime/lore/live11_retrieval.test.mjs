import assert from "node:assert/strict";
import { test } from "node:test";
import { retrieveTurnContext } from "./turn_retrieval.js";

test("controlled event rendering rejects unsupported question premises", async () => {
  const result = await retrieveTurnContext({
    personaId: "rana",
    query: "愛音衣服沾上葉子那回，妳拿那片葉子做了什麼？",
    sessionKey: "live11-premise",
  });
  assert.ok(result.entries.some((entry) => entry.kind === "relation_event" || entry.kind === "fact"));
  assert.match(result.text, /If the user's question assumes a detail the entries do not contain or contradict, answer with what the entries say instead of confirming the assumption\./u);
});

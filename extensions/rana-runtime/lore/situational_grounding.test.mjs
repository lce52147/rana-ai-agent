import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolutionKey } from "./guidance.js";
import { shouldRetrieveLore } from "./retrieval.js";

test("identity corrections and observation reports stay ordinary conversation", () => {
  for (const text of [
    "是立希",
    "是愛音",
    "是睦",
    "是外婆",
    "那個人是小明",
    "不是立希，是愛音",
    "我看到爽世了",
    "我碰到一個不在角色表的人",
    "你看，是立希",
  ]) {
    assert.equal(shouldRetrieveLore(text), false, text);
  }
});

test("explicit character knowledge questions still retrieve LORE", () => {
  for (const text of [
    "立希是誰？",
    "愛音和樂奈有什麼互動？",
    "睦跟 Mortis 是同一個人嗎？",
    "外婆是誰？",
    "爽世生日是什麼時候？",
    "喵夢和樂奈的直接互動來源在哪？",
  ]) {
    assert.equal(shouldRetrieveLore(text), true, text);
  }
});

test("pronoun state is scoped by session and sender", () => {
  const promptA = 'Conversation info: {"sender_id":"111111111111111111"}';
  const promptB = 'Conversation info: {"sender_id":"222222222222222222"}';
  const ctx = { sessionKey: "agent:main:discord:channel:123" };
  assert.equal(resolutionKey(promptA, ctx), "agent:main:discord:channel:123|user:111111111111111111");
  assert.equal(resolutionKey(promptB, ctx), "agent:main:discord:channel:123|user:222222222222222222");
});

test("runtime contains no situational reply template or system prompt replacement", () => {
  const source = readFileSync(new URL("./guidance.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /classifySituationalEntityTurn|compactSituationalSystemPrompt|required_action|ask_location/u);
  assert.doesNotMatch(source, /systemPrompt\s*:/u);
});

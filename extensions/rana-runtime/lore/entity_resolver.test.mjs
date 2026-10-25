import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEntityMentions } from "./entity_resolver.js";

const names = (text) => resolveEntityMentions(text).map((item) => item.canonical_name);

test("short aliases require a usable boundary and preserve vocative forms", () => {
  for (const text of [
    "燈光好暗喔",
    "燈泡又壞了",
    "野貓又來了",
    "小希望你今天開心",
    "小愛心送你",
    "電燈壞了",
    "那隻野貓很黏人",
  ]) assert.deepEqual(names(text), [], text);

  for (const [text, expected] of [
    ["你和愛音是什麼關係？", "千早愛音"],
    ["小希今天有來嗎", "椎名立希"],
    ["燈ちゃん呢", "高松燈"],
    ["あのちゃん最近怎樣", "千早愛音"],
    ["樂奈醬在哪", "要樂奈"],
    ["野貓，過來", "要樂奈"],
  ]) assert.deepEqual(names(text), [expected], text);
});

test("contextual aliases 燈 and 野貓 name a person only with a person cue", () => {
  for (const text of [
    "燈有點暗",
    "燈還亮著",
    "燈沒關",
    "燈今天很暗",
    "野貓在叫",
    "野貓有來",
  ]) assert.deepEqual(names(text), [], text);

  for (const [text, expected] of [
    ["燈呢？", ["高松燈"]],
    ["你認識燈嗎", ["高松燈"]],
    ["燈酱今天呢", ["高松燈"]],
    ["高松燈今天有來嗎", ["高松燈"]],
    ["燈和愛音", ["高松燈", "千早愛音"]],
    ["愛音和燈有什麼互動", ["高松燈", "千早愛音"]],
  ]) assert.deepEqual(names(text), expected, text);
});

// Regression from the 2026-10-15 sister live run: two-character names followed
// by an ordinary word (爽世平常, 立希排練) and 燈 inside a relation question were
// dropped, so no relation events reached the prompt.
test("names followed by ordinary words still resolve; 燈 compounds do not", () => {
  for (const [text, expected] of [
    ["爽世平常都在做什麼？", ["長崎爽世"]],
    ["愛音平時怎麼樣？", ["千早愛音"]],
    ["立希排練的時候兇嗎？", ["椎名立希"]],
    ["燈平常會寫歌嗎？", ["高松燈"]],
    ["和燈相處時有沒有哪件事你記得？", ["高松燈"]],
    ["你和燈平常如何一起練習？", ["高松燈"]],
    ["小樂陪燈寫歌", ["要樂奈", "高松燈"]],
    ["爽世跟燈在團裡怎麼互動？", ["高松燈", "長崎爽世"]],
    ["妳買飲料給燈後，最後弄清楚什麼？", ["高松燈"]],
    ["妳跟燈說了什麼？", ["高松燈"]],
    ["燈ちゃん後來怎麼了？", ["高松燈"]],
  ]) assert.deepEqual(names(text), expected, text);

  for (const text of [
    "燈光很亮，大家一起看",
    "燈泡壞了，一起去買",
  ]) assert.deepEqual(names(text), [], text);
});

test("contextual aliases resolve relation-object continuations", () => {
  for (const [text, expected] of [
    ["給燈後", ["高松燈"]],
    ["跟燈說", ["高松燈"]],
    ["燈ちゃん", ["高松燈"]],
  ]) assert.deepEqual(names(text), expected, text);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentTurnToolAuthorized,
  parseMusicCommand,
  parseMusicControlCommand,
  resolveCurrentTurnToolSurface,
} from "./current_turn_tool_contract.js";
import { parseControlRequest, parsePlayRequest } from "./tool_contracts.js";

const MUSIC = [
  "rana_play_music",
  "rana_stop_music",
  "rana_show_queue",
  "rana_skip_music",
  "rana_volume_music",
  "rana_join_voice",
  "rana_leave_voice",
];

function allowed(text) {
  return resolveCurrentTurnToolSurface({
    text,
    toolNames: ["read", ...MUSIC],
  }).allowedToolNames;
}

test("Chinese 播放 accepts natural no-space form without broadening English play", () => {
  assert.deepEqual(parseMusicCommand("@樂奈 播放DJ小慌"), { target: "DJ小慌" });
  assert.deepEqual(parseMusicCommand("@樂奈 播放 aizo"), { target: "aizo" });
  assert.deepEqual(parseMusicCommand("@樂奈 play aizo"), { target: "aizo" });
  assert.equal(parseMusicCommand("@樂奈 player aizo"), null);
  assert.equal(parseMusicCommand("春日影這首歌的歌名很有感覺。"), null);
  assert.deepEqual(parsePlayRequest({ body: "@樂奈 播放DJ小慌" }), {
    url: null,
    query: "DJ小慌",
    display: "DJ小慌",
    source: "youtube",
  });
});

test("natural control forms are canonical and do not fall through to the model", () => {
  const cases = [
    ["@樂奈 現在還有哪些歌", { kind: "queue" }],
    ["@樂奈 下一首是什麼？", { kind: "next" }],
    ["@樂奈 停止", { kind: "stop" }],
    ["@樂奈 停止播放", { kind: "stop" }],
    ["@樂奈 跳過", { kind: "skip", query: null }],
    ["@樂奈 音量 35", { kind: "volume", volume: 35 }],
    ["@樂奈 進來我這個頻道", { kind: "join" }],
    ["@樂奈 離開這個頻道", { kind: "leave" }],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(parseMusicControlCommand(text), expected, text);
    assert.deepEqual(parseControlRequest({ body: text }), expected, text);
  }

  for (const text of [
    "我覺得下一首歌的歌詞比較好",
    "停止討論播放工具",
    "volume 這個單字是什麼",
    "春日影這首歌的歌名很有感覺。",
  ]) {
    assert.equal(parseMusicControlCommand(text), null, text);
  }
});

test("turn-scoped surface exposes only the exact music tool needed", () => {
  assert.deepEqual(allowed("春日影這首歌的歌名很有感覺。"), ["read"]);
  assert.deepEqual(allowed("播放DJ小慌"), ["read", "rana_play_music"]);
  assert.deepEqual(allowed("現在還有哪些歌"), ["read", "rana_show_queue"]);
  assert.deepEqual(allowed("下一首是什麼？"), ["read", "rana_show_queue"]);
  assert.deepEqual(allowed("跳過"), ["read", "rana_skip_music"]);
  assert.deepEqual(allowed("停止"), ["read", "rana_stop_music"]);
  assert.deepEqual(allowed("音量 35"), ["read", "rana_volume_music"]);
  assert.deepEqual(allowed("進來"), ["read", "rana_join_voice"]);
  assert.deepEqual(allowed("離開"), ["read", "rana_leave_voice"]);
});

test("execution authorization uses the same canonical current-turn grammar", () => {
  const cases = [
    ["rana_play_music", "播放DJ小慌", true],
    ["rana_play_music", "DJ小慌", false],
    ["rana_show_queue", "現在還有哪些歌", true],
    ["rana_skip_music", "跳過", true],
    ["rana_stop_music", "停止", true],
    ["rana_volume_music", "音量 35", true],
    ["rana_join_voice", "進來", true],
    ["rana_leave_voice", "離開", true],
    ["rana_stop_music", "跳過", false],
    ["rana_skip_music", "停止", false],
  ];
  for (const [toolName, text, expected] of cases) {
    assert.equal(isCurrentTurnToolAuthorized({ toolName, text }), expected, `${toolName}: ${text}`);
  }
});

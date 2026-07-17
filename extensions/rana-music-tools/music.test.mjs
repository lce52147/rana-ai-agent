import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import musicPlugin, { __test } from "./index.js";

test("music plugin registers only music and voice tools", () => {
  const names = [];
  musicPlugin.register({
    config: {},
    registerTool(tool) { names.push(tool.name); },
  });
  assert.deepEqual(names.sort(), [
    "rana_join_voice",
    "rana_leave_voice",
    "rana_play_music",
    "rana_show_queue",
    "rana_skip_music",
    "rana_stop_music",
    "rana_volume_music",
  ]);
});

test("music plugin source does not load Vision", async () => {
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /rana-vision|Vision|rana_analyze_image/);
});

test("playback evidence requires a real playback or queue state", () => {
  assert.equal(__test.hasPlaybackEvidence({ status: "error" }), false);
  assert.equal(__test.hasPlaybackEvidence({ queued: 0 }), false);
  assert.equal(__test.hasPlaybackEvidence({ queued: 2 }), true);
  assert.equal(__test.hasPlaybackEvidence({ current: { title: "song" } }), true);
});

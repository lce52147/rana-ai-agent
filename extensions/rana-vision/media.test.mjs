import assert from "node:assert/strict";
import { test } from "node:test";
import { __test as mediaTest } from "./media.js";

test("direct Discord media attachments route to the media pipeline", () => {
  const prompt = [
    "Conversation info",
    "@Rana 這個影片在做什麼？",
    "[media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\sample.mp4 (video/mp4)]",
  ].join("\n");
  assert.equal(
    mediaTest.directMediaAttachment(prompt),
    "C:\\Users\\Administrator\\.openclaw\\media\\inbound\\sample.mp4",
  );
  assert.match(mediaTest.userQuestion(prompt), /這個影片在做什麼/u);
});

test("replied video messages use only the referenced Discord message", () => {
  const prompt = [
    '"chat_id": "channel:1495319712370917396"',
    '"reply_to_id": "1526807589537579039"',
    '"has_reply_context": true',
    "@Rana 這段在演什麼？",
  ].join("\n");
  assert.deepEqual(mediaTest.replyReference(prompt), {
    channel: "1495319712370917396",
    message: "1526807589537579039",
  });
});

test("media payload keeps transcript and visual observations separate", () => {
  const payload = mediaTest.compactPayload({
    status: "ok",
    kind: "video",
    source: "sample.mp4",
    transcript: { status: "ok", language: "ja", text: "測試台詞", segments: [] },
  }, [{
    index: 1,
    source: "grid_01.jpg",
    status: "ok",
    observation: { summary: "a band performing on stage" },
  }], "media-test", "這是什麼影片？");
  assert.equal(payload.transcript.text, "測試台詞");
  assert.equal(payload.visualObservations[0].observation.summary, "a band performing on stage");
});

test("media context is readable and forbids cross-fabrication", () => {
  const context = mediaTest.mediaContext({
    schema: "rana.media.understanding.v1",
    visualObservations: [],
    transcript: { status: "unavailable" },
  });
  assert.match(context, /影片畫面只能依 visualObservations/);
  assert.match(context, /語音或字幕只能依 transcript/);
  assert.match(context, /不要猜人物、事件、台詞或聲音/);
  assert.doesNotMatch(context, /\uFFFD/);
});

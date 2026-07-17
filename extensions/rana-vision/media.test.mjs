import assert from "node:assert/strict";
import { test } from "node:test";
import { __test as mediaTest, buildMediaEvidenceContext } from "./media.js";

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

test("audio attachments produce a strict unsupported result", async () => {
  const prompt = "[media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\sample.wav (audio/wav)]";
  assert.equal(mediaTest.directMediaAttachment(prompt), "");
  assert.equal(mediaTest.hasAudioAttachment(prompt), true);
  const result = mediaTest.unsupportedAudioContext(prompt, "audio-test");
  assert.equal(result.payload.status, "unsupported");
  assert.equal(result.payload.responseContract.doNotGuessAudioContent, true);
  assert.match(result.context, /目前沒有音訊理解模型/);
  assert.match(result.context, /不要猜語音、歌曲、人物、事件或環境聲/);
  const built = await buildMediaEvidenceContext(prompt, { requestId: "audio-test-live" });
  assert.equal(built.payload.status, "unsupported");
});

test("media payload contains visuals but does not claim audio understanding", () => {
  const payload = mediaTest.compactPayload({
    status: "ok",
    kind: "video",
    source: "sample.mp4",
  }, [{
    index: 1,
    source: "grid_01.jpg",
    status: "ok",
    observation: { summary: "a band performing on stage" },
  }], "media-test", "這是什麼影片？");
  assert.equal(payload.visualObservations[0].observation.summary, "a band performing on stage");
  assert.equal("transcript" in payload, false);
  assert.equal(payload.responseContract.doNotClaimAudioUnderstanding, true);
});

test("media context is readable and forbids cross-fabrication", () => {
  const context = mediaTest.mediaContext({
    schema: "rana.media.understanding.v1",
    visualObservations: [],
  });
  assert.match(context, /影片只能依 visualObservations/);
  assert.match(context, /沒有音訊理解/);
  assert.match(context, /不得描述聲音、語音或台詞/);
  assert.doesNotMatch(context, /\uFFFD/);
});

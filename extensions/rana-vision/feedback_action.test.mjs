import assert from "node:assert/strict";
import { test } from "node:test";
import { runVisionFeedbackAction, __test } from "./feedback_action.js";

const pending = {
  requestId: "feedback-test",
  channelId: "1495319712370917396",
  sourceMessageId: "1527277262976847977",
};

test("retry re-runs image identity from the original Discord message", async () => {
  let prompt = "";
  const reply = await runVisionFeedbackAction(pending, "retry", {
    buildImage: async (value) => {
      prompt = value;
      return {
        payload: {
          imageUnderstanding: {
            summary: "粉紅色長髮、戴眼鏡的人握著拳。",
            visibleText: [],
            primaryCharacter: {
              canonicalId: "anon",
              canonicalName: "千早愛音",
              confidence: "high",
            },
          },
          ranaCharacterImpression: {
            recognitionLevel: "core",
            memoryAnchors: ["MyGO!!!!! 的團員"],
          },
        },
      };
    },
  });
  assert.match(prompt, /"reply_to_id": "1527277262976847977"/);
  assert.equal(reply, "千早愛音。MyGO!!!!! 的團員");
});

test("describe uses visible evidence and never adds an identity", async () => {
  const reply = await runVisionFeedbackAction(pending, "describe", {
    buildImage: async () => ({
      payload: {
        imageUnderstanding: {
          summary: "粉紅色長髮、戴眼鏡的人握著拳。",
          visibleText: ["LIVE"],
          primaryCharacter: {
            canonicalId: "anon",
            canonicalName: "千早愛音",
            confidence: "high",
          },
        },
      },
    }),
  });
  assert.equal(reply, "粉紅色長髮、戴眼鏡的人握著拳。\n看得到的文字：LIVE");
  assert.doesNotMatch(reply, /千早愛音/);
});

test("description hides generated frame and grid labels", () => {
  assert.equal(
    __test.shortDescription("一個人握著拳。", ["frame_001.jpg", "grid_01.jpg", "LIVE"]),
    "一個人握著拳。\n看得到的文字：LIVE",
  );
});

test("video retry uses the independently resolved keyframe identity", async () => {
  const reply = await runVisionFeedbackAction(pending, "retry", {
    buildImage: async () => null,
    buildMedia: async (_prompt, options) => {
      assert.equal(options.resolveIdentity, true);
      return {
        payload: {
          kind: "video",
          visualObservations: [{
            observation: {
              summary: "粉紅色長髮、戴眼鏡的人握著拳。",
              visible_text: [],
            },
          }],
          characterIdentity: {
            primaryCharacter: {
              canonicalId: "anon",
              canonicalName: "千早愛音",
              confidence: "high",
            },
            impression: {
              recognitionLevel: "core",
              memoryAnchors: [],
            },
          },
        },
      };
    },
  });
  assert.equal(reply, "千早愛音。");
});

test("unknown retry remains unknown and includes only the description", () => {
  assert.equal(
    __test.identityReply(null, null, "一個人站在舞台上。"),
    "重新看過了，還是不知道是誰。\n一個人站在舞台上。",
  );
});

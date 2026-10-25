import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { leanPromptText, modelFacingContext } from "./architecture/lean_prompt.js";
import { activeCurrentEvents, currentEventsContext } from "./lore/current_events.js";
import { wantsCurrentEvents } from "./architecture/turn_context_projection.js";
import { buildUnifiedTurnPlan } from "./architecture/turn_plan.js";
import { parseEventList, parseJapaneseDates } from "../../scripts/fetch_current_events.mjs";

test("lean prompt keeps instructions and drops bare policy atoms", () => {
  const source = [
    "TURN CONTEXT — R3_COMPILED_CONTRACT (deterministic runtime contract; not dialogue):",
    "UTTERANCE_ACT=QUESTION",
    "RESPONSE_RIGHTS.YES_NO_ASSERTION=DENY",
    "FINAL_FORBIDDEN=FABRICATED_RECENT_EVENT|STATE_CAUSE",
    "FINAL_BOUNDARY_TEXT=Answer in general terms and do not invent a recent event.",
    "PAIR_1_TARGET_CHARACTER_IDENTITY=椎名立希",
    "PAIR_1_PREFERRED_VOCATIVE=りっきー",
    "HINTS_JSON=[\"先說當下真正想說的內容\",\"喜歡或討厭直接表達\"]",
    "TURN_MODE_cat-interest_GUIDANCE=貓是樂奈真正會被吸引的東西，直接反應。",
    "Plain instruction line stays.",
    "Plain instruction line stays.",
  ].join("\n");
  const lean = leanPromptText(source);
  assert.match(lean, /^Answer in general terms and do not invent a recent event\.$/mu);
  assert.match(lean, /直接叫椎名立希時用「りっきー」。/u);
  assert.match(lean, /^- 先說當下真正想說的內容$/mu);
  assert.match(lean, /^貓是樂奈真正會被吸引的東西/mu);
  assert.equal(lean.match(/Plain instruction line stays\./gu).length, 1);
  assert.doesNotMatch(lean, /=|DENY|R3_COMPILED_CONTRACT|FABRICATED_RECENT_EVENT/u);
});

test("legacy prompt mode passes the context through unchanged", () => {
  const previous = process.env.RANA_PROMPT_MODE;
  process.env.RANA_PROMPT_MODE = "legacy";
  try {
    assert.equal(modelFacingContext("A=B\nUTTERANCE_ACT=QUESTION"), "A=B\nUTTERANCE_ACT=QUESTION");
  } finally {
    if (previous === undefined) delete process.env.RANA_PROMPT_MODE;
    else process.env.RANA_PROMPT_MODE = previous;
  }
});

test("bang-dream.com event dates parse, including multi-day and cross-year", () => {
  assert.deepEqual(parseJapaneseDates("2026年11月14日(土)・15日(日)"), { start: "2026-11-14", end: "2026-11-15" });
  assert.deepEqual(parseJapaneseDates("2026年10月25日(日)"), { start: "2026-10-25", end: "2026-10-25" });
  assert.deepEqual(parseJapaneseDates("2026年12月30日(火)～2027年1月5日(月)"), { start: "2026-12-30", end: "2027-01-05" });
  assert.equal(parseJapaneseDates("未定"), null);
});

test("bang-dream.com event list parses title, place and artists", () => {
  const html = `<article class="p-live-event-list__item"><a href="https://bang-dream.com/events/mygo_9th_hyogo">
    <div class="p-live-event-list__item-category">ライブ</div>
    <div class="p-live-event-list__item-title">MyGO!!!!! 9th LIVE</div>
    <div class="item-date"><h2>開催日</h2> <p>2026年11月14日(土)・15日(日)</p></div>
    <div class="item-place"><h2>場所</h2> <p>ワールド記念ホール</p></div>
    <span class="item-artist-item">MyGO!!!!!</span></a></article>`;
  const [item] = parseEventList(html);
  assert.equal(item.id, "mygo_9th_hyogo");
  assert.equal(item.title, "MyGO!!!!! 9th LIVE");
  assert.equal(item.place, "ワールド記念ホール");
  assert.deepEqual(item.artists, ["MyGO!!!!!"]);
  assert.equal(item.start, "2026-11-14");
});

function eventsFile(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rana-events-"));
  const file = path.join(dir, "current_events.json");
  fs.writeFileSync(file, JSON.stringify({ events }), "utf8");
  return file;
}

test("only confirmed events inside the window are shown, with timing", () => {
  const dataPath = eventsFile([
    { id: "a", title: "MyGO!!!!! 9th LIVE", start: "2026-11-14", end: "2026-11-15", place: "ワールド記念ホール", status: "confirmed" },
    { id: "b", title: "Pending fair", start: "2026-10-25", end: "2026-10-25", status: "pending" },
    { id: "c", title: "Old live", start: "2026-08-01", end: "2026-08-01", status: "confirmed" },
    { id: "d", title: "Far future", start: "2027-06-01", end: "2027-06-01", status: "confirmed" },
  ]);
  const now = Date.parse("2026-10-15T12:00:00+09:00");
  const active = activeCurrentEvents({ now, dataPath });
  assert.deepEqual(active.map((item) => item.event.id), ["a"]);
  assert.match(active[0].when, /還有 30 天/u);
  const during = activeCurrentEvents({ now: Date.parse("2026-11-15T12:00:00+09:00"), dataPath });
  assert.equal(during[0].when, "正在舉行");
  const after = activeCurrentEvents({ now: Date.parse("2026-11-20T12:00:00+09:00"), dataPath });
  assert.match(after[0].when, /已經結束/u);
  const context = currentEventsContext({ now, dataPath });
  assert.match(context, /2026-11-14～2026-11-15｜MyGO!!!!! 9th LIVE｜ワールド記念ホール｜還有 30 天/u);
  assert.doesNotMatch(context, /Pending fair|Old live|Far future/u);
});

test("with no confirmed events the block neither claims nor denies activities", () => {
  const context = currentEventsContext({ dataPath: eventsFile([]) });
  assert.doesNotMatch(context, /現況（現實中官方公布的行程）|目前沒有/u);
  assert.match(context, /不要說有或沒有活動/u);
  assert.match(context, /用這個角色平常的口吻概括近況/u);
});

test("a recent practice question with a member gets the band status block", () => {
  const plan = { ...buildUnifiedTurnPlan("最近跟立希一起練習，妳覺得進展怎麼樣？", { personaId: "rana" }), currentUser: "最近跟立希一起練習，妳覺得進展怎麼樣？" };
  assert.equal(wantsCurrentEvents(plan), true);
});

test("current events are attached only to how-is-it-going-now questions", () => {
  const plan = (text) => ({ ...buildUnifiedTurnPlan(text, { personaId: "rana" }), currentUser: text });
  assert.equal(wantsCurrentEvents(plan("妳最近和立希練習順利嗎？")), true);
  assert.equal(wantsCurrentEvents(plan("最近樂團還順利嗎？")), true);
  assert.equal(wantsCurrentEvents(plan("@愛音 這陣子愛音自己都在忙什麼？")), false);
  assert.equal(wantsCurrentEvents(plan("我旁邊有隻貓在睡覺")), false);
  assert.equal(wantsCurrentEvents(plan("燈是怎樣的人？")), false);
});

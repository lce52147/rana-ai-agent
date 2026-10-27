import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openParfaitLedger, parfaitConfig, dayKey, countedChars } = require("./parfait_ledger.js");

const config = parfaitConfig({});
// 2026-10-26 12:00 Taipei = 04:00Z
const NOON = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function ledger() {
  return openParfaitLedger({ dbPath: ":memory:" });
}

test("day key follows Taipei midnight, not UTC", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 25, 15, 59, 0)), "2026-10-25");
  assert.equal(dayKey(Date.UTC(2026, 9, 25, 16, 0, 0)), "2026-10-26");
});

test("mentions, links, emoji and punctuation do not count toward the 5-character minimum", () => {
  assert.equal(countedChars("<@123456789012345678> 好！！ https://x.y/z 😀"), 1);
  assert.equal(countedChars("今天好累喔"), 5);
});

test("a new user starts with 3 cups and a booster starts with 6 plus the one-time bonus", () => {
  const l = ledger();
  assert.equal(l.balance("u1", { now: NOON, config }).balance, 3);
  const booster = l.balance("b1", { booster: true, now: NOON, config });
  assert.equal(booster.balance, 16);
  assert.equal(booster.cap, 60);
  // The bonus is given once only.
  assert.equal(l.balance("b1", { booster: true, now: NOON + 1000, config }).balance, 16);
});

test("a user who starts boosting later gets the bonus once and the higher cap", () => {
  const l = ledger();
  l.balance("u1", { booster: false, now: NOON, config });
  const after = l.balance("u1", { booster: true, now: NOON + 1000, config });
  assert.equal(after.balance, 13);
  assert.equal(after.cap, 60);
});

test("only the first message of 5+ characters each day earns a cup", () => {
  const l = ledger();
  assert.equal(l.recordText("u1", { text: "嗨", now: NOON, config }).counted, false);
  const first = l.recordText("u1", { text: "今天好累喔", now: NOON, config });
  assert.equal(first.granted, 1);
  assert.equal(first.balance, 4);
  const second = l.recordText("u1", { text: "再說一句話好了", now: NOON + 60_000, config });
  assert.equal(second.granted, 0);
  assert.equal(second.balance, 4);
  assert.equal(l.grantedToday("u1", { now: NOON, config }), true);
  const nextDay = l.recordText("u1", { text: "今天也好累喔", now: NOON + DAY, config });
  assert.equal(nextDay.granted, 1);
  assert.equal(nextDay.balance, 5);
});

test("voice time earns the same daily cup once 30 minutes accumulate, and shares the cap with text", () => {
  const l = ledger();
  assert.equal(l.recordVoice("u1", { seconds: 900, now: NOON, config }).granted, 0);
  const crossed = l.recordVoice("u1", { seconds: 900, now: NOON + 900_000, config });
  assert.equal(crossed.granted, 1);
  assert.equal(crossed.balance, 4);
  assert.equal(l.recordText("u1", { text: "今天好累喔", now: NOON + 1_000_000, config }).granted, 0);
  assert.equal(l.recordVoice("u1", { seconds: 900, now: NOON + 2_000_000, config }).balance, 4);
});

test("one voice flush is clamped so a stuck session cannot grant a day in one call", () => {
  const l = ledger();
  const result = l.recordVoice("u1", { seconds: 99999, now: NOON, config });
  assert.equal(result.added, 900);
  assert.equal(result.granted, 0);
});

test("a 7-day streak gives +3 and a missed day restarts the streak", () => {
  const l = ledger();
  let result;
  for (let day = 0; day < 7; day += 1) result = l.recordText("u1", { text: "今天好累喔", now: NOON + day * DAY, config });
  assert.equal(result.streak, 7);
  assert.equal(result.bonus, 3);
  assert.equal(result.balance, 3 + 7 + 3);
  const gap = l.recordText("u1", { text: "今天好累喔", now: NOON + 8 * DAY, config });
  assert.equal(gap.streak, 1);
  assert.equal(gap.bonus, 0);
});

test("earning stops at the cap and a lapsed booster keeps cups above the normal cap", () => {
  const custom = parfaitConfig({ parfait: { cap: 5 } });
  const l = ledger();
  for (let day = 0; day < 4; day += 1) l.recordText("u1", { text: "今天好累喔", now: NOON + day * DAY, config: custom });
  assert.equal(l.balance("u1", { now: NOON + 4 * DAY, config: custom }).balance, 5);

  l.balance("b1", { booster: true, now: NOON, config: custom });
  const lapsed = l.recordText("b1", { text: "今天好累喔", now: NOON + DAY, booster: false, config: custom });
  assert.equal(lapsed.balance, 16);
  assert.equal(lapsed.granted, 0);
});

test("spending refuses when short and a refund restores the charge", () => {
  const l = ledger();
  const custom = parfaitConfig({ parfait: { startCups: 1 } });
  const paid = l.spend("u1", { amount: 1, reason: "memory_remember", now: NOON, config: custom });
  assert.equal(paid.ok, true);
  assert.equal(paid.balance, 0);
  const short = l.spend("u1", { amount: 1, reason: "memory_remember", now: NOON, config: custom });
  assert.equal(short.ok, false);
  assert.equal(short.balance, 0);
  assert.equal(l.refund("u1", { amount: 1, reason: "memory_remember_refund", now: NOON }).balance, 1);
  assert.deepEqual(l.events("u1").map((event) => event.reason), ["memory_remember_refund", "memory_remember", "start"]);
});

test("thresholds come from rules.parfait", () => {
  const custom = parfaitConfig({ parfait: { textMinChars: 2, dailyGrant: 2 } });
  const l = ledger();
  assert.equal(l.recordText("u1", { text: "早安", now: NOON, config: custom }).balance, 5);
});

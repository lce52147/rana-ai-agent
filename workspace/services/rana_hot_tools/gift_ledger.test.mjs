import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openGiftLedger, giftConfig } = require("./gift_ledger.js");

const NOON = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const tomori = giftConfig({}, "tomori");

test("each character has its own gift name, and Rana has none here (her gift is 抹茶芭菲)", () => {
  assert.equal(tomori.name, "企鵝貼紙");
  assert.equal(giftConfig({}, "taki").name, "熊貓吊飾");
  assert.equal(giftConfig({}, "soyo").name, "香水");
  assert.equal(giftConfig({}, "anon").name, "手機吊飾");
  assert.equal(giftConfig({}, "rana"), null);
  assert.equal(giftConfig({ gifts: { characters: { anon: { name: "吉他撥片", unit: "片" } } } }, "anon").name, "吉他撥片");
  assert.equal(giftConfig({ gifts: { cap: 50 } }, "taki").cap, 50);
});

test("talking to a character earns its gift once a day, separately per character", () => {
  const l = openGiftLedger({ dbPath: ":memory:" });
  assert.equal(l.recordTalk("u1", { text: "燈今天在做什麼", now: NOON, config: tomori }).granted, 1);
  assert.equal(l.recordTalk("u1", { text: "燈還在嗎在嗎", now: NOON + 1000, config: tomori }).granted, 0);
  assert.equal(l.recordTalk("u1", { text: "嗨", now: NOON + DAY, config: tomori }).counted, false);
  assert.equal(l.balance("u1", { config: tomori }).balance, 1);
  assert.equal(l.balance("u1", { config: giftConfig({}, "taki") }).balance, 0);
});

test("a 7-day streak of talking gives +3", () => {
  const l = openGiftLedger({ dbPath: ":memory:" });
  let result;
  for (let d = 0; d < 7; d += 1) result = l.recordTalk("u1", { text: "燈今天在做什麼", now: NOON + d * DAY, config: tomori });
  assert.equal(result.streak, 7);
  assert.equal(result.balance, 10);
});

test("exchange credit refuses past the cap instead of trimming", () => {
  const l = openGiftLedger({ dbPath: ":memory:" });
  const small = giftConfig({ gifts: { cap: 3 } }, "tomori");
  assert.equal(l.credit("u1", { amount: 2, config: small }).balance, 2);
  const over = l.credit("u1", { amount: 2, config: small });
  assert.equal(over.ok, false);
  assert.equal(over.room, 1);
  assert.equal(l.balance("u1", { config: small }).balance, 2);
});

test("leaderboard lists holders only, highest first, with shared ranks for ties", () => {
  const l = openGiftLedger({ dbPath: ":memory:" });
  l.credit("a", { amount: 5, now: NOON, config: tomori });
  l.credit("b", { amount: 3, now: NOON + 1, config: tomori });
  l.credit("c", { amount: 5, now: NOON + 2, config: tomori });
  l.recordTalk("z", { text: "嗨", now: NOON, config: tomori });
  assert.deepEqual(l.leaderboard("tomori", 10).map((e) => [e.user_id, e.balance, e.rank]), [["a", 5, 1], ["c", 5, 1], ["b", 3, 3]]);
  assert.deepEqual(l.standing("tomori", "b"), { balance: 3, rank: 3, total: 3 });
  assert.equal(l.standing("tomori", "nobody").rank, null);
  assert.deepEqual(l.leaderboard("taki", 10), []);
});

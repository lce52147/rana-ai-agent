import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { currencyCatalog, parseGrant, grantNameCandidates } = require("./currency_exchange.js");

const catalog = currencyCatalog({});
const T = "910000000000000009";

test("a mention rendered as a name still grants to the mentioned person", () => {
  assert.deepEqual(parseGrant("@Rana 給 咳咳咳咳咳（主人） 200杯抹茶芭菲", catalog, "rana", T), { kind: "grant", action: "give", userId: T, currency: "rana", count: 200 });
  assert.deepEqual(parseGrant("拿走 有喜（よし） 5張企鵝貼紙", catalog, "rana", T), { kind: "grant", action: "take", userId: T, currency: "tomori", count: 5 });
});

test("the name after 給 @ is what the member search looks up", () => {
  assert.deepEqual(grantNameCandidates("@Rana 給 @很COG 200杯抹茶芭菲"), ["很COG"]);
  assert.deepEqual(grantNameCandidates("拿走 @有喜 よし 5張企鵝貼紙"), ["有喜 よし", "有喜"]);
  assert.deepEqual(grantNameCandidates("@Rana 今天好嗎"), []);
});

test("a number inside the name is not the count", () => {
  assert.equal(parseGrant("給 aua123 5杯抹茶芭菲", catalog, "rana", T).count, 5);
});

test("without a mentioned person, or without a count, nothing is granted", () => {
  assert.equal(parseGrant("給 咳 200杯抹茶芭菲", catalog, "rana", ""), null);
  assert.equal(parseGrant("給妳 4 杯抹茶芭菲", catalog, "rana", T), null);
  assert.equal(parseGrant("給我 4 杯抹茶芭菲", catalog, "rana", T), null);
  assert.equal(parseGrant("你看這張給 咳 的圖", catalog, "rana", T), null);
});

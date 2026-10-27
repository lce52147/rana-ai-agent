import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { currencyCatalog, parseExchange, parseGrant, runExchange, exchangeButtons, combineHoldings, holdingsDetail, isCombinedBoardQuestion } = require("./currency_exchange.js");

const catalog = currencyCatalog({});

test("the count may come after the gift, and 抹茶芭菲 is the default payment", () => {
  assert.deepEqual(parseExchange("我想用抹茶芭菲換企鵝貼紙5張", catalog, "tomori"), { kind: "exchange", source: "rana", target: "tomori", count: 5 });
  assert.deepEqual(parseExchange("換 3 張企鵝貼紙", catalog, "tomori"), { kind: "exchange", source: "rana", target: "tomori", count: 3 });
  assert.deepEqual(parseExchange("換五瓶香水", catalog, "soyo"), { kind: "exchange", source: "rana", target: "soyo", count: 5 });
});

test("a gift can be exchanged back into 抹茶芭菲 or into another gift, typos included", () => {
  assert.deepEqual(parseExchange("我想用企鵝貼紙換抹茶芭菲 3杯", catalog, "rana"), { kind: "exchange", source: "tomori", target: "rana", count: 3 });
  assert.deepEqual(parseExchange("我想用企鵝貼只換抹茶芭菲 3杯", catalog, "rana"), { kind: "exchange", source: "tomori", target: "rana", count: 3 });
  assert.deepEqual(parseExchange("我想用熊貓吊飾換企鵝貼紙 2 張", catalog, "tomori"), { kind: "exchange", source: "taki", target: "tomori", count: 2 });
  assert.deepEqual(parseExchange("用 2 杯抹茶芭菲換", catalog, "anon"), { kind: "exchange", source: "rana", target: "anon", count: 2 });
});

test("ordinary talk is not an exchange", () => {
  assert.equal(parseExchange("燈今天在做什麼", catalog, "tomori"), null);
  assert.equal(parseExchange("我買了企鵝貼紙", catalog, "tomori"), null);
  assert.equal(parseExchange("我想換手機", catalog, "anon"), null);
  assert.equal(parseExchange("大家有多少抹茶芭菲", catalog, "rana"), null);
});

test("asking 樂奈 for 抹茶芭菲 without naming what to pay with asks back", () => {
  assert.deepEqual(parseExchange("換 3 杯抹茶芭菲", catalog, "rana"), { kind: "exchange", error: "no_source", target: "rana" });
});

function wallet(balance, cap = 30) {
  const state = { balance };
  return {
    state,
    balance: () => ({ ok: true, balance: state.balance, cap }),
    spend: (n) => (state.balance < n ? { ok: false, balance: state.balance } : { ok: true, balance: (state.balance -= n) }),
    credit: (n) => (state.balance + n > cap ? { ok: false, cap } : { ok: true, balance: (state.balance += n), cap }),
    refund: (n) => ({ ok: true, balance: (state.balance += n) }),
  };
}

test("an exchange moves units between the two wallets at the configured rate", () => {
  const wallets = { rana: wallet(16), tomori: wallet(3) };
  const done = runExchange({ request: { source: "tomori", target: "rana", count: 3 }, catalog, wallets });
  assert.equal(done.ok, true);
  assert.equal(done.reply, "換好了。企鵝貼紙 -3 張（剩 0 張），抹茶芭菲 +3 杯（現在 19 杯）。");
  const short = runExchange({ request: { source: "tomori", target: "rana", count: 1 }, catalog, wallets });
  assert.equal(short.kind, "gift_insufficient");
  assert.equal(wallets.rana.state.balance, 19);
});

test("the target's cap is checked before anything is taken", () => {
  const wallets = { rana: wallet(10), tomori: wallet(29) };
  const result = runExchange({ request: { source: "rana", target: "tomori", count: 2 }, catalog, wallets });
  assert.equal(result.kind, "gift_cap");
  assert.equal(wallets.rana.state.balance, 10);
});

test("the gift board sums all five currencies 1:1 and lists each beside the total", () => {
  const ranked = combineHoldings(
    [{ user_id: "1", balance: 20, updated_ts: 5 }, { user_id: "2", balance: 3, updated_ts: 1 }, { user_id: "3", balance: 0, updated_ts: 1 }],
    [{ bot_id: "tomori", user_id: "2", balance: 17, updated_ts: 2 }, { bot_id: "taki", user_id: "1", balance: 1, updated_ts: 6 }],
  );
  assert.deepEqual(ranked.map((p) => [p.user_id, p.total, p.rank]), [["1", 21, 1], ["2", 20, 2]]);
  assert.equal(holdingsDetail(ranked[1].parts, catalog), "🍨3 🐧17");
  assert.equal(isCombinedBoardQuestion("禮物排行"), true);
  assert.equal(isCombinedBoardQuestion("大家有多少禮物"), true);
  assert.equal(isCombinedBoardQuestion("大家有多少企鵝貼紙"), false);
});

test("給 / 拿走 need a mention, and default to the asked bot's currency", () => {
  assert.deepEqual(parseGrant("給 <@910000000000000001> 20杯 抹茶芭菲", catalog, "rana"), { kind: "grant", action: "give", userId: "910000000000000001", currency: "rana", count: 20 });
  assert.deepEqual(parseGrant("拿走 <@910000000000000001> 5張", catalog, "tomori"), { kind: "grant", action: "take", userId: "910000000000000001", currency: "tomori", count: 5 });
  assert.equal(parseGrant("送我兩杯好不好", catalog, "rana"), null);
});

test("the 抹茶芭菲 card offers each gift; a gift card offers buying it and trading it back", () => {
  assert.deepEqual(exchangeButtons(catalog, "rana").map((b) => b.target), ["tomori", "taki", "soyo", "anon"]);
  assert.deepEqual(exchangeButtons(catalog, "tomori").map((b) => `${b.source}->${b.target}`), ["rana->tomori", "tomori->rana"]);
});

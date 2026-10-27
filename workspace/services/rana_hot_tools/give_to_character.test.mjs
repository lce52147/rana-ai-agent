import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { currencyCatalog, parseGiveToBot } = require("./currency_exchange.js");
const { openGiftLedger } = require("./gift_ledger.js");

const catalog = currencyCatalog({});

test("giving the asked character some currency is read as a gift", () => {
  assert.deepEqual(parseGiveToBot("<@1> 給妳 4 杯抹茶芭菲", catalog, ["樂奈"]), { kind: "give", currency: "rana", count: 4 });
  assert.deepEqual(parseGiveToBot("送你三張企鵝貼紙", catalog, ["燈"]), { kind: "give", currency: "tomori", count: 3 });
  assert.deepEqual(parseGiveToBot("這 2 杯芭菲送給樂奈", catalog, ["樂奈"]), { kind: "give", currency: "rana", count: 2 });
  assert.deepEqual(parseGiveToBot("給立希熊貓吊飾", catalog, ["立希"]), { kind: "give", currency: "taki", count: 1 });
});

test("asking, past tense, refusals, questions and exchanges are not gifts", () => {
  assert.equal(parseGiveToBot("給我 4 杯抹茶芭菲", catalog, ["樂奈"]), null);
  assert.equal(parseGiveToBot("你給我抹茶芭菲", catalog, ["樂奈"]), null);
  assert.equal(parseGiveToBot("我剛剛給了你 4 杯抹茶芭菲", catalog, ["樂奈"]), null);
  assert.equal(parseGiveToBot("我不給你抹茶芭菲", catalog, ["樂奈"]), null);
  assert.equal(parseGiveToBot("要不要給你抹茶芭菲", catalog, ["樂奈"]), null);
  assert.equal(parseGiveToBot("給你 1 杯芭菲換企鵝貼紙", catalog, ["燈"]), null);
  assert.equal(parseGiveToBot("給你看我的貓", catalog, ["樂奈"]), null);
});

test("received gifts add up per character and currency", () => {
  const ledger = openGiftLedger({ dbPath: ":memory:" });
  assert.deepEqual(ledger.receiveGift("rana", "111111111111111111", "rana", 4), { rana: 4 });
  assert.deepEqual(ledger.receiveGift("rana", "111111111111111111", "tomori", 2), { rana: 4, tomori: 2 });
  assert.deepEqual(ledger.receiveGift("rana", "111111111111111111", "rana", 1), { rana: 5, tomori: 2 });
  assert.deepEqual(ledger.received("tomori", "111111111111111111"), {});
  ledger.close();
});

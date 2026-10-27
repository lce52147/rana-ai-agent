import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isIntimacyBoardQuestion, isOwnIntimacyQuestion, isCombinedBoardQuestion } = require("./currency_exchange.js");
const { openGiftLedger } = require("./gift_ledger.js");

test("intimacy board and own-closeness questions are told apart from the gift board", () => {
  for (const q of ["親密度排行", "親密排行榜", "誰跟妳最親", "大家的親密度"]) assert.ok(isIntimacyBoardQuestion(q), q);
  for (const q of ["我跟妳有多親", "我跟樂奈多親", "我的親密度", "親密度幾級"]) assert.ok(isOwnIntimacyQuestion(q), q);
  assert.equal(isIntimacyBoardQuestion("禮物排行"), false);
  assert.equal(isCombinedBoardQuestion("親密度排行"), false);
  assert.equal(isOwnIntimacyQuestion("今天天氣很好"), false);
});

test("the board sums every currency per giver and shares ranks on ties", () => {
  const ledger = openGiftLedger({ dbPath: ":memory:" });
  ledger.receiveGift("rana", "1", "rana", 5);
  ledger.receiveGift("rana", "1", "tomori", 3);
  ledger.receiveGift("rana", "2", "rana", 8);
  ledger.receiveGift("rana", "3", "rana", 2);
  ledger.receiveGift("tomori", "3", "rana", 50);
  const board = ledger.intimacyBoard("rana");
  assert.deepEqual(board.rows.map((r) => [r.user_id, r.total, r.rank]), [["1", 8, 1], ["2", 8, 1], ["3", 2, 3]]);
  assert.equal(board.holders, 3);
  ledger.close();
});

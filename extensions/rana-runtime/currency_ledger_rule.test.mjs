import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPersonaGenerationContext } from './persona_context.js';

function ctx(accountId, agentId = accountId === 'default' ? 'main' : accountId) {
  return { accountId, agentId, sessionKey: `agent:${agentId}:discord:channel:currency-rule` };
}

// The model once said 「拿去吧」 and 「收下了」 while the ledger never moved; every persona must be
// told that only the ledger gives, takes or counts 抹茶芭菲 and gifts.
for (const accountId of ['default', 'anon', 'tomori', 'soyo', 'taki']) {
  for (const prompt of ['今天想吃什麼？', '可以給我一杯抹茶芭菲嗎？我上次給了你四杯']) {
    test(`${accountId} gets the no-fake-transaction rule for 「${prompt}」`, () => {
      const out = buildPersonaGenerationContext({ prompt }, ctx(accountId));
      assert.match(out, /^CURRENCY_FAKE_TRANSACTION=DENY$/mu);
      assert.match(out, /^CURRENCY_LEDGER_RULE=.*never state anyone's count or balance/mu);
    });
  }
}

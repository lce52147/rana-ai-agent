import assert from 'node:assert/strict';
import test from 'node:test';

import { intimacyLevel, intimacyLines, loadIntimacyTiers } from './intimacy_context.js';
import { leanPromptText } from './architecture/lean_prompt.js';

const tiers = loadIntimacyTiers();

test('the user-set thresholds map gift totals to five levels', () => {
  const at = (n) => intimacyLevel(n, tiers).level;
  assert.deepEqual([0, 10, 11, 50, 51, 100, 101, 250, 251, 9999].map(at), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test('every persona has a tone for every level', () => {
  for (const persona of ['rana', 'tomori', 'anon', 'soyo', 'taki']) {
    assert.equal(tiers.personas[persona].tones.length, tiers.levels.length, persona);
    for (const tone of tiers.personas[persona].tones) assert.ok(tone.tone && tone.examples.length, persona);
  }
});

test('the level, tone and samples survive the lean prompt and carry the no-copy rule', () => {
  const lean = leanPromptText(intimacyLines('rana', 12, tiers));
  assert.match(lean, /Lv\.2 of 5 \(熟悉\)/u);
  assert.match(lean, /記得你了/u);
  assert.match(lean, /「啊，是你。」/u);
  assert.match(lean, /Do not copy them/u);
  assert.match(lean, /Never mention the level or any gift count/u);
});

test('an unknown persona gets nothing', () => {
  assert.equal(intimacyLines('nobody', 300, tiers), '');
});

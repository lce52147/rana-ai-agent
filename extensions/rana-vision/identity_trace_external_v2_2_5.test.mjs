import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from './debug.js';

const env = { RANA_VISION_TRACE_MODE: 'identity' };

for (const stage of [
  'anilist_character_search',
  'external_candidate_batch_comparison_request',
  'external_candidate_batch_comparison_response',
  'anilist_candidate_batch_comparison',
  'deep_search_resolution',
]) {
  test(`identity trace includes ${stage}`, () => {
    assert.equal(__test.shouldTraceStage(stage, env), true);
  });
}

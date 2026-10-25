import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDefinitionEvidence,
  detectLookupIntent,
  isEvidenceBoundedAnswer,
  looksUnsearchedUnknown,
  registerWebSearchGuard,
} from './index.js';

test('detects niche term definition request', () => {
  const result = detectLookupIntent('@樂奈 跟我說說邦圖神人是什麼意思');
  assert.equal(result.active, true);
  assert.equal(result.term, '邦圖神人');
  assert.equal(result.explicitSearch, false);
});

test('detects explicit search request', () => {
  const result = detectLookupIntent('幫我查一下 邦圖神人');
  assert.equal(result.active, true);
  assert.equal(result.explicitSearch, true);
});

test('does not claim image turns', () => {
  const result = detectLookupIntent('[media attached: C:\\tmp\\a.png]\n這是誰');
  assert.equal(result.active, false);
  assert.equal(result.reason, 'image_turn');
});

test('detects unsupported unknown answer', () => {
  assert.equal(looksUnsearchedUnknown('這詞我不熟，沒聽過。'), true);
  assert.equal(looksUnsearchedUnknown('查了一下，公開搜尋沒有固定定義。'), false);
});

test('finalize requests one bounded retry when no web search was called', async () => {
  const hooks = new Map();
  const api = { on(name, fn) { hooks.set(name, fn); } };
  registerWebSearchGuard(api);
  const ctx = { runId: 'r1', sessionKey: 's1' };
  const injected = await hooks.get('before_prompt_build')({ runId: 'r1', prompt: '邦圖神人是什麼意思' }, ctx);
  assert.match(injected.appendSystemContext, /web_search/);
  const decision = await hooks.get('before_agent_finalize')({ runId: 'r1', assistantText: '這詞我不熟，沒聽過。' }, ctx);
  assert.equal(decision.action, 'revise');
  assert.equal(decision.retry.maxAttempts, 1);
});

test('finalize does not retry after web_search tool call', async () => {
  const hooks = new Map();
  const api = { on(name, fn) { hooks.set(name, fn); } };
  registerWebSearchGuard(api);
  const ctx = { runId: 'r2', sessionKey: 's2' };
  await hooks.get('before_prompt_build')({ runId: 'r2', prompt: '邦圖神人是什麼意思' }, ctx);
  await hooks.get('before_tool_call')({ runId: 'r2', toolName: 'web_search', params: { query: '"邦圖神人"' } }, ctx);
  const decision = await hooks.get('before_agent_finalize')({ runId: 'r2', assistantText: '公開搜尋沒有固定定義。' }, ctx);
  assert.equal(decision, undefined);
});

test('definition evidence excludes the query field and rejects unrelated results', () => {
  const evidence = assessDefinitionEvidence('\u90a6\u5716\u795e\u4eba', {
    details: {
      query: '\u90a6\u5716\u795e\u4eba',
      results: [
        { title: 'BanG Dream!', snippet: '\u9019\u662f\u4e00\u500b\u97f3\u6a02\u4f01\u5283' },
        { title: '\u90a6\u591a\u5229\u795e\u4eba\u65e5\u5e38', snippet: '\u5f71\u7247\u7c21\u4ecb' },
      ],
    },
  });
  assert.deepEqual(evidence, {
    supported: false,
    resultCount: 2,
    exactMatches: 0,
    definitionalMatches: 0,
  });
});

test('definition evidence accepts an exact definitional result', () => {
  const evidence = assessDefinitionEvidence('\u6e2c\u8a66\u8a5e', {
    results: [{ title: '\u6e2c\u8a66\u8a5e\u662f\u4ec0\u9ebc', snippet: '\u6e2c\u8a66\u8a5e\u662f\u6307\u67d0\u7a2e\u516c\u958b\u7528\u6cd5' }],
  });
  assert.equal(evidence.supported, true);
  assert.equal(evidence.definitionalMatches, 1);
});

test('finalize revises an unsupported factual definition after web search', async () => {
  const hooks = new Map();
  const api = { on(name, fn) { hooks.set(name, fn); } };
  registerWebSearchGuard(api);
  const ctx = { runId: 'r3', sessionKey: 's3' };
  const prompt = '\u8ddf\u6211\u8aaa\u8aaa\u90a6\u5716\u795e\u4eba\u662f\u4ec0\u9ebc\u610f\u601d';
  await hooks.get('before_prompt_build')({ runId: 'r3', prompt }, ctx);
  await hooks.get('before_tool_call')({ runId: 'r3', toolName: 'web_search', params: { query: '\u90a6\u5716\u795e\u4eba' } }, ctx);
  await hooks.get('after_tool_call')({
    runId: 'r3',
    toolName: 'web_search',
    result: { details: { results: [{ title: 'BanG Dream!', snippet: '\u97f3\u6a02\u4f01\u5283' }] } },
  }, ctx);
  const decision = await hooks.get('before_agent_finalize')({
    runId: 'r3',
    assistantText: '\u90a6\u5716\u795e\u4eba\u662f\u73a9\u5bb6\u5708\u88e1\u5c0d\u9ad8\u624b\u7684\u7a31\u547c\u3002',
  }, ctx);
  assert.equal(decision.action, 'revise');
  assert.match(decision.reason, /did not establish/);
  assert.match(decision.retry.instruction, /Do not invent/);
});

test('finalize allows a cautious no-definition answer after weak search results', async () => {
  const hooks = new Map();
  const api = { on(name, fn) { hooks.set(name, fn); } };
  registerWebSearchGuard(api);
  const ctx = { runId: 'r4', sessionKey: 's4' };
  await hooks.get('before_prompt_build')({ runId: 'r4', prompt: '\u90a6\u5716\u795e\u4eba\u662f\u4ec0\u9ebc\u610f\u601d' }, ctx);
  await hooks.get('before_tool_call')({ runId: 'r4', toolName: 'web_search', params: { query: '\u90a6\u5716\u795e\u4eba' } }, ctx);
  await hooks.get('after_tool_call')({
    runId: 'r4',
    toolName: 'web_search',
    result: { results: [{ title: 'BanG Dream!', snippet: '\u97f3\u6a02\u4f01\u5283' }] },
  }, ctx);
  const answer = '\u641c\u5c0b\u7d50\u679c\u6c92\u6709\u627e\u5230\u9019\u500b\u8a5e\u7684\u56fa\u5b9a\u516c\u958b\u5b9a\u7fa9\u3002';
  assert.equal(isEvidenceBoundedAnswer(answer), true);
  const decision = await hooks.get('before_agent_finalize')({ runId: 'r4', assistantText: answer }, ctx);
  assert.equal(decision, undefined);
});

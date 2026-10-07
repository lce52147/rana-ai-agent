import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { __test as debugTest } from './debug.js';
import { deepSearchExternalIdentity, __test as deepTest } from './deep_search.js';
import { verifyKnownCandidate, __test as reverseTest } from './reverse_search.js';

const LEGACY = 'http://127.0.0.1:11434/api/experimental/web_search';

test('core trace records curated stages but excludes raw 6970 payloads', () => {
  const env = { RANA_VISION_TRACE_MODE: 'core' };
  assert.equal(debugTest.shouldTraceStage('identity_sidecar_result', env), true);
  assert.equal(debugTest.shouldTraceStage('deep_search_resolution', env), true);
  assert.equal(debugTest.shouldTraceStage('vision_result_summary', env), true);
  assert.equal(debugTest.shouldTraceStage('model_6970_http_response_raw', env), false);
  assert.equal(debugTest.shouldTraceStage('resolver_input', env), false);
  assert.equal(debugTest.shouldTraceStage('before_prompt_build_raw', env), false);
});

test('legacy localhost Ollama web search is disabled unless explicitly opted in', () => {
  assert.equal(deepTest.isLegacyLocalOllamaWebSearch(LEGACY), true);
  assert.equal(reverseTest.isLegacyLocalOllamaWebSearch(LEGACY), true);
  assert.equal(deepTest.configuredWebSearchUrl({ RANA_WEB_SEARCH_URL: LEGACY }), '');
  assert.equal(reverseTest.configuredWebSearchUrl({ RANA_WEB_SEARCH_URL: LEGACY }), '');
  assert.equal(
    deepTest.configuredWebSearchUrl({ RANA_WEB_SEARCH_URL: LEGACY, RANA_ALLOW_OLLAMA_WEB_SEARCH: '1' }),
    LEGACY,
  );
});

test('deep search degrades immediately to exhausted when generic backend is disabled', async () => {
  const previousUrl = process.env.RANA_WEB_SEARCH_URL;
  const previousOptIn = process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
  delete process.env.RANA_WEB_SEARCH_URL;
  delete process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
  try {
    const result = await deepSearchExternalIdentity({
      image: Buffer.from('image'),
      mimeType: 'image/png',
      vision: { observation: { summary: '藍髮雙馬尾角色', distinctive_features: ['藍髮', '雙馬尾'] } },
      ocr: { lines: [] },
      reverse: { results: [] },
      requestId: 'test-disabled-web',
      dependencies: {
        anilistCharacters: async () => ({ status: 'empty', candidates: [], media: [] }),
      },
    });
    assert.equal(result.status, 'exhausted');
    assert.equal(result.reason, 'generic_web_backend_disabled');
    assert.equal(result.searchExhausted, true);
  } finally {
    if (previousUrl === undefined) delete process.env.RANA_WEB_SEARCH_URL;
    else process.env.RANA_WEB_SEARCH_URL = previousUrl;
    if (previousOptIn === undefined) delete process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
    else process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH = previousOptIn;
  }
});

test('known-candidate text verification skips without waking Ollama', async () => {
  const previousUrl = process.env.RANA_WEB_SEARCH_URL;
  const previousOptIn = process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
  process.env.RANA_WEB_SEARCH_URL = LEGACY;
  delete process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
  try {
    const result = await verifyKnownCandidate({ accepted: true, title: '要樂奈' }, undefined, 'verify-no-ollama');
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'generic_web_backend_disabled');
  } finally {
    if (previousUrl === undefined) delete process.env.RANA_WEB_SEARCH_URL;
    else process.env.RANA_WEB_SEARCH_URL = previousUrl;
    if (previousOptIn === undefined) delete process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH;
    else process.env.RANA_ALLOW_OLLAMA_WEB_SEARCH = previousOptIn;
  }
});

test('before_message_write raw capture hook is synchronous', async () => {
  const source = await readFile(new URL('./guidance.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /api\.on\("before_message_write",\s*async\s*\(/);
  assert.match(source, /api\.on\("before_message_write",\s*\(event, ctx\)\s*=>/);
});

test('evidence emits compact summaries instead of requiring full raw capture', async () => {
  const source = await readFile(new URL('./evidence.js', import.meta.url), 'utf8');
  assert.match(source, /"vision_result_summary"/);
  assert.match(source, /"ocr_result_summary"/);
  assert.match(source, /"reverse_search_summary"/);
});

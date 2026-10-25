import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('debug trace is opt-in', async () => {
  const oldTrace = process.env.RANA_VISION_TRACE;
  const oldDebug = process.env.RANA_VISION_DEBUG;
  const oldMode = process.env.RANA_VISION_TRACE_MODE;
  delete process.env.RANA_VISION_TRACE;
  delete process.env.RANA_VISION_DEBUG;
  delete process.env.RANA_VISION_TRACE_MODE;
  const mod = await import(`${pathToFileURL(path.join(here, 'debug.js')).href}?t=${Date.now()}`);
  assert.equal(mod.visionDebugEnabled(), false);
  process.env.RANA_VISION_TRACE = '1';
  assert.equal(mod.visionDebugEnabled(), true);
  if (oldTrace === undefined) delete process.env.RANA_VISION_TRACE; else process.env.RANA_VISION_TRACE = oldTrace;
  if (oldDebug === undefined) delete process.env.RANA_VISION_DEBUG; else process.env.RANA_VISION_DEBUG = oldDebug;
  if (oldMode === undefined) delete process.env.RANA_VISION_TRACE_MODE; else process.env.RANA_VISION_TRACE_MODE = oldMode;
});

test('raw model capture is opt-in', async () => {
  const guidance = await readFile(path.join(here, 'guidance.js'), 'utf8');
  assert.match(guidance, /RANA_VISION_RAW_CAPTURE === "1"/);
  assert.match(guidance, /if \(!RAW_CAPTURE_ENABLED\) return;/);
});

test('6970 raw payload capture is opt-in and ToriiGate trace is metadata only', async () => {
  const client = await readFile(path.join(here, 'client.js'), 'utf8');
  assert.match(client, /RANA_VISION_RAW_HTTP_CAPTURE === "1"/);
  assert.match(client, /if \(RAW_6970_CAPTURE_ENABLED\)/);
  const toriiStart = client.indexOf('await traceVision(requestId, "toriigate_request"');
  const toriiEnd = client.indexOf('const response = await fetch', toriiStart);
  assert.ok(toriiStart >= 0 && toriiEnd > toriiStart);
  assert.doesNotMatch(client.slice(toriiStart, toriiEnd), /request_payload|sanitize6970CapturePayload/);
});

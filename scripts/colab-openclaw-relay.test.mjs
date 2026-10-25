import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const relayScript = path.join(import.meta.dirname, 'colab-openclaw-relay.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function startRelay(statePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relayScript], {
      env: {
        ...process.env,
        COLAB_OPENCLAW_RELAY_HOST: '127.0.0.1',
        COLAB_OPENCLAW_RELAY_PORT: '0',
        COLAB_OPENCLAW_STATE_PATH: statePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`relay exited ${code}: ${stderr}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(/COLAB_OPENCLAW_RELAY_LISTENING http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
  });
}

async function request(port, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${options.path ?? '/v1/models'}`, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

test('returns 503 until an upstream endpoint is configured', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'colab-relay-'));
  const statePath = path.join(dir, 'endpoint.json');
  const { child, port } = await startRelay(statePath);
  t.after(() => child.kill());

  const result = await request(port);
  assert.equal(result.status, 503);
  assert.match(result.text, /not configured/i);
});

test('forwards OpenAI-compatible traffic using the current state file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'colab-relay-'));
  const statePath = path.join(dir, 'endpoint.json');
  let observed;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observed = {
        path: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.end('data: second\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  await writeFile(statePath, JSON.stringify({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'test-secret',
  }), 'utf8');

  const { child, port } = await startRelay(statePath);
  t.after(() => child.kill());

  const body = JSON.stringify({ model: 'qwen3.8-27b', input: 'ping' });
  const result = await request(port, {
    path: '/v1/responses',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'text/event-stream');
  assert.equal(result.text, 'data: first\n\ndata: second\n\n');
  assert.deepEqual(observed, {
    path: '/v1/responses',
    authorization: 'Bearer test-secret',
    body,
  });
});

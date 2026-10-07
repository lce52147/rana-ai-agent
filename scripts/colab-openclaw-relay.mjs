import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.COLAB_OPENCLAW_RELAY_HOST || '127.0.0.1';
const port = Number(process.env.COLAB_OPENCLAW_RELAY_PORT || 4000);
const statePath = process.env.COLAB_OPENCLAW_STATE_PATH
  || path.resolve(scriptDir, '..', 'state', 'colab-openclaw-endpoint.json');

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function cleanHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name.toLowerCase())),
  );
}

async function loadState() {
  const raw = await readFile(statePath, 'utf8');
  const state = JSON.parse(raw);
  if (!state.upstreamBaseUrl) throw new Error('upstreamBaseUrl is missing');
  const base = new URL(state.upstreamBaseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('upstreamBaseUrl must use http or https');
  }
  return { base, apiKey: state.apiKey || '' };
}

function sendJson(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': payload.length,
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  let state;
  try {
    state = await loadState();
  } catch {
    sendJson(res, 503, { error: 'Colab upstream is not configured' });
    return;
  }

  const target = new URL(req.url || '/', `${state.base.toString().replace(/\/+$/, '')}/`);
  const headers = cleanHeaders(req.headers);
  headers.host = target.host;
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;

  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, {
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, cleanHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });

  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { error: 'Colab upstream is unreachable' });
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`COLAB_OPENCLAW_RELAY_LISTENING http://${host}:${actualPort}\n`);
});

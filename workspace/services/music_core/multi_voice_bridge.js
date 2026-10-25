'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = __dirname;
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.resolve(ROOT, '..', '..', '..');
const CONFIG_PATH = path.join(OPENCLAW_ROOT, 'openclaw.json');
const VOICE_BRIDGE_SCRIPT = path.join(ROOT, 'voice_bridge.js');
const SPECS = [
  { botId: 'rana', accountId: 'default', port: 8081 },
  { botId: 'tomori', accountId: 'tomori', port: 8082 },
  { botId: 'anon', accountId: 'anon', port: 8083 },
  { botId: 'soyo', accountId: 'soyo', port: 8084 },
  { botId: 'taki', accountId: 'taki', port: 8085 },
];

const workers = new Map();
const restartAttempts = new Map();
let stopping = false;

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/u, ''));
}

function tokenFor(config, spec) {
  return config.channels?.discord?.accounts?.[spec.accountId]?.token || '';
}

function botUserId(token) {
  const first = String(token || '').split('.')[0];
  if (!first) return '';
  try {
    const normalized = first.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(first.length / 4) * 4, '=');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    return /^\d{15,25}$/.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

function workerConfig(spec, config) {
  const token = tokenFor(config, spec);
  const userId = botUserId(token);
  if (!token || !userId) return null;
  return {
    DISCORD_TOKEN: token,
    BOT_USER_ID: userId,
    MYGO_BOT_ID: spec.botId,
    BRIDGE_PORT: String(spec.port),
    LAVALINK_HOST: process.env.LAVALINK_HOST || '127.0.0.1',
    LAVALINK_PORT: process.env.LAVALINK_PORT || '2333',
    LAVALINK_PASS: process.env.LAVALINK_PASS || 'youshallnotpass',
    LIVE_RESOLVE_HOST: process.env.LIVE_RESOLVE_HOST || '127.0.0.1',
    LIVE_RESOLVE_PORT: process.env.LIVE_RESOLVE_PORT || '8080',
    LIVE_RESOLVE_TIMEOUT_MS: process.env.LIVE_RESOLVE_TIMEOUT_MS || '30000',
    STREAM_FRESH_MS: process.env.STREAM_FRESH_MS || '60000',
  };
}

function startWorker(spec, config) {
  if (stopping || workers.has(spec.botId)) return;
  const settings = workerConfig(spec, config);
  if (!settings) {
    console.error(`[multi-voice] ${spec.botId}: token or user id unavailable; worker not started`);
    return;
  }

  const worker = new Worker(VOICE_BRIDGE_SCRIPT, {
    workerData: { ranaVoiceBridge: settings },
  });
  workers.set(spec.botId, worker);
  worker.once('online', () => {
    restartAttempts.set(spec.botId, 0);
    console.log(`[multi-voice] ${spec.botId}: client worker online thread=${worker.threadId} port=${spec.port}`);
  });
  worker.on('error', (error) => {
    console.error(`[multi-voice] ${spec.botId}: worker error: ${error?.message || String(error)}`);
  });
  worker.once('exit', (code) => {
    if (workers.get(spec.botId) === worker) workers.delete(spec.botId);
    if (stopping) return;
    const attempt = (restartAttempts.get(spec.botId) || 0) + 1;
    restartAttempts.set(spec.botId, attempt);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6));
    console.error(`[multi-voice] ${spec.botId}: worker exited code=${code}; restarting in ${delay}ms`);
    setTimeout(() => {
      try { startWorker(spec, readConfig()); } catch (error) {
        console.error(`[multi-voice] ${spec.botId}: restart failed: ${error?.message || String(error)}`);
      }
    }, delay).unref();
  });
}

function startAll() {
  const config = readConfig();
  for (const spec of SPECS) startWorker(spec, config);
  console.log(`[multi-voice] one process supervising ${workers.size}/${SPECS.length} isolated Discord/Lavalink clients on ports ${SPECS.map((spec) => spec.port).join(',')}`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[multi-voice] shutdown ${signal}; terminating ${workers.size} client workers`);
  await Promise.all([...workers.values()].map((worker) => worker.terminate().catch(() => undefined)));
  workers.clear();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

module.exports = { SPECS, botUserId, workerConfig, startAll };

if (require.main === module) {
  try {
    startAll();
  } catch (error) {
    console.error(`[multi-voice] boot failed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

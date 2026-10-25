'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = __dirname;
const CONFIG_PATH = path.resolve(ROOT, '..', '..', '..', 'openclaw.json');
const BRIDGE_SCRIPT = path.join(ROOT, 'multi_voice_bridge.js');
const LOCK_PATH = path.join(ROOT, '.mygo_voice_bridges.lock');
const SPECS = [
  { botId: 'rana', accountId: 'default', port: 8081 },
  { botId: 'tomori', accountId: 'tomori', port: 8082 },
  { botId: 'anon', accountId: 'anon', port: 8083 },
  { botId: 'soyo', accountId: 'soyo', port: 8084 },
  { botId: 'taki', accountId: 'taki', port: 8085 },
];

let bridgeProcess = null;
let lockOwned = false;
let reconcileTimer = null;
let shuttingDown = false;

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/u, ''));
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

function portIsListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(Boolean(value));
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function classifyDiagnostics(data, expectedUserId, expectedBotId) {
  const actualUserId = String(data?.discord_bot_id || '');
  const actualBotId = String(data?.mygo_bot_id || '');
  const expectedUser = String(expectedUserId || '');
  const expectedBot = String(expectedBotId || '');
  if (!actualUserId || actualUserId !== expectedUser) {
    return { healthy: false, occupied: true, legacy: false, reason: 'identity mismatch expected=' + expectedUser + ' actual=' + (actualUserId || 'unknown') };
  }
  if (data?.discord_ready !== true) {
    return { healthy: false, occupied: true, legacy: false, reason: 'Discord client not ready' };
  }
  if (actualBotId && actualBotId !== expectedBot) {
    return { healthy: false, occupied: true, legacy: false, reason: 'bot id mismatch expected=' + expectedBot + ' actual=' + actualBotId };
  }
  return { healthy: true, occupied: true, legacy: !actualBotId, reason: actualBotId ? 'ok' : 'legacy-compatible diagnostics' };
}

async function healthState(port, expectedUserId, expectedBotId) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/diagnostics', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { healthy: false, occupied: true, legacy: false, reason: 'diagnostics HTTP ' + response.status };
    const data = await response.json();
    return { ...classifyDiagnostics(data, expectedUserId, expectedBotId), data };
  } catch (error) {
    const occupied = await portIsListening(port);
    return {
      healthy: false,
      occupied,
      legacy: false,
      reason: occupied ? 'port listening but diagnostics unavailable' : 'offline',
      detail: error?.message || String(error),
    };
  }
}

function acquireSupervisorLock() {
  if (lockOwned) return true;
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid), 'utf8');
    fs.closeSync(fd);
    lockOwned = true;
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let priorPid = 0;
  try { priorPid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim()); } catch (_) {}
  if (priorPid && priorPid !== process.pid) {
    try {
      process.kill(priorPid, 0);
      console.log('[mygo-voice] another supervisor is active pid=' + priorPid + '; exiting duplicate');
      return false;
    } catch (_) {}
  }
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  const fd = fs.openSync(LOCK_PATH, 'wx');
  fs.writeFileSync(fd, String(process.pid), 'utf8');
  fs.closeSync(fd);
  lockOwned = true;
  return true;
}

function releaseSupervisorLock() {
  if (!lockOwned) return;
  try {
    const current = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    if (current === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
  lockOwned = false;
}

async function waitForPortsFree(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const occupied = await Promise.all(SPECS.map((spec) => portIsListening(spec.port, 250)));
    if (!occupied.some(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const occupied = await Promise.all(SPECS.map((spec) => portIsListening(spec.port, 250)));
  return !occupied.some(Boolean);
}

function managedAlive() {
  return Boolean(bridgeProcess && !bridgeProcess.killed && bridgeProcess.exitCode == null);
}

function spawnBridge() {
  if (managedAlive()) return;
  bridgeProcess = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, OPENCLAW_ROOT: path.resolve(ROOT, '..', '..', '..') },
    stdio: 'inherit',
    windowsHide: true,
  });
  bridgeProcess.on('error', (error) => console.error('[mygo-voice] multi bridge spawn error: ' + (error?.message || String(error))));
  bridgeProcess.on('exit', (code, signal) => {
    console.error('[mygo-voice] multi bridge exited code=' + (code ?? 'null') + ' signal=' + (signal || 'none'));
    bridgeProcess = null;
  });
  console.log('[mygo-voice] started one multi-client bridge process for ports 8081-8085 pid=' + bridgeProcess.pid);
}

async function reconcile() {
  const config = readConfig();
  const expected = SPECS.map((spec) => ({
    ...spec,
    userId: botUserId(config.channels?.discord?.accounts?.[spec.accountId]?.token || ''),
  }));
  const checks = await Promise.all(expected.map((spec) => healthState(spec.port, spec.userId, spec.botId)));
  if (checks.every((check) => check.healthy)) return;

  if (managedAlive()) {
    const unhealthyOccupied = checks.find((check) => check.occupied && !check.healthy);
    if (!unhealthyOccupied) return;
    console.error('[mygo-voice] managed multi bridge unhealthy: ' + unhealthyOccupied.reason + '; restarting one process');
    try { bridgeProcess.kill(); } catch (_) {}
    bridgeProcess = null;
    if (!(await waitForPortsFree())) {
      console.error('[mygo-voice] managed bridge stopped but one of 8081-8085 remains occupied; replacement blocked');
      return;
    }
  }

  const occupied = checks.find((check) => check.occupied);
  if (occupied) {
    console.error('[mygo-voice] port occupied by an unhealthy or unknown service; refusing duplicate bridge: ' + occupied.reason);
    return;
  }
  spawnBridge();
}

async function main() {
  if (!acquireSupervisorLock()) return;
  await reconcile();
  reconcileTimer = setInterval(() => { void reconcile().catch((error) => console.error('[mygo-voice] reconcile failed: ' + (error?.message || String(error)))); }, 10000);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  console.log('[mygo-voice] shutdown ' + signal + '; stopping managed multi bridge');
  if (managedAlive()) {
    try { bridgeProcess.kill(); } catch (_) {}
  }
  releaseSupervisorLock();
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseSupervisorLock);

module.exports = { SPECS, botUserId, classifyDiagnostics, healthState, portIsListening };

if (require.main === module) void main();

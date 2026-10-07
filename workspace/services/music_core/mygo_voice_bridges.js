const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

const ROOT = __dirname;
const CONFIG_PATH = path.resolve(ROOT, "..", "..", "..", "openclaw.json");
const BRIDGE_SCRIPT = path.join(ROOT, "voice_bridge.js");
const LOCK_PATH = path.join(ROOT, ".mygo_voice_bridges.lock");
const SPECS = [
  { botId: "rana", accountId: "default", port: 8081 },
  { botId: "tomori", accountId: "tomori", port: 8082 },
  { botId: "anon", accountId: "anon", port: 8083 },
  { botId: "soyo", accountId: "soyo", port: 8084 },
  { botId: "taki", accountId: "taki", port: 8085 },
];

const children = new Map();
const legacyNotices = new Set();
let lockOwned = false;
let reconcileTimer = null;

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/u, ""));
}

function botUserId(token) {
  const first = String(token || "").split(".")[0];
  if (!first) return "";
  try {
    const normalized = first.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(first.length / 4) * 4, "=");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return /^\d{15,25}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function portIsListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(Boolean(value));
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Classify one bridge diagnostics payload without making network/process calls.
 *
 * Upgrade compatibility rule:
 * - v3.2 production bridges predate `mygo_bot_id`.
 * - For such a bridge, an exact expected Discord user id on the fixed expected
 *   port is sufficient identity evidence. Missing `mygo_bot_id` is therefore
 *   legacy-compatible, not an identity mismatch.
 * - Once `mygo_bot_id` exists, it must match exactly.
 */
function classifyDiagnostics(data, expectedUserId, expectedBotId) {
  const actualUserId = String(data?.discord_bot_id || "");
  const actualBotId = String(data?.mygo_bot_id || "");
  const expectedUser = String(expectedUserId || "");
  const expectedBot = String(expectedBotId || "");

  if (!actualUserId || actualUserId !== expectedUser) {
    return {
      healthy: false,
      occupied: true,
      legacy: false,
      reason: "identity mismatch expected=" + expectedUser + " actual=" + (actualUserId || "unknown"),
    };
  }
  if (data?.discord_ready !== true) {
    return { healthy: false, occupied: true, legacy: false, reason: "Discord client not ready" };
  }
  if (actualBotId && actualBotId !== expectedBot) {
    return {
      healthy: false,
      occupied: true,
      legacy: false,
      reason: "bot id mismatch expected=" + expectedBot + " actual=" + actualBotId,
    };
  }

  const legacy = !actualBotId;
  return {
    healthy: true,
    occupied: true,
    legacy,
    reason: legacy ? "legacy-compatible diagnostics" : "ok",
  };
}

async function healthState(port, expectedUserId, expectedBotId) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/diagnostics", { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { healthy: false, occupied: true, legacy: false, reason: "diagnostics HTTP " + response.status };
    const data = await response.json();
    return { ...classifyDiagnostics(data, expectedUserId, expectedBotId), data };
  } catch (error) {
    // An HTTP timeout does not prove the port is free. Probe TCP before spawn so
    // a hung/wrong process cannot make us launch a second bridge into EADDRINUSE.
    const occupied = await portIsListening(port);
    return {
      healthy: false,
      occupied,
      legacy: false,
      reason: occupied ? "port listening but diagnostics unavailable" : "offline",
      detail: error?.message || String(error),
    };
  }
}

function tokenFor(config, spec) {
  return config.channels?.discord?.accounts?.[spec.accountId]?.token || "";
}

async function waitForPortFree(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsListening(port, 250))) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !(await portIsListening(port, 250));
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this token.
    return error?.code === "EPERM";
  }
}

function acquireSupervisorLock() {
  if (lockOwned) return true;
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(fd, String(process.pid), "utf8");
    fs.closeSync(fd);
    lockOwned = true;
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let priorPid = 0;
  try { priorPid = Number(fs.readFileSync(LOCK_PATH, "utf8").trim()); } catch (_) {}
  if (priorPid && priorPid !== process.pid && processAlive(priorPid)) {
    console.log("[mygo-voice] another current supervisor is active pid=" + priorPid + "; exiting duplicate");
    return false;
  }

  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  const fd = fs.openSync(LOCK_PATH, "wx");
  fs.writeFileSync(fd, String(process.pid), "utf8");
  fs.closeSync(fd);
  lockOwned = true;
  return true;
}

function releaseSupervisorLock() {
  if (!lockOwned) return;
  try {
    const current = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
    if (current === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
  lockOwned = false;
}

async function ensure(spec) {
  const config = readConfig();
  const token = tokenFor(config, spec);
  if (!token) {
    console.error("[mygo-voice] " + spec.botId + ": token unavailable; bridge not started");
    return;
  }
  const userId = botUserId(token);
  if (!userId) {
    console.error("[mygo-voice] " + spec.botId + ": could not derive Discord user id; bridge not started");
    return;
  }

  const health = await healthState(spec.port, userId, spec.botId);
  if (health.healthy) {
    if (health.legacy && !legacyNotices.has(spec.botId)) {
      legacyNotices.add(spec.botId);
      console.log(
        "[mygo-voice] " + spec.botId + ": compatible legacy bridge on " + spec.port +
        " (Discord user verified; mygo_bot_id unavailable). It may continue until the planned Music activation/restart."
      );
    }
    return;
  }

  const existing = children.get(spec.botId);
  const managedAlive = Boolean(existing && !existing.killed && existing.exitCode == null);
  if (health.occupied) {
    if (!managedAlive) {
      // Unknown/pre-existing process that does NOT pass the compatibility
      // identity contract. Never kill it just because it owns this port.
      console.error("[mygo-voice] " + spec.botId + ": port " + spec.port + " occupied but unhealthy: " + health.reason);
      return;
    }

    console.error("[mygo-voice] " + spec.botId + ": managed bridge unhealthy; restarting: " + health.reason);
    try { existing.kill(); } catch (_) {}
    children.delete(spec.botId);
    if (!(await waitForPortFree(spec.port))) {
      console.error("[mygo-voice] " + spec.botId + ": managed child stopped but port " + spec.port + " is still occupied; replacement blocked");
      return;
    }
  } else if (managedAlive) {
    // Child is alive but has not opened its port yet. Do not duplicate it.
    return;
  }

  const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_TOKEN: token,
      BOT_USER_ID: userId,
      BRIDGE_PORT: String(spec.port),
      MYGO_BOT_ID: spec.botId,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  children.set(spec.botId, child);
  legacyNotices.delete(spec.botId);
  child.on("exit", (code, signal) => {
    console.error("[mygo-voice] " + spec.botId + " bridge exited code=" + (code ?? "null") + " signal=" + (signal || "none"));
    if (children.get(spec.botId) === child) children.delete(spec.botId);
  });
  console.log("[mygo-voice] started " + spec.botId + " bridge on " + spec.port + " user=" + userId);
}

async function reconcile() {
  for (const spec of SPECS) {
    try {
      await ensure(spec);
    } catch (error) {
      console.error("[mygo-voice] " + spec.botId + " reconcile failed: " + (error?.message || String(error)));
    }
  }
}

async function main() {
  if (!acquireSupervisorLock()) return;
  await reconcile();
  reconcileTimer = setInterval(() => { void reconcile(); }, 10000);
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  console.log("[mygo-voice] shutdown " + signal + "; stopping managed bridges");
  for (const child of children.values()) {
    try { child.kill(); } catch (_) {}
  }
  releaseSupervisorLock();
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => releaseSupervisorLock());

module.exports = {
  SPECS,
  botUserId,
  classifyDiagnostics,
  healthState,
  portIsListening,
};

if (require.main === module) {
  void main();
}

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = process.env.RANA_VISION_FEEDBACK_DIR || 'C:\\tmp\\rana-vision-feedback';

function safeRequestId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9-]{8,64}$/.test(text) ? text : '';
}

function snowflake(value) {
  const text = String(value || '').trim();
  return /^\d{17,20}$/.test(text) ? text : '';
}

function parseVisionFeedbackCustomId(value) {
  const parts = String(value || '').split('|');
  if (parts[0] === 'vf' && parts.length === 4) {
    const parsed = {
      type: 'button',
      action: parts[1],
      requestId: safeRequestId(parts[2]),
      requesterId: snowflake(parts[3]),
    };
    return parsed.requestId && parsed.requesterId ? parsed : null;
  }
  if (parts[0] === 'vfm' && parts.length === 3) {
    const parsed = {
      type: 'modal',
      action: 'wrong',
      requestId: safeRequestId(parts[1]),
      requesterId: snowflake(parts[2]),
    };
    return parsed.requestId && parsed.requesterId ? parsed : null;
  }
  return null;
}

function createVisionFeedbackStore(root = DEFAULT_ROOT) {
  const pendingDir = path.join(root, 'pending');
  const resultDir = path.join(root, 'results');
  const logPath = path.join(root, 'feedback.jsonl');

  function ensure() {
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
  }

  function readPending(requestId) {
    const clean = safeRequestId(requestId);
    if (!clean) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(pendingDir, `${clean}.json`), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function record(requestId, actorId, verdict, correction = '') {
    const clean = safeRequestId(requestId);
    const actor = snowflake(actorId);
    const pending = readPending(clean);
    if (!clean || !actor || !pending) return { status: 'missing' };
    const result = {
      schema: 'rana.vision.feedback.v1',
      recordedAt: new Date().toISOString(),
      requestId: clean,
      actorId: actor,
      verdict: verdict === 'incorrect' ? 'incorrect' : 'correct',
      correction: String(correction || '').trim().slice(0, 160),
      pending,
    };
    ensure();
    fs.appendFileSync(logPath, `${JSON.stringify(result)}\n`, 'utf8');
    fs.writeFileSync(path.join(resultDir, `${clean}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return { status: 'recorded', result };
  }

  return { readPending, record, root, logPath };
}

module.exports = {
  createVisionFeedbackStore,
  parseVisionFeedbackCustomId,
};

'use strict';

const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 7000, 15000, 30000]);

function firstText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeQueueMode(value) {
  return String(value || '').toLowerCase() === 'next' ? 'next' : 'append';
}

function insertQueueItems(queue, incoming, mode) {
  if (!Array.isArray(queue) || !Array.isArray(incoming)) throw new TypeError('queue/incoming must be arrays');
  if (normalizeQueueMode(mode) === 'next') queue.unshift(...incoming);
  else queue.push(...incoming);
  return queue;
}

function trackKey(track) {
  if (!track || typeof track !== 'object') return '';
  const encoded = firstText(track.encoded);
  if (encoded) return `encoded:${encoded}`;
  const info = track.info || {};
  const identifier = firstText(info.identifier);
  const uri = firstText(info.uri);
  if (identifier || uri) return `info:${identifier}|${uri}`;
  return '';
}

function currentTrackKey(current) {
  if (!current || typeof current !== 'object') return '';
  if (firstText(current.encoded)) return `encoded:${current.encoded}`;
  if (firstText(current.track_key)) return current.track_key;
  const identifier = firstText(current.identifier);
  const uri = firstText(current.stream_url) || firstText(current.source_url);
  return identifier || uri ? `info:${identifier}|${uri}` : '';
}

function eventMatchesCurrent(current, eventTrack) {
  const currentKey = currentTrackKey(current);
  const eventKey = trackKey(eventTrack);
  return Boolean(currentKey && eventKey && currentKey === eventKey);
}

function shouldAdvanceForTrackEnd(reason) {
  const normalized = String(reason || '').toUpperCase();
  return normalized === 'FINISHED' || normalized === 'LOADFAILED';
}

function voiceCloseAction(code) {
  const numeric = Number(code);
  // Discord voice close semantics: 4006=session invalid, 4009=session timeout,
  // 4015=voice server crashed. These can be recovered with a fresh voice
  // handshake. Explicit disconnect / protocol / rate-limit / terminated-call
  // failures must not enter an automatic reconnect loop.
  if ([4006, 4009, 4015].includes(numeric)) return 'recover';
  if ([4014, 4016, 4017, 4020, 4021, 4022].includes(numeric)) return 'terminal';
  return 'observe';
}

function statusFromError(error) {
  const status = Number(error?.upstreamStatus ?? error?.upstream_status ?? error?.status ?? 0);
  return Number.isFinite(status) ? status : 0;
}

function isTransientPlaybackError(error) {
  const status = statusFromError(error);
  const stage = firstText(error?.stage).toLowerCase();
  const message = String(error?.message || error || '');

  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|request timeout|timed out|session not established|Discord bot not ready|No shard available|Voice join timeout/i.test(message)) return true;
  if (stage === 'voice_join' || stage === 'voice_bridge' || stage === 'update_player') {
    // Update-player 400 generally means a deterministic contract error and must
    // not churn through the queue. Other network/session failures can recover.
    if (status === 400) return false;
    return true;
  }
  if (stage === 'resolve_track' && (status === 429 || status >= 500 || status === 0)) return true;
  if (stage === 'loadtracks' && (status === 429 || status >= 500 || status === 0)) return true;
  return false;
}

function retryDelayMs(retryCount) {
  const index = Math.max(0, Number(retryCount || 1) - 1);
  return TRANSIENT_RETRY_DELAYS_MS[index] ?? null;
}

function publicFailure(error) {
  const message = String(error?.message || error || 'playback failed')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
  return {
    stage: firstText(error?.stage) || 'playback',
    upstream_status: statusFromError(error) || null,
    message,
  };
}

module.exports = {
  TRANSIENT_RETRY_DELAYS_MS,
  currentTrackKey,
  eventMatchesCurrent,
  insertQueueItems,
  isTransientPlaybackError,
  normalizeQueueMode,
  publicFailure,
  retryDelayMs,
  shouldAdvanceForTrackEnd,
  trackKey,
  voiceCloseAction,
};

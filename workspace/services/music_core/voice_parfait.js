// 抹茶芭菲 voice time: built from Discord voice-state events only. No audio is received.
// A member's time counts while they are in a voice channel, not deafened, not in the
// guild's AFK channel, and at least one other non-bot member is in the same channel.
// Seconds are reported to hot_tools, which owns the 30-minute threshold and the ledger.

function createVoiceParfaitTracker({ now = Date.now, isBot = () => false, afkChannelOf = () => null, report } = {}) {
  const members = new Map(); // userId -> { guildId, channelId, selfDeaf, serverDeaf }
  const pending = new Map(); // userId -> eligible milliseconds not yet reported
  let eligibleNow = new Set();
  let lastTick = now();

  function eligible(userId) {
    const state = members.get(userId);
    if (!state?.channelId || isBot(userId)) return false;
    if (state.selfDeaf || state.serverDeaf) return false;
    if (afkChannelOf(state.guildId) === state.channelId) return false;
    for (const [otherId, other] of members) {
      if (otherId !== userId && other.guildId === state.guildId && other.channelId === state.channelId && !isBot(otherId)) return true;
    }
    return false;
  }

  function accrue(t = now()) {
    const elapsed = Math.max(0, t - lastTick);
    lastTick = t;
    if (!elapsed) return;
    for (const userId of eligibleNow) pending.set(userId, (pending.get(userId) || 0) + elapsed);
  }

  function recompute() {
    eligibleNow = new Set([...members.keys()].filter(eligible));
  }

  // Voice time is settled up to now before the change, so it is credited to the state that earned it.
  function update({ userId, guildId, channelId, selfDeaf = false, serverDeaf = false }, t = now()) {
    if (!userId) return;
    accrue(t);
    const id = String(userId);
    if (channelId) members.set(id, { guildId: String(guildId || ""), channelId: String(channelId), selfDeaf: Boolean(selfDeaf), serverDeaf: Boolean(serverDeaf) });
    else members.delete(id);
    recompute();
    if (!channelId) return flushUser(id, String(guildId || ""));
    return null;
  }

  function flushUser(userId, guildId = members.get(userId)?.guildId || "") {
    const ms = pending.get(userId) || 0;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 1) return null;
    pending.set(userId, ms - seconds * 1000);
    return Promise.resolve(report?.(userId, seconds, guildId))
      .then((ok) => {
        if (ok === false) pending.set(userId, (pending.get(userId) || 0) + seconds * 1000);
      })
      .catch(() => pending.set(userId, (pending.get(userId) || 0) + seconds * 1000));
  }

  function flush(t = now()) {
    accrue(t);
    return Promise.all([...pending.keys()].map((userId) => flushUser(userId)).filter(Boolean));
  }

  return {
    update,
    flush,
    // A bot flag learned later can change who is "alone".
    refresh(t = now()) {
      accrue(t);
      recompute();
    },
    pendingSeconds(userId) {
      return Math.floor((pending.get(String(userId)) || 0) / 1000);
    },
    eligibleUsers() {
      return [...eligibleNow];
    },
  };
}

// Raw MESSAGE_CREATE -> /parfait/activity body. Only people's guild messages count:
// no DMs, bots, webhooks, or messages without text (hot_tools applies the length rule).
function parfaitMessageReport(data) {
  if (!data?.guild_id || data.webhook_id || data.author?.bot || !data.author?.id || !data.content) return null;
  return { user_id: String(data.author.id), text: String(data.content), guild_id: String(data.guild_id) };
}

module.exports = { createVoiceParfaitTracker, parfaitMessageReport };

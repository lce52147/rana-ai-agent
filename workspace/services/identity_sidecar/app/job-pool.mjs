export function createJobPool({ concurrency = 2, maxQueuedJobs = 8 } = {}) {
  const limit = Math.max(1, Math.min(4, Number(concurrency || 1)));
  const queueLimit = Math.max(limit, Math.min(32, Number(maxQueuedJobs || 8)));
  const pending = [];
  let active = 0;
  let total = 0;

  const drain = () => {
    while (active < limit && pending.length > 0) {
      const entry = pending.shift();
      if (Number.isFinite(entry.deadlineAt) && Date.now() >= entry.deadlineAt) {
        total -= 1;
        Promise.resolve()
          .then(() => entry.onExpired?.())
          .then(entry.resolve, entry.reject);
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(entry.job)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          total -= 1;
          drain();
        });
    }
  };

  return {
    enqueue(job, { deadlineAt = null, onExpired = null } = {}) {
      if (total >= queueLimit) {
        throw Object.assign(new Error("identity queue is full"), { statusCode: 429 });
      }
      total += 1;
      return new Promise((resolve, reject) => {
        pending.push({
          job,
          resolve,
          reject,
          deadlineAt: deadlineAt === null || deadlineAt === undefined || !Number.isFinite(Number(deadlineAt))
            ? null
            : Number(deadlineAt),
          onExpired,
        });
        drain();
      });
    },
    snapshot() {
      return { concurrency: limit, active_jobs: active, queue_depth: total, waiting_jobs: pending.length };
    },
  };
}

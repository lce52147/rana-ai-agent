// 抹茶芭菲 ledger: one wallet per Discord user. The database lives outside git
// (<openclaw root>/state/rana_parfait.sqlite) because it is keyed by real user ids.
// Every threshold comes from rules.json "parfait" so it can be tuned without code changes.
const fs = require("fs");
const path = require("path");

const PARFAIT_DEFAULTS = Object.freeze({
  enabled: true,
  startCups: 3,
  cap: 30,
  boosterStartCups: 6,
  boosterBonusCups: 10,
  boosterCap: 60,
  boosterRoles: [],
  dailyGrant: 1,
  textMinChars: 5,
  voiceMinSeconds: 1800,
  voiceMaxFlushSeconds: 900,
  streakDays: 7,
  streakBonus: 3,
  rememberPrice: 1,
  timeZone: "Asia/Taipei",
});

function parfaitConfig(rules = {}) {
  return { ...PARFAIT_DEFAULTS, ...(rules?.parfait || {}) };
}

function dayKey(ts, timeZone = PARFAIT_DEFAULTS.timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// Mentions, custom emoji, links, whitespace, punctuation and symbols (most emoji) do not count.
function countedChars(text) {
  const clean = String(text || "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/<[@#][!&]?\d+>/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return [...clean].length;
}

function openParfaitLedger({ dbPath, DatabaseSync } = {}) {
  const Database = DatabaseSync || require("node:sqlite").DatabaseSync;
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS parfait_accounts (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL,
      booster INTEGER NOT NULL DEFAULT 0,
      booster_bonus_given INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      last_active_day TEXT,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parfait_days (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      text_count INTEGER NOT NULL DEFAULT 0,
      voice_seconds INTEGER NOT NULL DEFAULT 0,
      granted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS parfait_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL
    );
  `);

  const stmt = {
    getAccount: db.prepare("SELECT * FROM parfait_accounts WHERE user_id = ?"),
    insertAccount: db.prepare("INSERT INTO parfait_accounts (user_id, balance, booster, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)"),
    setBalance: db.prepare("UPDATE parfait_accounts SET balance = ?, updated_ts = ? WHERE user_id = ?"),
    setBooster: db.prepare("UPDATE parfait_accounts SET booster = ?, updated_ts = ? WHERE user_id = ?"),
    setBonusGiven: db.prepare("UPDATE parfait_accounts SET booster_bonus_given = 1 WHERE user_id = ?"),
    setStreak: db.prepare("UPDATE parfait_accounts SET streak = ?, last_active_day = ? WHERE user_id = ?"),
    insertEvent: db.prepare("INSERT INTO parfait_events (ts, user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?, ?)"),
    ensureDay: db.prepare("INSERT OR IGNORE INTO parfait_days (user_id, day) VALUES (?, ?)"),
    getDay: db.prepare("SELECT * FROM parfait_days WHERE user_id = ? AND day = ?"),
    addText: db.prepare("UPDATE parfait_days SET text_count = text_count + 1 WHERE user_id = ? AND day = ?"),
    addVoice: db.prepare("UPDATE parfait_days SET voice_seconds = voice_seconds + ? WHERE user_id = ? AND day = ?"),
    setGranted: db.prepare("UPDATE parfait_days SET granted = 1 WHERE user_id = ? AND day = ?"),
  };

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function capFor(account, cfg) {
    return account.booster ? cfg.boosterCap : cfg.cap;
  }

  function setBalance(account, next, reason, now) {
    const delta = next - account.balance;
    if (!delta) return 0;
    stmt.setBalance.run(next, now, account.user_id);
    stmt.insertEvent.run(now, account.user_id, delta, reason, next);
    account.balance = next;
    return delta;
  }

  // Earned cups stop at the cap. A balance already above the cap (a lapsed booster) is kept, never trimmed.
  function earn(account, amount, reason, cfg, now) {
    const next = Math.max(account.balance, Math.min(capFor(account, cfg), account.balance + amount));
    return setBalance(account, next, reason, now);
  }

  // booster === undefined means the Discord lookup failed: keep the stored flag.
  function ensureAccount(userId, booster, cfg, now) {
    let row = stmt.getAccount.get(userId);
    if (!row) {
      const start = booster ? cfg.boosterStartCups : cfg.startCups;
      stmt.insertAccount.run(userId, start, booster ? 1 : 0, now, now);
      stmt.insertEvent.run(now, userId, start, booster ? "start_booster" : "start", start);
      row = stmt.getAccount.get(userId);
    }
    const account = { ...row };
    if (booster !== undefined && Boolean(account.booster) !== Boolean(booster)) {
      account.booster = booster ? 1 : 0;
      stmt.setBooster.run(account.booster, now, userId);
    }
    if (account.booster && !account.booster_bonus_given) {
      earn(account, cfg.boosterBonusCups, "booster_bonus", cfg, now);
      stmt.setBonusGiven.run(userId);
      account.booster_bonus_given = 1;
    }
    return account;
  }

  function grantDaily(account, day, source, cfg, now) {
    const dayRow = stmt.getDay.get(account.user_id, day);
    if (dayRow?.granted) return { granted: 0, bonus: 0, streak: account.streak };
    stmt.setGranted.run(account.user_id, day);
    const granted = earn(account, cfg.dailyGrant, `daily_${source}`, cfg, now);
    const streak = account.last_active_day === previousDay(day) ? account.streak + 1 : 1;
    stmt.setStreak.run(streak, day, account.user_id);
    account.streak = streak;
    account.last_active_day = day;
    const bonus = cfg.streakDays > 0 && streak % cfg.streakDays === 0
      ? earn(account, cfg.streakBonus, "streak_bonus", cfg, now)
      : 0;
    return { granted, bonus, streak };
  }

  function summary(account, cfg, day) {
    const dayRow = stmt.getDay.get(account.user_id, day);
    return {
      balance: account.balance,
      cap: capFor(account, cfg),
      booster: Boolean(account.booster),
      streak: account.last_active_day === day || account.last_active_day === previousDay(day) ? account.streak : 0,
      today_granted: Boolean(dayRow?.granted),
      today_voice_seconds: Number(dayRow?.voice_seconds || 0),
    };
  }

  return {
    // Lets callers skip the Discord member lookup once today's grant is done.
    grantedToday(userId, { now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      return Boolean(stmt.getDay.get(String(userId), dayKey(now, config.timeZone))?.granted);
    },
    // Counts a message on a day whose cup is already granted (activity stats only, no cups).
    noteText(userId, { now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      stmt.addText.run(String(userId), dayKey(now, config.timeZone));
    },
    recordText(userId, { text, booster, now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      if (countedChars(text) < config.textMinChars) return { ok: true, counted: false };
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(String(userId), booster, config, now);
        stmt.ensureDay.run(account.user_id, day);
        stmt.addText.run(account.user_id, day);
        const result = grantDaily(account, day, "text", config, now);
        return { ok: true, counted: true, ...result, ...summary(account, config, day) };
      });
    },
    recordVoice(userId, { seconds, booster, now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      const added = Math.max(0, Math.min(Math.floor(Number(seconds) || 0), config.voiceMaxFlushSeconds));
      if (!added) return { ok: true, counted: false };
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(String(userId), booster, config, now);
        stmt.ensureDay.run(account.user_id, day);
        stmt.addVoice.run(added, account.user_id, day);
        const voiceSeconds = Number(stmt.getDay.get(account.user_id, day).voice_seconds);
        const result = voiceSeconds >= config.voiceMinSeconds
          ? grantDaily(account, day, "voice", config, now)
          : { granted: 0, bonus: 0, streak: account.streak };
        return { ok: true, counted: true, added, ...result, ...summary(account, config, day) };
      });
    },
    balance(userId, { booster, now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(String(userId), booster, config, now);
        return { ok: true, ...summary(account, config, day) };
      });
    },
    spend(userId, { amount, reason, booster, now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      const price = Math.max(0, Math.floor(Number(amount) || 0));
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(String(userId), booster, config, now);
        if (account.balance < price) return { ok: false, price, ...summary(account, config, day) };
        setBalance(account, account.balance - price, reason || "spend", now);
        return { ok: true, price, ...summary(account, config, day) };
      });
    },
    // Exchange into 抹茶芭菲: refuses instead of trimming past the cap (the booster cap for boosters).
    credit(userId, { amount, reason, booster, now = Date.now(), config = PARFAIT_DEFAULTS } = {}) {
      const count = Math.max(0, Math.floor(Number(amount) || 0));
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(String(userId), booster, config, now);
        const before = summary(account, config, day);
        const room = Math.max(0, before.cap - account.balance);
        if (count > room) return { ok: false, reason: "cap", room, ...before };
        setBalance(account, account.balance + count, reason || "exchange", now);
        return { ok: true, ...summary(account, config, day) };
      });
    },
    // Gives back a charge whose action failed; ignores the cap so the user is made whole.
    refund(userId, { amount, reason, now = Date.now() } = {}) {
      return transaction(() => {
        const row = stmt.getAccount.get(String(userId));
        if (!row) return { ok: false };
        const account = { ...row };
        setBalance(account, account.balance + Math.max(0, Math.floor(Number(amount) || 0)), reason || "refund", now);
        return { ok: true, balance: account.balance };
      });
    },
    // Highest balance first; ties go to whoever reached the balance earlier. rank counts
    // only strictly higher balances, so equal balances share a rank.
    leaderboard(limit = 10) {
      const top = db.prepare("SELECT user_id, balance FROM parfait_accounts ORDER BY balance DESC, updated_ts ASC LIMIT ?")
        .all(Math.max(1, Math.min(50, Math.floor(Number(limit) || 10))));
      const rankOf = db.prepare("SELECT COUNT(*) AS higher FROM parfait_accounts WHERE balance > ?");
      return top.map((row) => ({ user_id: row.user_id, balance: row.balance, rank: Number(rankOf.get(row.balance).higher) + 1 }));
    },
    // Every positive balance, for the combined gift leaderboard.
    allBalances() {
      return db.prepare("SELECT user_id, balance, updated_ts FROM parfait_accounts WHERE balance > 0").all();
    },
    standing(userId) {
      const row = stmt.getAccount.get(String(userId));
      if (!row) return null;
      const higher = Number(db.prepare("SELECT COUNT(*) AS higher FROM parfait_accounts WHERE balance > ?").get(row.balance).higher);
      const total = Number(db.prepare("SELECT COUNT(*) AS total FROM parfait_accounts").get().total);
      return { balance: row.balance, rank: higher + 1, total };
    },
    events(userId, limit = 20) {
      return db.prepare("SELECT ts, delta, reason, balance_after FROM parfait_events WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(String(userId), limit);
    },
    close() {
      db.close();
    },
  };
}

module.exports = { PARFAIT_DEFAULTS, parfaitConfig, dayKey, previousDay, countedChars, openParfaitLedger };

// Per-character gift wallets (企鵝貼紙 for 燈, 熊貓吊飾 for 立希, ...). Rana's own gift is
// 抹茶芭菲, which lives in parfait_ledger.js. A gift is earned by talking to that character.
// The database lives outside git (<openclaw root>/state/rana_gifts.sqlite); every rule and
// gift name comes from rules.json "gifts" so it can be tuned without code changes.
const fs = require("fs");
const path = require("path");
const { dayKey, previousDay, countedChars } = require("./parfait_ledger");

const GIFT_DEFAULTS = Object.freeze({
  enabled: true,
  startCount: 0,
  cap: 30,
  dailyGrant: 1,
  textMinChars: 5,
  streakDays: 7,
  streakBonus: 3,
  exchangeRate: 1, // units given per unit received, for every pair (抹茶芭菲 and the four gifts)
  timeZone: "Asia/Taipei",
  characters: Object.freeze({
    // aliases: other spellings people type for the gift (typos included); kept specific so
    // ordinary talk such as 「換手機」 is not read as an exchange.
    tomori: Object.freeze({ name: "企鵝貼紙", unit: "張", emoji: "🐧", aliases: Object.freeze(["企鵝貼", "貼紙"]) }),
    taki: Object.freeze({ name: "熊貓吊飾", unit: "個", emoji: "🐼", aliases: Object.freeze(["熊貓"]) }),
    soyo: Object.freeze({ name: "香水", unit: "瓶", emoji: "🌸", aliases: Object.freeze([]) }),
    anon: Object.freeze({ name: "手機吊飾", unit: "個", emoji: "📱", aliases: Object.freeze([]) }),
  }),
});

// rules.gifts may override the shared numbers and, per character, the gift name/unit or numbers.
function giftConfig(rules = {}, botId = "") {
  const raw = rules?.gifts || {};
  const base = GIFT_DEFAULTS.characters[botId];
  const override = raw.characters?.[botId];
  if (!base && !override) return null;
  // Per field, so a rules.json entry that only names the gift keeps the default emoji and aliases.
  const character = { ...(base || {}), ...(override || {}) };
  const { characters: _ignored, ...shared } = raw;
  return { ...GIFT_DEFAULTS, ...shared, ...character, botId, characters: undefined };
}

function openGiftLedger({ dbPath, DatabaseSync } = {}) {
  const Database = DatabaseSync || require("node:sqlite").DatabaseSync;
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS gift_accounts (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      balance INTEGER NOT NULL,
      streak INTEGER NOT NULL DEFAULT 0,
      last_active_day TEXT,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (bot_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS gift_days (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      text_count INTEGER NOT NULL DEFAULT 0,
      granted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, user_id, day)
    );
    CREATE TABLE IF NOT EXISTS gift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL
    );
    -- What each user has given each character (any of the five currencies), for gift-unlocked features.
    CREATE TABLE IF NOT EXISTS character_gifts (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      currency_id TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (bot_id, user_id, currency_id)
    );
    CREATE TABLE IF NOT EXISTS character_gift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      currency_id TEXT NOT NULL,
      count INTEGER NOT NULL
    );
  `);

  const stmt = {
    getAccount: db.prepare("SELECT * FROM gift_accounts WHERE bot_id = ? AND user_id = ?"),
    insertAccount: db.prepare("INSERT INTO gift_accounts (bot_id, user_id, balance, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)"),
    setBalance: db.prepare("UPDATE gift_accounts SET balance = ?, updated_ts = ? WHERE bot_id = ? AND user_id = ?"),
    setStreak: db.prepare("UPDATE gift_accounts SET streak = ?, last_active_day = ? WHERE bot_id = ? AND user_id = ?"),
    insertEvent: db.prepare("INSERT INTO gift_events (ts, bot_id, user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?, ?, ?)"),
    ensureDay: db.prepare("INSERT OR IGNORE INTO gift_days (bot_id, user_id, day) VALUES (?, ?, ?)"),
    getDay: db.prepare("SELECT * FROM gift_days WHERE bot_id = ? AND user_id = ? AND day = ?"),
    addText: db.prepare("UPDATE gift_days SET text_count = text_count + 1 WHERE bot_id = ? AND user_id = ? AND day = ?"),
    setGranted: db.prepare("UPDATE gift_days SET granted = 1 WHERE bot_id = ? AND user_id = ? AND day = ?"),
    top: db.prepare("SELECT user_id, balance FROM gift_accounts WHERE bot_id = ? AND balance > 0 ORDER BY balance DESC, updated_ts ASC LIMIT ?"),
    higher: db.prepare("SELECT COUNT(*) AS higher FROM gift_accounts WHERE bot_id = ? AND balance > ?"),
    holders: db.prepare("SELECT COUNT(*) AS total FROM gift_accounts WHERE bot_id = ? AND balance > 0"),
    addReceived: db.prepare("INSERT INTO character_gifts (bot_id, user_id, currency_id, count, updated_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bot_id, user_id, currency_id) DO UPDATE SET count = count + excluded.count, updated_ts = excluded.updated_ts"),
    receivedEvent: db.prepare("INSERT INTO character_gift_events (ts, bot_id, user_id, currency_id, count) VALUES (?, ?, ?, ?, ?)"),
    received: db.prepare("SELECT currency_id, count FROM character_gifts WHERE bot_id = ? AND user_id = ?"),
  };

  function receivedBy(botId, userId) {
    return Object.fromEntries(stmt.received.all(botId, String(userId)).map((row) => [row.currency_id, Number(row.count)]));
  }

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

  function ensureAccount(botId, userId, cfg, now) {
    let row = stmt.getAccount.get(botId, userId);
    if (!row) {
      stmt.insertAccount.run(botId, userId, cfg.startCount, now, now);
      if (cfg.startCount) stmt.insertEvent.run(now, botId, userId, cfg.startCount, "start", cfg.startCount);
      row = stmt.getAccount.get(botId, userId);
    }
    return { ...row };
  }

  // Earned gifts stop at the cap; a balance already above it is kept.
  function earn(account, amount, reason, cfg, now) {
    const next = Math.max(account.balance, Math.min(cfg.cap, account.balance + amount));
    const delta = next - account.balance;
    if (!delta) return 0;
    stmt.setBalance.run(next, now, account.bot_id, account.user_id);
    stmt.insertEvent.run(now, account.bot_id, account.user_id, delta, reason, next);
    account.balance = next;
    return delta;
  }

  return {
    recordTalk(userId, { text, now = Date.now(), config } = {}) {
      if (!config || countedChars(text) < config.textMinChars) return { ok: true, counted: false };
      const botId = config.botId;
      const day = dayKey(now, config.timeZone);
      return transaction(() => {
        const account = ensureAccount(botId, String(userId), config, now);
        stmt.ensureDay.run(botId, account.user_id, day);
        stmt.addText.run(botId, account.user_id, day);
        if (stmt.getDay.get(botId, account.user_id, day).granted) return { ok: true, counted: true, granted: 0, bonus: 0, balance: account.balance };
        stmt.setGranted.run(botId, account.user_id, day);
        const granted = earn(account, config.dailyGrant, "daily_talk", config, now);
        const streak = account.last_active_day === previousDay(day) ? account.streak + 1 : 1;
        stmt.setStreak.run(streak, day, botId, account.user_id);
        const bonus = config.streakDays > 0 && streak % config.streakDays === 0 ? earn(account, config.streakBonus, "streak_bonus", config, now) : 0;
        return { ok: true, counted: true, granted, bonus, streak, balance: account.balance };
      });
    },
    // Exchange path (another gift or 抹茶芭菲 -> this gift). Refuses instead of trimming past the cap.
    credit(userId, { amount, reason, now = Date.now(), config } = {}) {
      const count = Math.max(0, Math.floor(Number(amount) || 0));
      return transaction(() => {
        const account = ensureAccount(config.botId, String(userId), config, now);
        const room = Math.max(0, config.cap - account.balance);
        if (count > room) return { ok: false, reason: "cap", room, balance: account.balance, cap: config.cap };
        earn(account, count, reason || "exchange", config, now);
        return { ok: true, balance: account.balance, cap: config.cap };
      });
    },
    // Exchange path (this gift -> another gift or 抹茶芭菲).
    spend(userId, { amount, reason, now = Date.now(), config } = {}) {
      const price = Math.max(0, Math.floor(Number(amount) || 0));
      return transaction(() => {
        const account = ensureAccount(config.botId, String(userId), config, now);
        if (account.balance < price) return { ok: false, price, balance: account.balance, cap: config.cap };
        const next = account.balance - price;
        stmt.setBalance.run(next, now, account.bot_id, account.user_id);
        stmt.insertEvent.run(now, account.bot_id, account.user_id, -price, reason || "spend", next);
        return { ok: true, price, balance: next, cap: config.cap };
      });
    },
    // Gives back a spend whose exchange failed; ignores the cap so the user is made whole.
    refund(userId, { amount, reason, now = Date.now(), config } = {}) {
      return transaction(() => {
        const account = ensureAccount(config.botId, String(userId), config, now);
        const next = account.balance + Math.max(0, Math.floor(Number(amount) || 0));
        stmt.setBalance.run(next, now, account.bot_id, account.user_id);
        stmt.insertEvent.run(now, account.bot_id, account.user_id, next - account.balance, reason || "refund", next);
        return { ok: true, balance: next };
      });
    },
    balance(userId, { config } = {}) {
      const row = stmt.getAccount.get(config.botId, String(userId));
      return { ok: true, balance: row ? row.balance : config.startCount, cap: config.cap };
    },
    leaderboard(botId, limit = 10) {
      const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
      return stmt.top.all(botId, size).map((row) => ({ user_id: row.user_id, balance: row.balance, rank: Number(stmt.higher.get(botId, row.balance).higher) + 1 }));
    },
    // Every positive balance of every character, for the combined gift leaderboard.
    allBalances() {
      return db.prepare("SELECT bot_id, user_id, balance, updated_ts FROM gift_accounts WHERE balance > 0").all();
    },
    // The user already paid from their wallet; this records it as received by the character.
    receiveGift(botId, userId, currencyId, amount, { now = Date.now() } = {}) {
      const count = Math.max(0, Math.floor(Number(amount) || 0));
      return transaction(() => {
        stmt.addReceived.run(botId, String(userId), currencyId, count, now);
        stmt.receivedEvent.run(now, botId, String(userId), currencyId, count);
        return receivedBy(botId, userId);
      });
    },
    // Who has given this character the most (all five currencies 1:1), ties share a rank.
    intimacyBoard(botId, limit = 10) {
      const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
      const rows = db.prepare("SELECT user_id, SUM(count) AS total, MAX(updated_ts) AS updated_ts FROM character_gifts WHERE bot_id = ? GROUP BY user_id HAVING total > 0 ORDER BY total DESC, updated_ts ASC").all(botId);
      const ranked = rows.map((row) => ({ user_id: row.user_id, total: Number(row.total) }));
      for (const row of ranked) row.rank = ranked.filter((other) => other.total > row.total).length + 1;
      return { rows: ranked.slice(0, size), holders: ranked.length, all: ranked };
    },
    // { currencyId: total } the user has given this character.
    received(botId, userId) {
      return receivedBy(botId, userId);
    },
    standing(botId, userId) {
      const row = stmt.getAccount.get(botId, String(userId));
      const total = Number(stmt.holders.get(botId).total);
      if (!row || row.balance <= 0) return { balance: row ? row.balance : 0, rank: null, total };
      return { balance: row.balance, rank: Number(stmt.higher.get(botId, row.balance).higher) + 1, total };
    },
    close() {
      db.close();
    },
  };
}

module.exports = { GIFT_DEFAULTS, giftConfig, openGiftLedger };

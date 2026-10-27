// Exchange between any two of the five currencies: 抹茶芭菲 (樂奈) and the four character gifts.
// Parsing is kept apart from the ledgers so it can be tested on its own; server.js supplies
// wallets with balance / spend / credit / refund for the asking user.
const { giftConfig } = require("./gift_ledger");

const PARFAIT_CURRENCY = Object.freeze({ id: "rana", name: "抹茶芭菲", unit: "杯", emoji: "🍨", aliases: Object.freeze(["芭菲"]) });
const GIFT_BOTS = Object.freeze(["tomori", "taki", "soyo", "anon"]);
const CHINESE_COUNTS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const MAX_COUNT = 30;

function currencyCatalog(rules = {}) {
  const gifts = GIFT_BOTS.map((botId) => giftConfig(rules, botId)).filter(Boolean)
    .map((cfg) => ({ id: cfg.botId, name: cfg.name, unit: cfg.unit, emoji: cfg.emoji || "🎁", aliases: cfg.aliases || [] }));
  return [PARFAIT_CURRENCY, ...gifts];
}

function currencyById(catalog, id) {
  return catalog.find((currency) => currency.id === id) || null;
}

// Every currency named in the text, in order; longer spellings win where they overlap.
function currencyMentions(text, catalog) {
  const spellings = catalog
    .flatMap((currency) => [currency.name, ...currency.aliases].filter(Boolean).map((word) => ({ id: currency.id, word })))
    .sort((a, b) => b.word.length - a.word.length);
  const taken = new Array(text.length).fill(false);
  const found = [];
  for (const { id, word } of spellings) {
    let from = 0;
    for (let at = text.indexOf(word, from); at >= 0; at = text.indexOf(word, from)) {
      from = at + word.length;
      if (taken.slice(at, at + word.length).some(Boolean)) continue;
      for (let i = at; i < at + word.length; i += 1) taken[i] = true;
      found.push({ id, index: at, end: at + word.length });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function countFrom(text) {
  const match = text.match(/(\d+|[一二兩三四五六七八九十])\s*(?:個|張|瓶|杯|份)?/u);
  if (!match) return null;
  const value = /^\d+$/.test(match[1]) ? Number(match[1]) : CHINESE_COUNTS[match[1]];
  return value || null;
}

// 「我想用企鵝貼紙換抹茶芭菲 3杯」, 「換企鵝貼紙5張」, 「用 2 杯抹茶芭菲換」.
// The currency after 換 is what the user gets; the other named one (or 抹茶芭菲) is what they pay.
// Without a currency after 換, it must be 「用 X 換」 at a bot whose own currency is received.
// Returns null when the text is not an exchange, or { error } when it is but cannot be read.
function parseExchange(text, catalog, botId) {
  const clean = String(text || "").replace(/<@!?\d+>/g, " ").trim();
  // 「買了」「換過」 talk about the past; they are not requests.
  const verb = clean.search(/(?:兌換|換|買)(?![了過])/u);
  if (verb < 0) return null;
  const mentions = currencyMentions(clean, catalog);
  if (!mentions.length) return null;
  const after = mentions.filter((m) => m.index > verb);
  const before = mentions.filter((m) => m.end <= verb);
  const usesSource = /用/u.test(clean.slice(0, verb)) && before.length > 0;
  let target = after[0]?.id || null;
  if (!target) {
    if (!usesSource) return null;
    target = botId;
  }
  let source = (usesSource ? before[before.length - 1].id : null)
    || mentions.find((m) => m.id !== target)?.id
    || (target === PARFAIT_CURRENCY.id ? null : PARFAIT_CURRENCY.id);
  if (!currencyById(catalog, target)) return null;
  if (!source) return { kind: "exchange", error: "no_source", target };
  if (source === target) return { kind: "exchange", error: "same", target, source };
  const count = countFrom(clean.slice(verb)) || countFrom(clean) || 1;
  return { kind: "exchange", source, target, count: Math.max(1, Math.min(MAX_COUNT, count)) };
}

// Combined gift leaderboard: every exchange is 1:1 (user decision 2026-10-26), so the plain sum of
// all five currencies is a person's total and exchanging never changes the order.
function combineHoldings(parfaitRows, giftRows) {
  const people = new Map();
  const add = (userId, id, balance, updated) => {
    const person = people.get(userId) || { user_id: userId, total: 0, parts: {}, updated_ts: 0 };
    person.parts[id] = (person.parts[id] || 0) + Number(balance);
    person.total += Number(balance);
    person.updated_ts = Math.max(person.updated_ts, Number(updated) || 0);
    people.set(userId, person);
  };
  for (const row of parfaitRows) add(String(row.user_id), PARFAIT_CURRENCY.id, row.balance, row.updated_ts);
  for (const row of giftRows) add(String(row.user_id), row.bot_id, row.balance, row.updated_ts);
  const ranked = [...people.values()].filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total || a.updated_ts - b.updated_ts);
  for (const person of ranked) person.rank = ranked.filter((other) => other.total > person.total).length + 1;
  return ranked;
}

// 「🍨20 🐧5 🐼3」, in catalog order, skipping zeros.
function holdingsDetail(parts, catalog) {
  return catalog.filter((c) => parts[c.id] > 0).map((c) => `${c.emoji}${parts[c.id]}`).join(" ");
}

// 「親密度排行」 at a character = who has given her the most; 「我跟妳多親」 = the asker's own level.
function isIntimacyBoardQuestion(text) {
  return /親密度?.{0,3}(?:排行|排名|榜)|(?:排行|排名|榜).{0,3}親密|(?:誰|大家).{0,6}(?:最親|親密度)/u.test(String(text || ""));
}

function isOwnIntimacyQuestion(text) {
  return /(?:我們|我跟[妳你您]|我和[妳你您]|我跟.{1,4}|我和.{1,4}).{0,3}(?:多親|有多親|親密度)|我的親密度|親密度.{0,3}(?:多少|幾級|幾)/u.test(String(text || ""));
}

function isCombinedBoardQuestion(text) {
  return /禮物.{0,3}(?:排行|排名|榜)|(?:大家|所有人|全部人|誰).{0,8}禮物|(?:排行|排名|榜).{0,3}禮物/u.test(String(text || ""));
}

// Owner-only adjustments: 「給 @某人 20杯抹茶芭菲」, 「拿走 @某人 5張企鵝貼紙」. The currency defaults
// to the asked bot's own. Needs a mention of the person, so 「送我兩杯」 is never read as one.
// Discord often hands the text over with the mention already rendered as a name (「給 咳（主人） 20杯」);
// then targetId, the one human the message mentions (from Discord's mention list), is the person,
// and a count must follow so ordinary talk is not read as a grant.
function parseGrant(text, catalog, botId, targetId = "") {
  const raw = String(text || "");
  let match = raw.match(/(拿走|收回|沒收|扣掉?|給|發給?|加給?|送給?)\s*<@!?(\d{15,25})>/u);
  if (!match && /^\d{15,25}$/.test(String(targetId || ""))) {
    const verb = raw.match(/(拿走|收回|沒收|扣掉?|發給?|加給?|送給?|給)(?![妳你您我了過])/u);
    if (verb && countFrom(raw.slice(verb.index + verb[0].length))) match = Object.assign([verb[0], verb[1], String(targetId)], { index: verb.index });
  }
  if (!match) return null;
  const action = /拿走|收回|沒收|扣/u.test(match[1]) ? "take" : "give";
  const rest = raw.slice(match.index + match[0].length).replace(/<@!?\d+>/g, " ");
  const named = currencyMentions(rest, catalog)[0]?.id || null;
  const currency = named || (currencyById(catalog, botId) ? botId : null);
  if (!currency) return null;
  // A count with its unit first, so a name such as 「aua123」 is not read as 123.
  const unit = rest.match(/(\d+|[一二兩三四五六七八九十])\s*(?:個|張|瓶|杯|份)/u);
  const count = (unit ? countFrom(unit[0]) : null) || countFrom(rest) || 1;
  return { kind: "grant", action, userId: match[2], currency, count: Math.max(1, Math.min(1000, count)) };
}

// 「@樂奈 給妳 4 杯抹茶芭菲」: the user gives the asked character some of their own 抹茶芭菲 or gifts
// (any of the five). Needs 給/送 right before 妳/你/您 or the character's name, plus a named currency.
// 「給我」, 「給了你」, 「不給你」, questions, and anything with 換 are not gifts.
function parseGiveToBot(text, catalog, names = []) {
  const clean = String(text || "").replace(/<@!?\d+>/g, " ").trim();
  if (/換|要不要|嗎|[?？]/u.test(clean)) return null;
  const who = ["妳", "你", "您", ...names.filter(Boolean).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|");
  const verb = clean.match(new RegExp(`(?<![不沒別])(?:送給|交給|給|送)(?![了過])\\s*(?:${who})`, "u"));
  if (!verb) return null;
  const mentions = currencyMentions(clean, catalog);
  const named = mentions.find((m) => m.index >= verb.index) || mentions[0];
  if (!named) return null;
  const count = countFrom(clean.slice(verb.index)) || countFrom(clean) || 1;
  return { kind: "give", currency: named.id, count: Math.max(1, Math.min(1000, count)) };
}

// The text OpenClaw hands over renders mentions as 「@很COG」, not <@id>. For 「給 @很COG 200杯」 these
// are the names to look the person up by: everything up to the count, then just the first word.
function grantNameCandidates(text) {
  const match = String(text || "").match(/(?:拿走|收回|沒收|扣掉?|發給?|加給?|送給?|給)\s*@(.+)/u);
  if (!match) return [];
  const beforeCount = match[1].split(/\s*(?:\d+|[一二兩三四五六七八九十])\s*(?:個|張|瓶|杯|份)/u)[0].trim();
  return [...new Set([beforeCount, match[1].split(/\s+/u)[0]].map((name) => name.trim().slice(0, 32)).filter(Boolean))];
}

// wallets[id] = { balance(), spend(n, reason), credit(n, reason), refund(n, reason) }, each
// returning { ok, balance, cap? }. Check the target's room, take the source, then credit the
// target; a failed credit gives the source back.
function runExchange({ request, catalog, wallets, rate = 1 }) {
  const source = currencyById(catalog, request.source);
  const target = currencyById(catalog, request.target);
  const pay = wallets[request.source];
  const get = wallets[request.target];
  if (!source || !target || !pay || !get) return { ok: false, kind: "gift_exchange_unavailable", reply: "現在不能換。" };
  const count = request.count;
  const price = Math.max(1, Math.round(count * (Number(rate) || 1)));
  const held = get.balance();
  if (held.cap != null && held.balance + count > held.cap) {
    return { ok: false, kind: "gift_cap", reply: `${target.name}最多 ${held.cap} ${target.unit}，你已經有 ${held.balance} ${target.unit}。` };
  }
  const paid = pay.spend(price, `exchange_to_${target.id}`);
  if (!paid.ok) {
    return { ok: false, kind: source.id === PARFAIT_CURRENCY.id ? "parfait_insufficient" : "gift_insufficient",
      reply: `${source.name}不夠。換 ${count} ${target.unit}${target.name}要 ${price} ${source.unit}，你有 ${paid.balance} ${source.unit}。` };
  }
  const credited = get.credit(count, `exchange_from_${source.id}`);
  if (!credited.ok) {
    pay.refund(price, `exchange_to_${target.id}_refund`);
    return { ok: false, kind: "gift_cap", reply: `${target.name}最多 ${credited.cap ?? held.cap} ${target.unit}，換不了。` };
  }
  return {
    ok: true,
    kind: "gift_exchange",
    reply: `換好了。${source.name} -${price} ${source.unit}（剩 ${paid.balance} ${source.unit}），${target.name} +${count} ${target.unit}（現在 ${credited.balance} ${target.unit}）。`,
    source: { id: source.id, balance: paid.balance },
    target: { id: target.id, balance: credited.balance },
  };
}

function exchangeErrorReply(request, catalog) {
  const target = currencyById(catalog, request.target);
  if (request.error === "no_source") return `要用什麼換${target?.name || ""}？例如「用企鵝貼紙換${target?.name || "抹茶芭菲"} 1 ${target?.unit || "個"}」。`;
  return "同一種不用換。";
}

// Buttons for a leaderboard card: the 抹茶芭菲 card offers each gift; a gift card offers
// 抹茶芭菲 -> that gift and back. One click exchanges one unit.
function exchangeButtons(catalog, boardId) {
  const parfait = PARFAIT_CURRENCY;
  if (boardId === parfait.id) {
    return catalog.filter((c) => c.id !== parfait.id).map((c) => ({ source: parfait.id, target: c.id, emoji: c.emoji, label: `換 1 ${c.unit}${c.name}` }));
  }
  const gift = currencyById(catalog, boardId);
  if (!gift) return [];
  return [
    { source: parfait.id, target: gift.id, emoji: gift.emoji, label: `用 1 杯抹茶芭菲換 1 ${gift.unit}` },
    { source: gift.id, target: parfait.id, emoji: parfait.emoji, label: `換回 1 杯抹茶芭菲` },
  ];
}

module.exports = { PARFAIT_CURRENCY, currencyCatalog, currencyById, currencyMentions, parseExchange, parseGrant, grantNameCandidates, parseGiveToBot, combineHoldings, holdingsDetail, isIntimacyBoardQuestion, isOwnIntimacyQuestion, isCombinedBoardQuestion, runExchange, exchangeErrorReply, exchangeButtons };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVoiceParfaitTracker, parfaitMessageReport } = require("./voice_parfait.js");

test("only people's guild messages are reported, mentioned or not", () => {
  const author = { id: "910000000000000001" };
  assert.deepEqual(parfaitMessageReport({ guild_id: G, author, content: "今天練團好累喔" }),
    { user_id: "910000000000000001", text: "今天練團好累喔", guild_id: G });
  assert.equal(parfaitMessageReport({ author, content: "私訊也是五個字" }), null);
  assert.equal(parfaitMessageReport({ guild_id: G, author: { ...author, bot: true }, content: "我是另一個 bot 喔" }), null);
  assert.equal(parfaitMessageReport({ guild_id: G, author, webhook_id: "1", content: "webhook 的訊息" }), null);
  assert.equal(parfaitMessageReport({ guild_id: G, author, content: "" }), null);
});

const G = "900000000000000006";
const VC = "900000000000000007";
const AFK = "900000000000000008";
const MIN = 60_000;

function tracker(options = {}) {
  let t = 0;
  const reports = [];
  const bots = new Set(options.bots || []);
  const tr = createVoiceParfaitTracker({
    now: () => t,
    isBot: (id) => bots.has(id),
    afkChannelOf: () => AFK,
    report: options.report || ((userId, seconds, guildId) => { reports.push({ userId, seconds, guildId }); return true; }),
  });
  return { tr, reports, at: (ms) => { t = ms; return ms; } };
}

test("time alone in a channel does not count; it starts when a second person joins", async () => {
  const { tr, reports, at } = tracker();
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "b", guildId: G, channelId: VC }, at(10 * MIN));
  await tr.flush(at(40 * MIN));
  assert.equal(reports.find((r) => r.userId === "a").seconds, 1800);
});

test("two people together for 30 minutes both get 1800 seconds reported", async () => {
  const { tr, reports, at } = tracker();
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "b", guildId: G, channelId: VC }, at(0));
  await tr.flush(at(30 * MIN));
  assert.deepEqual(reports.sort((x, y) => x.userId.localeCompare(y.userId)), [
    { userId: "a", seconds: 1800, guildId: G },
    { userId: "b", seconds: 1800, guildId: G },
  ]);
});

test("a bot in the channel does not make a person not-alone, and bots never earn", async () => {
  const { tr, reports, at } = tracker({ bots: ["rana"] });
  tr.update({ userId: "rana", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(0));
  await tr.flush(at(30 * MIN));
  assert.deepEqual(reports, []);
});

test("self-deafened and server-deafened time does not count, and neither does the AFK channel", async () => {
  const { tr, reports, at } = tracker();
  tr.update({ userId: "a", guildId: G, channelId: VC, selfDeaf: true }, at(0));
  tr.update({ userId: "b", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(10 * MIN));
  tr.update({ userId: "b", guildId: G, channelId: VC, serverDeaf: true }, at(15 * MIN));
  await tr.flush(at(20 * MIN));
  const byUser = Object.fromEntries(reports.map((r) => [r.userId, r.seconds]));
  // a: 10-20 min counts (b deafened still keeps a company). b: 0-15 min counts.
  assert.equal(byUser.a, 600);
  assert.equal(byUser.b, 900);

  const afk = tracker();
  afk.tr.update({ userId: "a", guildId: G, channelId: AFK }, afk.at(0));
  afk.tr.update({ userId: "b", guildId: G, channelId: AFK }, afk.at(0));
  await afk.tr.flush(afk.at(30 * MIN));
  assert.deepEqual(afk.reports, []);
});

test("leaving the channel reports the time right away, and the person left behind stops earning", async () => {
  const { tr, reports, at } = tracker();
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "b", guildId: G, channelId: VC }, at(0));
  await tr.update({ userId: "a", guildId: G, channelId: null }, at(5 * MIN));
  assert.deepEqual(reports, [{ userId: "a", seconds: 300, guildId: G }]);
  await tr.flush(at(60 * MIN));
  assert.equal(reports.find((r) => r.userId === "b").seconds, 300);
});

test("a failed report keeps the seconds for the next flush", async () => {
  let fail = true;
  const sent = [];
  const { tr, at } = tracker({ report: (userId, seconds) => { if (fail) return false; sent.push(seconds); return true; } });
  tr.update({ userId: "a", guildId: G, channelId: VC }, at(0));
  tr.update({ userId: "b", guildId: G, channelId: VC }, at(0));
  await tr.flush(at(5 * MIN));
  fail = false;
  await tr.flush(at(10 * MIN));
  assert.ok(sent.includes(600));
});

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMemoryToolResult } from "./memory.js";
import { currencyCommandReply, textChannelIdOf, registerPreDispatch } from "../architecture/pre_dispatch.js";
import { getPersonaProfile } from "../persona_registry.js";
import { localDiscordIds } from "../local_discord_ids.js";

const SHORT = { handled: true, kind: "parfait_insufficient", reply: "抹茶芭菲不夠。要 1 杯，你有 0 杯。", parfait: { price: 1, balance: 0 } };

test("a short 抹茶芭菲 balance from hot-tools (HTTP 402 body) reaches every persona with the numbers", () => {
  const error = new Error(JSON.stringify(SHORT));
  for (const persona of ["rana", "anon", "tomori", "soyo", "taki"]) {
    const outcome = normalizeMemoryToolResult("remember", null, error, persona);
    assert.equal(outcome.success, false);
    assert.equal(outcome.kind, "parfait_insufficient");
    assert.equal(outcome.reply, SHORT.reply, persona);
  }
});

test("a paid save keeps Rana's hot-tools wording and adds the balance for other personas", () => {
  const saved = { handled: true, kind: "memory_save", reply: "嗯。記住了。抹茶芭菲收下了。剩 2 杯。", parfait: { price: 1, balance: 2 } };
  assert.equal(normalizeMemoryToolResult("remember", saved, undefined, "rana").reply, saved.reply);
  assert.match(normalizeMemoryToolResult("remember", saved, undefined, "anon").reply, /抹茶芭菲剩 2 杯/u);
});

test("every message aimed at a bot is offered to /parfait/command with the bot, sender and guild", async () => {
  const calls = [];
  const post = (url, body) => { calls.push({ url, body }); return Promise.resolve(body.text.includes("大家") ? { handled: true, reply: "企鵝貼紙排行：" } : { handled: false }); };
  const group = { senderId: "910000000000000001", isGroup: true, chatType: "channel" };
  assert.equal(await currencyCommandReply(group, {}, { botId: "tomori", guildId: "900000000000000006" }, "大家有多少企鵝貼紙", post), "企鵝貼紙排行：");
  assert.equal(await currencyCommandReply(group, {}, { botId: "tomori", guildId: "900000000000000006" }, "燈今天在做什麼", post), null);
  await currencyCommandReply({ senderId: "910000000000000001", isGroup: false }, {}, { botId: "anon", guildId: "900000000000000006" }, "私訊愛音", post);
  assert.match(calls[0].url, /\/parfait\/command$/u);
  assert.deepEqual(calls[0].body, { bot_id: "tomori", user_id: "910000000000000001", text: "大家有多少企鵝貼紙", guild_id: "900000000000000006", in_guild: true, target_user_id: "" });
  assert.equal(calls[2].body.in_guild, false, "a DM is marked so it earns nothing");
  assert.equal(calls[2].body.guild_id, "");
  await currencyCommandReply(group, {}, { botId: "rana", guildId: "900000000000000006" }, "@Rana 給 某某（主人） 20杯抹茶芭菲", post, "910000000000000009");
  assert.equal(calls[3].body.target_user_id, "910000000000000009", "the mentioned person goes along for owner grants");
});

test("a hot-tools failure never blocks the reply path", async () => {
  const post = () => Promise.reject(new Error("ECONNREFUSED"));
  assert.equal(await currencyCommandReply({ senderId: "910000000000000001", isGroup: true, chatType: "channel" }, {}, { botId: "rana" }, "我有幾杯抹茶芭菲", post), null);
});

const BOARD = { handled: true, reply: "抹茶芭菲排行：\n1. 甲 5 杯\n你第 1 名，5 杯。", short: "你第 1 名，5 杯。", panel: { title: "抹茶芭菲排行", unit: "杯", rows: [{ rank: 1, name: "甲", count: 5 }], mine: "你第 1 名，5 杯。" } };
const group = { senderId: "910000000000000001", isGroup: true, chatType: "channel" };

test("a leaderboard is posted as a panel by that character's own bridge, and the reply keeps only the rank", async () => {
  const calls = [];
  const post = (url, body) => { calls.push({ url, body }); return Promise.resolve(url.endsWith("/parfait/command") ? BOARD : { status: "panel", message_id: "1" }); };
  const context = { botId: "tomori", sessionKey: "agent:tomori:discord:channel:930000000000000001" };
  assert.equal(await currencyCommandReply(group, {}, context, "大家有多少企鵝貼紙", post), "你第 1 名，5 杯。");
  assert.equal(calls[1].url, "http://127.0.0.1:8082/voice/leaderboard-panel");
  assert.deepEqual(calls[1].body, { text_channel_id: "930000000000000001", panel: BOARD.panel });
});

test("without a channel or a working bridge the leaderboard stays plain text", async () => {
  const noChannel = (url) => Promise.resolve(url.endsWith("/parfait/command") ? BOARD : { message_id: "1" });
  assert.equal(await currencyCommandReply(group, {}, { botId: "rana" }, "大家有多少抹茶芭菲", noChannel), BOARD.reply);
  const broken = (url) => (url.endsWith("/parfait/command") ? Promise.resolve(BOARD) : Promise.reject(new Error("ECONNREFUSED")));
  assert.equal(await currencyCommandReply(group, {}, { botId: "rana", channelId: "930000000000000001" }, "大家有多少抹茶芭菲", broken), BOARD.reply);
  assert.equal(textChannelIdOf({}, { sessionKey: "agent:rana:discord:default:channel:930000000000000002" }, { botId: "rana" }), "930000000000000002");
});

test("owner mention normalization does not corrupt the recipient ID in grant commands", async () => {
  // Use the test fixture's owner ID so normalization remains deterministic under node --test.
  const ownerId = localDiscordIds().ownerUserId;
  const raw = `@樂奈 給 <@${ownerId}> 20杯 抹茶芭菲`;
  let beforeAgentReply;
  let commandText = "";

  const profile = getPersonaProfile("rana");
  registerPreDispatch({
    on(name, handler) {
      if (name === "before_agent_reply") beforeAgentReply = handler;
    },
  }, {
    isModelOnlineCheck: async () => true,
    currencyCommandReplyHandler: async (_event, _ctx, _botContext, text) => {
      commandText = text;
      return "grant dispatched";
    },
  });

  const event = {
    senderId: ownerId,
    isGroup: true,
    chatType: "channel",
    body: raw,
    wasMentioned: true,
  };
  const context = {
    agentId: profile.agentId,
    botId: "rana",
    personaId: "rana",
    accountId: profile.accountId,
  };

  assert.deepEqual(await beforeAgentReply(event, context), {
    handled: true,
    reply: { text: "grant dispatched" },
  });
  assert.equal(commandText, raw, "the deterministic command handler must receive the raw Discord mention");
  assert.match(event.body, /咳咳咳咳咳（主人）/u, "the conversational route may still use the normalized owner alias");
});
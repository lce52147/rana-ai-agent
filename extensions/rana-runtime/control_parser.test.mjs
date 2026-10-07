import assert from "node:assert/strict";
import { parseControlRequest } from "./tool_contracts.js";
import { isDirectMessageEvent, isTargetedEvent, registerPreDispatch } from "./architecture/pre_dispatch.js";
import { getPersonaProfile } from "./persona_registry.js";

const joinFixtures = [
  "@Rana 進來",
  "@樂奈 進來",
  "@高松燈 進來",
  "@燈 進來",
  "@千早愛音 進來",
  "@愛音 進來",
  "@長崎爽世 進來",
  "@爽世 進來",
  "@椎名立希 進來",
  "@立希 進來",
  "<@123> 進來",
  "<@!123> 進來",
];

for (const body of joinFixtures) {
  assert.deepEqual(parseControlRequest({ body }), { kind: "join" }, body);
}

assert.deepEqual(parseControlRequest({ body: "@立希 @爽世 進來" }), { kind: "join" });
assert.equal(parseControlRequest({ body: "我看到 @立希 進來了" }), null);
assert.equal(parseControlRequest({ body: "立希進來" }), null);

console.log(`control parser: ${joinFixtures.length + 3} assertions passed`);

const guild = { isGroup: true, chatType: "channel" };
// Fixture uses the real registry binding (Rana = agent "main" / account "default").
const persona = (botId) => {
  const profile = getPersonaProfile(botId);
  return { agentId: profile.agentId, botId, personaId: botId, accountId: profile.accountId };
};
const ARBITRARY_REQUESTER_ID = "300000000000000003";

assert.equal(isTargetedEvent({ ...guild, body: "@Rana 要不要去？", wasMentioned: true }, persona("anon"), "@Rana 要不要去？"), false);
assert.equal(isTargetedEvent({ ...guild, body: "@Rana 要不要去？", wasMentioned: true }, persona("rana"), "@Rana 要不要去？"), true);

for (const botId of ["rana", "tomori", "anon", "soyo", "taki"]) {
  assert.equal(isTargetedEvent({ ...guild, body: "@here 大家集合", wasMentioned: true }, persona(botId), "@here 大家集合"), false, botId);
}

for (const botId of ["rana", "tomori", "anon"]) {
  assert.equal(isTargetedEvent({ ...guild, body: "@Rana @Tomori @Anon 進來", wasMentioned: false }, persona(botId), "@Rana @Tomori @Anon 進來"), true, botId);
}
for (const botId of ["soyo", "taki"]) {
  assert.equal(isTargetedEvent({ ...guild, body: "@Rana @Tomori @Anon 進來", wasMentioned: true }, persona(botId), "@Rana @Tomori @Anon 進來"), false, botId);
}

const ranaDirectMessage = {
  isGroup: false,
  chatType: "dm",
  senderId: ARBITRARY_REQUESTER_ID,
  body: "沒有提到名字的私訊",
};
assert.equal(isTargetedEvent(ranaDirectMessage, persona("rana"), ranaDirectMessage.body), true);

console.log("target gate: 13 assertions passed");

let beforeAgentReply;
let stockSidecarCalls = 0;
const stockDispatches = [];
registerPreDispatch({
  on(name, handler) {
    assert.equal(name, "before_agent_reply");
    beforeAgentReply = handler;
  },
}, {
  isModelOnlineCheck: async () => true,
  handleStockResearchRequest: async (event, ctx, routeText) => {
    stockSidecarCalls += 1;
    stockDispatches.push({ requesterId: event.senderId, routeText });
    return { handled: true, text: "mock stock result" };
  },
});

assert.ok(beforeAgentReply);
const anonContext = persona("anon");
assert.deepEqual(
  await beforeAgentReply({ ...guild, body: "@here 集合", wasMentioned: true }, anonContext),
  { handled: true },
);
assert.deepEqual(
  await beforeAgentReply({ ...guild, body: "@Rana 要不要去？", wasMentioned: true }, anonContext),
  { handled: true },
);
assert.equal(
  await beforeAgentReply({ ...guild, body: "@Rana 要不要去？", wasMentioned: false }, persona("rana")),
  undefined,
);
assert.equal(await beforeAgentReply(ranaDirectMessage, persona("rana")), undefined);
assert.deepEqual(
  await beforeAgentReply({
    ...guild,
    senderId: ARBITRARY_REQUESTER_ID,
    body: "我想看美股 INTC",
    wasMentioned: true,
  }, persona("rana")),
  { handled: true, reply: { text: "mock stock result" } },
);
assert.equal(stockSidecarCalls, 1);
assert.deepEqual(stockDispatches, [{ requesterId: ARBITRARY_REQUESTER_ID, routeText: "我想看美股 INTC" }]);
assert.deepEqual(
  await beforeAgentReply({
    ...guild,
    senderId: ARBITRARY_REQUESTER_ID,
    body: "我想看美股 QCOM",
    wasMentioned: false,
  }, persona("rana")),
  { handled: true },
);
assert.equal(stockSidecarCalls, 1);

const webchatContext = {
  ...persona("rana"),
  messageProvider: "webchat",
  channel: "webchat",
  sessionKey: "agent:main:main",
};
assert.equal(isDirectMessageEvent({ cleanedBody: "hello" }, webchatContext), true);
assert.equal(await beforeAgentReply({ cleanedBody: "hello" }, webchatContext), undefined);

console.log("registerPreDispatch target gate: 7 assertions passed");

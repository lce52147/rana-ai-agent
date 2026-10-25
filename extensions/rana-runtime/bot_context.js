import { firstText } from "./tool_contracts.js";
import { getPersonaProfile, isKnownPersonaId, personaForAccount, personaForAgent, PERSONA_IDS } from "./persona_registry.js";

const ID_KEYS = Object.freeze({
  accountId: ["accountId", "account_id", "channelAccountId", "channel_account_id"],
  agentId: ["agentId", "agent_id"],
  botId: ["botId", "bot_id"],
  personaId: ["personaId", "persona_id"],
  sessionKey: ["sessionKey", "session_key", "sessionId", "session_id", "conversationId", "conversation_id"],
  requesterId: ["requesterId", "requester_id", "senderId", "sender_id", "authorId", "author_id", "userId", "user_id"],
  guildId: ["guildId", "guild_id", "serverId", "server_id"],
  channelId: ["channelId", "channel_id", "textChannelId", "text_channel_id"],
  voiceChannelId: ["voiceChannelId", "voice_channel_id"],
});

function firstFrom(values) {
  for (const value of values) {
    const text = firstText(value);
    if (text) return text;
  }
  return "";
}

function readNested(value, key) {
  if (!value || typeof value !== "object") return "";
  const direct = firstFrom(ID_KEYS[key].map((name) => value[name]));
  if (direct) return direct;
  return firstFrom([
    ...ID_KEYS[key].map((name) => value.discord?.[name]),
    ...ID_KEYS[key].map((name) => value.metadata?.[name]),
    ...ID_KEYS[key].map((name) => value.channel?.[name]),
  ]);
}

function readContextField(event, ctx, key) {
  return firstFrom([readNested(event, key), readNested(ctx, key)]);
}

function agentFromSession(sessionKey) {
  const match = String(sessionKey || "").match(/^agent:([^:]+):/i);
  return match?.[1] || "";
}

function normalizeAccountId(event, ctx, agentId) {
  const explicit = readContextField(event, ctx, "accountId");
  if (explicit) return explicit;
  const personaId = personaForAgent(agentId);
  return getPersonaProfile(personaId)?.accountId || "";
}

function normalizeBotId(event, ctx, personaId) {
  const explicit = readContextField(event, ctx, "botId");
  if (explicit && explicit !== personaId) return "";
  return personaId;
}

function normalizePersonaId(event, ctx, botId) {
  const explicit = readContextField(event, ctx, "personaId");
  if (explicit && explicit !== botId) return "";
  return isKnownPersonaId(botId) ? botId : "";
}

function permissionList(value) {
  if (Array.isArray(value)) return value.map((item) => firstText(item?.id || item?.name || item)).filter(Boolean);
  const text = firstText(value);
  return text ? text.split(/[\s,]+/u).filter(Boolean) : [];
}

export function resolveBotContext(event = {}, ctx = {}) {
  const sessionKey = readContextField(event, ctx, "sessionKey");
  const agentId = readContextField(event, ctx, "agentId") || agentFromSession(sessionKey);
  const agentPersonaId = personaForAgent(agentId);
  if (!agentPersonaId) return null;
  const accountId = normalizeAccountId(event, ctx, agentId);
  const accountPersonaId = personaForAccount(accountId);
  if (!accountPersonaId || accountPersonaId !== agentPersonaId) return null;
  const botId = normalizeBotId(event, ctx, agentPersonaId);
  if (!botId) return null;
  const personaId = normalizePersonaId(event, ctx, botId);
  if (!personaId) return null;
  const profile = getPersonaProfile(personaId);
  if (!profile) return null;

  return Object.freeze({
    agentId,
    accountId: profile.accountId === "default" && accountId === "default" ? "default" : accountId,
    botId,
    personaId,
    sessionKey,
    requesterId: readContextField(event, ctx, "requesterId"),
    guildId: readContextField(event, ctx, "guildId"),
    channelId: readContextField(event, ctx, "channelId"),
    voiceChannelId: readContextField(event, ctx, "voiceChannelId"),
    permissions: permissionList(ctx.permissions || event.permissions || event.discord?.permissions),
    relationshipNamespace: profile.relationshipNamespace,
  });
}

export function scopedStateKey(baseKey, context) {
  if (!context || !isKnownPersonaId(context.botId) || !isKnownPersonaId(context.personaId)) {
    throw new Error("resolved bot context required");
  }
  const value = String(baseKey || "default");
  const bot = context.botId;
  const persona = context.personaId;
  const account = context.accountId;
  return `bot:${bot}|persona:${persona}|account:${account}|${value}`;
}

export function personaMentioned(text, context) {
  const source = firstText(text).toLocaleLowerCase();
  const profile = getPersonaProfile(context?.personaId);
  return profile ? profile.aliases.some((alias) => source.includes(alias.toLocaleLowerCase())) : false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionedPersonaIds(text) {
  const source = firstText(text);
  const mentioned = new Set();
  for (const personaId of PERSONA_IDS) {
    const aliases = getPersonaProfile(personaId).aliases;
    if (aliases.some((alias) => new RegExp(`(?:^|\\s)@${escapeRegExp(alias)}(?=$|\\s|\\p{P})`, "iu").test(source))) {
      mentioned.add(personaId);
    }
  }
  return mentioned;
}

export const __test = { agentFromSession, mentionedPersonaIds, personaMentioned, resolveBotContext, scopedStateKey };

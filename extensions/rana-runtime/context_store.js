import { firstText, isRanaMention } from "./tool_contracts.js";
import { resolveBotContext, scopedStateKey } from "./bot_context.js";

const DEFAULT_TEXT_CHANNEL_ID = "1495319712370917396";
const TOOL_CONTEXT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVIDENCE_TTL_MS = 60000;
const EMPTY_CONTEXT = {
  senderId: "",
  roles: [],
  textChannelId: DEFAULT_TEXT_CHANNEL_ID,
  text: "",
  isDirectMessage: false,
  agentId: "",
  accountId: "",
  botId: "",
  personaId: "",
  sessionKey: "",
  guildId: "",
  channelId: DEFAULT_TEXT_CHANNEL_ID,
  voiceChannelId: "",
  permissions: [],
  currentExplicitTargetId: "",
  currentExplicitTargetAliases: [],
  previousExplicitTargetId: "",
  previousExplicitTargetAliases: [],
  previousUserText: "",
  updatedAt: 0,
};
const contexts = new Map();
const evidence = new Map();
let activeKey = "default";
const NO_MATCH_KEY = "__no_context_match__";
const CONTEXT_TTL_MS = TOOL_CONTEXT_TTL_MS;

export function resolveTextChannelId(event, ctx) {
  const candidates = [event?.textChannelId, event?.channelId, event?.channel_id, event?.discord?.channelId, event?.channel?.id, event?.metadata?.channelId, event?.to, event?.sessionKey, ctx?.textChannelId, ctx?.channelId, ctx?.to, ctx?.sessionKey];
  for (const value of candidates) {
    const text = firstText(value);
    if (/^\d{17,20}$/.test(text)) return text;
    const match = text.match(/(?:channel:|channel\/|channels\/)(\d{17,20})/i);
    if (match) return match[1];
  }
  return DEFAULT_TEXT_CHANNEL_ID;
}

export function resolveRequesterId(event, ctx) {
  const candidates = [event?.senderId, event?.sender_id, event?.authorId, event?.author_id, event?.userId, event?.user_id, event?.requesterId, event?.requester_id, event?.discord?.senderId, event?.discord?.sender_id, event?.discord?.authorId, event?.discord?.author_id, event?.metadata?.senderId, event?.metadata?.sender_id, event?.metadata?.authorId, event?.metadata?.author_id, ctx?.senderId, ctx?.sender_id, ctx?.authorId, ctx?.author_id, ctx?.userId, ctx?.user_id, ctx?.requesterId, ctx?.requester_id];
  for (const value of candidates) {
    const text = firstText(value);
    if (/^\d{15,25}$/.test(text)) return text;
  }
  const body = [firstText(event?.body), firstText(event?.content)].filter(Boolean).join("\n");
  const senderMatch = body.match(/"sender_id"\s*:\s*"(\d{15,25})"/) || body.match(/Sender \(untrusted metadata\):[\s\S]*?"id"\s*:\s*"(\d{15,25})"/);
  return senderMatch?.[1] || "";
}

function rolesFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : firstText(item?.name || item?.label || item?.id)).filter(Boolean);
  const text = firstText(value);
  return text ? text.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean) : [];
}

export function resolveRequesterRoles(event, ctx) {
  // Authorization roles must come from structured adapter/runtime fields only.
  // Never parse role IDs out of the user-controlled message body: a user can
  // type JSON-like text claiming any role. If adapters do not expose roles,
  // downstream rana_hot_tools performs its own Discord member-role lookup.
  const direct = [
    event?.roles, event?.roleNames, event?.role_names, event?.memberRoles, event?.member_roles,
    event?.discord?.roles, event?.discord?.roleNames, event?.discord?.role_names,
    event?.metadata?.roles, event?.metadata?.roleNames, event?.metadata?.role_names,
    ctx?.roles, ctx?.roleNames, ctx?.role_names, ctx?.memberRoles, ctx?.member_roles,
  ];
  return [...new Set(direct.flatMap(rolesFromValue))];
}

function sessionOf(value) {
  return firstText(value?.sessionKey)
    || firstText(value?.session_id)
    || firstText(value?.sessionId)
    || firstText(value?.conversationId)
    || firstText(value?.conversation_id)
    || "";
}

export function resolveIsDirectMessage(event, ctx) {
  if (event?.isGroup === true || ctx?.isGroup === true) return false;
  if (event?.isDirectMessage === true || ctx?.isDirectMessage === true) return true;
  if (event?.isGroup === false || ctx?.isGroup === false) return true;

  const chatTypes = [
    event?.chatType,
    event?.chat_type,
    event?.ChatType,
    event?.conversation?.kind,
    event?.discord?.chatType,
    event?.discord?.chat_type,
    ctx?.chatType,
    ctx?.chat_type,
    ctx?.ChatType,
    ctx?.conversation?.kind,
  ].map(firstText).map((value) => value.toLowerCase()).filter(Boolean);
  if (chatTypes.some((value) => value === "channel" || value === "group" || value === "thread")) return false;
  if (chatTypes.some((value) => value === "direct" || value === "dm")) return true;

  const sessions = [sessionOf(event), sessionOf(ctx)].filter(Boolean);
  if (sessions.some((value) => /discord:(?:[^:]+:)?(?:channel|group):/i.test(value))) return false;
  if (sessions.some((value) => /discord:(?:[^:]+:)?(?:dm|direct|user):/i.test(value) || /:user:\d{15,25}(?:$|:)/i.test(value))) return true;

  return false;
}

export function contextKeyFrom(event, ctx) {
  const requester = resolveRequesterId(event, ctx);
  const session = sessionOf(event) || sessionOf(ctx);
  const base = session ? `session:${session}` : `channel:${resolveTextChannelId(event, ctx)}`;
  const context = resolveBotContext(event, ctx);
  // Unresolvable agent/account/persona must never be filed under any persona.
  if (!context) return `${NO_MATCH_KEY}|unresolved|${base}|user:${requester || "unknown"}`;
  return `${scopedStateKey(base, context)}|user:${requester || "unknown"}`;
}

function keyFor(hint) {
  if (!hint) return activeKey;
  if (typeof hint === "string" && /^\d{15,25}$/.test(hint)) {
    const suffix = `|user:${hint}`;
    return [...contexts.entries()].filter(([key, value]) => key.endsWith(suffix) && value.updatedAt).sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0]?.[0] || activeKey;
  }
  if (typeof hint === "object") {
    const requester = firstText(hint.requester_id) || firstText(hint.requesterId) || firstText(hint.senderId);
    const session = sessionOf(hint);
    const context = resolveBotContext(hint, hint);
    if (session) {
      if (!context) return `${NO_MATCH_KEY}|unresolved|session:${session}`;
      const scopedSession = scopedStateKey(`session:${session}`, context);
      if (requester) return `${scopedSession}|user:${requester}`;

      const prefix = `${scopedSession}|user:`;
      const freshMatches = [...contexts.entries()]
        .filter(([key, value]) => key.startsWith(prefix)
          && key !== `${prefix}unknown`
          && value?.updatedAt
          && Date.now() - value.updatedAt <= CONTEXT_TTL_MS)
        .map(([key]) => key);
      return freshMatches.length === 1 ? freshMatches[0] : `${NO_MATCH_KEY}|${scopedSession}`;
    }
    if (requester) return keyFor(requester);
  }
  return activeKey;
}

export function isNoMatchContext(hint) {
  return keyFor(hint).startsWith(`${NO_MATCH_KEY}|`);
}

function get(hint) {
  const key = keyFor(hint);
  return { key, value: contexts.get(key) || EMPTY_CONTEXT };
}

function normalizeDiscordUserId(value) {
  const text = firstText(value).trim();
  const match = text.match(/^(?:<@!?)?(\d{15,25})>?$/u);
  return match?.[1] || "";
}

function mentionRecord(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const id = normalizeDiscordUserId(value);
    return id ? { id, bot: null, aliases: [`<@${id}>`] } : null;
  }
  if (typeof value !== "object") return null;
  const user = value.user && typeof value.user === "object" ? value.user : null;
  const memberUser = value.member?.user && typeof value.member.user === "object" ? value.member.user : null;
  const id = normalizeDiscordUserId(
    value.id || value.userId || value.user_id || user?.id || memberUser?.id,
  );
  if (!id) return null;
  const botValue = value.bot ?? value.isBot ?? value.is_bot ?? user?.bot ?? memberUser?.bot;
  const aliases = [
    `<@${id}>`,
    value.username, value.userName, value.user_name, value.name, value.displayName, value.display_name, value.nick,
    user?.username, user?.name, user?.displayName, user?.display_name,
    memberUser?.username, memberUser?.name, memberUser?.displayName, memberUser?.display_name,
  ].map(firstText).map((item) => item.trim()).filter(Boolean);
  return {
    id,
    bot: typeof botValue === "boolean" ? botValue : null,
    aliases: [...new Set(aliases.flatMap((item) => item.startsWith("@") || item.startsWith("<@") ? [item] : [item, `@${item}`]))],
  };
}

function structuredMentionValues(event, ctx) {
  return [
    event?.mentionedUserIds, event?.mentioned_user_ids, event?.mentionUserIds, event?.mention_user_ids,
    event?.mentions, event?.mentionedUsers, event?.mentioned_users, event?.message?.mentions,
    event?.discord?.mentions, event?.discord?.mentionedUsers, event?.discord?.mentioned_users,
    event?.metadata?.mentions, event?.metadata?.mentionedUsers, event?.metadata?.mentioned_users,
    ctx?.mentionedUserIds, ctx?.mentioned_user_ids, ctx?.mentionUserIds, ctx?.mention_user_ids,
    ctx?.mentions, ctx?.mentionedUsers, ctx?.mentioned_users, ctx?.message?.mentions,
    ctx?.discord?.mentions, ctx?.discord?.mentionedUsers, ctx?.discord?.mentioned_users,
    ctx?.metadata?.mentions, ctx?.metadata?.mentionedUsers, ctx?.metadata?.mentioned_users,
  ];
}

function mentionRecords(event, ctx, text) {
  const records = [];
  for (const value of structuredMentionValues(event, ctx)) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of list) {
      const record = mentionRecord(item);
      if (record) records.push(record);
    }
  }
  for (const match of firstText(text).matchAll(/<@!?(\d{15,25})>/gu)) {
    const record = mentionRecord(match[1]);
    if (record) records.push(record);
  }
  const merged = new Map();
  for (const record of records) {
    const prior = merged.get(record.id);
    merged.set(record.id, {
      id: record.id,
      bot: prior?.bot === true || record.bot === true ? true : (prior?.bot === false || record.bot === false ? false : null),
      aliases: [...new Set([...(prior?.aliases || []), ...(record.aliases || [])])],
    });
  }
  return [...merged.values()];
}

function explicitHumanTarget(event, ctx, text) {
  const records = mentionRecords(event, ctx, text);
  if (!records.length) return { id: "", aliases: [] };
  const explicitHumans = records.filter((item) => item.bot === false);
  if (explicitHumans.length === 1) return explicitHumans[0];
  if (explicitHumans.length > 1) return { id: "", aliases: [] };

  const explicitBots = new Set(records.filter((item) => item.bot === true).map((item) => item.id));
  let candidates = records.filter((item) => !explicitBots.has(item.id));
  if (candidates.length === 1 && explicitBots.size > 0) return candidates[0];

  const source = firstText(text).trimStart();
  const namedPersonaAddress = /^@(?:rana|樂奈|高松燈|燈|千早愛音|愛音|長崎爽世|爽世|椎名立希|立希)(?:#\d{4})?(?=\s|$|[,.!?;:，。！？、])/iu.test(source);
  if (namedPersonaAddress && candidates.length === 1) return candidates[0];

  const literalIds = [...source.matchAll(/<@!?(\d{15,25})>/gu)].map((match) => match[1]);
  const leadingNumericAddress = source.match(/^<@!?(\d{15,25})>(?=\s|$|[,.!?;:，。！？、])/u)?.[1] || "";
  if (leadingNumericAddress) {
    candidates = candidates.filter((item) => item.id !== leadingNumericAddress);
    if (candidates.length === 1) return candidates[0];
    return { id: "", aliases: [] };
  }
  if (literalIds.length === 1 && candidates.length === 1) return candidates[0];
  return { id: "", aliases: [] };
}

export function rememberDiscordContext(event, ctx) {
  const botContext = resolveBotContext(event, ctx);
  // Fail closed: an event that cannot be tied to exactly one persona is not stored.
  if (!botContext) return { ...EMPTY_CONTEXT, roles: [], permissions: [], currentExplicitTargetAliases: [], previousExplicitTargetAliases: [] };
  const key = contextKeyFrom(event, ctx);
  const prior = contexts.get(key) || EMPTY_CONTEXT;
  const text = firstText(event?.cleanedBody) || firstText(event?.body) || firstText(event?.content) || "";
  const currentTarget = explicitHumanTarget(event, ctx, text);
  const stored = {
    senderId: resolveRequesterId(event, ctx),
    roles: resolveRequesterRoles(event, ctx),
    textChannelId: resolveTextChannelId(event, ctx),
    text,
    isDirectMessage: resolveIsDirectMessage(event, ctx),
    ...botContext,
    currentExplicitTargetId: currentTarget.id || "",
    currentExplicitTargetAliases: [...(currentTarget.aliases || [])],
    // Carry only the immediately preceding turn's *explicit* target. Never
    // promote an inherited/anaphoric target into a new explicit target, which
    // would silently create long-distance reference chains.
    previousExplicitTargetId: prior.currentExplicitTargetId || "",
    previousExplicitTargetAliases: [...(prior.currentExplicitTargetAliases || [])],
    // Bounded semantic continuity carries only the immediately preceding user
    // turn's transport-cleaned text. TurnPlan remains the sole owner that may
    // decide whether the new utterance is a semantic continuation.
    previousUserText: prior.text || "",
    updatedAt: Date.now(),
  };
  contexts.set(key, stored);
  activeKey = key;
  return stored;
}

export function recentRequesterId(hint) { const { value } = get(hint); return value.senderId && Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.senderId : ""; }
export function recentRequesterRoles(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? [...value.roles] : []; }
export function recentTextChannelId(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.textChannelId || DEFAULT_TEXT_CHANNEL_ID : DEFAULT_TEXT_CHANNEL_ID; }
export function recentDiscordText(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.text || "" : ""; }
export function isRecentDirectMention(hint) { const text = recentDiscordText(hint); return Boolean(text && isRanaMention(text)); }

export function rememberToolEvidence(tool, action = "", ok = true, hint, authoritativeReply = "") {
  evidence.set(keyFor(hint), {
    tool: firstText(tool),
    action: firstText(action),
    ok: Boolean(ok),
    authoritativeReply: firstText(authoritativeReply).trim(),
    updatedAt: Date.now(),
  });
}
export function hasRecentToolEvidence(tool, action = "", hint) {
  const item = evidence.get(keyFor(hint));
  return Boolean(item?.ok && Date.now() - item.updatedAt <= TOOL_EVIDENCE_TTL_MS && (!tool || item.tool === firstText(tool)) && (!action || item.action === firstText(action)));
}
export function consumeRecentToolEvidence(tool, action = "", hint) { const key = keyFor(hint); const ok = hasRecentToolEvidence(tool, action, hint); if (ok) evidence.set(key, { tool: "", action: "", ok: false, updatedAt: 0 }); return ok; }
export function consumeRecentToolOutcome(tool, action = "", hint) {
  const key = keyFor(hint);
  const item = evidence.get(key);
  const found = Boolean(item && Date.now() - item.updatedAt <= TOOL_EVIDENCE_TTL_MS && (!tool || item.tool === firstText(tool)) && (!action || item.action === firstText(action)));
  if (!found) return { found: false, ok: false, tool: "", action: "", authoritativeReply: "" };
  evidence.set(key, { tool: "", action: "", ok: false, updatedAt: 0 });
  return {
    found: true,
    ok: Boolean(item.ok),
    tool: item.tool,
    action: item.action,
    authoritativeReply: firstText(item.authoritativeReply).trim(),
  };
}

// Some delivery adapters expose a different session key at message_sending
// than the one available inside a tool call.  A cross-session fallback is
// safe only when there is exactly one fresh matching outcome; otherwise the
// caller must fail closed rather than attach another user's tool result.
export function consumeSingleRecentToolOutcome(tool, action = "") {
  const matches = [...evidence.entries()].filter(([, item]) =>
    item
    && Date.now() - item.updatedAt <= TOOL_EVIDENCE_TTL_MS
    && (!tool || item.tool === firstText(tool))
    && (!action || item.action === firstText(action))
  );
  if (matches.length !== 1) return { found: false, ok: false, tool: "", action: "", authoritativeReply: "" };
  const [key, item] = matches[0];
  evidence.set(key, { tool: "", action: "", ok: false, updatedAt: 0 });
  return {
    found: true,
    ok: Boolean(item.ok),
    tool: item.tool,
    action: item.action,
    authoritativeReply: firstText(item.authoritativeReply).trim(),
  };
}

export function recentContextSnapshot(hint) {
  const { value } = get(hint);
  const fresh = Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS;
  return {
    fresh,
    requester_id: fresh ? value.senderId : "",
    roles: fresh ? [...value.roles] : [],
    text_channel_id: fresh ? value.textChannelId : DEFAULT_TEXT_CHANNEL_ID,
    source_text: fresh ? value.text : "",
    is_direct_message: fresh ? Boolean(value.isDirectMessage) : false,
    agent_id: fresh ? value.agentId : "",
    account_id: fresh ? value.accountId : "",
    bot_id: fresh ? value.botId : "",
    persona_id: fresh ? value.personaId : "",
    session_key: fresh ? value.sessionKey : "",
    guild_id: fresh ? value.guildId : "",
    channel_id: fresh ? value.channelId : DEFAULT_TEXT_CHANNEL_ID,
    voice_channel_id: fresh ? value.voiceChannelId : "",
    permissions: fresh ? [...value.permissions] : [],
    current_explicit_target_id: fresh ? value.currentExplicitTargetId || "" : "",
    current_explicit_target_aliases: fresh ? [...(value.currentExplicitTargetAliases || [])] : [],
    previous_explicit_target_id: fresh ? value.previousExplicitTargetId || "" : "",
    previous_explicit_target_aliases: fresh ? [...(value.previousExplicitTargetAliases || [])] : [],
    previous_user_text: fresh ? value.previousUserText || "" : "",
    updated_at: value.updatedAt,
  };
}

export function recentMemoryReferenceHints(hint) {
  const snapshot = recentContextSnapshot(hint);
  return {
    currentExplicitTargetId: snapshot.current_explicit_target_id || "",
    currentExplicitTargetAliases: snapshot.current_explicit_target_aliases || [],
    previousExplicitTargetId: snapshot.previous_explicit_target_id || "",
    previousExplicitTargetAliases: snapshot.previous_explicit_target_aliases || [],
    previousUserText: snapshot.previous_user_text || "",
  };
}

export const __test = { consumeRecentToolEvidence, consumeRecentToolOutcome, consumeSingleRecentToolOutcome, contextKeyFrom, explicitHumanTarget, get, hasRecentToolEvidence, isNoMatchContext, keyFor, mentionRecords, rememberDiscordContext, rememberToolEvidence, recentContextSnapshot, recentDiscordText, recentMemoryReferenceHints, recentRequesterId, recentRequesterRoles, recentTextChannelId, resolveIsDirectMessage, resolveRequesterRoles, resolveRequesterId, resolveTextChannelId };

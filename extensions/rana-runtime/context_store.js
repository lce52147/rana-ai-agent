import { firstText, isRanaMention } from "./tool_contracts.js";

const DEFAULT_TEXT_CHANNEL_ID = "1495319712370917396";
const TOOL_CONTEXT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVIDENCE_TTL_MS = 60000;
const EMPTY_CONTEXT = { senderId: "", roles: [], textChannelId: DEFAULT_TEXT_CHANNEL_ID, text: "", updatedAt: 0 };
const contexts = new Map();
const evidence = new Map();
let activeKey = "default";

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
  const direct = [event?.roles, event?.roleNames, event?.role_names, event?.memberRoles, event?.member_roles, event?.discord?.roles, event?.discord?.roleNames, event?.discord?.role_names, event?.metadata?.roles, event?.metadata?.roleNames, event?.metadata?.role_names, ctx?.roles, ctx?.roleNames, ctx?.role_names, ctx?.memberRoles, ctx?.member_roles];
  const roles = direct.flatMap(rolesFromValue);
  if (roles.length) return [...new Set(roles)];
  const body = [firstText(event?.body), firstText(event?.content)].filter(Boolean).join("\n");
  const found = [];
  for (const match of body.matchAll(/"(?:roles|role_names|roleNames|member_roles|memberRoles)"\s*:\s*\[([\s\S]*?)\]/g)) for (const role of match[1].matchAll(/"([^"]+)"/g)) found.push(role[1]);
  return [...new Set(found)];
}

function sessionOf(value) {
  return firstText(value?.sessionKey) || firstText(value?.conversationId) || firstText(value?.conversation_id) || "";
}

export function contextKeyFrom(event, ctx) {
  const requester = resolveRequesterId(event, ctx);
  const session = sessionOf(event) || sessionOf(ctx);
  return session ? `session:${session}|user:${requester || "unknown"}` : `channel:${resolveTextChannelId(event, ctx)}|user:${requester || "unknown"}`;
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
    if (session) return `session:${session}|user:${requester || "unknown"}`;
    if (requester) return keyFor(requester);
  }
  return activeKey;
}

function get(hint) { return { key: keyFor(hint), value: contexts.get(keyFor(hint)) || EMPTY_CONTEXT }; }

export function rememberDiscordContext(event, ctx) {
  const key = contextKeyFrom(event, ctx);
  const previous = contexts.get(key) || EMPTY_CONTEXT;
  contexts.set(key, {
    senderId: resolveRequesterId(event, ctx) || previous.senderId,
    roles: resolveRequesterRoles(event, ctx),
    textChannelId: resolveTextChannelId(event, ctx),
    text: firstText(event?.body) || firstText(event?.content) || previous.text,
    updatedAt: Date.now(),
  });
  activeKey = key;
}

export function recentRequesterId(hint) { const { value } = get(hint); return value.senderId && Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.senderId : ""; }
export function recentRequesterRoles(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? [...value.roles] : []; }
export function recentTextChannelId(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.textChannelId || DEFAULT_TEXT_CHANNEL_ID : DEFAULT_TEXT_CHANNEL_ID; }
export function recentDiscordText(hint) { const { value } = get(hint); return Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS ? value.text || "" : ""; }
export function isRecentDirectMention(hint) { const text = recentDiscordText(hint); return Boolean(text && isRanaMention(text)); }

export function rememberToolEvidence(tool, action = "", ok = true, hint) { evidence.set(keyFor(hint), { tool: firstText(tool), action: firstText(action), ok: Boolean(ok), updatedAt: Date.now() }); }
export function hasRecentToolEvidence(tool, action = "", hint) {
  const item = evidence.get(keyFor(hint));
  return Boolean(item?.ok && Date.now() - item.updatedAt <= TOOL_EVIDENCE_TTL_MS && (!tool || item.tool === firstText(tool)) && (!action || item.action === firstText(action)));
}
export function consumeRecentToolEvidence(tool, action = "", hint) { const key = keyFor(hint); const ok = hasRecentToolEvidence(tool, action, hint); if (ok) evidence.set(key, { tool: "", action: "", ok: false, updatedAt: 0 }); return ok; }
export function consumeRecentToolOutcome(tool, action = "", hint) {
  const key = keyFor(hint);
  const item = evidence.get(key);
  const found = Boolean(item && Date.now() - item.updatedAt <= TOOL_EVIDENCE_TTL_MS && (!tool || item.tool === firstText(tool)) && (!action || item.action === firstText(action)));
  if (!found) return { found: false, ok: false, tool: "", action: "" };
  evidence.set(key, { tool: "", action: "", ok: false, updatedAt: 0 });
  return { found: true, ok: Boolean(item.ok), tool: item.tool, action: item.action };
}

export function recentContextSnapshot(hint) {
  const { value } = get(hint);
  const fresh = Date.now() - value.updatedAt <= TOOL_CONTEXT_TTL_MS;
  return { fresh, requester_id: fresh ? value.senderId : "", roles: fresh ? [...value.roles] : [], text_channel_id: fresh ? value.textChannelId : DEFAULT_TEXT_CHANNEL_ID, source_text: fresh ? value.text : "", updated_at: value.updatedAt };
}

export const __test = { consumeRecentToolEvidence, consumeRecentToolOutcome, contextKeyFrom, hasRecentToolEvidence, rememberDiscordContext, rememberToolEvidence, recentContextSnapshot, recentDiscordText, recentRequesterId, recentRequesterRoles, recentTextChannelId, resolveRequesterRoles, resolveRequesterId, resolveTextChannelId };

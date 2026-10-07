import { firstText, stripRanaMention } from "../tool_contracts.js";
import { rememberToolEvidence, resolveRequesterId, resolveRequesterRoles } from "../context_store.js";
import { resolveBotContext } from "../bot_context.js";
import { deleteMemory, memoryStatus, recallMemory, rememberMemory } from "../sidecars/memory.js";
import { resolveTrustedInvocationContext, trustedContextHint, trustedToolError } from "../architecture/turn_isolation.js";
import { PERSONA_REPLIES } from "../persona_replies.js";
import { getPersonaProfile } from "../persona_registry.js";

// Fixed user-visible replies are owned per persona (see persona_replies.js).
// Callers with no resolved persona (legacy unit-test signatures) get neutral
// wording; that wording is never Rana's.
const NEUTRAL_REPLIES = Object.freeze({
  unresolvedRecall: "你是說誰？", unresolvedOther: "你說的是誰？", forgetWhat: "要忘記什麼？", recallWhich: "你想問哪件事？",
  rememberEmpty: "沒有內容，沒辦法記。", forgotten: "好，已經忘掉了。", deleteMiss: "沒有找到這個。", remembered: "好，我記住了。",
  recallMiss: "不知道。", badAction: "記憶動作不對。", failRemember: "沒有記住。", failForget: "沒有忘掉。",
  failRecall: "現在想不起來。", rejectedSensitive: "這個不能記。", noPermission: "沒有權限。",
});

function receiptAction(action) {
  if (action === "recall") return "RECALL";
  if (action === "forget" || action === "delete" || action === "remove" || action === "forget_bulk") return "FORGET";
  return "REMEMBER";
}

function memoryTargetIsOwner(name, personaId) {
  const key = String(name || "").replace(/(?:ちゃん|醬|酱|桑|さん)$/u, "").trim().toLowerCase();
  const profile = getPersonaProfile(personaId);
  if (!key || !profile) return false;
  return [profile.canonicalName, profile.shortName, profile.personaId, ...(profile.aliases || [])]
    .map((value) => String(value || "").replace(/\s+/gu, "").toLowerCase())
    .some((value) => value === key);
}

function memoryReplies(personaId) {
  return PERSONA_REPLIES[personaId] || NEUTRAL_REPLIES;
}

function ranaMemoryRecallText(value) {
  const text = firstText(value)
    .trim()
    .replace(/^我的/u, "你的")
    .replace(/^我/u, "你");
  if (!text) return "不知道。";
  return `${text.replace(/[。.\s]+$/g, "")}。`;
}

function recallQueryText(value) {
  return stripRanaMention(firstText(value))
    .replace(/^(?:你|妳)?(?:還)?記得\s*/u, "")
    .replace(/(?:什麼|哪一個|哪個)/gu, "")
    .replace(/[嗎嘛呢?？。.\s]+$/gu, "")
    .trim();
}

function parsedMemoryError(error) {
  let value = error?.message || error;
  for (let index = 0; index < 3; index += 1) {
    if (typeof value !== "string") break;
    try {
      const parsed = JSON.parse(value);
      value = typeof parsed?.error === "string" ? parsed.error : parsed;
    } catch {
      break;
    }
  }
  return value && typeof value === "object" ? value : { error: String(value || "memory request failed") };
}

function memoryActionSucceeded(action, data) {
  if (!data || typeof data !== "object" || data.handled === false || data.ok === false || data.status === "error") return false;
  if (action === "remember") return data.handled === true && data.kind === "memory_save";
  if (action === "recall") return data.handled === true && ["memory_recall", "memory_recall_empty", "memory_session_required"].includes(data.kind);
  if (["forget", "delete", "remove"].includes(action)) return data.handled === true && ["memory_delete", "memory_delete_miss"].includes(data.kind);
  if (action === "status") return data.status === "ok";
  return false;
}

// The hot-tools sidecar is shared by all five personas but its fixed success
// wording ("嗯。記住了。", "嗯。忘了。", "沒有那個。") is Rana's voice. Only Rana
// may surface that text; every other persona gets its own table entry.
function personaSuccessReply(action, data, personaId) {
  if (!personaId || personaId === "rana") return firstText(data?.reply);
  const replies = memoryReplies(personaId);
  if (action === "remember") return replies.remembered;
  if (["forget", "delete", "remove"].includes(action)) return data?.removed > 0 ? replies.forgotten : replies.deleteMiss;
  return firstText(data?.reply);
}

function memoryFailureReply(action, personaId, kind) {
  const replies = memoryReplies(personaId);
  if (personaId && personaId !== "rana") {
    if (kind === "memory_rejected") return replies.rejectedSensitive;
    if (String(kind || "").startsWith("security:")) return replies.noPermission;
  }
  if (action === "remember") return replies.failRemember;
  if (["forget", "delete", "remove"].includes(action)) return replies.failForget;
  return replies.failRecall;
}

function memoryRecallMissResult(parsed, personaId) {
  return parsed?.implicit === true ? null : { handled: true, text: memoryReplies(personaId).recallMiss };
}

function memoryTargetMetadata(parsed = {}) {
  const targetId = firstText(parsed?.targetId).trim();
  const targetAliases = Array.isArray(parsed?.targetAliases)
    ? parsed.targetAliases.map(firstText).map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    ...(targetId ? { target_id: targetId } : {}),
    ...(targetAliases.length ? { target_aliases: [...new Set(targetAliases)] } : {}),
    ...(firstText(parsed?.targetSource).trim() ? { target_source: firstText(parsed.targetSource).trim() } : {}),
  };
}

function memoryScope(hint = {}) {
  const botContext = resolveBotContext(hint, hint);
  if (!botContext) return null;
  return {
    bot_id: botContext.botId,
    persona_id: botContext.personaId,
    account_id: botContext.accountId,
    agent_id: botContext.agentId,
    session_key: botContext.sessionKey,
    guild_id: botContext.guildId,
    channel_id: botContext.channelId,
  };
}

function memoryRequestContext(event = {}, ctx = {}) {
  const botContext = resolveBotContext(event, ctx);
  if (!botContext) return null;
  const requester_id = resolveRequesterId(event, ctx);
  if (!requester_id) return null;
  const scope = memoryScope({ ...botContext, requesterId: requester_id });
  if (!scope) return null;
  return {
    requester_id,
    roles: resolveRequesterRoles(event, ctx),
    botContext,
    scope,
  };
}

export function normalizeMemoryToolResult(action, data, error, personaId) {
  const details = error ? parsedMemoryError(error) : data;
  const success = !error && memoryActionSucceeded(action, data);
  if (success) {
    const reply = personaSuccessReply(action, data, personaId);
    const shaped = reply && reply !== firstText(data?.reply) ? { ...data, reply } : data;
    return { ...shaped, tool: "rana_memory", action, success: true, status: "success", result: shaped };
  }
  return {
    tool: "rana_memory",
    action,
    success: false,
    status: "error",
    kind: firstText(details?.kind) || "memory_error",
    reply: memoryFailureReply(action, personaId, firstText(details?.kind)),
    error_code: "memory_unavailable",
  };
}

async function callMemoryTool(action, operation, hint) {
  try {
    const data = await operation();
    const outcome = normalizeMemoryToolResult(action, data, undefined, hint?.persona_id || hint?.personaId);
    rememberToolEvidence("rana_memory", action === "forget" || action === "remove" ? "delete" : action, outcome.success, hint);
    return outcome;
  } catch (error) {
    const outcome = normalizeMemoryToolResult(action, null, error, hint?.persona_id || hint?.personaId);
    rememberToolEvidence("rana_memory", action === "forget" || action === "remove" ? "delete" : action, false, hint);
    return outcome;
  }
}

export async function handleMemoryRequest(parsed, event, ctx, routeText, signal) {
  const ownerContext = resolveBotContext(event, ctx);
  if (!ownerContext) return null;
  const replies = memoryReplies(ownerContext.personaId);
  if (parsed?.unresolvedTarget) {
    return { handled: true, text: parsed?.action === "recall" ? replies.unresolvedRecall : replies.unresolvedOther, receipt: { action: receiptAction(parsed?.action), status: "AMBIGUOUS_TARGET" } };
  }
  // Fixed runtime answers: no sidecar call, no model involvement.
  if (parsed?.action === "forget_bulk") return { handled: true, text: replies.refuseBulkForget || replies.badAction, receipt: { action: "FORGET", status: "REFUSED_BULK" } };
  if (parsed?.action === "remember_cross") {
    if (!memoryTargetIsOwner(parsed.target, ownerContext.personaId)) return { handled: true, text: replies.refuseCrossMemory || replies.badAction, receipt: { action: "REMEMBER", status: "REFUSED_OTHER_PERSONA" } };
    parsed = { ...parsed, action: "remember" };   // "記到<自己>的記憶" is an ordinary remember
  }
  if (parsed?.action === "remember" && !firstText(parsed.text)) return { handled: true, text: replies.rememberEmpty, receipt: { action: "REMEMBER", status: "EMPTY" } };
  const requestContext = memoryRequestContext(event, ctx);
  if (!requestContext) return null;
  const { requester_id, roles, botContext, scope } = requestContext;
  const hint = {
    requester_id,
    ...botContext,
    bot_id: botContext.botId,
    persona_id: botContext.personaId,
    account_id: botContext.accountId,
    agent_id: botContext.agentId,
    session_key: botContext.sessionKey,
    guild_id: botContext.guildId,
    channel_id: botContext.channelId,
  };
  if (parsed?.action === "forget" || parsed?.action === "delete" || parsed?.action === "remove") {
    const query = recallQueryText(parsed.text);
    if (!query) return { handled: true, text: replies.forgetWhat, receipt: { action: "FORGET", status: "NEEDS_TARGET" } };
    const outcome = await callMemoryTool("delete", () => deleteMemory({ query, requester_id, roles, ...memoryTargetMetadata(parsed), ...scope }, signal), hint);
    if (!outcome.success) return { handled: true, text: outcome.reply, receipt: { action: "FORGET", status: "FAILED" } };
    const data = outcome.result;
    return {
      handled: true,
      text: personaSuccessReply("delete", data, botContext.personaId) || (data?.removed > 0 ? replies.forgotten : replies.deleteMiss),
      receipt: { action: "FORGET", status: data?.removed > 0 ? "FORGOTTEN" : "NOT_FOUND" },
    };
  }
  if (parsed?.action === "recall") {
    const query = recallQueryText(parsed.subject) || recallQueryText(parsed.text);
    if (!query) return { handled: true, text: replies.recallWhich, receipt: { action: "RECALL", status: "NEEDS_TARGET" } };
    const outcome = await callMemoryTool("recall", () => recallMemory({ query, requester_id, roles, ...memoryTargetMetadata(parsed), ...scope }, signal), hint);
    if (!outcome.success) return { handled: true, text: outcome.reply, receipt: { action: "RECALL", status: "FAILED" } };
    const data = outcome.result;
    if (data?.found || data?.hit || data?.item || (Array.isArray(data?.matches) && data.matches.length > 0)) {
      const value = firstText(data?.reply)
        || firstText(data?.item?.text)
        || firstText(data?.matches?.[0]?.text)
        || firstText(data?.items?.[0]?.text);
      return { handled: true, text: ranaMemoryRecallText(value) };
    }
    // Implicit user-defined-person lookup is opportunistic: a memory miss must
    // not steal canonical/general identity questions from Persona/LORE.
    const miss = memoryRecallMissResult(parsed, botContext.personaId);
    return miss ? { ...miss, receipt: { action: "RECALL", status: "NOT_FOUND" } } : miss;
  }
  if (parsed?.action !== "remember") return null;
  const text = firstText(parsed.text);
  if (!text) return { handled: true, text: replies.rememberEmpty, receipt: { action: "REMEMBER", status: "EMPTY" } };
  const outcome = await callMemoryTool("remember", () => rememberMemory({
    text,
    source: "rana_memory_pre_dispatch",
    requester_id,
    roles,
    ...memoryTargetMetadata(parsed),
    ...scope,
  }, signal), hint);
  if (!outcome.success) {
    return {
      handled: true,
      text: outcome.reply,
      receipt: { action: "REMEMBER", status: outcome.kind === "memory_rejected" ? "REFUSED_SENSITIVE" : "FAILED" },
    };
  }
  const data = outcome.result;
  return {
    handled: true,
    text: personaSuccessReply("remember", data, botContext.personaId) || replies.remembered,
    receipt: { action: "REMEMBER", status: "SAVED" },
  };
}

export const __test = {
  normalizeMemoryToolResult,
  ranaMemoryRecallText,
  memoryRecallMissResult,
  memoryScope,
  memoryRequestContext,
  memoryReplies,
  personaSuccessReply,
  memoryTargetIsOwner,
};

export function registerMemoryTool(api) {
  api.registerTool({
    name: "rana_memory",
    label: "Rana Memory",
    description: [
      "Durable memory tool for Rana.",
      "Use only for an explicit durable save, delete, or recall request. Casual discussion of memory, remembering in general, or current-session context must not call this tool.",
      "A save request must include the exact fact to store. If the user only says 一件事 or 這件事 without content, ask what to remember and do not call this tool.",
      "MUST call this tool before replying when the user asks Rana to remember something for later.",
      "MUST call this tool before replying when the user asks Rana to forget, delete, or remove remembered facts.",
      "MUST call this tool before replying when the user asks about durable remembered facts.",
      "A remember request is still a remember request when the saved fact contains negation such as 不是, 沒有, 不會, or 不是誰.",
      "Examples for remember: 記住紫貓酒量差, 幫我記住紫貓很容易醉, 樂奈記住這件事, 記住峰月律不是珂朵莉.",
      "Examples for recall: 紫貓酒量怎樣, 你記得紫貓酒量嗎, 紫貓是什麼狀況, 斧王是什麼, 皓男哥是誰.",
      "For user-defined nicknames or people, recall memory before answering; do not reuse lore examples.",
      "Do not answer the remembered fact as plain text unless this tool has returned a successful remember result.",
      "Never claim memory was saved unless this tool returns a successful remember result.",
      "Never answer durable-memory recall from current chat context only.",
      "Do not use this tool for current-session questions like 剛剛我說了什麼 or 這段對話記得嗎.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "One of: remember, recall, forget, status. Use recall for questions such as 紫貓酒量怎樣.",
        },
        text: { type: "string", description: "Memory text to store, or query text to recall." },
        requester_id: { type: "string", description: "Discord user id of the requester when available." },
      },
      required: ["action", "text"],
    },
    execute: async (_toolCallId, params, signal, _onUpdate, invocationCtx) => {
      const trusted = resolveTrustedInvocationContext(invocationCtx, { requireRequester: true });
      if (!trusted.ok) return trustedToolError("rana_memory", trusted);
      const trustedHint = trustedContextHint(trusted);
      const scope = memoryScope(trustedHint);
      if (!scope) return trustedToolError("rana_memory", { ok: false, error: "unresolved persona memory scope" });
      const action = firstText(params?.action);
      if (action === "status") {
        return { content: [{ type: "text", text: JSON.stringify(await memoryStatus(signal, scope)) }] };
      }
      if (action === "recall") {
        const query = recallQueryText(params?.text);
        const outcome = await callMemoryTool("recall", () => recallMemory({
          query,
          requester_id: trusted.requesterSenderId,
          roles: [],
          ...scope,
        }, signal), trustedHint);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      if (action === "remember") {
        const text = firstText(params?.text);
        if (!text) {
          return { content: [{ type: "text", text: JSON.stringify({ handled: true, status: "error", reply: memoryReplies(scope.persona_id).rememberEmpty }) }] };
        }
        const outcome = await callMemoryTool("remember", () => rememberMemory({
          text,
          source: "rana_memory_tool",
          requester_id: trusted.requesterSenderId,
          roles: [],
          ...scope,
        }, signal), trustedHint);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      if (action === "forget" || action === "delete" || action === "remove") {
        const query = recallQueryText(params?.text);
        if (!query) {
          return { content: [{ type: "text", text: JSON.stringify({ handled: true, status: "error", reply: memoryReplies(scope.persona_id).forgetWhat }) }] };
        }
        const outcome = await callMemoryTool("delete", () => deleteMemory({
          query,
          requester_id: trusted.requesterSenderId,
          roles: [],
          ...scope,
        }, signal), trustedHint);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ handled: false, status: "error", reply: memoryReplies(scope.persona_id).badAction }) }] };
    },
  });
}

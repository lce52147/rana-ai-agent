import { firstText, stripRanaMention } from "../tool_contracts.js";
import { recentRequesterId, recentRequesterRoles, rememberToolEvidence, resolveRequesterId } from "../context_store.js";
import { deleteMemory, memoryStatus, recallMemory, rememberMemory } from "../sidecars/memory.js";

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

function memoryFailureReply(action) {
  if (action === "remember") return "不行。沒有記住。";
  if (["forget", "delete", "remove"].includes(action)) return "不行。沒有忘掉。";
  return "卡住了。再問一次。";
}

export function normalizeMemoryToolResult(action, data, error) {
  const details = error ? parsedMemoryError(error) : data;
  const success = !error && memoryActionSucceeded(action, data);
  if (success) {
    return { ...data, tool: "rana_memory", action, success: true, status: "success", result: data };
  }
  return {
    tool: "rana_memory",
    action,
    success: false,
    status: "error",
    kind: firstText(details?.kind) || "memory_error",
    reply: memoryFailureReply(action),
    error: firstText(details?.error) || firstText(error?.message) || "memory result was not an explicit success",
    result: details,
  };
}

async function callMemoryTool(action, operation, hint) {
  try {
    const data = await operation();
    const outcome = normalizeMemoryToolResult(action, data);
    rememberToolEvidence("rana_memory", action === "forget" || action === "remove" ? "delete" : action, outcome.success, hint);
    return outcome;
  } catch (error) {
    const outcome = normalizeMemoryToolResult(action, null, error);
    rememberToolEvidence("rana_memory", action === "forget" || action === "remove" ? "delete" : action, false, hint);
    return outcome;
  }
}

export async function handleMemoryRequest(parsed, event, ctx, routeText, signal) {
  const requester_id = resolveRequesterId(event, ctx) || recentRequesterId();
  const hint = { requester_id };
  const roles = recentRequesterRoles(hint);
  if (parsed?.action === "forget" || parsed?.action === "delete" || parsed?.action === "remove") {
    const query = recallQueryText(parsed.text);
    if (!query) return { handled: true, text: "忘記什麼。" };
    const outcome = await callMemoryTool("delete", () => deleteMemory({ query, requester_id, roles }, signal), hint);
    if (!outcome.success) return { handled: true, text: outcome.reply };
    const data = outcome.result;
    return { handled: true, text: firstText(data?.reply) || (data?.removed > 0 ? "嗯。忘了。" : "沒有那個。") };
  }
  if (parsed?.action === "recall") {
    const query = recallQueryText(parsed.subject) || recallQueryText(parsed.text);
    if (!query) return { handled: true, text: "問哪件事。" };
    const outcome = await callMemoryTool("recall", () => recallMemory({ query, requester_id, roles }, signal), hint);
    if (!outcome.success) return { handled: true, text: outcome.reply };
    const data = outcome.result;
    if (data?.found || data?.hit || data?.item || (Array.isArray(data?.matches) && data.matches.length > 0)) {
      const value = firstText(data?.reply)
        || firstText(data?.item?.text)
        || firstText(data?.matches?.[0]?.text)
        || firstText(data?.items?.[0]?.text);
      return { handled: true, text: ranaMemoryRecallText(value) };
    }
    return { handled: true, text: "不知道。" };
  }
  if (parsed?.action !== "remember") return null;
  const text = firstText(parsed.text);
  if (!text) return { handled: true, text: "沒有內容。不能記。" };
  const outcome = await callMemoryTool("remember", () => rememberMemory({
    text,
    source: "rana_memory_pre_dispatch",
    requester_id,
    roles,
  }, signal), hint);
  if (!outcome.success) return { handled: true, text: outcome.reply };
  const data = outcome.result;
  return { handled: true, text: firstText(data?.reply) || "嗯。記住了。" };
}

export const __test = {
  normalizeMemoryToolResult,
  ranaMemoryRecallText,
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
    execute: async (_toolCallId, params, signal) => {
      const action = firstText(params?.action);
      if (action === "status") {
        return { content: [{ type: "text", text: JSON.stringify(await memoryStatus(signal)) }] };
      }
      if (action === "recall") {
        const query = recallQueryText(params?.text);
        const outcome = await callMemoryTool("recall", () => recallMemory({
          query,
          requester_id: firstText(params?.requester_id) || recentRequesterId(),
          roles: recentRequesterRoles(params),
        }, signal), params);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      if (action === "remember") {
        const text = firstText(params?.text);
        if (!text) {
          return { content: [{ type: "text", text: JSON.stringify({ handled: true, status: "error", reply: "沒有內容。不能記。" }) }] };
        }
        const outcome = await callMemoryTool("remember", () => rememberMemory({
          text,
          source: "rana_memory_tool",
          requester_id: firstText(params?.requester_id) || recentRequesterId(),
          roles: recentRequesterRoles(params),
        }, signal), params);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      if (action === "forget" || action === "delete" || action === "remove") {
        const query = recallQueryText(params?.text);
        if (!query) {
          return { content: [{ type: "text", text: JSON.stringify({ handled: true, status: "error", reply: "忘記什麼。" }) }] };
        }
        const outcome = await callMemoryTool("delete", () => deleteMemory({
          query,
          requester_id: firstText(params?.requester_id) || recentRequesterId(),
          roles: recentRequesterRoles(params),
        }, signal), params);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ handled: false, status: "error", reply: "記憶動作不對。" }) }] };
    },
  });
}

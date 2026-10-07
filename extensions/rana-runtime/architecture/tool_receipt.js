// Tool receipts: let the ONE natural-language generator speak in the character's
// own voice about a tool result that the runtime has already produced.
//
// Truth stays deterministic: the runtime performs (or refuses) the operation and
// hands the model a typed receipt with an explicit output allowlist. The model
// only chooses the wording. No sample sentences are included on purpose (finished
// answer examples are stochastic attractors); the receipt carries semantics only.
//
// Default OFF. Enable with RANA_TOOL_RECEIPT_VOICE=1 or by creating the empty file
// extensions/rana-runtime/flags/tool_receipt_voice.on (no restart needed for the file).
// The music stack never uses receipts; fixed wording stays there.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBotContext } from "../bot_context.js";

const RECEIPT_TTL_MS = 45_000;
const FLAG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flags", "tool_receipt_voice.on");
const receipts = new Map();

export function toolReceiptVoiceEnabled() {
  if (String(process.env.RANA_TOOL_RECEIPT_VOICE || "").trim() === "1") return true;
  try {
    return fs.existsSync(FLAG_FILE);
  } catch (_) {
    return false;
  }
}

function receiptKeys(event, ctx) {
  const bot = resolveBotContext(event, ctx);
  if (!bot?.personaId) return [];
  const channel = String(bot.channelId || "").trim();
  return channel ? [`${bot.personaId}|${channel}`, bot.personaId] : [bot.personaId];
}

export function recordToolReceipt(event, ctx, receipt) {
  const keys = receiptKeys(event, ctx);
  if (!keys.length || !receipt?.action || !receipt?.status) return false;
  const entry = { receipt, at: Date.now() };
  for (const key of keys) receipts.set(key, entry);
  return true;
}

export function consumeToolReceipt(event, ctx, now = Date.now()) {
  const keys = receiptKeys(event, ctx);
  for (const key of keys) {
    const entry = receipts.get(key);
    if (!entry) continue;
    for (const k of keys) if (receipts.get(k) === entry) receipts.delete(k);
    if (now - entry.at <= RECEIPT_TTL_MS) return entry.receipt;
  }
  return null;
}

// status -> [allowed predicates, forbidden predicates]
const STATUS_TABLE = {
  "REMEMBER/SAVED": ["ACK_MEMORY_SAVED", "CLAIM_MEMORY_NOT_SAVED|CLAIM_SAVED_FOR_OTHER_PERSONA|ADD_UNSAVED_DETAILS"],
  "REMEMBER/EMPTY": ["ASK_WHAT_TO_REMEMBER", "CLAIM_MEMORY_SAVED"],
  "REMEMBER/REFUSED_OTHER_PERSONA": ["REFUSE_TO_STORE_FOR_OTHER_PERSONA", "CLAIM_MEMORY_SAVED|CLAIM_SAVED_FOR_OTHER_PERSONA"],
  "REMEMBER/REFUSED_SENSITIVE": ["REFUSE_SENSITIVE_MEMORY", "CLAIM_MEMORY_SAVED|REPEAT_SENSITIVE_VALUE"],
  "REMEMBER/FAILED": ["REPORT_MEMORY_NOT_SAVED", "CLAIM_MEMORY_SAVED"],
  "REMEMBER/AMBIGUOUS_TARGET": ["ASK_WHO_IS_MEANT", "CLAIM_MEMORY_SAVED|GUESS_WHO_IS_MEANT"],
  "FORGET/FORGOTTEN": ["ACK_MEMORY_REMOVED", "CLAIM_NOTHING_MATCHED"],
  "FORGET/NOT_FOUND": ["REPORT_NOTHING_MATCHED", "CLAIM_MEMORY_REMOVED"],
  "FORGET/REFUSED_BULK": ["REFUSE_BULK_FORGET", "CLAIM_MEMORY_REMOVED"],
  "FORGET/NEEDS_TARGET": ["ASK_WHAT_TO_FORGET", "CLAIM_MEMORY_REMOVED"],
  "FORGET/FAILED": ["REPORT_MEMORY_NOT_REMOVED", "CLAIM_MEMORY_REMOVED"],
  "FORGET/AMBIGUOUS_TARGET": ["ASK_WHO_IS_MEANT", "CLAIM_MEMORY_REMOVED|GUESS_WHO_IS_MEANT"],
  "RECALL/NEEDS_TARGET": ["ASK_WHICH_MEMORY", "INVENT_MEMORY_CONTENT"],
  "RECALL/NOT_FOUND": ["REPORT_MEMORY_NOT_FOUND", "INVENT_MEMORY_CONTENT|CLAIM_REMEMBERING"],
  "RECALL/FAILED": ["REPORT_MEMORY_UNAVAILABLE", "INVENT_MEMORY_CONTENT|CLAIM_REMEMBERING"],
  "RECALL/AMBIGUOUS_TARGET": ["ASK_WHO_IS_MEANT", "INVENT_MEMORY_CONTENT|GUESS_WHO_IS_MEANT"],
};

export function renderToolReceipt(receipt) {
  const action = String(receipt?.action || "").toUpperCase();
  const status = String(receipt?.status || "").toUpperCase();
  const row = STATUS_TABLE[`${action}/${status}`];
  if (!row) return "";
  return [
    "TOOL_RECEIPT (deterministic runtime result; not dialogue):",
    `TOOL=${receipt.tool || "rana_memory"}`,
    `ACTION=${action}`,
    `STATUS=${status}`,
    "OPERATION_ALREADY_EXECUTED_BY_RUNTIME=TRUE",
    `ALLOWED_OUTPUT_PREDICATES=${row[0]}`,
    `FORBIDDEN_OUTPUT_PREDICATES=${row[1]}`,
    "RESPONSE_FUNCTION=SPEAK_ONE_SHORT_REACTION_TO_THIS_RESULT",
    "OUTPUT_TYPE=SPOKEN_CONTENT_ONLY",
    "SIMULATE_SCENE=DENY",
    "PARENTHETICAL_ROLEPLAY_ACTION=DENY",
    "TOOL_CALLS=DENY",
  ].join("\n");
}

export function registerToolReceiptContext(api) {
  api.on("before_prompt_build", (event, ctx) => {
    const receipt = consumeToolReceipt(event, ctx);
    if (!receipt) return undefined;
    const block = renderToolReceipt(receipt);
    return block ? { appendSystemContext: block } : undefined;
  }, { priority: 950, timeoutMs: 2_000 });
}

export const __test = { receipts, RECEIPT_TTL_MS, STATUS_TABLE };

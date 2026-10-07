import { fixedReply } from "../persona_replies.js";
import { resolveBotContext } from "../bot_context.js";
import { buildUnifiedTurnPlan } from "../architecture/turn_plan.js";
import {
  extractStockLikeTickers,
  firstText,
  isCurrentTurnToolAuthorized,
} from "../tool_contracts.js";
import {
  isNoMatchContext,
  recentContextSnapshot,
  recentRequesterId,
  rememberToolEvidence,
} from "../context_store.js";
import { researchStock } from "../sidecars/stock.js";
import { resolveTrustedInvocationContext, trustedContextHint, trustedToolError } from "../architecture/turn_isolation.js";

const FAILED_STOCK_KIND_RE = /(?:unavailable|error|empty|pass)$/iu;
const STOCK_INTENT_BLOCK_REASON = "rana_stock_research requires explicit current-turn stock intent";

export function stockResearchAuthorized(requester_id, hint = { requester_id }) {
  const requesterId = firstText(requester_id);
  if (!requesterId || isNoMatchContext(hint)) return false;
  const context = recentContextSnapshot(hint);
  return context.fresh && context.requester_id === requesterId;
}

export function stockResearchSucceeded(data) {
  return Boolean(
    data
    && data.handled === true
    && data.status !== "error"
    && /^leprechaun_/iu.test(firstText(data.kind))
    && !FAILED_STOCK_KIND_RE.test(firstText(data.kind))
    && firstText(data.reply).trim()
  );
}

export function normalizeStockTextForModel(text) {
  return firstText(text)
    .replace(/(我要看)(?=[A-Z$])/g, "$1 ")
    .replace(/(我想看)(?=[A-Z$])/g, "$1 ")
    .replace(/(幫我看)(?=[A-Z$])/g, "$1 ")
    .replace(/(查)(?=[A-Z$])/g, "$1 ");
}

export function stockToolSourceDecision(requester_id, hint = { requester_id }) {
  const context = recentContextSnapshot(hint);
  const sourceText = firstText(context.source_text);
  const plan = sourceText ? buildUnifiedTurnPlan(sourceText) : null;
  const grounded = Boolean(
    context.fresh
    && sourceText
    && isCurrentTurnToolAuthorized({ toolName: "rana_stock_research", plan })
  );
  const parsed = grounded ? plan?.tool?.arguments?.stock : null;
  return {
    grounded,
    sourceText,
    context,
    tickers: parsed ? [parsed.ticker] : [],
  };
}

function rejectedStockToolResult() {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        handled: false,
        kind: "stock_intent_rejected",
        status: "rejected",
        reply: "",
        error_code: "stock_intent_not_grounded",
        instruction: "原始訊息沒有明確美股語境。不要提股票、美股、ticker、公司產業或買賣限制；按原始問題作一般對話回答。候選不清楚就問是哪幾個。",
      }),
    }],
  };
}

// Explicit stock research is deterministic evidence, not a prose task. Run it
// before model dispatch so the financial renderer reaches Discord without a
// language model rounding, converting units, or inventing a conclusion.
export async function handleStockResearchRequest(event, ctx, routeText, signal) {
  const unavailableText = fixedReply(resolveBotContext(event, ctx)?.personaId, "toolUnavailable") || "現在查不到。";
  const query = firstText(routeText);
  const requester_id = firstText(event?.senderId)
    || firstText(event?.sender_id)
    || firstText(ctx?.requester_id)
    || firstText(ctx?.senderId)
    || recentRequesterId();
  const tickers = extractStockLikeTickers(query);
  const text = tickers.length ? `stock ${tickers.join(" ")} analysis` : query;
  if (!text) return { handled: true, text: unavailableText };
  try {
    const data = await researchStock({ query: text, requester_id }, signal);
    const succeeded = stockResearchSucceeded(data);
    rememberToolEvidence("rana_stock_research", "research", succeeded, { requester_id }, succeeded ? firstText(data.reply) : "");
    return {
      handled: true,
      text: firstText(data?.reply) || unavailableText,
    };
  } catch (_) {
    rememberToolEvidence("rana_stock_research", "research", false, { requester_id });
    return { handled: true, text: unavailableText };
  }
}

export function registerStockTool(api, { researchStock: researchStockImpl = researchStock } = {}) {
  if (typeof api.on === "function") {
    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (String(event?.toolName || "") !== "rana_stock_research") return;

        const agentId = typeof ctx?.agentId === "string" ? ctx.agentId.trim() : "";
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
        if (!agentId || !sessionKey) {
          return {
            block: true,
            blockReason: "rana_stock_research requires trusted current-turn context",
          };
        }

        const currentTurnText = firstText(ctx?.currentTurnText).trim();
        if (currentTurnText) {
          const plan = buildUnifiedTurnPlan(currentTurnText);
          const grounded = Boolean(
            isCurrentTurnToolAuthorized({ toolName: "rana_stock_research", plan })
          );
          if (!grounded) return { block: true, blockReason: STOCK_INTENT_BLOCK_REASON };
          return;
        }

        const hint = { agent_id: agentId, session_key: sessionKey, agentId, sessionKey };
        if (isNoMatchContext(hint)) {
          return {
            block: true,
            blockReason: "rana_stock_research requires an unambiguous current-turn context",
          };
        }

        const context = recentContextSnapshot(hint);
        if (!context.fresh || context.agent_id !== agentId || context.session_key !== sessionKey) {
          return {
            block: true,
            blockReason: "rana_stock_research requires trusted current-turn context",
          };
        }

        const decision = stockToolSourceDecision("", hint);
        if (!decision.grounded) {
          return { block: true, blockReason: STOCK_INTENT_BLOCK_REASON };
        }
      },
      { priority: 6000, timeoutMs: 5000 },
    );
  }

  api.registerTool((factoryCtx) => ({
    name: "rana_stock_research",
    label: "Rana Stock Research",
    description: "Allowed only for the exact current user command 我想看美股 <stock ID>. A bare ticker, company/product noun, mention, discussion, prior turn, or model-supplied parameter is not authorization.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Untrusted request parameter; authorization uses the exact current user turn." },
        tickers: {
          type: "array",
          items: { type: "string" },
          description: "Untrusted optional IDs; authorization uses the exact current user turn.",
        },
        requester_id: { type: "string", description: "Discord user id of the requester when available." },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      const trusted = resolveTrustedInvocationContext(factoryCtx, { requireRequester: true });
      if (!trusted.ok) return trustedToolError("rana_stock_research", trusted);
      const requester_id = trusted.requesterSenderId;
      const evidenceHint = trustedContextHint(trusted);
      const sourceDecision = stockToolSourceDecision(requester_id, evidenceHint);

      // Model-supplied query/tickers are untrusted. The original Discord text
      // is the authority. Reject before authorization so a mistaken tool call
      // cannot turn an ordinary product question into a finance denial reply.
      if (!sourceDecision.grounded) {
        rememberToolEvidence("rana_stock_research", "research", false, evidenceHint);
        return rejectedStockToolResult();
      }

      if (!stockResearchAuthorized(requester_id, evidenceHint)) {
        const reply = "目前回合的股票請求上下文未通過可信驗證。";
        rememberToolEvidence("rana_stock_research", "research", false, evidenceHint, reply);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              handled: true,
              kind: "leprechaun_access_denied",
              status: "denied",
              reply,
              error_code: "stock_access_denied",
            }),
          }],
        };
      }

      const text = sourceDecision.tickers.length
        ? `stock ${sourceDecision.tickers.join(" ")} analysis`
        : sourceDecision.sourceText;

      try {
        const data = await researchStockImpl({ query: text, requester_id }, signal);
        const succeeded = stockResearchSucceeded(data);
        // Preserve Leprechaun's deterministic financial renderer so the
        // personality model cannot round or alter numeric evidence.
        rememberToolEvidence(
          "rana_stock_research",
          "research",
          succeeded,
          evidenceHint,
          succeeded ? firstText(data.reply) : "",
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (_) {
        rememberToolEvidence("rana_stock_research", "research", false, evidenceHint);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              handled: true,
              kind: "leprechaun_tool_error",
              status: "error",
              reply: "美股研究工具沒跑通。現在不能補數字。",
              error_code: "stock_unavailable",
            }),
          }],
        };
      }
    },
  }), { names: ["rana_stock_research"] });
}

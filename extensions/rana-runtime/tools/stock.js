import { extractStockLikeTickers, firstText } from "../tool_contracts.js";
import { recentRequesterId, rememberToolEvidence } from "../context_store.js";
import { researchStock } from "../sidecars/stock.js";

const FAILED_STOCK_KIND_RE = /(?:unavailable|error|empty|pass)$/iu;

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

export function registerStockTool(api) {
  api.registerTool({
    name: "rana_stock_research",
    label: "Rana Stock Research",
    description: "Query Leprechaun for grounded US stock research. Call only when the user explicitly requests finance research and supplies a named ticker, or explicitly requests a market-wide scan. If the request lacks both, ask what ticker they mean without calling this tool.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Original finance request. Use this for US stock tickers and finance analysis." },
        tickers: {
          type: "array",
          items: { type: "string" },
          description: "Optional US stock tickers to analyze.",
        },
        requester_id: { type: "string", description: "Discord user id of the requester when available." },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params, signal) => {
      const query = firstText(params?.query);
      const requester_id = firstText(params?.requester_id) || recentRequesterId();
      const evidenceHint = { requester_id };
      const explicitTickers = Array.isArray(params?.tickers)
        ? params.tickers.map((ticker) => firstText(ticker).toUpperCase()).filter(Boolean)
        : [];
      const tickers = explicitTickers.length ? explicitTickers : extractStockLikeTickers(query);
      const text = tickers.length ? `stock ${tickers.join(" ")} analysis` : query;
      if (!text) {
        rememberToolEvidence("rana_stock_research", "research", false, evidenceHint);
        return { content: [{ type: "text", text: JSON.stringify({ handled: false, reply: "資料沒醒。不能亂講。" }) }] };
      }
      try {
        const data = await researchStock({ query: text, requester_id }, signal);
        rememberToolEvidence("rana_stock_research", "research", stockResearchSucceeded(data), evidenceHint);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (error) {
        rememberToolEvidence("rana_stock_research", "research", false, evidenceHint);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              handled: true,
              kind: "leprechaun_tool_error",
              status: "error",
              reply: "股票資料沒醒。不能亂說。",
              error: firstText(error?.message) || "stock research failed",
            }),
          }],
        };
      }
    },
  });
}

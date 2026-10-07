import { registerPreDispatch } from "./architecture/pre_dispatch.js";
import { registerRanaTurnContextEngine } from "./architecture/context_engine.js";
import { registerModelToolGuidance, __test as modelToolGuidanceTest } from "./architecture/model_tool_guidance.js";
import { registerTurnContextProjection } from "./architecture/turn_context_projection.js";
import { registerToolReceiptContext } from "./architecture/tool_receipt.js";
import { guardOutgoingMessage } from "./output_guard.js";
import { handleControlRequest, handlePlayRequest } from "../rana-music-tools/tools/music.js";
import { handleMemoryRequest, registerMemoryTool, __test as memoryToolTest } from "./tools/memory.js";
import { handleStockResearchRequest, normalizeStockTextForModel, registerStockTool } from "./tools/stock.js";
import { registerLoreGuidance } from "./lore/guidance.js";
import { registerPersonaGuidance } from "./persona_context.js";
import { registerPersonaLoreTool } from "./persona_lore.js";
import { getToolRegistry, getToolRegistryEntry, TOOL_REGISTRY, TOOL_REGISTRY_IDS } from "./tool_registry.js";
import { registerCurrentFactAuthorityGate, registerCurrentTurnEvidenceObserver, registerTurnIsolation, __test as turnIsolationTest } from "./architecture/turn_isolation.js";
import { registerTurnToolSurface } from "./tool_surface.js";
import { registerPersonaPromptSurface } from "./architecture/prompt_surface_profile.js";

function messageSendingContextHint(event, ctx) {
  return { ...(ctx || {}), ...(event || {}) };
}

const plugin = {
  id: "rana-runtime",
  name: "Rana Runtime",
  description: "Rana pre-dispatch, memory, stock, model guidance, and output boundary wiring.",
  register(api) {
    registerPersonaPromptSurface(api);
    registerRanaTurnContextEngine(api);
    registerTurnIsolation(api);
    registerCurrentTurnEvidenceObserver(api);
    registerCurrentFactAuthorityGate(api);
    registerTurnContextProjection(api);
registerToolReceiptContext(api);
    registerMemoryTool(api);
    registerStockTool(api);
    registerTurnToolSurface(api);
    registerModelToolGuidance(api);
    registerLoreGuidance(api);
    registerPersonaGuidance(api);
    registerPersonaLoreTool(api);
    registerPreDispatch(api, {
      handleControlRequest,
      handleMemoryRequest,
      handlePlayRequest,
      handleStockResearchRequest,
      normalizeRouteText: normalizeStockTextForModel,
    });
    api.on("message_sending", async (event, ctx) => guardOutgoingMessage(event?.content, messageSendingContextHint(event, ctx)), { priority: 1000 });
  },
};

export const __test = { ...memoryToolTest, ...modelToolGuidanceTest, ...turnIsolationTest, messageSendingContextHint };
export { getToolRegistry, getToolRegistryEntry, TOOL_REGISTRY, TOOL_REGISTRY_IDS };
export default plugin;

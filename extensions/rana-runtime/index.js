import { registerOfflineModelSelection, registerPreDispatch } from "./architecture/pre_dispatch.js";
import { registerModelToolGuidance, __test as modelToolGuidanceTest } from "./architecture/model_tool_guidance.js";
import { guardOutgoingMessage } from "./output_guard.js";
import { handleControlRequest, handlePlayRequest } from "../rana-music-tools/tools/music.js";
import { handleMemoryRequest, registerMemoryTool, __test as memoryToolTest } from "./tools/memory.js";
import { normalizeStockTextForModel, registerStockTool } from "./tools/stock.js";

const plugin = {
  id: "rana-runtime",
  name: "Rana Runtime",
  description: "Rana pre-dispatch, memory, stock, model guidance, and output boundary wiring.",
  register(api) {
    registerMemoryTool(api);
    registerStockTool(api);
    registerModelToolGuidance(api);
    registerOfflineModelSelection(api);
    registerPreDispatch(api, {
      handleControlRequest,
      handleMemoryRequest,
      handlePlayRequest,
      normalizeRouteText: normalizeStockTextForModel,
    });
    api.on("message_sending", async (event) => guardOutgoingMessage(event?.content, event), { priority: 1000 });
  },
};

export const __test = { ...memoryToolTest, ...modelToolGuidanceTest };
export default plugin;

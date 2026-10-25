import { registerVisionGuidance } from "./guidance.js";
import { registerVisionTool } from "./tool.js";

const plugin = {
  id: "rana-vision",
  name: "Rana Vision",
  description: "ToriiGate vision, feedback components, media attachment understanding, canonical identity resolution, and Rana response context.",
  register(api) {
    registerVisionTool(api);
    registerVisionGuidance(api);
  },
};

export default plugin;

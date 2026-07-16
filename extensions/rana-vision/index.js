import { registerVisionGuidance } from "./guidance.js";
import { registerVisionTool } from "./tool.js";

const plugin = {
  id: "rana-vision",
  name: "Rana Vision",
  description: "ToriiGate vision, OCR, canonical identity resolution, Rana impression lookup, and OOGG image context.",
  register(api) {
    registerVisionTool(api);
    registerVisionGuidance(api);
  },
};

export default plugin;

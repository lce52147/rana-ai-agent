import { readFile } from "node:fs/promises";

const [target, atlas] = await Promise.all([
  readFile(new URL("../references/source/tomori.png", import.meta.url)),
  readFile(new URL("../references/atlas-core.png", import.meta.url)),
]);
const content = [
  {
    type: "text",
    text: [
      "Image 1 is the ONLY target. Image 2 is a labeled 3x3 official reference grid.",
      "Find the single cell in image 2 that shows the same character design as the person in image 1.",
      "Return JSON only with keys match.id, match.confidence, match.evidence, match.position.",
      "Do not describe or list the grid. Use an empty id if no cell matches.",
    ].join("\n"),
  },
  { type: "image_url", image_url: { url: `data:image/png;base64,${target.toString("base64")}` } },
  { type: "text", text: "Official reference grid:" },
  { type: "image_url", image_url: { url: `data:image/png;base64,${atlas.toString("base64")}` } },
];
const response = await fetch("http://100.99.83.84:6970/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "model\\rana-vision\\ToriiGate-0.5-Q4_K_M.gguf",
    temperature: 0,
    max_tokens: 250,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "atlas_match",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["id", "confidence", "position"],
          properties: {
            id: { type: "string", enum: ["", "rana", "tomori", "anon", "soyo", "taki", "ririko", "shifune", "mutsumi", "nyamu"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            position: { type: "string" },
          },
        },
      },
    },
    messages: [
      { role: "system", content: "Compare the target only against the labeled reference grid. Return one JSON match, never a list of grid contents." },
      { role: "user", content },
    ],
  }),
});
console.log(response.status, await response.text());

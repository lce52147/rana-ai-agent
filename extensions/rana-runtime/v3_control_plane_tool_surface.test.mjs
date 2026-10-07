import assert from "node:assert/strict";
import test from "node:test";
import { registerMusicTools } from "../rana-music-tools/tools/music.js";
import { registerVisionTool } from "../rana-vision/tool.js";
import { __test as contextTest } from "./context_store.js";
import {
  __test as contractTest,
  isCurrentTurnToolAuthorized,
  resolveCurrentTurnToolSurface,
} from "./current_turn_tool_contract.js";
import { registerTurnToolSurface } from "./tool_surface.js";
import { registerStockTool } from "./tools/stock.js";

const MUSIC = "rana_play_music";
const ALL_MUSIC = [
  "rana_play_music",
  "rana_stop_music",
  "rana_show_queue",
  "rana_skip_music",
  "rana_volume_music",
  "rana_join_voice",
  "rana_leave_voice",
];
const VISION = "rana_analyze_image";
const STOCK = "rana_stock_research";
const OTHER = "read";
const IMAGE_PATH = "C:\\Users\\Administrator\\.openclaw\\media\\inbound\\v3-current.png";
const OWNER_ID = "376320922484867073";

function currentImageProvenance(overrides = {}) {
  return {
    currentTurn: true,
    recordedAt: Date.now(),
    attachments: [{ kind: "image", mimeType: "image/png", path: IMAGE_PATH }],
    ...overrides,
  };
}

function surface(text, mediaProvenance) {
  return resolveCurrentTurnToolSurface({
    text,
    mediaProvenance,
    toolNames: [OTHER, ...ALL_MUSIC, VISION, STOCK],
  });
}

function seedTurn(text, sessionKey, { senderId = OWNER_ID, chatType = "dm" } = {}) {
  contextTest.rememberDiscordContext(
    { body: text, senderId, channelId: "149531971971237091", guildId: "1486679037605842944" },
    {
      agentId: "main",
      sessionKey,
      channelId: "149531971971237091",
      guildId: "1486679037605842944",
      chatType,
    },
  );
}

test("ordinary named/persona/noun turns expose none of the gated schemas", () => {
  for (const text of [
    "Soyo",
    "Tomori",
    "RiNG",
    "LIVE",
    "noun turn",
    "Tomori S5 M5",
    "RiNG LIVE",
    "MyGO!!!!!",
    "music discussion",
    "NVDA",
    "Intel",
    "Qualcomm",
    "CPU company discussion",
  ]) {
    const result = surface(text);
    assert.deepEqual(result.allowedToolNames, [OTHER], text);
    for (const toolName of ALL_MUSIC)
      assert.equal(result.allowedToolNames.includes(toolName), false, `${text}: ${toolName}`);
  }
});

test("authorized forms expose only the required gated schema", () => {
  const cases = [
    { text: "\u64ad\u653e \u6625\u65e5\u5f71", required: MUSIC },
    { text: "play https://example.test/song", required: MUSIC },
    {
      text: `\u7d66\u4f60\u62b9\u8336\u82ad\u83f2 [media attached: ${IMAGE_PATH} (image/png)]`,
      media: currentImageProvenance(),
      required: VISION,
    },
    {
      text: `\u5e6b\u6211\u67e5 [media attached: ${IMAGE_PATH} (image/png)]`,
      media: currentImageProvenance(),
      required: VISION,
    },
    {
      text: "\u5e6b\u6211\u770b\u9019\u5f35\u5716",
      media: currentImageProvenance(),
      required: VISION,
    },
    { text: "\u6211\u60f3\u770b\u7f8e\u80a1 NVDA", required: STOCK },
  ];
  for (const item of cases) {
    const result = surface(item.text, item.media);
    assert.deepEqual(result.allowedToolNames, [OTHER, item.required], item.text);
    assert.deepEqual(result.allowedSensitiveToolNames, [item.required], item.text);
  }
});

test("Vision exposure uses immutable per-run event/context evidence and isolates concurrent runs", async () => {
  let hook;
  registerTurnToolSurface({
    on(name, handler) {
      if (name === "before_prompt_build") hook = handler;
    },
  });
  assert.equal(typeof hook, "function");

  const prompt = `\u5e6b\u6211\u67e5 [media attached: ${IMAGE_PATH} (image/png)]`;
  const tools = [OTHER, ...ALL_MUSIC, VISION, STOCK].map((name) => ({ name }));
  const current = Object.freeze({
    currentTurn: true,
    recordedAt: Date.now(),
    attachments: Object.freeze([{ kind: "image", mimeType: "image/png", path: IMAGE_PATH }]),
  });
  const stale = Object.freeze({
    ...current,
    recordedAt: Date.now() - 3 * 60 * 1000,
  });

  const [currentRun, staleRun] = await Promise.all([
    Promise.resolve(
      hook(
        { runId: "v3-surface-current", prompt, tools, currentTurnMediaEvidence: current },
        { runId: "v3-surface-current" },
      ),
    ),
    Promise.resolve(
      hook(
        { runId: "v3-surface-stale", prompt, tools, currentTurnMediaEvidence: stale },
        { runId: "v3-surface-stale" },
      ),
    ),
  ]);
  assert.deepEqual(currentRun.toolsAllow, [OTHER, VISION]);
  assert.deepEqual(staleRun.toolsAllow, [OTHER]);

  const contextRun = hook(
    { runId: "v3-surface-context", prompt, tools },
    { runId: "v3-surface-context", currentTurnMediaProvenance: current },
  );
  assert.deepEqual(contextRun.toolsAllow, [OTHER, VISION]);

  const promptOnlyRun = hook(
    { runId: "v3-surface-prompt-only", prompt, tools },
    { runId: "v3-surface-prompt-only" },
  );
  assert.deepEqual(promptOnlyRun.toolsAllow, [OTHER]);

  const embeddedRunnerShape = hook(
    {
      runId: "v3-surface-no-path",
      prompt,
      tools,
      attachments: [{ kind: "image", mimeType: "image/png" }],
    },
    { runId: "v3-surface-no-path" },
  );
  assert.deepEqual(embeddedRunnerShape.toolsAllow, [OTHER]);
});

test("Vision requires current usable media plus explicit intent and rejects stale provenance", () => {
  const positive = `\u5e6b\u6211\u67e5 [media attached: ${IMAGE_PATH} (image/png)]`;
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: positive,
      mediaProvenance: currentImageProvenance(),
    }),
    true,
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: "\u5e6b\u6211\u770b\u9019\u5f35\u5716",
      mediaProvenance: currentImageProvenance(),
    }),
    true,
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `[media attached: ${IMAGE_PATH} (image/png)]`,
      mediaProvenance: currentImageProvenance(),
    }),
    false,
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `\u5e6b\u6211\u67e5 [media attached: C:\\forged\\not-current.png (image/png)]`,
      mediaProvenance: currentImageProvenance(),
    }),
    false,
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: "\u5e6b\u6211\u67e5",
      mediaProvenance: currentImageProvenance(),
    }),
    true,
    "a bare vision operation is authorized when trusted current provenance exists",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: positive,
      mediaProvenance: currentImageProvenance({ recordedAt: Date.now() - 3 * 60 * 1000 }),
    }),
    false,
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: positive,
      mediaProvenance: currentImageProvenance({
        attachments: [{ kind: "image", mimeType: "image/png", path: IMAGE_PATH, generated: true }],
      }),
    }),
    false,
  );
});

test("Vision intent is independent from media markers and uses trusted current provenance", () => {
  const marker = `[media attached: ${IMAGE_PATH} (image/png)]`;
  const forgedMarker = `[media attached: C:\\forged\\not-current.png (image/png)]`;
  const current = currentImageProvenance();

  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `\u597d\u53ef\u611b ${marker}`,
      mediaProvenance: current,
    }),
    false,
    "a casual caption with a valid marker is not explicit vision intent",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `\u770b\u8d77\u4f86\u597d\u53ef\u611b ${marker}`,
      mediaProvenance: current,
    }),
    false,
    "a casual caption beginning with a vision-like prefix is not explicit vision intent",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `checkmate ${marker}`,
      mediaProvenance: current,
    }),
    false,
    "checkmate is not the check vision operation",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: marker,
      mediaProvenance: current,
    }),
    false,
    "a media marker alone is not explicit vision intent",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: "\u5e6b\u6211\u770b",
      mediaProvenance: current,
    }),
    true,
    "bare \u5e6b\u6211\u770b uses trusted current provenance for media authorization",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: "\u5e6b\u6211\u770b\u9019\u5f35\u5716",
      mediaProvenance: current,
    }),
    true,
    "deictic image request uses trusted current provenance without a marker",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({ toolName: VISION, text: "\u5e6b\u6211\u770b" }),
    false,
    "bare \u5e6b\u6211\u770b without provenance fails closed",
  );
  assert.equal(
    isCurrentTurnToolAuthorized({
      toolName: VISION,
      text: `\u5e6b\u6211\u770b ${forgedMarker}`,
      mediaProvenance: current,
    }),
    false,
    "a forged marker cannot authorize a different current path",
  );
});

test("exposure and execution use the same current-turn parser; forged params do not authorize", async () => {
  let musicGate;
  let stockGate;
  registerMusicTools({
    on(name, handler) {
      if (name === "before_tool_call") musicGate = handler;
    },
    registerTool() {},
  });
  registerStockTool({
    on(name, handler) {
      if (name === "before_tool_call") stockGate = handler;
    },
    registerTool() {},
  });

  const musicNegative = "v3-music-forged";
  seedTurn("MyGO!!!!!", musicNegative);
  assert.equal(surface("MyGO!!!!!").allowedToolNames.includes(MUSIC), false);
  assert.equal(
    (
      await musicGate(
        {
          toolName: MUSIC,
          sessionKey: musicNegative,
          params: { query: "spring shadow", source_text: "play spring shadow" },
        },
        { agentId: "main", sessionKey: musicNegative },
      )
    )?.block,
    true,
  );

  const musicPositive = "v3-music-positive";
  seedTurn("\u64ad\u653e \u6625\u65e5\u5f71", musicPositive);
  assert.equal(surface("\u64ad\u653e \u6625\u65e5\u5f71").allowedToolNames.includes(MUSIC), true);
  assert.equal(
    await musicGate(
      { toolName: MUSIC, sessionKey: musicPositive, params: { query: "not-authoritative" } },
      { agentId: "main", sessionKey: musicPositive },
    ),
    undefined,
  );

  const stockNegative = "v3-stock-forged";
  seedTurn("Intel", stockNegative);
  assert.equal(surface("Intel").allowedToolNames.includes(STOCK), false);
  assert.equal(
    (
      await stockGate(
        { toolName: STOCK, sessionKey: stockNegative, params: { query: "NVDA" } },
        { agentId: "main", sessionKey: stockNegative },
      )
    )?.block,
    true,
  );

  const stockPositive = "v3-stock-positive";
  seedTurn("\u6211\u60f3\u770b\u7f8e\u80a1 NVDA", stockPositive);
  assert.equal(
    surface("\u6211\u60f3\u770b\u7f8e\u80a1 NVDA").allowedToolNames.includes(STOCK),
    true,
  );
  assert.equal(
    await stockGate(
      { toolName: STOCK, sessionKey: stockPositive, params: { query: "Intel" } },
      { agentId: "main", sessionKey: stockPositive },
    ),
    undefined,
  );
});

test("before_tool_call gates prefer host currentTurnText and retain Vision provenance gates", async () => {
  let musicGate;
  let stockGate;
  registerMusicTools({
    on(name, handler) {
      if (name === "before_tool_call") musicGate = handler;
    },
    registerTool() {},
  });
  registerStockTool({
    on(name, handler) {
      if (name === "before_tool_call") stockGate = handler;
    },
    registerTool() {},
  });

  const stockAllowSession = "v3-current-text-stock-allow";
  assert.equal(
    await stockGate(
      { toolName: STOCK, sessionKey: stockAllowSession, params: { query: "NVDA" } },
      {
        agentId: "main",
        sessionKey: stockAllowSession,
        currentTurnText: "\u6211\u60f3\u770b\u7f8e\u80a1 NVDA",
      },
    ),
    undefined,
  );

  const stockBlockSession = "v3-current-text-stock-block";
  seedTurn("\u6211\u60f3\u770b\u7f8e\u80a1 NVDA", stockBlockSession);
  assert.equal(
    (
      await stockGate(
        { toolName: STOCK, sessionKey: stockBlockSession, params: { query: "NVDA" } },
        { agentId: "main", sessionKey: stockBlockSession, currentTurnText: "NVDA" },
      )
    )?.block,
    true,
  );

  const musicAllowSession = "v3-current-text-music-allow";
  seedTurn("\u6625\u65e5\u5f71", musicAllowSession);
  assert.equal(
    await musicGate(
      { toolName: MUSIC, sessionKey: musicAllowSession, params: { query: "\u6625\u65e5\u5f71" } },
      {
        agentId: "main",
        sessionKey: musicAllowSession,
        currentTurnText: "\u64ad\u653e \u6625\u65e5\u5f71",
      },
    ),
    undefined,
  );

  const musicBlockSession = "v3-current-text-music-block";
  seedTurn("\u64ad\u653e \u6625\u65e5\u5f71", musicBlockSession);
  assert.equal(
    (
      await musicGate(
        { toolName: MUSIC, sessionKey: musicBlockSession, params: { query: "\u6625\u65e5\u5f71" } },
        { agentId: "main", sessionKey: musicBlockSession, currentTurnText: "\u6625\u65e5\u5f71" },
      )
    )?.block,
    true,
  );

  let visionPromptHook;
  let visionCallHook;
  const provenance = currentImageProvenance();
  registerVisionTool(
    {
      on(name, handler) {
        if (name === "before_prompt_build") visionPromptHook = handler;
        if (name === "before_tool_call") visionCallHook = handler;
      },
      registerTool() {},
    },
    { currentTurnMediaEvidence: provenance },
  );

  const visionPrompt = `\u5e6b\u6211\u770b [media attached: ${IMAGE_PATH} (image/png)]`;
  const visionAllowRun = "v3-current-text-vision-allow";
  await visionPromptHook(
    { runId: visionAllowRun, prompt: visionPrompt },
    { runId: visionAllowRun, currentTurnText: visionPrompt, currentTurnMediaEvidence: provenance },
  );
  assert.equal(
    await visionCallHook(
      {
        toolName: VISION,
        runId: visionAllowRun,
        toolCallId: "v3-current-text-vision-allow-call",
        params: { image_path: IMAGE_PATH },
      },
      { runId: visionAllowRun, currentTurnText: visionPrompt, currentTurnMediaEvidence: provenance },
    ),
    undefined,
  );

  const missingIntentRun = "v3-current-text-vision-no-intent";
  const missingIntentPrompt = `[media attached: ${IMAGE_PATH} (image/png)]\n\u665a\u5b89`;
  await visionPromptHook(
    { runId: missingIntentRun, prompt: missingIntentPrompt },
    { runId: missingIntentRun, currentTurnText: missingIntentPrompt, currentTurnMediaEvidence: provenance },
  );
  assert.equal(
    (
      await visionCallHook(
        {
          toolName: VISION,
          runId: missingIntentRun,
          toolCallId: "v3-current-text-vision-no-intent-call",
          params: { image_path: IMAGE_PATH },
        },
        { runId: missingIntentRun, currentTurnText: missingIntentPrompt, currentTurnMediaEvidence: provenance },
      )
    )?.block,
    true,
  );

  const missingMediaRun = "v3-current-text-vision-no-media";
  const missingMediaPrompt = "\u5e6b\u6211\u770b\u9019\u5f35\u5716";
  await visionPromptHook(
    { runId: missingMediaRun, prompt: missingMediaPrompt },
    { runId: missingMediaRun, currentTurnText: missingMediaPrompt, currentTurnMediaEvidence: provenance },
  );
  assert.equal(
    (
      await visionCallHook(
        {
          toolName: VISION,
          runId: missingMediaRun,
          toolCallId: "v3-current-text-vision-no-media-call",
          params: { image_path: IMAGE_PATH },
        },
        { runId: missingMediaRun, currentTurnText: missingMediaPrompt, currentTurnMediaEvidence: provenance },
      )
    )?.block,
    true,
  );
});

test("Vision hard gate rejects stale or mismatched forged invocation and allows the exact current path", async () => {
  let visionPromptHook;
  let visionCallHook;
  let definition;
  registerVisionTool(
    {
      on(name, handler) {
        if (name === "before_prompt_build") visionPromptHook = handler;
        if (name === "before_tool_call") visionCallHook = handler;
      },
      registerTool(tool) {
        definition = tool;
      },
    },
    { currentTurnMediaEvidence: currentImageProvenance() },
  );
  assert.match(definition.description, /current user turn/u);
  const prompt = `\u5e6b\u6211\u67e5 [media attached: ${IMAGE_PATH} (image/png)]`;
  await visionPromptHook({ runId: "v3-vision", prompt }, { runId: "v3-vision" });
  assert.equal(
    await visionCallHook(
      {
        toolName: VISION,
        runId: "v3-vision",
        toolCallId: "v3-call",
        params: { image_path: IMAGE_PATH },
      },
      { runId: "v3-vision" },
    ),
    undefined,
  );
  const mismatch = await visionCallHook(
    {
      toolName: VISION,
      runId: "v3-vision-2",
      toolCallId: "v3-call-2",
      params: { image_path: "C:\\wrong.png" },
    },
    { runId: "v3-vision-2" },
  );
  assert.equal(mismatch?.block, true);
});

test("gated schema descriptions state only the current-turn whitelist", () => {
  let music;
  let stockFactory;
  let vision;
  registerMusicTools({
    registerTool(tool) {
      if (tool.name === MUSIC) music = tool;
    },
    on() {},
  });
  registerStockTool({
    registerTool(tool) {
      stockFactory = tool;
    },
    on() {},
  });
  registerVisionTool({
    registerTool(tool) {
      vision = tool;
    },
    on() {},
  });
  stockFactory = stockFactory({
    agentId: "main",
    sessionKey: "v3-description",
    requesterSenderId: OWNER_ID,
  });
  assert.match(music.description, /current user turn/u);
  assert.match(music.description, /play <keyword-or-URL>/u);
  assert.match(stockFactory.description, /\u6211\u60f3\u770b\u7f8e\u80a1 <stock ID>/u);
  assert.match(vision.description, /usable current image\/media/u);
  assert.doesNotMatch(music.description, /MUST call|persona|Discord voice pipeline/u);
  assert.doesNotMatch(stockFactory.description, /Leprechaun|decision_contract|numbers_hash/u);
  assert.doesNotMatch(vision.description, /ToriiGate|OCR|reverse-image|persona evidence/u);
});

test("contract parser exposes explicit negative decisions without using model params", () => {
  assert.deepEqual(contractTest.parseMusicCommand("<@123> \u64ad\u653e \u6625\u65e5\u5f71"), {
    target: "\u6625\u65e5\u5f71",
  });
  assert.deepEqual(contractTest.parseMusicCommand("<@!123> play spring shadow"), {
    target: "spring shadow",
  });
  for (const handle of ["Rana", "\u6a02\u5948", "Tomori", "Soyo", "Taki"]) {
    assert.deepEqual(
      contractTest.parseMusicCommand(`@${handle} \u64ad\u653e \u6625\u65e5\u5f71`),
      { target: "\u6625\u65e5\u5f71" },
      handle,
    );
  }
  assert.equal(contractTest.parseMusicCommand("Rana \u64ad\u653e \u6625\u65e5\u5f71"), null);
  assert.equal(contractTest.parseMusicCommand("\u6a02\u5948 play spring shadow"), null);
  assert.equal(contractTest.parseMusicCommand("\u64f2\u97f3"), null);
  assert.equal(contractTest.parseMusicCommand("\u64ad\u653e"), null);
  assert.equal(contractTest.parseStockCommand("NVDA"), null);
  assert.deepEqual(contractTest.parseStockCommand("\u6211\u60f3\u770b\u7f8e\u80a1 NVDA"), {
    ticker: "NVDA",
  });
  assert.equal(contractTest.parseStockCommand("\u6211\u60f3\u770b\u7f8e\u80a1 nvda"), null);
  assert.equal(contractTest.parseStockCommand("\u6211\u60f3\u770b\u7f8e\u80a1 NVDA!"), null);
  assert.equal(contractTest.parseStockCommand("\u6211\u60f3\u770b\u7f8e\u80a1 Intel"), null);
  assert.equal(contractTest.hasExplicitVisionIntent("\u7d66\u4f60\u62b9\u8336\u82ad\u83f2"), true);
});

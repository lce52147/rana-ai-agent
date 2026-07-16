import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { __test as clientTest } from "./client.js";
import { buildVisionEvidence, __test as evidenceTest } from "./evidence.js";
import { __test as guidanceTest } from "./guidance.js";
import { reverseImageSearch } from "./reverse_search.js";
import { lookupCharacterImpression, resolveCanonicalIdentities, resolveImageCharacters } from "./character_catalog.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const noTrace = async () => {};

test("Vision plugin source does not load Music", async () => {
  const files = ["index.js", "client.js", "evidence.js", "guidance.js", "reverse_search.js", "tool.js"];
  for (const file of files) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /rana-music-tools|tools\/music|sidecars\/music/, file);
  }
});

test("ToriiGate prompt sends exactly one image and requests raw observation", () => {
  const content = clientTest.visionUserContent(Buffer.from("image"), "image/png");
  assert.equal(content.filter((item) => item.type === "image_url").length, 1);
  assert.match(content[0].text, /without guessing a character name/i);
});

test("ToriiGate parser preserves a string feature as evidence", () => {
  const result = clientTest.parseObservation('{"medium":"anime","subject_type":"character","distinctive_features":"heterochromia and short hair"}');
  assert.deepEqual(result.distinctive_features, ["heterochromia and short hair"]);
  assert.equal(result.summary, "heterochromia and short hair");
});

test("ToriiGate schema echo is invalid evidence rather than a successful observation", () => {
  const raw = '{"medium":"photo|anime|illustration|game_ui|manga|poster|other","subject_type":"food|object|person|character|scene|unknown","people_count":1,"visible_text":null,"distinctive_features":null,"scene":"visible scene","summary":"factual visual summary"}';
  const observation = clientTest.parseObservation(raw);
  assert.equal(clientTest.observationLooksTemplate(raw, observation), true);
});

test("ToriiGate response format constrains runtime observations without identity fixtures", () => {
  const format = clientTest.visionResponseFormat();
  const content = clientTest.visionUserContent(Buffer.from("image"), "image/png");
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.properties.medium.enum, ["photo", "anime", "illustration", "game_ui", "manga", "poster", "other"]);
  assert.deepEqual(format.json_schema.schema.properties.subject_type.enum, ["food", "object", "person", "character", "scene", "unknown"]);
  assert.equal(JSON.stringify(format).includes("戸山香澄"), false);
  assert.equal(JSON.stringify(format).includes("東雲芽吹"), false);
  assert.equal(JSON.stringify(content).includes("factual visual summary"), false);
  assert.equal(JSON.stringify(content).includes("photo|anime|illustration"), false);
});

test("official-reference parser maps only neutral reference cells", () => {
  const matches = clientTest.parseAtlasMatches(JSON.stringify({ cell: "R1C1", confidence: 0.98 }), [
    { id: "rana", cell: "R1C1" }, { id: "tomori", cell: "R1C2" }, { id: "soyo", cell: "R1C3" },
  ]);
  assert.deepEqual(matches.map((item) => item.id), ["rana"]);
  assert.equal(matches[0].target_position, "center");
  assert.deepEqual(clientTest.parseAtlasMatches('{"cell":"R1C2","confidence":0.4}', [{ id: "tomori", cell: "R1C2" }]), []);
  assert.deepEqual(clientTest.parseAtlasMatches('{"cell":"R9C9","confidence":1}', [{ id: "tomori", cell: "R1C2" }]), []);
});

test("official-reference prompt contains images but no text identity catalog", () => {
  const content = clientTest.atlasUserContent(Buffer.from("target"), "image/png", Buffer.from("atlas"));
  assert.equal(content.filter((item) => item.type === "image_url").length, 2);
  const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.doesNotMatch(text, /aliases=|traits=|要樂奈|高松燈|Rana|Tomori/);
  assert.match(text, /neutral visual reference cells/i);
  assert.doesNotMatch(text, /same character design.*Rana|same character design.*Tomori/i);
});

test("reply image placeholder resolves the referenced Discord attachment once", async () => {
  const prompt = [
    '"chat_id": "channel:1494206026390700092"',
    '"reply_to_id": "1526495598151467108"',
    'Replied message (untrusted, for context):',
    '"body": "<media:image> (1 image)"',
    '@Rana 這是什麼',
  ].join("\n");
  let replyLoads = 0;
  let evidenceBuilds = 0;
  const built = await guidanceTest.buildImageEvidenceContext(prompt, {
    loadRepliedDiscordImage: async (channelId, messageId, signal, requestId) => {
      replyLoads += 1;
      assert.equal(channelId, "1494206026390700092");
      assert.equal(messageId, "1526495598151467108");
      assert.equal(requestId, "reply-test");
      return { image: Buffer.from("reply-image"), mimeType: "image/png", source: "mock" };
    },
    buildEvidence: async (load) => {
      evidenceBuilds += 1;
      const loaded = await load(undefined, "reply-test");
      assert.equal(loaded.image.toString(), "reply-image");
      return { vision: { raw: "reply image" }, reverse_image: { status: "empty", results: [] } };
    },
    trace: noTrace,
    requestId: "reply-test",
  });
  assert.ok(built);
  assert.equal(replyLoads, 1);
  assert.equal(evidenceBuilds, 1);
});

test("media placeholder alone is not treated as resolved image data", async () => {
  const request = guidanceTest.imageRequest([
    'Replied message (untrusted, for context):',
    '"body": "<media:image> (1 image)"',
    '@Rana 這是誰',
  ].join("\n"));
  assert.ok(request);
  await assert.rejects(request.load(), /no resolved attachment or reply reference/);
});

test("production Discord image reply resolves by reply_to_id even when OpenClaw omits the attachment placeholder", () => {
  const prompt = [
    '"chat_id": "channel:1495319712370917396"',
    '"reply_to_id": "1526807589537579039"',
    '"has_reply_context": true',
    'Replied message (untrusted, for context):',
    '"body": "@Rana 給你抹茶芭菲 說說這是誰?"',
    '@Rana 這張圖是誰？',
  ].join("\n");
  assert.deepEqual(guidanceTest.repliedImageReference(prompt), {
    channel: "1495319712370917396",
    message: "1526807589537579039",
  });
});

test("ordinary text reply returns to normal chat when the referenced message has no image", async () => {
  const prompt = [
    '"chat_id": "channel:1494206026390700092"',
    '"reply_to_id": "1526587981283201064"',
    '"has_reply_context": true',
    'Replied message (untrusted, for context):',
    '"body": "嗯。可以啊。"',
    '@Rana 不可以',
  ].join("\n");
  let builds = 0;
  const built = await guidanceTest.buildImageEvidenceContext(prompt, {
    loadRepliedDiscordImage: async () => { throw new Error("referenced message has no image attachment"); },
    buildEvidence: async (load) => {
      builds += 1;
      return load();
    },
    trace: noTrace,
    requestId: "ordinary-text-reply",
  });
  assert.equal(builds, 1);
  assert.equal(built, null);
});

test("session-title prompts cannot replay an earlier Discord image request", async () => {
  const prompt = [
    "Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).",
    "Conversation summary:",
    "user: [media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\old.png (image/png)]",
    "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"old\">>>",
    "Source: External",
    "UNTRUSTED Discord message body",
    "@Rana 這是誰？",
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"old\">>>",
  ].join("\n");
  let loads = 0;
  const built = await guidanceTest.buildImageEvidenceContext(prompt, {
    loadInboundImage: async () => { loads += 1; return { image: Buffer.from("old"), mimeType: "image/png" }; },
  });
  assert.equal(built, null);
  assert.equal(loads, 0);
  assert.equal(guidanceTest.isInternalTitleRequest(prompt), true);
});

test("Vision endpoint discovery prefers LAN and retains Tailscale fallback", () => {
  assert.deepEqual(clientTest.visionBaseUrls("http://192.168.50.3:6970", "http://100.99.83.84:6970/v1"), [
    "http://192.168.50.3:6970",
    "http://100.99.83.84:6970",
  ]);
});

test("Vision keeps the direct LAN endpoint ahead of inherited environment routes", () => {
  assert.deepEqual(clientTest.visionBaseUrls("http://192.168.50.79:6970", "http://100.99.83.84:6970"), [
    "http://192.168.50.3:6970",
    "http://192.168.50.79:6970",
    "http://100.99.83.84:6970",
  ]);
});

test("atlas timeout is terminal for the current comparison budget", () => {
  assert.equal(clientTest.isComparisonTimeout({ name: "AbortError", message: "This operation was aborted" }), true);
  assert.equal(clientTest.isComparisonTimeout(new Error("remote vision request timed out")), true);
  assert.equal(clientTest.isComparisonTimeout(new Error("HTTP 500")), false);
});

test("trace, SauceNAO, and IQDB runners start in parallel", async () => {
  const gate = deferred();
  const started = [];
  const runner = (service, similarity) => async () => {
    started.push(service);
    await gate.promise;
    return { service, status: "ok", results: [{ service, title: service, similarity }] };
  };
  const pending = reverseImageSearch(Buffer.from("image"), "image/png", undefined, "test-request", {
    traceMoe: runner("trace.moe", 0.8),
    sauceNao: runner("SauceNAO", 0.9),
    iqdb: runner("IQDB", 0.7),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["IQDB", "SauceNAO", "trace.moe"]);
  gate.resolve();
  const result = await pending;
  assert.equal(result.results[0].service, "SauceNAO");
  assert.equal(result.attempts.length, 3);
});

test("ToriiGate, local OCR, and reverse search start from the same image in parallel", async () => {
  const gate = deferred();
  const started = [];
  const pending = buildVisionEvidence(
    async () => ({ image: Buffer.from("same-image"), mimeType: "image/png" }),
    "who",
    undefined,
    "test-request",
    {
      analyze: async (image) => {
        started.push(`vision:${image.toString()}`);
        await gate.promise;
        return { status: "ok", source: "ToriiGate", raw: "raw", observation: { summary: "raw" } };
      },
      reverse: async (image) => {
        started.push(`reverse:${image.toString()}`);
        await gate.promise;
        return { status: "empty", attempts: [], results: [] };
      },
      ocr: async (image) => {
        started.push(`ocr:${image.toString()}`);
        await gate.promise;
        return { status: "ok", source: "test-ocr", lines: [], text: "", raw: "" };
      },
      verify: async () => ({ status: "skipped", results: [] }),
      trace: noTrace,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["ocr:same-image", "reverse:same-image", "vision:same-image"]);
  gate.resolve();
  const evidence = await pending;
  assert.equal(evidence.vision.raw, "raw");
  assert.equal(evidence.reverse_image.status, "empty");
});

test("low-confidence reverse candidates cannot trigger text verification or replace OCR", async () => {
  let verifyCalls = 0;
  const evidence = await buildVisionEvidence(
    async () => ({ image: Buffer.from("kasumi"), mimeType: "image/png" }),
    "who",
    undefined,
    "evidence-gate-test",
    {
      analyze: async () => ({
        status: "ok",
        source: "ToriiGate",
        raw: '{"subject_type":"unknown","visible_text":["HAPPY BIRTHDAY! 香澄"]}',
        observation: { subject_type: "unknown", visible_text: ["HAPPY BIRTHDAY! 香澄"], summary: "birthday banner" },
      }),
      reverse: async () => ({
        status: "ok",
        attempts: [
          { service: "trace.moe", status: "ok", http_status: 200 },
          { service: "IQDB", status: "ok", http_status: 200 },
        ],
        results: [
          { service: "trace.moe", title: "なむあみだ仏っ！-蓮台 UTENA-", similarity: 0.742 },
          { service: "IQDB", title: "42% similarity", similarity: 0.42 },
        ],
      }),
      ocr: async () => ({ status: "ok", source: "test-ocr", lines: ["HAPPY BIRTHDAY! 香澄"], text: "HAPPY BIRTHDAY! 香澄", raw: "raw ocr" }),
      verify: async () => {
        verifyCalls += 1;
        return { status: "ok", results: [{ title: "wrong" }] };
      },
      trace: noTrace,
    },
  );
  assert.equal(verifyCalls, 0);
  assert.deepEqual(evidence.standardized.ocr.lines, ["HAPPY BIRTHDAY! 香澄"]);
  assert.deepEqual(evidence.vision.reported_text, ["HAPPY BIRTHDAY! 香澄"]);
  assert.equal(evidence.reverse_image.accepted.length, 0);
  assert.equal(evidence.reverse_image.rejected.length, 2);
  assert.equal(evidence.reverse_image.raw_candidates.length, 2);
  assert.equal(evidence.final_candidate, null);
  assert.match(JSON.stringify(evidence.conflicts), /香澄/);
  assert.match(JSON.stringify(evidence.conflicts), /ocr_candidate_mismatch/);
  assert.equal(evidence.text_verification.status, "skipped");
});

test("reverse evidence applies service-specific acceptance thresholds", () => {
  const gate = evidenceTest.evaluateReverseEvidence({
    results: [
      { service: "trace.moe", title: "Trace candidate", similarity: 0.869 },
      { service: "SauceNAO", title: "Sauce candidate", similarity: 0.8 },
      { service: "IQDB", title: "IQDB candidate", similarity: 0.799 },
    ],
  }, { observation: { visible_text: [] } });
  assert.equal(gate.results.find((item) => item.service === "trace.moe").accepted, false);
  assert.equal(gate.results.find((item) => item.service === "SauceNAO").accepted, true);
  assert.equal(gate.results.find((item) => item.service === "IQDB").accepted, false);
});

test("ordinary subtitle OCR does not reject an otherwise accepted reverse-search result", () => {
  const gate = evidenceTest.evaluateReverseEvidence({
    results: [
      { service: "trace.moe", title: "バンドリ！ ゆめ∞みた", similarity: 0.9683 },
      { service: "IQDB", title: "unrelated low result", similarity: 0.4 },
    ],
  }, { observation: { visible_text: ["我全都討厭"] } }, {
    normalized_lines: ["我全都討厭"],
  });
  assert.deepEqual(gate.ocr, ["我全都討厭"]);
  assert.deepEqual(gate.results[0].accepted, true);
  assert.deepEqual(gate.results[0].reason, "meets_service_threshold");
  assert.deepEqual(gate.results[1].accepted, false);
  assert.deepEqual(gate.conflicts, []);
});

test("corroborated trace.moe work evidence stays outside the character resolver", () => {
  const gate = evidenceTest.evaluateReverseEvidence({
    results: [
      { service: "trace.moe", title: "Chiikawa", similarity: 0.844 },
      { service: "trace.moe", title: "Chiikawa", similarity: 0.838 },
      { service: "trace.moe", title: "Chiikawa", similarity: 0.824 },
    ],
  }, {}, { normalized_lines: [] });
  assert.equal(gate.candidate, null);
  assert.deepEqual(gate.external_work_reference, {
    title: "Chiikawa", confidence: "medium", similarity: 0.844, service: "trace.moe", corroboratingResults: 3, scope: "work_only",
  });
});

test("OCR identity terms contain only catalog-backed character names", () => {
  assert.deepEqual(evidenceTest.ocrIdentityTerms(["我全都討厭"]), []);
  assert.ok(evidenceTest.ocrIdentityTerms(["戸 山 香 澄", "TOYAMA KASUMI"]).length > 0);
});

test("Vision raw evidence survives when reverse image search has no result", async () => {
  const evidence = await buildVisionEvidence(
    async () => ({ image: Buffer.from("unknown"), mimeType: "image/png" }),
    "who",
    undefined,
    "vision-only-test",
    {
      analyze: async () => ({
        status: "ok",
        source: "ToriiGate",
        raw: "raw visible evidence",
        observation: { subject_type: "character", visible_text: [], summary: "pink-haired character" },
      }),
      reverse: async () => ({ status: "empty", attempts: [], results: [] }),
      ocr: async () => ({ status: "ok", source: "test-ocr", lines: [], text: "", raw: "" }),
      verify: async () => assert.fail("text verification must be skipped without an accepted candidate"),
      trace: noTrace,
    },
  );
  assert.equal(evidence.vision.raw, "raw visible evidence");
  assert.equal(evidence.vision.observation.summary, "pink-haired character");
  assert.equal(evidence.text_verification.status, "skipped");
});

test("clear OCR identity rejects a high-confidence conflicting reverse candidate and blocks verification", async () => {
  let verifyCalls = 0;
  const evidence = await buildVisionEvidence(
    async () => ({ image: Buffer.from("kasumi"), mimeType: "image/png" }),
    "who",
    undefined,
    "ocr-identity-conflict",
    {
      analyze: async () => ({
        status: "ok",
        source: "ToriiGate",
        raw: "raw vision",
        observation: { subject_type: "character", visible_text: ["HAPPY BIRTHDAY"], summary: "birthday character" },
      }),
      ocr: async () => ({
        status: "ok",
        source: "Windows.Media.Ocr",
        lines: ["戸 山 香 澄", "TOYAMA KASUMI", "HAPPY BIRTHDAY"],
        text: "戸 山 香 澄\nTOYAMA KASUMI\nHAPPY BIRTHDAY",
        raw: "raw local OCR",
      }),
      reverse: async () => ({
        status: "ok",
        attempts: [{ service: "SauceNAO", status: "ok", http_status: 200 }],
        results: [{ service: "SauceNAO", title: "東雲芽吹", similarity: 0.96, source: "https://example.invalid/wrong" }],
      }),
      verify: async () => {
        verifyCalls += 1;
        return { status: "ok", results: [{ title: "wrong official result" }] };
      },
      trace: noTrace,
    },
  );
  const rejected = evidence.reverse_image.rejected[0];
  assert.equal(verifyCalls, 0);
  assert.equal(rejected.threshold_passed, true);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "ocr_identity_conflict");
  assert.equal(evidence.reverse_image.accepted.length, 0);
  assert.equal(evidence.final_candidate, null);
  assert.equal(evidence.text_verification.status, "skipped");
  assert.match(JSON.stringify(evidence.local_ocr), /TOYAMA KASUMI/);
  assert.match(JSON.stringify(evidence.conflicts), /block_text_verification/);
  assert.match(JSON.stringify(evidence.vision), /raw vision/);
  assert.equal(evidence.final_identity.canonicalId, "kasumi");
  assert.equal(evidence.final_identity.confidence, "high");
  assert.equal(evidence.impression_lookup.recognitionLevel, "unknown");
});

test("resolved Vision identity remains in the final OOGG input", async () => {
  const built = await guidanceTest.buildImageEvidenceContext(
    '[media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\identity.png (image/png)]\n@Rana 這是誰',
    {
      requestId: "identity-injection",
      loadInboundImage: async () => ({ image: Buffer.from("image"), mimeType: "image/png", source: "identity.png" }),
      buildEvidence: async () => ({
        image_source: { source: "identity.png" },
        vision: { raw: "character portrait", observation: { summary: "character portrait" }, reported_text: [] },
        local_ocr: { raw: "戸山香澄", normalized_text: "戸山香澄", normalized_lines: ["戸山香澄"] },
        conflicts: [{ type: "ocr_candidate_mismatch", resolution: "reject_candidate_and_block_text_verification" }],
        identity_resolution: {
          primaryCharacter: { canonicalId: "kasumi", canonicalName: "戶山香澄", confidence: "high", confidenceScore: 0.99, evidence: [{ reason: "ocr_alias_match", observedText: "戸山香澄" }] },
          detectedCharacters: [{ canonicalId: "kasumi", canonicalName: "戶山香澄", confidence: "high", confidenceScore: 0.99, evidence: [{ reason: "ocr_alias_match", observedText: "戸山香澄" }], impression: { recognitionLevel: "unknown", tentative: false } }],
          primaryImpression: { recognitionLevel: "unknown", howRanaKnowsThem: [], memoryAnchors: [], ranaCallsThem: [], allowedKnowledge: ["圖片中直接可見的資訊"], allowedReactionStyle: ["不熟"], forbiddenExpansion: ["不能裝熟"], tentative: false },
        },
      }),
      trace: noTrace,
    },
  );
  assert.match(built.context, /戶山香澄/);
  assert.match(built.context, /recognitionLevel":"unknown/);
  assert.doesNotMatch(built.context, /東雲芽吹/);
});

test("Vision pipeline errors emit a structured trace instead of failing silently", async () => {
  const traces = [];
  await assert.rejects(
    guidanceTest.buildImageEvidenceContext(
      '[media attached: C:\\Users\\Administrator\\.openclaw\\media\\inbound\\broken.png (image/png)]\n@Rana 這是誰',
      {
        requestId: "pipeline-error",
        buildEvidence: async () => { throw new Error("local OCR process error"); },
        trace: async (requestId, stage, data) => traces.push({ requestId, stage, data }),
      },
    ),
    /local OCR process error/,
  );
  assert.deepEqual(traces, [{
    requestId: "pipeline-error",
    stage: "vision_pipeline_error",
    data: { error: "local OCR process error" },
  }]);
});

test("OOGG receives visual observation without inventing an identity", () => {
  const context = guidanceTest.ooggContext({
    vision: { raw: "pink-haired anime character", observation: { summary: "pink-haired anime character", subject_type: "character", medium: "anime" } },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  });
  assert.match(context, /pink-haired anime character/);
  assert.match(context, /"primaryCharacter":null/);
  assert.match(context, /"ranaCharacterImpression":null/);
  assert.match(context, /不得從人物印象反推身分/);
});

test("unknown identity output guard removes unsupported character comparisons without claiming image failure", () => {
  const payload = guidanceTest.ooggPayload({
    vision: { observation: { summary: "short-haired character", subject_type: "character", people_count: 1 } },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  }, "這是誰？");
  assert.equal(
    guidanceTest.guardVisionIdentityOutput("不認識她。不過有點像燈。", payload),
    "不認得。",
  );
  assert.equal(
    guidanceTest.guardVisionIdentityOutput("短髮，異色瞳。我不確定。", payload),
    "不認得。",
  );
});

test("work-level external reference may answer without creating a character identity", () => {
  const payload = guidanceTest.ooggPayload({
    vision: { status: "ok", observation: { summary: "yellow rabbit-like character" } },
    external_work_reference: { title: "Chiikawa", confidence: "medium", similarity: 0.844, corroboratingResults: 3, scope: "work_only" },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  }, "這是誰？");
  assert.equal(payload.imageUnderstanding.analysisStatus, "unknown");
  assert.equal(payload.imageUnderstanding.primaryCharacter, null);
  assert.equal(payload.imageUnderstanding.externalReference.title, "Chiikawa");
  assert.equal(guidanceTest.guardVisionIdentityOutput("是《Chiikawa》裡的兔子。", payload), "是《Chiikawa》裡的兔子。");
});

test("analysis status separates known, unknown, and image-analysis errors", () => {
  const unknown = guidanceTest.ooggPayload({
    vision: { status: "ok", observation: { summary: "visible person" } },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  }, "這是誰？");
  const known = guidanceTest.ooggPayload({
    vision: { status: "ok", observation: { summary: "visible person" } },
    identity_resolution: {
      primaryCharacter: { canonicalId: "rana", canonicalName: "要樂奈", confidence: "high" },
      detectedCharacters: [], primaryImpression: null,
    },
  }, "這是誰？");
  const failed = guidanceTest.ooggPayload({
    vision: { status: "unavailable", observation: null },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  }, "這是誰？");

  assert.equal(unknown.imageUnderstanding.analysisStatus, "unknown");
  assert.equal(known.imageUnderstanding.analysisStatus, "known");
  assert.equal(failed.imageUnderstanding.analysisStatus, "error");
  assert.equal(guidanceTest.guardVisionIdentityOutput("像燈。", unknown), "不認得。");
  assert.equal(guidanceTest.guardVisionIdentityOutput("像燈。", failed), "圖片分析失敗。不能確定是誰。");
});

test("OOGG visibleText uses real OCR only, never ToriiGate-reported text", () => {
  const payload = guidanceTest.ooggPayload({
    vision: {
      reported_text: ["Torii guessed 春日影 and Suzuki Eri"],
      observation: { summary: "night scene", subject_type: "character", people_count: 1 },
    },
    local_ocr: { normalized_lines: ["我全都討厭"] },
    identity_resolution: { primaryCharacter: null, detectedCharacters: [], primaryImpression: null },
  }, "這是什麼？");
  assert.deepEqual(payload.imageUnderstanding.visibleText, ["我全都討厭"]);
});

test("accepted identity output guard allows only resolver-supported character names", () => {
  const payload = {
    imageUnderstanding: {
      primaryCharacter: { canonicalId: "rana", canonicalName: "要樂奈", confidence: "high" },
      detectedCharacters: [{ canonicalId: "rana", canonicalName: "要樂奈", confidence: "high" }],
    },
    userQuestion: "這是誰？",
  };
  assert.equal(guidanceTest.guardVisionIdentityOutput("這是我。", payload), "這是我。");
  assert.equal(guidanceTest.guardVisionIdentityOutput("是我，但有點像燈。", payload), "是我。");
  assert.equal(guidanceTest.guardVisionIdentityOutput("這是我。要樂奈。\n灰白短髮、異色瞳的我。", payload), "是我。");
  assert.equal(guidanceTest.guardVisionIdentityOutput("這是我。正在吃著抹茶芭菲。", payload), "是我。");
  assert.equal(guidanceTest.guardVisionIdentityOutput("我。拍太近了。", payload), "我。拍太近了。");
});

test("before-message guard rewrites the persisted self reply before Discord dispatch", () => {
  const payload = {
    imageUnderstanding: {
      primaryCharacter: { canonicalId: "rana", canonicalName: "要樂奈", confidence: "high" },
      detectedCharacters: [{ canonicalId: "rana", canonicalName: "要樂奈", confidence: "high" }],
    },
    userQuestion: "這是誰？",
  };
  const original = {
    role: "assistant",
    content: [{ type: "text", text: "這是我。要樂奈。正吃著抹茶芭菲。", textSignature: "stale" }],
    stopReason: "stop",
  };
  const guarded = guidanceTest.guardAssistantMessageInPlace(original, payload);
  assert.equal(guarded.changed, true);
  assert.equal(guarded.message, original);
  assert.deepEqual(guarded.message.content, [{ type: "text", text: "是我。" }]);
});

test("llm-output guard rewrites the dispatcher assistantTexts in place", () => {
  const payload = {
    imageUnderstanding: {
      primaryCharacter: null,
      detectedCharacters: [],
    },
    userQuestion: "這張圖裡的人是誰？",
  };
  const assistantTexts = ["畫面有三個女孩。我不熟這些人，也沒辦法確認她們是誰。"];
  const lastAssistant = {
    role: "assistant",
    content: [{ type: "text", text: assistantTexts[0], textSignature: "stale" }],
  };
  const event = { assistantTexts, lastAssistant };

  const guarded = guidanceTest.guardLlmOutputInPlace(event, payload);

  assert.equal(guarded.changed, true);
  assert.equal(event.assistantTexts, assistantTexts);
  assert.deepEqual(event.assistantTexts, ["不認得。"]);
  assert.equal(event.lastAssistant, lastAssistant);
  assert.deepEqual(event.lastAssistant.content, [{ type: "text", text: "不認得。" }]);
});

test("Vision-reported names and visual traits cannot create canonical identity", async () => {
  const resolved = resolveImageCharacters({
    vision: {
      reported_text: ["Rna"],
      observation: {
        summary: "A girl with short white hair and heterochromia.",
        distinctive_features: ["short white hair", "heterochromia"],
      },
    },
    local_ocr: { normalized_lines: [] },
    reverse_image: { accepted: [] },
  });
  assert.equal(resolved.primaryCharacter, null);
  assert.equal(resolved.primaryImpression, null);
});

test("verified official visual comparison resolves Rana without using observation guesses", () => {
  const resolved = resolveImageCharacters({
    vision: {
      reported_text: [],
      observation: {
        subject_type: "character",
        people_count: 1,
        summary: "A close-up portrait of a girl with heterochromia, featuring one blue eye and one yellow eye. She has short brown hair.",
        distinctive_features: ["Extreme close-up, short hair, heterochromia, one blue eye and one yellow eye."],
      },
    },
    official_reference_match: {
      matches: [{ id: "chu2", similarity: 0.606787, exact_sha256: false }],
    },
    local_ocr: { normalized_lines: [], normalized_text: "" },
    reverse_image: { accepted: [] },
    visual_reference_comparison: {
      matches: [{ id: "rana", confidence_score: 0.92, evidence: "atlas_and_single_reference_agree", position: "center", atlas_id: "core", atlas_confidence: 0.99, confirmation_confidence: 0.98 }],
    },
  });
  assert.equal(resolved.primaryCharacter.canonicalId, "rana");
  assert.equal(resolved.primaryCharacter.confidence, "high");
  assert.equal(resolved.primaryCharacter.evidence[0].reason, "verified_official_visual_reference_match");
  assert.equal(resolved.primaryImpression.canonicalId, "rana");
});

test("Mutsumi and Mortis are separate canonical identities", () => {
  const mutsumi = resolveCanonicalIdentities({ local_ocr: { normalized_lines: ["若葉睦"] } });
  const mortis = resolveCanonicalIdentities({ local_ocr: { normalized_lines: ["Mortis"] } });
  assert.equal(mutsumi.primaryCharacter.canonicalId, "mutsumi");
  assert.equal(mortis.primaryCharacter.canonicalId, "mortis");
  assert.notEqual(mutsumi.primaryCharacter.canonicalId, mortis.primaryCharacter.canonicalId);
});

test("impression lookup respects remembered and conservative boundaries", () => {
  const nyamu = resolveCanonicalIdentities({ local_ocr: { normalized_lines: ["祐天寺にゃむ"] } }).primaryCharacter;
  const uika = resolveCanonicalIdentities({ local_ocr: { normalized_lines: ["三角初華"] } }).primaryCharacter;
  const umiri = resolveCanonicalIdentities({ local_ocr: { normalized_lines: ["八幡海鈴"] } }).primaryCharacter;
  assert.equal(lookupCharacterImpression(nyamu).recognitionLevel, "remembered_once");
  assert.equal(lookupCharacterImpression(uika).recognitionLevel, "unknown");
  assert.equal(lookupCharacterImpression(umiri).recognitionLevel, "unknown");
});

test("low identity confidence cannot inject a character impression", () => {
  assert.equal(lookupCharacterImpression({ canonicalId: "tomori", confidence: "low" }), null);
  assert.equal(lookupCharacterImpression({ canonicalId: "tomori", confidence: "unknown" }), null);
  assert.equal(lookupCharacterImpression({ canonicalId: "tomori", confidence: "medium" }).tentative, true);
});

test("identity selection is independent from impression content", () => {
  const evidence = { local_ocr: { normalized_lines: ["TOYAMA KASUMI"] }, reverse_image: { accepted: [] } };
  const first = resolveCanonicalIdentities(evidence);
  const impression = lookupCharacterImpression(first.primaryCharacter);
  const second = resolveCanonicalIdentities(evidence);
  assert.equal(first.primaryCharacter.canonicalId, "kasumi");
  assert.equal(impression.recognitionLevel, "unknown");
  assert.deepEqual(second, first);
});

test("exact official reference match ignores an uncorroborated model identity guess", () => {
  const resolved = resolveCanonicalIdentities({
    vision: { observation: { known_people_matches: [{ id: "anon", confidence: 1 }] } },
    official_reference_match: { matches: [{ id: "tomori", similarity: 1, exact_sha256: true }] },
    reverse_image: { accepted: [] },
  });
  assert.equal(resolved.primaryCharacter.canonicalId, "tomori");
  assert.equal(resolved.primaryCharacter.evidence[0].reason, "exact_sha256_official_reference");
  assert.equal(resolved.detectedCharacters.some((item) => item.canonicalId === "anon"), false);
});

test("unverified model identity output is ignored", () => {
  const resolved = resolveCanonicalIdentities({
    vision: { observation: { known_people_matches: [{ id: "tomori", confidence: 0.92, evidence: "atlas face match", position: "center" }] } },
    official_reference_match: { matches: [] },
    reverse_image: { accepted: [] },
  });
  assert.equal(resolved.primaryCharacter, null);
});

test("two-stage official visual comparison is usable when no stronger evidence conflicts", () => {
  const resolved = resolveCanonicalIdentities({
    visual_reference_comparison: {
      matches: [{ id: "tomori", confidence_score: 0.92, evidence: "atlas_and_single_reference_agree", position: "center", atlas_id: "core", atlas_confidence: 1, confirmation_confidence: 0.98 }],
    },
    official_reference_match: { matches: [] },
    reverse_image: { accepted: [] },
  });
  assert.equal(resolved.primaryCharacter.canonicalId, "tomori");
  assert.equal(resolved.primaryCharacter.confidence, "high");
  assert.equal(resolved.primaryCharacter.evidence[0].reason, "verified_official_visual_reference_match");
});

test("multi-character identity chooses the user-named person as primary", () => {
  const resolved = resolveImageCharacters({
    local_ocr: { normalized_lines: ["高松燈 千早愛音"] },
    reverse_image: { accepted: [] },
  }, "右邊的愛音是誰？");
  assert.deepEqual(resolved.detectedCharacters.map((item) => item.canonicalId).sort(), ["anon", "tomori"]);
  assert.equal(resolved.primaryCharacter.canonicalId, "anon");
});

test("Vision delivery tracing keeps the sending entry until message_sent", () => {
  const tracker = guidanceTest.createDeliveryTracker(1000);
  tracker.enqueue({ requestId: "trace-1", runId: "run-1", channelId: "channel-1" }, 100);
  assert.equal(tracker.findByRunId("run-1", 150).requestId, "trace-1");
  assert.equal(tracker.findBySessionKey(undefined, 175).requestId, "trace-1");
  assert.equal(tracker.peek({ channelId: "channel-1" }, 200).requestId, "trace-1");
  assert.equal(tracker.size(200), 1);
  assert.equal(tracker.take({ channelId: "channel-1" }, 300).requestId, "trace-1");
  assert.equal(tracker.size(300), 0);
});

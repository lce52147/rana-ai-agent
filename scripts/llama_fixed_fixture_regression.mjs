import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const valueOf = (name, fallback = undefined) => {
  const prefix = `--${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
};
const endpoint = valueOf("endpoint", "http://127.0.0.1:6969/v1/responses");
const outputDir = path.resolve(valueOf("output"));
const maxRequests = Number(valueOf("max", "300"));
const label = valueOf("label", "unnamed");
const fixturePaths = args.filter((arg) => !arg.startsWith("--")).map((item) => path.resolve(item));
if (!outputDir || fixturePaths.length !== 3 || !Number.isInteger(maxRequests) || maxRequests < 1) {
  throw new Error("usage: node llama_fixed_fixture_regression.mjs --output=<dir> [--label=x] [--max=300] <fixture1> <fixture2> <fixture3>");
}

fs.mkdirSync(outputDir, { recursive: true });
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const fixtures = fixturePaths.map((fixturePath, index) => {
  const bytes = fs.readFileSync(fixturePath);
  const parsed = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  if (parsed.stream !== true) throw new Error(`fixture ${fixturePath} does not have stream=true`);
  return {
    index: index + 1,
    path: fixturePath,
    name: path.basename(fixturePath, ".request.json"),
    bytes,
    sha256: sha256(bytes),
    maxOutputTokens: parsed.max_output_tokens,
  };
});

function parseSse(rawText) {
  const events = [];
  const invalidDataLines = [];
  let doneCount = 0;
  for (const line of rawText.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") {
      doneCount += 1;
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch (error) {
      invalidDataLines.push({ line, error: String(error) });
    }
  }
  const completedEvent = [...events].reverse().find((event) => event?.type === "response.completed");
  const failedEvent = [...events].reverse().find((event) => event?.type === "response.failed");
  return { events, invalidDataLines, doneCount, response: completedEvent?.response ?? failedEvent?.response ?? null };
}

function responseText(response) {
  return (response?.output ?? [])
    .flatMap((item) => item?.content ?? [])
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("");
}

function longestIdenticalCharacterRun(text) {
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const character of [...text]) {
    if (character === previous) current += 1;
    else {
      previous = character;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return longest;
}

function longestIdenticalDeltaRun(events) {
  const deltas = events
    .filter((event) => event?.type === "response.output_text.delta" && typeof event.delta === "string")
    .map((event) => event.delta);
  let longest = 0;
  let current = 0;
  let previous;
  for (const delta of deltas) {
    if (delta === previous) current += 1;
    else {
      previous = delta;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return { longest, deltaCount: deltas.length };
}

const manifest = {
  started_utc: new Date().toISOString(),
  label,
  endpoint,
  max_requests: maxRequests,
  fixtures: fixtures.map(({ bytes, maxOutputTokens, ...item }) => ({ ...item, bytes: bytes.length, max_output_tokens: maxOutputTokens })),
};
fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const results = [];
let stopReason = "max_requests_completed";
for (let sequence = 1; sequence <= maxRequests; sequence += 1) {
  const fixture = fixtures[(sequence - 1) % fixtures.length];
  const stem = `${String(sequence).padStart(3, "0")}_fixture-${fixture.index}`;
  fs.writeFileSync(path.join(outputDir, `${stem}.request.json`), fixture.bytes);
  fs.writeFileSync(path.join(outputDir, `${stem}.request.sha256.txt`), `${fixture.sha256}\n`);
  const startedAt = Date.now();
  let httpStatus = 0;
  let headers = {};
  let responseBytes = Buffer.alloc(0);
  let requestError = null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: fixture.bytes,
    });
    httpStatus = response.status;
    headers = Object.fromEntries(response.headers.entries());
    responseBytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    requestError = String(error?.stack ?? error);
  }
  const elapsedMs = Date.now() - startedAt;
  const rawText = responseBytes.toString("utf8");
  const parsedSse = parseSse(rawText);
  const parsedResponse = parsedSse.response;
  const outputText = responseText(parsedResponse);
  const compactOutput = outputText.replace(/\s/gu, "");
  const questionMarkCount = [...outputText].filter((char) => char === "?").length;
  const longestCharacterRun = longestIdenticalCharacterRun(outputText);
  const identicalDelta = longestIdenticalDeltaRun(parsedSse.events);
  const outputTokens = parsedResponse?.usage?.output_tokens ?? null;
  const atLimit = Number.isFinite(outputTokens) && Number.isFinite(fixture.maxOutputTokens) && outputTokens >= fixture.maxOutputTokens;
  const pureQuestionMarks = compactOutput.length > 0 && /^\?+$/u.test(compactOutput);
  const oneCharacterOnly = compactOutput.length > 0 && new Set([...compactOutput]).size === 1;
  const repeatedSingleTokenAtLimit = Boolean(atLimit && (oneCharacterOnly || identicalDelta.longest >= 64));
  const rawSseDamaged = Boolean(
    requestError ||
    httpStatus !== 200 ||
    parsedSse.invalidDataLines.length > 0 ||
    !parsedResponse ||
    parsedResponse.status !== "completed"
  );
  const corruption = Boolean(
    pureQuestionMarks ||
    longestCharacterRun >= 64 ||
    identicalDelta.longest >= 64 ||
    repeatedSingleTokenAtLimit ||
    rawSseDamaged
  );
  const result = {
    sequence,
    fixture_index: fixture.index,
    fixture_path: fixture.path,
    request_sha256: fixture.sha256,
    request_bytes: fixture.bytes.length,
    response_sha256: sha256(responseBytes),
    response_bytes: responseBytes.length,
    http_status: httpStatus,
    response_status: parsedResponse?.status ?? null,
    response_id: parsedResponse?.id ?? null,
    input_tokens: parsedResponse?.usage?.input_tokens ?? null,
    output_tokens: outputTokens,
    latency_ms: elapsedMs,
    question_mark_count: questionMarkCount,
    pure_question_marks: pureQuestionMarks,
    longest_consecutive_single_character: longestCharacterRun,
    longest_identical_sse_delta: identicalDelta.longest,
    sse_delta_count: identicalDelta.deltaCount,
    repeated_single_token_at_limit: repeatedSingleTokenAtLimit,
    raw_sse_damaged: rawSseDamaged,
    invalid_sse_data_lines: parsedSse.invalidDataLines.length,
    done_marker_count: parsedSse.doneCount,
    corruption,
    request_error: requestError,
    response_headers: headers,
    output_text: outputText,
  };
  fs.writeFileSync(path.join(outputDir, `${stem}.response.bin`), responseBytes);
  fs.writeFileSync(path.join(outputDir, `${stem}.response.sse`), rawText, "utf8");
  fs.writeFileSync(path.join(outputDir, `${stem}.parsed.json`), `${JSON.stringify({ response: parsedResponse, events: parsedSse.events, invalid_data_lines: parsedSse.invalidDataLines }, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, `${stem}.result.json`), `${JSON.stringify(result, null, 2)}\n`);
  fs.appendFileSync(path.join(outputDir, "results.jsonl"), `${JSON.stringify(result)}\n`);
  results.push(result);
  process.stdout.write(`${JSON.stringify({ sequence, fixture: fixture.index, http_status: httpStatus, response_status: result.response_status, input_tokens: result.input_tokens, output_tokens: result.output_tokens, latency_ms: elapsedMs, question_marks: questionMarkCount, longest_character_run: longestCharacterRun, longest_identical_delta: identicalDelta.longest, repeated_single_token_at_limit: repeatedSingleTokenAtLimit, raw_sse_damaged: rawSseDamaged, corruption })}\n`);
  if (corruption) {
    stopReason = `corruption_at_request_${sequence}`;
    break;
  }
}

const completedAt = new Date().toISOString();
const summary = {
  ...manifest,
  completed_utc: completedAt,
  stop_reason: stopReason,
  completed_requests: results.length,
  successful_requests: results.filter((item) => !item.corruption).length,
  corruption_request: results.find((item) => item.corruption)?.sequence ?? null,
  corruption_result: results.find((item) => item.corruption) ?? null,
};
fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);
process.exitCode = summary.corruption_request === null ? 0 : 2;

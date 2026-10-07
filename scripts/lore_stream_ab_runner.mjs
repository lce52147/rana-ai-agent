import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [firstFixturePath, secondFixturePath, modeArg = "both", iterationsArg = "10"] = process.argv.slice(2);
if (!firstFixturePath || !secondFixturePath) {
  throw new Error("usage: node lore_stream_ab_runner.mjs <first.request.json> <second.request.json> [true|false|both] [iterations]");
}

const iterations = Number(iterationsArg);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");

const endpoint = process.env.RANA_LLAMA_RESPONSES_URL || "http://127.0.0.1:6969/v1/responses";
const outputRoot = path.resolve(
  process.env.RANA_AB_OUTPUT_DIR || path.join(process.cwd(), "runtime-debug", "streaming-ab"),
);
const runId = new Date().toISOString().replaceAll(":", "-");
const runDir = path.join(outputRoot, runId);
fs.mkdirSync(runDir, { recursive: true });

const fixtures = {
  first: JSON.parse(fs.readFileSync(path.resolve(firstFixturePath), "utf8")),
  second: JSON.parse(fs.readFileSync(path.resolve(secondFixturePath), "utf8")),
};
const fixtureHashes = Object.fromEntries(
  Object.entries({ first: firstFixturePath, second: secondFixturePath }).map(([name, fixturePath]) => [
    name,
    crypto.createHash("sha256").update(fs.readFileSync(path.resolve(fixturePath))).digest("hex"),
  ]),
);
const modes = modeArg === "both" ? [true, false] : [modeArg === "true"];

function parseSseResponse(rawText) {
  const payloads = rawText
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return payloads.findLast((item) => item.type === "response.completed")?.response || null;
}

function outputText(response) {
  return (response?.output || [])
    .flatMap((item) => item?.content || [])
    .map((item) => item?.text || "")
    .join("");
}

function questionMarkStats(text) {
  const trimmed = text.trim();
  const runs = trimmed.match(/[?？]+/gu) || [];
  return {
    questionMarks: [...trimmed].filter((char) => char === "?" || char === "？").length,
    maxConsecutiveQuestionMarks: runs.reduce((max, run) => Math.max(max, [...run].length), 0),
    pureQuestionMarks: trimmed.length > 0 && /^[?？]+$/u.test(trimmed),
  };
}

const results = [];
for (const stream of modes) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const fixtureName of ["first", "second"]) {
      const request = structuredClone(fixtures[fixtureName]);
      request.stream = stream;
      const requestText = JSON.stringify(request);
      const stem = `${stream ? "stream-true" : "stream-false"}_${String(iteration).padStart(2, "0")}_${fixtureName}`;
      fs.writeFileSync(path.join(runDir, `${stem}.request.json`), `${JSON.stringify(request, null, 2)}\n`, "utf8");
      const startedAt = Date.now();
      let status = 0;
      let responseHeaders = {};
      let responseBytes = Buffer.alloc(0);
      let parsedResponse = null;
      let error = null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestText,
        });
        status = response.status;
        responseHeaders = Object.fromEntries(response.headers.entries());
        responseBytes = Buffer.from(await response.arrayBuffer());
        const rawText = responseBytes.toString("utf8");
        parsedResponse = stream ? parseSseResponse(rawText) : JSON.parse(rawText);
      } catch (caught) {
        error = String(caught);
      }
      const rawText = responseBytes.toString("utf8");
      const text = outputText(parsedResponse);
      const questionMarkStatsForResult = questionMarkStats(text);
      const result = {
        runId,
        iteration,
        fixture: fixtureName,
        endpoint,
        stream,
        model: request.model,
        max_output_tokens: request.max_output_tokens,
        temperature: request.temperature,
        input_items: Array.isArray(request.input) ? request.input.length : 0,
        tools_count: Array.isArray(request.tools) ? request.tools.length : 0,
        tool_choice: request.tool_choice,
        request_bytes: Buffer.byteLength(requestText),
        status,
        response_headers: responseHeaders,
        response_bytes: responseBytes.length,
        elapsed_ms: Date.now() - startedAt,
        response_id: parsedResponse?.id,
        finish_status: parsedResponse?.status,
        usage: parsedResponse?.usage,
        output_tokens: parsedResponse?.usage?.output_tokens,
        output_text: text,
        question_marks: questionMarkStatsForResult.questionMarks,
        max_consecutive_question_marks: questionMarkStatsForResult.maxConsecutiveQuestionMarks,
        pure_question_marks: questionMarkStatsForResult.pureQuestionMarks,
        error,
      };
      fs.writeFileSync(path.join(runDir, `${stem}.response.bin`), responseBytes);
      fs.writeFileSync(path.join(runDir, `${stem}.response.txt`), rawText, "utf8");
      fs.writeFileSync(path.join(runDir, `${stem}.parsed.json`), `${JSON.stringify(parsedResponse, null, 2)}\n`, "utf8");
      fs.writeFileSync(path.join(runDir, `${stem}.result.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
      results.push(result);
      process.stdout.write(`${JSON.stringify({ iteration, fixture: fixtureName, stream, status, elapsed_ms: result.elapsed_ms, output_tokens: result.output_tokens, question_marks: result.question_marks, max_consecutive_question_marks: result.max_consecutive_question_marks, pure_question_marks: result.pure_question_marks, error })}\n`);
    }
  }
}

const summary = {
  runId,
  runDir,
  endpoint,
  iterations,
  fixture_hashes_sha256: fixtureHashes,
  counts: Object.fromEntries(
    modes.map((stream) => {
      const rows = results.filter((item) => item.stream === stream);
      return [stream ? "stream_true" : "stream_false", {
        total: rows.length,
        ok: rows.filter((item) => item.status === 200 && item.finish_status === "completed" && !item.error).length,
        with_question_marks: rows.filter((item) => item.question_marks > 0).length,
        pure_question_mark_failures: rows.filter((item) => item.pure_question_marks).length,
        errors: rows.filter((item) => item.error || item.status !== 200 || item.finish_status !== "completed").length,
        latency_ms: {
          min: Math.min(...rows.map((item) => item.elapsed_ms)),
          max: Math.max(...rows.map((item) => item.elapsed_ms)),
          mean: Math.round(rows.reduce((sum, item) => sum + item.elapsed_ms, 0) / rows.length),
        },
      }];
    }),
  ),
};
fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);

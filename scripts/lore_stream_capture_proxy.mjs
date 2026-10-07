import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

const listenHost = process.env.RANA_CAPTURE_HOST || "127.0.0.1";
const listenPort = Number(process.env.RANA_CAPTURE_PORT || 6968);
const upstreamHost = process.env.RANA_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = Number(process.env.RANA_UPSTREAM_PORT || 6969);
const outputDir = path.resolve(
  process.env.RANA_CAPTURE_DIR || path.join(process.cwd(), "runtime-debug", "streaming-captures"),
);

fs.mkdirSync(outputDir, { recursive: true });

function redactHeaders(headers) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers || {})) {
    redacted[key] = /^(?:authorization|api-key|x-api-key|proxy-authorization)$/iu.test(key)
      ? "<redacted>"
      : value;
  }
  return redacted;
}

function safeStamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const server = http.createServer((clientRequest, clientResponse) => {
  const captureId = `${safeStamp()}_${randomUUID()}`;
  const requestChunks = [];
  const responseChunks = [];
  const startedAt = Date.now();

  clientRequest.on("data", (chunk) => requestChunks.push(Buffer.from(chunk)));
  clientRequest.on("end", () => {
    const requestBytes = Buffer.concat(requestChunks);
    const upstreamRequest = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: clientRequest.method,
        path: clientRequest.url,
        headers: {
          ...clientRequest.headers,
          host: `${upstreamHost}:${upstreamPort}`,
          "content-length": requestBytes.length,
        },
      },
      (upstreamResponse) => {
        clientResponse.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.on("data", (chunk) => {
          const bytes = Buffer.from(chunk);
          responseChunks.push(bytes);
          clientResponse.write(bytes);
        });
        upstreamResponse.on("end", () => {
          clientResponse.end();
          const responseBytes = Buffer.concat(responseChunks);
          const requestText = requestBytes.toString("utf8");
          const responseText = responseBytes.toString("utf8");
          let requestJson;
          try {
            requestJson = JSON.parse(requestText);
          } catch {
            requestJson = null;
          }
          const stem = path.join(outputDir, captureId);
          fs.writeFileSync(`${stem}.request.bin`, requestBytes);
          fs.writeFileSync(`${stem}.response.bin`, responseBytes);
          fs.writeFileSync(`${stem}.request.txt`, requestText, "utf8");
          fs.writeFileSync(`${stem}.response.txt`, responseText, "utf8");
          if (requestJson) writeJson(`${stem}.request.json`, requestJson);
          writeJson(`${stem}.meta.json`, {
            captureId,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            request: {
              method: clientRequest.method,
              url: clientRequest.url,
              headers: redactHeaders(clientRequest.headers),
              byteLength: requestBytes.length,
            },
            response: {
              statusCode: upstreamResponse.statusCode,
              headers: redactHeaders(upstreamResponse.headers),
              byteLength: responseBytes.length,
            },
          });
          process.stdout.write(`${captureId} ${clientRequest.method} ${clientRequest.url} ${upstreamResponse.statusCode} ${Date.now() - startedAt}ms\n`);
        });
      },
    );

    upstreamRequest.on("error", (error) => {
      if (!clientResponse.headersSent) clientResponse.writeHead(502, { "content-type": "application/json" });
      clientResponse.end(JSON.stringify({ error: { message: "capture proxy upstream failure" } }));
      writeJson(path.join(outputDir, `${captureId}.error.json`), {
        captureId,
        error: String(error),
        request: {
          method: clientRequest.method,
          url: clientRequest.url,
          headers: redactHeaders(clientRequest.headers),
          byteLength: requestBytes.length,
        },
      });
    });
    upstreamRequest.end(requestBytes);
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`capture proxy listening http://${listenHost}:${listenPort} -> http://${upstreamHost}:${upstreamPort}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

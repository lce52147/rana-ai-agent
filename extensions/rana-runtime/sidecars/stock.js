import { postJson } from "./http.js";

const HOT_TOOLS_URL = "http://127.0.0.1:8091";

export async function researchStock(body, signal) {
  const payload = body || {};
  try {
    return await postJson(`${HOT_TOOLS_URL}/stock/research`, payload, signal, 60000);
  } catch (err) {
    if (!/not found|HTTP 404/i.test(String(err?.message || err))) throw err;
    const text = payload.query || payload.text || "";
    return await postJson(`${HOT_TOOLS_URL}/api/hot-tools`, {
      text,
      body: text,
      content: text,
      requester_id: payload.requester_id,
    }, signal, 60000);
  }
}

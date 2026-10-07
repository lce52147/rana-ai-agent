const HTTP_TIMEOUT_MS = 12000;

export async function postJson(url, body, signal, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!res.ok) {
      const detail = data?.error || text || `HTTP ${res.status}`;
      throw new Error(String(detail));
    }
    return data ?? {};
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`request timeout (${timeoutMs}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export async function getJson(url, signal, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!res.ok) {
      const detail = data?.error || text || `HTTP ${res.status}`;
      throw new Error(String(detail));
    }
    return data ?? {};
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`request timeout (${timeoutMs}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

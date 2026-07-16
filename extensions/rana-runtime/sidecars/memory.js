import { getJson, postJson } from "./http.js";

const HOT_TOOLS_URL = "http://127.0.0.1:8091";

export async function memoryStatus(signal) { return await getJson(`${HOT_TOOLS_URL}/memory/status`, signal, 15000); }
export async function recallMemory(body, signal) { return await postJson(`${HOT_TOOLS_URL}/memory/recall`, body || {}, signal, 15000); }
export async function rememberMemory(body, signal) { return await postJson(`${HOT_TOOLS_URL}/memory/remember`, body || {}, signal, 15000); }
export async function deleteMemory(body, signal) { return await postJson(`${HOT_TOOLS_URL}/memory/delete`, body || {}, signal, 15000); }

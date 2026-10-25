/**
 * Lean model-facing prompt rendering.
 *
 * The runtime contracts (TurnPlan, persona policy, final boundary) are built
 * as KEY=VALUE atoms. On the sister Gemma 12B run they added ~12k characters
 * (187 flag lines) per turn, and the few natural-language instructions that
 * actually steer generation were buried among them. This module renders the
 * same blocks for the model by keeping the natural-language lines and the
 * handful of atoms that carry meaning, and dropping bare policy flags.
 *
 * It only changes what is shown to the model. The TurnPlan and every
 * builder's own output are unchanged, so `RANA_PROMPT_MODE=legacy` restores
 * the previous prompt exactly.
 */

const ATOM_LINE_RE = /^([A-Z][A-Za-z0-9_.-]*)=(.*)$/u;
const HEADER_LINE_RE = /^[A-Z][A-Z0-9 _/—\-]*(?:\([^)]*\))?[^a-z]*:$|^[A-Z][A-Z0-9_ ]+—[^\n]*:$/u;
const PIPE_ATOM_LIST_RE = /^[A-Z0-9_]+(?:\|[A-Z0-9_]+)*$/u;
const HAN_RE = /\p{Script=Han}/u;

export function promptMode() {
  return String(process.env.RANA_PROMPT_MODE || "lean").trim().toLowerCase() === "legacy" ? "legacy" : "lean";
}

function sentenceLike(value) {
  const text = String(value || "").trim();
  if (text.length < 12) return false;
  if (PIPE_ATOM_LIST_RE.test(text)) return false;
  if (text === "<redacted>") return false;
  return /\s/u.test(text) || HAN_RE.test(text);
}

function jsonStringArray(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

// Atoms whose value is a fact the model needs, rendered as a sentence.
function meaningfulAtom(key, value, atoms) {
  const pair = key.match(/^PAIR_(\d+)_PREFERRED_VOCATIVE$/u);
  if (pair) {
    const target = atoms.get(`PAIR_${pair[1]}_TARGET_CHARACTER_IDENTITY`);
    return value && target ? `直接叫${target}時用「${value}」。` : "";
  }
  if (key === "TASK_REQUIRED_ITEM_COUNT" && /^\d+$/u.test(value) && Number(value) > 1) {
    return `這題要求的 ${value} 項都要完成。`;
  }
  if (key === "OUTPUT_SLOT_COUNT" && /^\d+$/u.test(value) && Number(value) > 1) {
    return `依序回答這 ${value} 個部分。`;
  }
  return "";
}

export function leanPromptText(text) {
  const source = String(text || "");
  if (!source.trim()) return source;
  const lines = source.split(/\r?\n/u);
  const atoms = new Map();
  for (const line of lines) {
    const match = line.match(ATOM_LINE_RE);
    if (match) atoms.set(match[1], match[2].trim());
  }

  const out = [];
  const seen = new Set();
  const push = (line) => {
    const value = String(line ?? "");
    const key = value.trim();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(value);
  };

  for (const line of lines) {
    const match = line.match(ATOM_LINE_RE);
    if (!match) {
      if (HEADER_LINE_RE.test(line.trim())) continue;
      push(line);
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    const items = key.endsWith("_JSON") ? jsonStringArray(value) : null;
    if (items) {
      for (const item of items) push(`- ${item}`);
      continue;
    }
    const meaningful = meaningfulAtom(key, value, atoms);
    if (meaningful) {
      push(meaningful);
      continue;
    }
    if (sentenceLike(value)) push(value);
  }

  return out.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function modelFacingContext(text) {
  return promptMode() === "legacy" ? text : leanPromptText(text);
}

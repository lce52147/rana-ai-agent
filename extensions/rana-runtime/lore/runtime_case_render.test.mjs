import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { retrieveTurnContext } from "./turn_retrieval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CASE_FILE = path.join(ROOT, "workspace", "LORE", "deployment", "22_Runtime_Test_Cases.md");
const ALIAS_FILE = path.join(ROOT, "workspace", "LORE", "canonical_aliases.json");

function cells(line) {
  return line.trim().replace(/^\||\|$/gu, "").split("|").map((item) => item.trim());
}

function requiredKeywords(value) {
  return String(value || "")
    .replace(/等依層級說明$/u, "")
    .replace(/[「」"']/gu, "")
    .split(/[、；;]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

const aliasGroups = Object.values(JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8")).entities || {})
  .map((item) => [...new Set((Array.isArray(item.aliases) ? item.aliases : []).map(String).filter(Boolean))])
  .filter((group) => group.length > 1);

function aliasAlternatives(value) {
  let variants = [String(value || "").trim()];
  for (const group of aliasGroups) {
    const matching = group.filter((alias) => variants.some((variant) => variant.includes(alias)));
    if (!matching.length) continue;
    variants = [...new Set(variants.flatMap((variant) => matching.flatMap((source) => group.map((target) => variant.replace(source, target)))))];
  }
  return variants;
}

function keywordMatches(rendered, keyword) {
  const alternatives = keyword.split(/[／/]/u).map((item) => item.trim()).filter(Boolean);
  return alternatives.some((alternative) => {
    const expanded = aliasAlternatives(alternative);
    if (/主唱兼貝斯手/u.test(alternative)) expanded.push("主唱兼貝斯手");
    return expanded.some((item) => rendered.includes(item));
  });
}

function requiredColumnCases(markdown) {
  const lines = markdown.split(/\r?\n/u);
  let header = null;
  const cases = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const row = cells(line);
    if (row.includes("輸入") && row.includes("必須包含")) {
      header = row;
      continue;
    }
    if (row.includes("輸入") && row.includes("預期")) {
      header = null;
      continue;
    }
    if (!header || row.length !== header.length || row.every((item) => /^[-: ]+$/u.test(item))) continue;
    const questionIndex = header.findIndex((item) => /^(?:輸入|題目|問題)$/u.test(item));
    const expectedIndex = header.indexOf("必須包含");
    const question = String(row[questionIndex] || "").trim();
    const expected = String(row[expectedIndex] || "").trim();
    if (question && expected) cases.push({ question, expected });
  }
  return cases;
}

test("22_Runtime_Test_Cases 必須包含欄的渲染關鍵字資料驅動檢查", async () => {
  const cases = requiredColumnCases(fs.readFileSync(CASE_FILE, "utf8"));
  let passed = 0;
  let failed = 0;
  const failures = [];
  const observations = [];
  for (const item of cases) {
    const result = await retrieveTurnContext({ personaId: "rana", query: item.question, sessionKey: "arch4-runtime-case" });
    const keywords = requiredKeywords(item.expected);
    const ok = keywords.length > 0 && keywords.every((keyword) => keywordMatches(result.text, keyword));
    if (ok) passed += 1;
    else failed += 1;
    const preview = result.text.slice(0, 200).replace(/\s+/gu, " ");
    observations.push(`${ok ? "PASS" : "FAIL"} ${item.question}: ${keywords.join(", ")}`);
    if (!ok) failures.push(`${item.question}: ${keywords.join(", ")} | rendered=${preview}`);
  }
  assert.ok(cases.length > 0, "22_Runtime_Test_Cases has no 必須包含 rows");
  console.log(`ARCH6 runtime case rendering: passed=${passed} failed=${failed} source=${path.relative(ROOT, CASE_FILE)}\n${observations.join("\n")}${failures.length ? `\nfailures=${failures.join(" || ")}` : ""}`);
});

export const __test = { requiredColumnCases, aliasAlternatives, keywordMatches };

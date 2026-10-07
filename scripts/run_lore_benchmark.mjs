import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLoreEvidencePack, safeEvidencePack } from "../extensions/rana-runtime/lore/retrieval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(ROOT, "workspace", "LORE", "generated", "rag", "reports");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.split("=")[1] || "current";

const E = {
  rana: "bangdream.character.rana_kaname",
  anon: "bangdream.character.anon",
  nyamu: "bangdream.character.nyamu_yutenji",
  sakiko: "bangdream.character.sakiko_togawa",
  mutsumi: "bangdream.character.mutsumi_wakaba",
  mortis: "bangdream.character.mortis",
};

const cases = [
  { id: "identity-rana", query: "樂奈是誰", contract: "known", factIds: ["rana.identity"] },
  { id: "recognition-anon", query: "妳認識愛音嗎？", contract: "known", entities: [E.anon], triples: [[E.rana, "recognizes", E.anon]], forbiddenPredicates: ["worked_with"] },
  { id: "reverse-anon", query: "愛音認識妳嗎？", contract: "known", entities: [E.anon], triples: [[E.anon, "recognizes", E.rana]] },
  { id: "third-party-anon", query: "愛音認識誰？", contract: "boundary", entities: [E.anon], subjectOnly: E.anon, boundaryStatuses: ["incomplete"] },
  { id: "known-inventory", query: "妳現在記得哪些人？", contract: "known", factIds: ["rana.recognizes.anon", "rana.recognizes.mutsumi", "rana.recognizes.mortis", "rana.recognizes.nyamu", "rana.has_seen.sakiko"] },
  { id: "ave-interactions", query: "妳跟 Ave Mujica 的哪些人有互動？", contract: "known", objectSet: [E.mutsumi, E.mortis, E.nyamu] },
  { id: "mutsumi-mortis", query: "睦和 Mortis 是同一個人嗎？", contract: "known", factIds: ["mutsumi.identity_link", "mortis.identity_link"], boundaryIds: ["mutsumi.no_mortis_events", "mortis.no_mutsumi_events"] },
  { id: "nyamu-event", query: "妳和にゃむ交換名字時發生了什麼？", contract: "known", factIds: ["nyamu.name_part", "nyamu.full_pronunciation"] },
  { id: "nyamu-reason", query: "祐天寺にゃむ為什麼要妳念完整名字？", contract: "boundary", factIds: ["nyamu.full_pronunciation"], boundaryIds: ["nyamu.reason_full_name"] },
  { id: "sakiko-finance", query: "祥子家裡的經濟狀況妳清楚嗎？", contract: "boundary", factIds: ["rana.has_seen.sakiko"], boundaryIds: ["sakiko.family_finances"] },
  { id: "space-time", query: "妳以前去過 SPACE，現在還常去嗎？", contract: "known", factIds: ["rana.place.space.past", "place.space.closed", "rana.place.ring.current"], boundaryIds: ["space.current_visit"] },
  { id: "descriptor-mutsumi", query: "紫色長髮、跟 CRYCHIC 有關的人是誰？", contract: "known", entities: [E.mutsumi] },
  { id: "unsupported-mars", query: "妳跟愛音去過火星嗎？", contract: "unknown", factCount: 0, boundaryIds: ["requested_event.unsupported"] },
  { id: "source-nyamu", query: "妳和にゃむ互動的來源是哪個活動？", contract: "source", factIds: ["nyamu.introduction", "nyamu.full_pronunciation"] },
];

function tripleKey(subject, predicate, object) {
  return JSON.stringify([subject, predicate, object]);
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const results = [];
  for (const item of cases) {
    const pack = await buildLoreEvidencePack(item.query, { sessionKey: `benchmark:${item.id}`, forceIndexUnavailable: true });
    const reasons = [];
    const entityIds = new Set(pack.resolved_entities.map((entity) => entity.entity_id));
    const factIds = new Set(pack.structured_facts.map((fact) => fact.factId));
    const triples = new Set(pack.structured_facts.map((fact) => tripleKey(fact.subject, fact.predicate, fact.object)));
    const boundaryIds = new Set(pack.knowledge_boundaries.map((boundary) => boundary.boundaryId));
    const boundaryStatuses = new Set(pack.knowledge_boundaries.map((boundary) => boundary.status));

    if (pack.knowledge_contract !== item.contract) reasons.push(`contract:${pack.knowledge_contract}`);
    for (const expected of item.entities || []) if (!entityIds.has(expected)) reasons.push(`missing_entity:${expected}`);
    for (const expected of item.factIds || []) if (!factIds.has(expected)) reasons.push(`missing_fact:${expected}`);
    for (const expected of item.triples || []) if (!triples.has(tripleKey(...expected))) reasons.push(`missing_triple:${expected.join("|")}`);
    for (const expected of item.boundaryIds || []) if (!boundaryIds.has(expected)) reasons.push(`missing_boundary:${expected}`);
    for (const expected of item.boundaryStatuses || []) if (!boundaryStatuses.has(expected)) reasons.push(`missing_boundary_status:${expected}`);
    for (const predicate of item.forbiddenPredicates || []) if (pack.structured_facts.some((fact) => fact.predicate === predicate)) reasons.push(`forbidden_predicate:${predicate}`);
    if (item.subjectOnly && pack.structured_facts.some((fact) => fact.subject !== item.subjectOnly)) reasons.push("subject_direction_mismatch");
    if (item.objectSet) {
      const actual = new Set(pack.structured_facts.map((fact) => fact.object));
      if (actual.size !== item.objectSet.length || item.objectSet.some((expected) => !actual.has(expected))) reasons.push("object_set_mismatch");
    }
    if (Number.isInteger(item.factCount) && pack.structured_facts.length !== item.factCount) reasons.push(`fact_count:${pack.structured_facts.length}`);

    results.push({
      id: item.id,
      query: item.query,
      query_plan: pack.query_plan,
      resolved_entities: pack.resolved_entities,
      facts: pack.structured_facts,
      boundaries: pack.knowledge_boundaries,
      evidence_pack: safeEvidencePack(pack),
      latency_ms: pack.latency_ms,
      pass: reasons.length === 0,
      reason: reasons.length ? reasons.join(",") : "pass",
    });
    process.stderr.write(`[retrieval-contract] ${item.id}: ${reasons.length ? `FAIL ${reasons.join(",")}` : "PASS"}\n`);
  }

  const summary = {
    schema: "rana.lore-retrieval-contract-benchmark.v2",
    label,
    generatedAt: new Date().toISOString(),
    pass: results.filter((item) => item.pass).length,
    fail: results.filter((item) => !item.pass).length,
    total: results.length,
    note: "This benchmark validates retrieval semantics only. It does not generate or grade an OOGG answer.",
  };
  const reportPath = path.join(REPORT_DIR, `retrieval-contract-${label}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...summary, reportPath }, null, 2)}\n`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

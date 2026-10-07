import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildUnifiedTurnPlan } from "../architecture/turn_plan.js";
import { buildLoreEvidencePack } from "./retrieval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STORE = JSON.parse(fs.readFileSync(path.join(ROOT, "workspace", "LORE", "runtime", "06_Rana_Character_Impressions.json"), "utf8"));
const LEVEL_BY_ENTITY = new Map((STORE.characters || []).map((item) => [item.entityId, item.recognitionLevel]));

function inventoryTargets(pack) {
  return (pack.structured_facts || [])
    .filter((fact) => fact.subject === "bangdream.character.rana_kaname" && ["recognizes", "has_seen"].includes(fact.predicate))
    .map((fact) => fact.object);
}

test("first known-people inventory exposes only CORE recognition targets and follows planner classification", async () => {
  for (const query of ["你都認識哪些人", "你認識哪些人", "你認識的人有誰", "你都認識誰"]) {
    const turnPlan = buildUnifiedTurnPlan(query, { personaId: "rana" });
    const pack = await buildLoreEvidencePack(query, { turnPlan, forceIndexUnavailable: true });
    const targets = inventoryTargets(pack);

    assert.equal(pack.intent, "known_people_inventory", query);
    assert.deepEqual(pack.retrieved_evidence, []);
    assert.ok(targets.length > 0, query);
    for (const target of targets) assert.equal(LEVEL_BY_ENTITY.get(target), "core", `${query}: ${target}`);
    for (const expected of [
      "bangdream.character.tomori",
      "bangdream.character.taki",
      "bangdream.character.anon",
      "bangdream.character.soyo",
    ]) assert.ok(targets.includes(expected), `${query}: ${expected}`);
  }

  const turnPlan = buildUnifiedTurnPlan("你認識的人有誰", { personaId: "rana" });
  const pack = await buildLoreEvidencePack("列一下", { turnPlan, forceIndexUnavailable: true });

  assert.equal(pack.intent, "known_people_inventory");
  const targets = inventoryTargets(pack);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.equal(LEVEL_BY_ENTITY.get(target), "core", target);
});

test("known-people follow-ups stay canonical and expose only REMEMBERED targets", async () => {
  for (const query of ["其他呢", "其他人呢", "還有呢", "還有其他人嗎", "還有別人嗎"]) {
    const previousUserText = "你認識的人有誰";
    const turnPlan = buildUnifiedTurnPlan(query, { personaId: "rana", previousUserText });

    assert.equal(turnPlan.evidence.required, true);
    assert.equal(turnPlan.evidence.source, "persona_canonical");
    assert.equal(turnPlan.utteranceAct?.continuationMode, "known_people_inventory_followup");

    const pack = await buildLoreEvidencePack(query, { turnPlan, forceIndexUnavailable: true });
    const targets = inventoryTargets(pack);
    assert.equal(pack.intent, "known_people_inventory");
    assert.equal(pack.evidence_coverage?.supported, true);
    assert.deepEqual(pack.retrieved_evidence, []);
    assert.ok(targets.length > 0, query);
    for (const target of targets) {
      assert.ok(["remembered", "remembered_once"].includes(LEVEL_BY_ENTITY.get(target)), `${query}: ${target}: ${LEVEL_BY_ENTITY.get(target)}`);
    }
    assert.equal(targets.includes("bangdream.character.umiri"), false, query);
  }
});

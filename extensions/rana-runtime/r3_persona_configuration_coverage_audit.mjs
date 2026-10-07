import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSONA_IDS,
  getPersonaProfile,
  stablePersonaProfile,
} from "./persona_registry.js";
import { buildPersonaRelationshipContext } from "./persona_context.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WORKSPACE = path.join(ROOT, "workspace");
const OUTPUT_JSON = path.join(WORKSPACE, "Rana_R3_PERSONA_CONFIGURATION_COVERAGE_20260929.json");
const OUTPUT_MD = path.join(WORKSPACE, "Rana_R3_PERSONA_CONFIGURATION_COVERAGE_20260929.md");

const LORE_AUTHORITY_FILES = Object.freeze({
  rana: path.join(ROOT, "workspace", "LORE", "runtime", "06_Rana_Character_Impressions.json"),
  tomori: path.join(ROOT, "workspace-bots", "tomori", "LORE", "runtime", "06_Tomori_Character_Impressions.json"),
  anon: path.join(ROOT, "workspace-bots", "anon", "LORE", "runtime", "06_Anon_Character_Impressions.json"),
  soyo: path.join(ROOT, "workspace-bots", "soyo", "LORE", "runtime", "06_Soyo_Character_Impressions.json"),
  taki: path.join(ROOT, "workspace-bots", "taki", "LORE", "runtime", "06_Taki_Character_Impressions.json"),
});

const TESTS = Object.freeze({
  source: "controlled Persona source inventory is complete for all five Personas and all 20 directed pairs",
  stable: "stable identity inventory is complete and agrees with the active Persona package identity",
  factual: "all 20 directed factual relationship authorities are present independently from delivery profiles",
  core: "active Persona controlled roleCore and interactionPolicy reach the generation contract without fact authority",
  identityResponse: "identityResponse guidance is projected only when the turn actually asks character identity",
  modePositive: "every configured turnMode activates from its own keyword and stays delivery-only",
  modeNegative: "turnModes do not activate on a neighboring unrelated turn and multiple matched modes stay separately indexed",
  referenceAliases: "every configured recognitionAlias resolves to the correct target without granting relationship facts",
  relationshipAliases: "every relationship-only alias resolves to its own directed target without granting relationship facts",
  references: "all 20 directed reference records expose preferredReference as optional delivery metadata",
  pairs: "all 20 directed pair realization rows are explicit and retain fact-authority denial",
  tomoriRana: "Tomori to Rana uses the controlled concrete music/action relation profile instead of generic fallback",
  nicknameIsolation: "pair-specific nicknames resolve only to their own target and canonical plus nickname does not duplicate the target",
  multiTarget: "multi-target turns preserve separate target-indexed pair metadata for two and four mentioned members",
  profilePlace: "r3_profile_place_relation_convergence_regression.test.mjs",
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function rel(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative && !relative.startsWith("..") ? relative.replaceAll("\\", "/") : filePath.replaceAll("\\", "/");
}

function personaCtx(id) {
  return {
    accountId: id === "rana" ? "default" : id,
    agentId: id === "rana" ? "main" : id,
    sessionKey: `agent:${id === "rana" ? "main" : id}:discord:channel:r3-full-persona-audit-report`,
  };
}

function parseContract(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/u)) {
    const split = line.indexOf("=");
    if (split <= 0) continue;
    values.set(line.slice(0, split), line.slice(split + 1));
  }
  return values;
}

function replayCaseFor(surface, persona, target, modeId = "") {
  if (surface === "identity") return `profile-${persona}`;
  if (surface === "identity_response") return `profile-${persona}`;
  if (surface === "turn_mode") return `mode-${persona}-${modeId}`;
  if (["reference", "relationship", "pair_realization", "factual_relationship_authority"].includes(surface)) {
    return `pair-${persona}-${target}`;
  }
  if (["role_core", "interaction_policy"].includes(surface)) return `rolecore-${persona}`;
  return null;
}

const entries = [];
let sequence = 0;
function add({
  surface,
  sourceFile,
  jsonPath,
  persona,
  target = null,
  value,
  validationType,
  testNames,
  sourceStatus = "PRESENT",
  status = "PASS",
  productionReplayCase = null,
  notes = "",
}) {
  sequence += 1;
  entries.push({
    setting_id: `PCOV-${String(sequence).padStart(4, "0")}`,
    surface,
    source_file: rel(sourceFile),
    json_path: jsonPath,
    persona,
    target,
    value,
    validation_type: validationType,
    test_names: Array.isArray(testNames) ? testNames : [testNames].filter(Boolean),
    source_status: sourceStatus,
    production_replay_case: productionReplayCase,
    status,
    notes,
  });
}

const configs = {};
const sourceHashes = {};
const directionMatrix = [];
const turnModeMatrix = [];
const roleCoreCounts = {};

const registryFile = path.join(HERE, "persona_registry.js");
const contextFile = path.join(HERE, "persona_context.js");
sourceHashes[rel(registryFile)] = hash(registryFile);
sourceHashes[rel(contextFile)] = hash(contextFile);

for (const personaId of PERSONA_IDS) {
  const registry = getPersonaProfile(personaId);
  const stable = stablePersonaProfile(personaId);
  const configFile = path.join(registry.workspace, "PERSONA.json");
  const config = readJson(configFile);
  configs[personaId] = config;
  sourceHashes[rel(configFile)] = hash(configFile);

  const loreFile = LORE_AUTHORITY_FILES[personaId];
  const lore = readJson(loreFile);
  sourceHashes[rel(loreFile)] = hash(loreFile);

  const identityFields = [
    ["canonicalName", stable.canonicalName, `PERSONAS.${personaId}.canonicalName`],
    ["aliases", registry.aliases, `PERSONAS.${personaId}.aliases`],
    ["affiliation/band", stable.band, `PERSONAS.${personaId}.stableProfile.band`],
    ["role", stable.role, `PERSONAS.${personaId}.stableProfile.role`],
    ["school", stable.school, `PERSONAS.${personaId}.stableProfile.school`],
    ["grade/class", stable.gradeClass, `PERSONAS.${personaId}.stableProfile.gradeClass`],
    ["birthday", stable.birthday, `PERSONAS.${personaId}.stableProfile.birthday`],
  ];
  for (const [field, value, jsonPath] of identityFields) {
    add({
      surface: "identity",
      sourceFile: registryFile,
      jsonPath,
      persona: personaId,
      value: { field, value },
      validationType: "deterministic_registry_reconciliation",
      testNames: [TESTS.stable, TESTS.profilePlace],
      productionReplayCase: replayCaseFor("identity", personaId),
      notes: "Stable identity/profile authority is persona_registry.js; PERSONA delivery policy cannot widen it.",
    });
  }

  for (const field of ["schema", "revision", "personaId", "botId", "canonicalName", "recognitionAliases"]) {
    add({
      surface: "persona_package_metadata",
      sourceFile: configFile,
      jsonPath: field,
      persona: personaId,
      value: config[field],
      validationType: "source_inventory_orphan_guard",
      testNames: TESTS.source,
      notes: "Source/package metadata is inventoried; it is not independent factual authority over stable profile fields.",
    });
  }

  for (const [key, value] of Object.entries(config.lorePolicy || {})) {
    add({
      surface: "lore_policy",
      sourceFile: configFile,
      jsonPath: `lorePolicy.${key}`,
      persona: personaId,
      value,
      validationType: "source_inventory_plus_lore_authority_separation",
      testNames: [TESTS.source, TESTS.factual],
      notes: "LORE policy governs retrieval/authority ownership; pair delivery remains fact-authority denied.",
    });
  }

  for (const [key, value] of Object.entries(config.identityResponse || {})) {
    add({
      surface: "identity_response",
      sourceFile: configFile,
      jsonPath: `identityResponse.${key}`,
      persona: personaId,
      value,
      validationType: "identity_turn_scoped_projection",
      testNames: [TESTS.identityResponse, TESTS.profilePlace],
      productionReplayCase: replayCaseFor("identity_response", personaId),
      notes: "Projected only for character-identity turns; suppressed on unrelated/stable-profile turns to prevent adjacent fact leakage.",
    });
  }

  const responseMechanism = config.roleCore?.responseMechanism || [];
  const assistantLeakAvoid = config.roleCore?.assistantLeakAvoid || [];
  roleCoreCounts[personaId] = {
    responseMechanism: responseMechanism.length,
    assistantLeakAvoid: assistantLeakAvoid.length,
    stopRule: config.roleCore?.stopRule ? 1 : 0,
    knowledgeBoundary: config.roleCore?.knowledgeBoundary ? 1 : 0,
  };
  responseMechanism.forEach((value, index) => add({
    surface: "role_core",
    sourceFile: configFile,
    jsonPath: `roleCore.responseMechanism[${index}]`,
    persona: personaId,
    value,
    validationType: "realization_projection",
    testNames: TESTS.core,
    productionReplayCase: replayCaseFor("role_core", personaId),
    notes: "Delivery invariant only; cannot add facts or override TurnPlan.",
  }));
  if (config.roleCore?.stopRule) add({
    surface: "role_core",
    sourceFile: configFile,
    jsonPath: "roleCore.stopRule",
    persona: personaId,
    value: config.roleCore.stopRule,
    validationType: "realization_projection",
    testNames: TESTS.core,
    productionReplayCase: replayCaseFor("role_core", personaId),
    notes: "Stopping behavior is projected as delivery policy, not as semantic authority.",
  });
  if (config.roleCore?.knowledgeBoundary) add({
    surface: "role_core",
    sourceFile: configFile,
    jsonPath: "roleCore.knowledgeBoundary",
    persona: personaId,
    value: config.roleCore.knowledgeBoundary,
    validationType: "realization_projection_with_stable_profile_suppression",
    testNames: [TESTS.core, TESTS.profilePlace],
    productionReplayCase: replayCaseFor("role_core", personaId),
    notes: "Projected on ordinary turns; suppressed when stable profile authority owns the turn so retrieval/profile wording cannot leak adjacent facts.",
  });
  assistantLeakAvoid.forEach((value, index) => add({
    surface: "role_core",
    sourceFile: configFile,
    jsonPath: `roleCore.assistantLeakAvoid[${index}]`,
    persona: personaId,
    value,
    validationType: "realization_projection",
    testNames: TESTS.core,
    productionReplayCase: replayCaseFor("role_core", personaId),
    notes: "Assistant-leak avoidance is delivery policy only.",
  }));

  for (const [key, value] of Object.entries(config.interactionPolicy || {})) {
    add({
      surface: "interaction_policy",
      sourceFile: configFile,
      jsonPath: `interactionPolicy.${key}`,
      persona: personaId,
      value,
      validationType: "realization_projection",
      testNames: TESTS.core,
      productionReplayCase: replayCaseFor("interaction_policy", personaId),
      notes: "Interaction policy controls delivery/continuation only and cannot create autobiographical or relationship facts.",
    });
  }

  for (const mode of config.turnModes || []) {
    const row = {
      id: mode.id,
      keywords: mode.keywords || [],
      guidance: mode.guidance || "",
      activation_boundary: "current turn text contains a configured keyword; realization owner only",
      negative_control: "sibling mode keyword and unrelated ordinary greeting must not activate this mode",
      fact_authority: "DENY",
    };
    turnModeMatrix.push({ persona: personaId, ...row });
    add({
      surface: "turn_mode",
      sourceFile: configFile,
      jsonPath: `turnModes[id=${mode.id}]`,
      persona: personaId,
      value: row,
      validationType: "positive_activation+neighbor_negative+collision+fact_denial",
      testNames: [TESTS.modePositive, TESTS.modeNegative],
      productionReplayCase: replayCaseFor("turn_mode", personaId, null, mode.id),
      notes: "Keyword match activates delivery guidance only; it is not a semantic/factual classifier.",
    });
  }

  const loreCharacters = Array.isArray(lore.characters) ? lore.characters : [];
  for (const targetId of PERSONA_IDS.filter((id) => id !== personaId)) {
    const reference = config.references?.[targetId] || null;
    const relationship = config.relationships?.[targetId] || null;
    const targetProfile = getPersonaProfile(targetId);
    const factual = loreCharacters.find((entry) => entry?.canonicalName === targetProfile.canonicalName) || null;
    const relationshipOutput = buildPersonaRelationshipContext(
      { prompt: `${reference?.canonicalName || targetProfile.canonicalName}呢？` },
      personaCtx(personaId),
    );
    const contract = parseContract(relationshipOutput);
    const pairProfile = contract.get("PAIR_1_PROFILE") || "";
    const pairRow = {
      active_persona: personaId,
      target_persona: targetId,
      profile: pairProfile,
      preferredVocative: contract.get("PAIR_1_PREFERRED_VOCATIVE") || null,
      allowedVocatives: (contract.get("PAIR_1_ALLOWED_VOCATIVES") || "").split("|").filter(Boolean),
      preferredReference: contract.get("PAIR_1_PREFERRED_REFERENCE") || null,
      canonicalReference: contract.get("PAIR_1_CANONICAL_REFERENCE") || null,
      activeDimensions: (contract.get("PAIR_1_ACTIVE_DIMENSIONS") || "").split("|").filter(Boolean),
      inhibitedDimensions: (contract.get("PAIR_1_INHIBITED_DIMENSIONS") || "").split("|").filter(Boolean),
      fallback: pairProfile === "FAMILIAR_TEAMMATE_BASELINE",
      factAuthority: contract.get("PAIR_FACT_AUTHORITY") || null,
      mayAssertRelationshipFact: contract.get("PAIR_MAY_ASSERT_RELATIONSHIP_FACT") || null,
    };
    directionMatrix.push({
      active_persona: personaId,
      target_persona: targetId,
      reference,
      relationship,
      pair_realization: pairRow,
      factual_authority: factual,
    });

    add({
      surface: "reference",
      sourceFile: configFile,
      jsonPath: `references.${targetId}`,
      persona: personaId,
      target: targetId,
      value: reference,
      validationType: "alias_resolution+preferred_reference_projection+target_isolation",
      testNames: [TESTS.referenceAliases, TESTS.references, TESTS.nicknameIsolation, TESTS.multiTarget],
      productionReplayCase: replayCaseFor("reference", personaId, targetId),
      notes: "Reference identity is target-indexed. PreferredReference is available when natural and is never factual relationship authority.",
    });

    add({
      surface: "relationship",
      sourceFile: configFile,
      jsonPath: `relationships.${targetId}`,
      persona: personaId,
      target: targetId,
      value: relationship,
      validationType: "source_inventory+alias_resolution+explicit_pair_delivery_mapping",
      testNames: [TESTS.source, TESTS.relationshipAliases, TESTS.pairs],
      productionReplayCase: replayCaseFor("relationship", personaId, targetId),
      notes: "PERSONA relationship stance/reaction/stopRule is implementation delivery policy. Canonical factual propositions come from the separate factual-authority row.",
    });

    add({
      surface: "pair_realization",
      sourceFile: contextFile,
      jsonPath: `R3_PAIR_REALIZATION_PROFILE.${personaId}.${targetId}`,
      persona: personaId,
      target: targetId,
      value: pairRow,
      validationType: "runtime_projection+fact_denial+target_isolation",
      testNames: [TESTS.pairs, ...(personaId === "tomori" && targetId === "rana" ? [TESTS.tomoriRana] : [])],
      productionReplayCase: replayCaseFor("pair_realization", personaId, targetId),
      status: pairRow.fallback ? "FAIL" : "PASS",
      notes: pairRow.fallback
        ? "Generic fallback remains on a directed MyGO pair and requires investigation."
        : "Explicit directional delivery profile; pair fact authority remains DENY.",
    });

    add({
      surface: "factual_relationship_authority",
      sourceFile: loreFile,
      jsonPath: `characters[canonicalName=${targetProfile.canonicalName}]`,
      persona: personaId,
      target: targetId,
      value: factual,
      validationType: "controlled_lore_authority_inventory",
      testNames: TESTS.factual,
      sourceStatus: factual ? "PRESENT" : "MISSING",
      status: factual ? "PASS" : "NOT_COVERED",
      productionReplayCase: replayCaseFor("factual_relationship_authority", personaId, targetId),
      notes: "This row owns factual relationship recognition/allowed knowledge/boundary. Delivery profile does not.",
    });
  }
}

const statusCounts = entries.reduce((acc, entry) => {
  acc[entry.status] = (acc[entry.status] || 0) + 1;
  return acc;
}, {});
const summary = {
  configuration_inventory_count: entries.length,
  covered_count: statusCounts.PASS || 0,
  fail_count: statusCounts.FAIL || 0,
  not_covered_count: statusCounts.NOT_COVERED || 0,
  not_applicable_count: statusCounts.NOT_APPLICABLE || 0,
  directed_relationships: directionMatrix.length,
  explicit_pair_realizations: directionMatrix.filter((row) => !row.pair_realization.fallback).length,
  fallback_pair_realizations: directionMatrix.filter((row) => row.pair_realization.fallback).length,
  turn_modes: turnModeMatrix.length,
  reference_records: directionMatrix.filter((row) => row.reference).length,
  relationship_records: directionMatrix.filter((row) => row.relationship).length,
  factual_relationship_authority_records: directionMatrix.filter((row) => row.factual_authority).length,
  role_core_response_mechanism_items: Object.values(roleCoreCounts).reduce((sum, row) => sum + row.responseMechanism, 0),
  role_core_assistant_leak_avoid_items: Object.values(roleCoreCounts).reduce((sum, row) => sum + row.assistantLeakAvoid, 0),
};

const report = {
  schema: "rana.r3.persona_configuration_coverage.v1",
  generated_at: new Date().toISOString(),
  source_root: ROOT.replaceAll("\\", "/"),
  agreed_controlled_surface: [
    "identity",
    "persona_package_metadata",
    "lore_policy",
    "identity_response",
    "role_core",
    "interaction_policy",
    "turn_mode",
    "reference",
    "relationship",
    "pair_realization",
    "factual_relationship_authority",
  ],
  summary,
  source_hashes_sha256: sourceHashes,
  role_core_counts: roleCoreCounts,
  turn_mode_matrix: turnModeMatrix,
  direction_matrix: directionMatrix,
  entries,
};

fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const lines = [
  "# Rana R3 Persona Configuration Coverage — 2026-09-29",
  "",
  "Generated from the current working tree. The JSON file is the canonical machine-readable audit artifact.",
  "",
  "## Coverage summary",
  "",
  `- Configuration inventory rows: ${summary.configuration_inventory_count}`,
  `- PASS: ${summary.covered_count}`,
  `- FAIL: ${summary.fail_count}`,
  `- NOT_COVERED: ${summary.not_covered_count}`,
  `- NOT_APPLICABLE: ${summary.not_applicable_count}`,
  `- Directed relationships: ${summary.directed_relationships}/20`,
  `- Explicit R3 pair realizations: ${summary.explicit_pair_realizations}/20`,
  `- Generic fallbacks on MyGO directed pairs: ${summary.fallback_pair_realizations}`,
  `- Turn modes: ${summary.turn_modes}/14`,
  `- Reference records: ${summary.reference_records}/20`,
  `- Relationship records: ${summary.relationship_records}/20`,
  `- Factual relationship authority records: ${summary.factual_relationship_authority_records}/20`,
  `- roleCore.responseMechanism bullets: ${summary.role_core_response_mechanism_items}`,
  `- roleCore.assistantLeakAvoid bullets: ${summary.role_core_assistant_leak_avoid_items}`,
  "",
  "## 20-direction matrix",
  "",
  "| Active | Target | Preferred reference | Pair profile | Factual authority | Fallback |",
  "|---|---|---|---|---|---|",
  ...directionMatrix.map((row) => `| ${row.active_persona} | ${row.target_persona} | ${row.reference?.preferredReference || "—"} | ${row.pair_realization.profile || "—"} | ${row.factual_authority?.recognitionLevel || "MISSING"} | ${row.pair_realization.fallback ? "YES" : "NO"} |`),
  "",
  "## Turn modes",
  "",
  "| Persona | Mode | Keywords | Fact authority |",
  "|---|---|---|---|",
  ...turnModeMatrix.map((row) => `| ${row.persona} | ${row.id} | ${(row.keywords || []).join(" / ")} | ${row.fact_authority} |`),
  "",
  "## RoleCore inventory",
  "",
  "| Persona | responseMechanism | assistantLeakAvoid | stopRule | knowledgeBoundary |",
  "|---|---:|---:|---:|---:|",
  ...PERSONA_IDS.map((id) => {
    const row = roleCoreCounts[id];
    return `| ${id} | ${row.responseMechanism} | ${row.assistantLeakAvoid} | ${row.stopRule} | ${row.knowledgeBoundary} |`;
  }),
  "",
  "## Validation boundary",
  "",
  "- Reference identity, factual relationship authority, and realization modulation are tracked as separate surfaces.",
  "- Persona delivery and pair profiles have no factual assertion authority.",
  "- identityResponse is scoped to identity turns; roleCore.knowledgeBoundary is suppressed on stable-profile turns to preserve aspect-scoped profile authority.",
  "- Production replay case IDs are assigned in the JSON; production acceptance remains separate from source/test coverage.",
  "",
  `Machine-readable report: ${rel(OUTPUT_JSON)}`,
];
fs.writeFileSync(OUTPUT_MD, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify({ output_json: OUTPUT_JSON, output_md: OUTPUT_MD, summary }, null, 2));

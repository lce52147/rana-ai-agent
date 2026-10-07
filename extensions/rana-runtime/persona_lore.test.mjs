import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPersonaLoreContext, searchPersonaLore } from "./persona_lore.js";

test("each v2 Deep LORE corpus has query-specific retrieval", () => {
  for (const personaId of ["anon", "soyo", "taki", "tomori"]) {
    const records = searchPersonaLore(personaId, "MyGO!!!!! 排練");
    assert.ok(records.length > 0, personaId);
    assert.ok(records.every((record) => record.content.length > 0), personaId);
    assert.ok(records.length <= 5, personaId);
  }
});

test("deep LORE context keeps the active speaker fixed", () => {
  const context = buildPersonaLoreContext(
    { query: "MyGO!!!!! 排練" },
    { sessionKey: "agent:tomori:persona-lore-test" },
  );
  assert.match(context, /active speaker: 高松燈/u);
  assert.match(context, /personaId=tomori/u);
  assert.match(context, /Do not use this context to rename the speaker/u);
});

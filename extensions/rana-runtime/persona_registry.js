const PERSONAS = {
  rana: {
    personaId: "rana",
    botId: "rana",
    agentId: "main",
    accountId: "default",
    canonicalName: "要樂奈",
    shortName: "樂奈",
    aliases: ["Rana", "樂奈", "要樂奈", "らーな"],
    pronoun: "她",
    canonicalEntityId: "bangdream.character.rana_kaname",
    stableProfile: Object.freeze({
      band: "MyGO!!!!!",
      role: "吉他手",
      school: "花咲川女子學園 中學部",
      gradeClass: "三年 A 班",
      birthday: "2 月 22 日",
    }),
    workspace: "C:\\Users\\Administrator\\.openclaw\\workspace",
    sourceOfTruth: "workspace/LORE/runtime/06_Rana_Character_Impressions.json",
    relationshipNamespace: "rana",
  },
  tomori: {
    personaId: "tomori",
    botId: "tomori",
    agentId: "tomori",
    accountId: "tomori",
    canonicalName: "高松燈",
    shortName: "燈",
    aliases: ["Tomori", "燈", "高松燈", "Tomorin", "ともり", "ともりん", "燈ちゃん"],
    pronoun: "她",
    canonicalEntityId: "bangdream.character.tomori",
    stableProfile: Object.freeze({
      band: "MyGO!!!!!",
      role: "主唱",
      school: "羽丘女子學園 高中",
      gradeClass: "一年 A 班",
      birthday: "11 月 22 日",
    }),
    workspace: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\tomori",
    sourceOfTruth: "workspace-bots/tomori",
    relationshipNamespace: "tomori",
  },
  anon: {
    personaId: "anon",
    botId: "anon",
    agentId: "anon",
    accountId: "anon",
    canonicalName: "千早愛音",
    shortName: "愛音",
    aliases: ["Anon", "愛音", "千早愛音", "愛音ちゃん", "あのん", "Ano-chan"],
    pronoun: "她",
    canonicalEntityId: "bangdream.character.anon",
    stableProfile: Object.freeze({
      band: "MyGO!!!!!",
      role: "吉他手",
      school: "羽丘女子學園 高中",
      gradeClass: "一年 A 班",
      birthday: "9 月 8 日",
    }),
    workspace: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\anon",
    sourceOfTruth: "workspace-bots/anon",
    relationshipNamespace: "anon",
  },
  soyo: {
    personaId: "soyo",
    botId: "soyo",
    agentId: "soyo",
    accountId: "soyo",
    canonicalName: "長崎爽世",
    shortName: "爽世",
    aliases: ["Soyo", "爽世", "長崎爽世", "Soyorin", "Soyo-rin", "そよ", "そよりん"],
    pronoun: "她",
    canonicalEntityId: "bangdream.character.soyo",
    stableProfile: Object.freeze({
      band: "MyGO!!!!!",
      role: "貝斯手",
      school: "月之森女子學園 高中",
      gradeClass: "一年 A 班",
      birthday: "5 月 27 日",
    }),
    workspace: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\soyo",
    sourceOfTruth: "workspace-bots/soyo",
    relationshipNamespace: "soyo",
  },
  taki: {
    personaId: "taki",
    botId: "taki",
    agentId: "taki",
    accountId: "taki",
    canonicalName: "椎名立希",
    shortName: "立希",
    aliases: ["Taki", "立希", "椎名立希", "Rikki", "りっきー", "立希ちゃん"],
    pronoun: "她",
    canonicalEntityId: "bangdream.character.taki",
    stableProfile: Object.freeze({
      band: "MyGO!!!!!",
      role: "鼓手",
      school: "花咲川女子學園 高中",
      gradeClass: "一年 B 班",
      birthday: "8 月 9 日",
    }),
    workspace: "C:\\Users\\Administrator\\.openclaw\\workspace-bots\\taki",
    sourceOfTruth: "workspace-bots/taki",
    relationshipNamespace: "taki",
  },
};

const ACCOUNT_TO_PERSONA = Object.freeze(Object.fromEntries(
  Object.values(PERSONAS).map((profile) => [profile.accountId, profile.personaId]),
));
// An agent id resolves to its own persona only. Rana's OpenClaw agent id is
// "main"; the literal persona id "rana" is accepted as an explicit alias for
// the same persona (never as a fallback for unknown ids).
const AGENT_TO_PERSONA = Object.freeze(Object.fromEntries(
  Object.values(PERSONAS).flatMap((profile) => [
    [profile.agentId, profile.personaId],
    [profile.personaId, profile.personaId],
  ]),
));

export const PERSONA_REGISTRY = Object.freeze(PERSONAS);
export const PERSONA_IDS = Object.freeze(Object.keys(PERSONAS));
export const MYGO_PERSONA_IDS = Object.freeze(["rana", "taki", "tomori", "anon", "soyo"]);

export function personaForAccount(accountId) {
  return ACCOUNT_TO_PERSONA[String(accountId || "").trim()] || null;
}

export function personaForAgent(agentId) {
  return AGENT_TO_PERSONA[String(agentId || "").trim()] || null;
}

export function getPersonaProfile(personaId) {
  return PERSONAS[String(personaId || "").trim()] || null;
}

export function isKnownPersonaId(value) {
  return PERSONA_IDS.includes(String(value || "").trim());
}

export function personaAliases(personaId) {
  const profile = getPersonaProfile(personaId);
  return profile ? [...profile.aliases] : [];
}

export function stablePersonaProfile(personaId) {
  const profile = getPersonaProfile(personaId);
  if (!profile) return null;
  return {
    personaId: profile.personaId,
    canonicalName: profile.canonicalName,
    canonicalEntityId: profile.canonicalEntityId,
    ...profile.stableProfile,
  };
}

export function stableMygoProfiles() {
  return MYGO_PERSONA_IDS.map((personaId) => stablePersonaProfile(personaId)).filter(Boolean);
}

export const __test = { ACCOUNT_TO_PERSONA, AGENT_TO_PERSONA, getPersonaProfile, personaForAccount, personaForAgent };

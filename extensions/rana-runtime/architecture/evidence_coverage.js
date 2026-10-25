/**
 * Evidence coverage 2.1.0 — subject/aspect + entity-alias semantics.
 * Decides coverage only; never generates or rewrites an answer.
 */

import { getPersonaProfile, isKnownPersonaId } from "../persona_registry.js";

const IGNORED_KEYS_RE = /^(?:query|prompt|currentUser|status|ok|success|tool|provider|metadata|type|intent|query_plan|latency_ms|namespace|schemaVersion|generatedAt)$/iu;

export function evidenceText(value, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try { return evidenceText(JSON.parse(text), depth + 1); } catch { /* plain text */ }
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => evidenceText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";

  const preferred = [
    "content", "text", "facts", "structured_facts", "relationship_evidence",
    "knowledge_boundaries", "retrieved_evidence", "supporting_evidence", "source_evidence",
    "allowedKnowledge", "memoryAnchors", "resolved_entities", "entity_bindings",
  ];
  const parts = [];
  let usedPreferred = false;
  for (const key of preferred) {
    if (!(key in value)) continue;
    usedPreferred = true;
    const part = evidenceText(value[key], depth + 1);
    if (part) parts.push(part);
  }
  if (usedPreferred) return parts.join("\n");

  for (const [key, item] of Object.entries(value)) {
    if (IGNORED_KEYS_RE.test(key)) continue;
    const part = evidenceText(item, depth + 1);
    if (part) parts.push(part);
  }
  return parts.join("\n");
}

export function evidenceComparable(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function parseEvidenceObject(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || !((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function meaningfulSubject(plan = {}) {
  const value = String(plan?.subject?.name || "").trim();
  if (!value || /^(?:self|user|self_group)$/u.test(value)) return "";
  return value;
}

function activePersonaSubject(plan = {}) {
  const type = String(plan?.subject?.type || "").trim();
  const name = String(plan?.subject?.name || "").trim();
  if (!["active_persona", "active_persona_group"].includes(type) || !/^(?:self|self_group)$/u.test(name)) return "";
  const personaId = String(plan?.personaId || "").trim();
  if (!isKnownPersonaId(personaId)) return "";
  return String(getPersonaProfile(personaId)?.canonicalName || "").trim();
}

function activePersonaAliasGroup(plan = {}) {
  const type = String(plan?.subject?.type || "").trim();
  const name = String(plan?.subject?.name || "").trim();
  if (!["active_persona", "active_persona_group"].includes(type) || !/^(?:self|self_group)$/u.test(name)) return [];
  const personaId = String(plan?.personaId || "").trim();
  if (!isKnownPersonaId(personaId)) return [];
  const profile = getPersonaProfile(personaId);
  return [...new Set([
    profile?.canonicalName,
    profile?.shortName,
    ...(Array.isArray(profile?.aliases) ? profile.aliases : []),
    profile?.canonicalEntityId,
  ].map((item) => String(item || "").trim()).filter(Boolean))];
}

function requestedAnchors(plan = {}) {
  const anchors = Array.isArray(plan?.evidence?.anchors)
    ? plan.evidence.anchors.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const subject = meaningfulSubject(plan);
  if (!anchors.length && subject) anchors.push(subject);
  const activePersona = activePersonaSubject(plan);
  if (!anchors.length && activePersona) anchors.push(activePersona);
  return [...new Set(anchors)];
}

function requestedPredicateAnchors(plan = {}) {
  const values = Array.isArray(plan?.evidence?.predicateAnchors)
    ? plan.evidence.predicateAnchors
    : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function evidenceUnits(rawEvidence) {
  const root = parseEvidenceObject(rawEvidence);
  const units = [];
  const add = (value) => {
    const text = evidenceText(value).trim();
    if (text) units.push({ text, raw: value });
  };
  if (!root || typeof root !== "object") {
    add(rawEvidence);
    return units;
  }
  if (Array.isArray(root)) {
    for (const item of root) add(item);
    return units;
  }
  const unitKeys = [
    "structured_facts", "relationship_evidence", "supporting_evidence", "retrieved_evidence",
    "source_evidence", "knowledge_boundaries", "facts",
  ];
  let found = false;
  for (const key of unitKeys) {
    const value = root[key];
    if (!value) continue;
    found = true;
    if (Array.isArray(value)) for (const item of value) add(item);
    else add(value);
  }
  if (!found) add(root);
  return units;
}

function aliasGroups(rawEvidence) {
  const root = parseEvidenceObject(rawEvidence);
  if (!root || typeof root !== "object") return [];
  const groups = [];
  const add = (...values) => {
    const group = [...new Set(values.flatMap((v) => Array.isArray(v) ? v : [v]).map((v) => String(v || "").trim()).filter(Boolean))];
    if (group.length >= 2) groups.push(group);
  };
  const walk = (value, depth = 0) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (value.canonical_name || value.matched_alias || value.aliases || value.entity_id) {
      add(value.canonical_name, value.matched_alias, value.aliases, value.entity_id);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "resolved_entities" || key === "entity_bindings" || depth < 3) walk(item, depth + 1);
    }
  };
  walk(root);
  return groups;
}

function anchorCovered(anchor, comparableText, groups) {
  const needle = evidenceComparable(anchor);
  if (!needle) return false;
  if (comparableText.includes(needle)) return true;
  for (const group of groups) {
    const comps = group.map(evidenceComparable).filter(Boolean);
    if (!comps.includes(needle)) continue;
    if (comps.some((alias) => comparableText.includes(alias))) return true;
  }
  return false;
}

const NAMED_ENTITY_ASSERTION_RE = /(?:是|為|为|指(?:的是|的)?|屬於|属于|位於|位于|經營|经营|開設|开设|關閉|关闭|成為|成为|使用|舉辦|举办|工作|打工|讓|让|frequented|frequents|status|current_use|member_of|role|identity)/iu;

function namedEntityAssertionCovered(unit, anchors, groups) {
  const raw = unit?.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const predicate = String(raw?.predicate || "").trim();
    if (predicate) return true;
  }
  if (!anchors.length) return false;
  const lines = String(unit?.text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    const comparable = evidenceComparable(line);
    const subjectHere = anchors.every((anchor) => anchorCovered(anchor, comparable, groups));
    return subjectHere && NAMED_ENTITY_ASSERTION_RE.test(line);
  });
}

function entityDefinitionCovered(unit, anchors, groups) {
  const raw = unit?.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const predicate = String(raw?.predicate || "").trim();
    if (["entity_type", "definition", "is_a"].includes(predicate)) return true;
  }
  if (!anchors.length) return false;
  const lines = String(unit?.text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    const comparable = evidenceComparable(line);
    const subjectHere = anchors.every((anchor) => anchorCovered(anchor, comparable, groups));
    return subjectHere
      && /(?:是|為|为|屬於|属于|指(?:的是|的)?)/u.test(line)
      && /(?:live\s*house|ライブハウス|展演|演出場地|場所|場地|店|空間|venue|entity[_ -]?type|live[_ -]?house)/iu.test(line);
  });
}

function aspectRegex(aspect, currentUser = "") {
  switch (String(aspect || "")) {
    case "rhythm": return /(?:節奏|拍子|節拍|拍點|鼓點|律動|速度|bpm|rhythm|timing|tempo)/iu;
    case "arrangement": return /(?:編曲|配器|聲部|arrang|instrumentation)/iu;
    case "singing": return /(?:唱|演唱|歌聲|主唱|vocal|voice|咬字|音域|換氣)/iu;
    case "performance": return /(?:彈|演奏|吉他|鼓|貝斯|鍵盤|指法|刷弦|鼓點|play|perform)/iu;
    case "character_capability": return /(?:不會|不会|會|会|能|可以|彈的是|弹的是|吉他手|貝斯手|贝斯手|鼓手|鍵盤手|键盘手|guitarist|bassist|drummer|keyboardist|play|perform)/iu;
    case "place_type": return /(?:live\s*house|ライブハウス|展演|演出場地|場所|場地|店|空間|venue)/iu;
    case "person_identity": return /(?:(?:姓名|名字|本名)\s*[:：=]\s*[\p{Script=Han}A-Za-z·・]{2,32}|(?:名叫|叫做|叫)\s*[\p{Script=Han}A-Za-z·・]{2,32}|(?:canonicalName|full[_ -]?name)\s*[:=]\s*["']?[\p{Script=Han}A-Za-z·・]{2,32})/iu;
    case "relationship": return /(?:關係|認識|朋友|團員|同伴|互動|信任|衝突|照顧|在意|熟悉|稱呼|称呼|叫|看穿|拉回|安慰|陪伴|幫忙|帮忙|幫助|帮助|recogniz|interact|relationship|trust|member|associated|family_relation|worked_with|performed_live_with|rehearsed)/iu;
    case "event_ownership": return /(?:event[_ -]?ownership|linked_identity_event_ownership|exchanged_names_with|交換名字|交换名字|followed_to|跟著|跟随|watched_cats_with|說過話|说过话|聊過|聊过|見過|见过|遇到|變熟|变熟)/iu;
    case "relationship_stance": return /(?:喜歡|喜欢|討厭|讨厌|反感|在意|重視|重视|偏好|最愛|最爱|想要|想試|想试|嫌|接受|信任|依賴|依赖|照顧|照顾|保護|保护|關心|关心|佩服|認可|认可|欣賞|欣赏|敬重|尊重|不耐|合作|鬥嘴|斗嘴|偏心|熟悉|執著|执着|負面反應|负面反应|重要|特別|特别|不是普通|(?:覺得|觉得|認為|认为|評價|评价)[^\n]{0,36}(?:好|差|強|强|弱|厲害|厉害|有趣|無聊|无聊|可愛|可爱|可靠|認真|认真|努力|溫柔|温柔|麻煩|麻烦|固執|固执|可怕|值得信任|討厭|讨厌|喜歡|喜欢))/iu;
    case "character_profile": return /(?:(?:覺得|觉得|認為|认为|評價|评价|形容|印象|性格|個性|个性|嫌)[^\n]{0,120}|(?:是|算是)[^\n]{0,80}(?:的人|角色))/iu;
    case "identity_relation": return /(?:identity[ _-]?link|linked_identity_distinct_state_or_persona|同一個人|同一个人|同一人|不同(?:狀態|状态|人格)|人格|persona|state)/iu;
    case "object_provenance": return /(?:來源|來歷|哪裡|哪家|買|撿|拿到|得到|找到|取得|留|放|送|source|provenance)/iu;
    case "autobiographical_experience": return /(?:第一次|最初|當初|小時候|以前|看過|會看|玩過|會玩|追過|會追|聽過|會聽|讀過|會讀|用過|會用|去過|吃過|喝過|參加過|彈過|唱過|經過|經歷|開始|拿到|得到|入手|習慣)/iu;
    case "subjective_stance": return /(?:喜歡|討厭|反感|在意|不想|想要|感受|情緒|衝擊|哭|離開|擅自|演奏|表演|回憶|關係|事件)/iu;
    case "preference": return /(?:喜歡\s*[:：／/]|喜欢\s*[:：／/]|不喜歡\s*[:：]|不喜欢\s*[:：]|討厭\s*[:：]|讨厌\s*[:：]|興趣\s*[:：]|兴趣\s*[:：]|喜歡／不喜歡|喜欢／不喜欢|(?:角色設定|角色设定|profile)[^\n]{0,32}(?:喜歡|喜欢|興趣|兴趣)|(?:喜歡|喜欢|偏好|最愛|最爱)[^\n]{0,40}(?:吉他手|鼓手|貝斯手|贝斯手|歌手|主唱|樂手|乐手|樂團|乐团|團|团|吉他|琴))/iu;
    case "language_capability": return /(?:(?:會|会|能|可以|使用|說|说|讀|读|寫|写|流利|母語|母语)[^\n]{0,20}(?:日文|日本語|日语|英文|英語|英语|中文|華語|华语|國語|国语|韓文|韩文|韓語|韩语|法文|法語|法语|德文|德語|德语|西班牙文|西班牙語|西班牙语)|(?:日文|日本語|日语|英文|英語|英语|中文|華語|华语|國語|国语|韓文|韩文|韓語|韩语|法文|法語|法语|德文|德語|德语|西班牙文|西班牙語|西班牙语)[^\n]{0,20}(?:會|会|能|可以|使用|說|说|讀|读|寫|写|流利|母語|母语))/iu;
    case "auditory_capability": return /(?:絕對音感|绝对音感|相對音感|相对音感)[^\n]{0,24}(?:有|具備|具备|會|会|能|能力)|(?:有|具備|具备|會|会|能)[^\n]{0,24}(?:絕對音感|绝对音感|相對音感|相对音感)/iu;
    case "practice_duration": return /(?:練|练|練習|练习)[^\n]{0,36}(?:每天|每日|一天|每週|每周|小時|小时|分鐘|分钟|多久|時長|时长|時間|时间)[^\n]{0,24}(?:\d+(?:\.\d+)?|一|二|兩|两|三|四|五|六|七|八|九|十|半)|(?:每天|每日|一天|每週|每周)[^\n]{0,24}(?:練|练|練習|练习)[^\n]{0,24}(?:\d+(?:\.\d+)?|一|二|兩|两|三|四|五|六|七|八|九|十|半)/iu;
    case "performance_repertoire": return /(?:(?:彈過|弹过|演奏過|演奏过|唱過|唱过|演奏|perform(?:ed)?|played)[^\n]{0,80}(?:《[^》]{1,80}》|「[^」]{1,80}」|『[^』]{1,80}』)|(?:《[^》]{1,80}》|「[^」]{1,80}」|『[^』]{1,80}』)[^\n]{0,80}(?:彈過|弹过|演奏過|演奏过|唱過|唱过|演奏|perform(?:ed)?|played))/iu;
    case "performance_skill_opinion": return /(?:(?:評價|评价|覺得|觉得|認為|认为|給|给|評分|评分)[^\n]{0,40}(?:吉他|演奏|唱歌|歌聲|歌声|鼓|貝斯|贝斯)[^\n]{0,40}(?:強|强|厲害|厉害|好|差|弱|上手|下手|\d+\s*分)|(?:吉他|演奏|唱歌|歌聲|歌声|鼓|貝斯|贝斯)[^\n]{0,40}(?:強|强|厲害|厉害|好|差|弱|上手|下手|\d+\s*分))/iu;
    case "group_place_activity": return /(?:練習|练习|排練|排练|練團|练团|演出|live|活動|活动|activity|rehears|perform)/iu;
    case "current_activity_place": return /(?:(?:現在|目前|平常|通常|主要|current)[^\n]{0,48}(?:練習|练习|排練|排练|練團|练团|演出|live|活動|活动|activity|rehears|perform)|(?:練習|练习|排練|排练|練團|练团|演出|live|活動|活动|activity|rehears|perform)[^\n]{0,48}(?:現在|目前|平常|通常|主要|current))/iu;
    case "historical_place_relation": return /(?:(?:以前|過去|过去|曾經|曾经|小時候|小时候|past)[^\n]{0,40}(?:常去|去過|去过|待過|待过|待在|frequented|visited)|(?:常去|去過|去过|待過|待过|待在|frequented|visited)[^\n]{0,40}(?:以前|過去|过去|曾經|曾经|小時候|小时候|past)|\bfrequented\b)/iu;
    case "event_verification": {
      const words = ["吵架", "爭吵", "衝突", "加入", "離開", "解散", "發生", "參加", "演出", "比賽", "排練", "練團", "練習", "練歌", "錄音"].filter((word) => String(currentUser || "").includes(word));
      return words.length ? new RegExp(`(?:${words.join("|")})`, "u") : /(?:事件|發生|參加|演出|離開|加入|衝突|解散|排練|練團|練習|練歌|錄音)/u;
    }
    default: return null;
  }
}

function curatedCharacterImpressionAspectCovered(unit, aspect) {
  const raw = unit?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!["character_profile", "relationship_stance"].includes(String(aspect || ""))) return false;
  const source = String(raw?.source || "").replace(/\\/gu, "/");
  return /^runtime\/character_impressions\/06_.*_Character_Impressions\.json$/iu.test(source);
}

export function evaluateEvidenceCoverage(plan = {}, rawEvidence = "", currentUser = "") {
  const text = evidenceText(rawEvidence).trim();
  const base = {
    supported: false,
    subjectCoverage: false,
    aspectCoverage: false,
    predicateAnchorCoverage: false,
    matchedAnchors: [],
    matchedPredicateAnchors: [],
    requiredAnchors: requestedAnchors(plan),
    requiredPredicateAnchors: requestedPredicateAnchors(plan),
    requestedAspect: String(plan?.evidence?.requestedAspect || plan?.predicate || "fact"),
    reason: "",
  };
  if (!text) return { ...base, reason: "empty_evidence" };
  if (!plan?.evidence?.required || plan?.evidence?.source !== "persona_canonical") {
    return { ...base, supported: true, subjectCoverage: true, aspectCoverage: true, predicateAnchorCoverage: true, reason: "coverage_not_required_for_source" };
  }

  const aliases = aliasGroups(rawEvidence);
  const activePersonaAliases = activePersonaAliasGroup(plan);
  if (activePersonaAliases.length >= 2) aliases.push(activePersonaAliases);
  const anchors = base.requiredAnchors;
  const predicateAnchors = base.requiredPredicateAnchors;
  const requiredHitCount = anchors.length >= 2 ? Math.min(2, anchors.length) : anchors.length;
  const unresolvedCanonicalSubject = plan?.subject?.type === "unresolved" && plan?.evidence?.source === "persona_canonical";
  const unanchoredCanonicalFact = plan?.evidence?.source === "persona_canonical"
    && plan?.evidence?.kind === "canonical_fact"
    && anchors.length === 0;
  const re = aspectRegex(base.requestedAspect, currentUser);
  const units = evidenceUnits(rawEvidence);
  const namedEntityFact = plan?.evidence?.kind === "canonical_fact"
    && String(plan?.utteranceAct?.activity || "") === "named_entity_fact";

  let anySubject = false;
  let anyAspect = false;
  let anyPredicateAnchor = predicateAnchors.length === 0;
  const globalMatchedAnchors = new Set();
  const globalMatchedPredicateAnchors = new Set();
  let atomicSupported = false;

  for (const unit of units) {
    const comparable = evidenceComparable(unit.text);
    const unitMatchedAnchors = anchors.filter((anchor) => anchorCovered(anchor, comparable, aliases));
    const unitMatchedPredicateAnchors = predicateAnchors.filter((anchor) => anchorCovered(anchor, comparable, aliases));
    unitMatchedAnchors.forEach((item) => globalMatchedAnchors.add(item));
    unitMatchedPredicateAnchors.forEach((item) => globalMatchedPredicateAnchors.add(item));

    const unitSubjectCoverage = !unresolvedCanonicalSubject
      && !unanchoredCanonicalFact
      && (anchors.length === 0 || unitMatchedAnchors.length >= requiredHitCount);
    const unitPredicateAnchorCoverage = predicateAnchors.length === 0
      || unitMatchedPredicateAnchors.length === predicateAnchors.length;
    const unitAspectCoverage = namedEntityFact && base.requestedAspect === "entity_definition"
      ? entityDefinitionCovered(unit, anchors, aliases)
      : namedEntityFact
        ? namedEntityAssertionCovered(unit, anchors, aliases)
      : curatedCharacterImpressionAspectCovered(unit, base.requestedAspect)
        || (!re || re.test(unit.text));

    anySubject ||= unitSubjectCoverage;
    anyPredicateAnchor ||= unitPredicateAnchorCoverage;
    anyAspect ||= unitAspectCoverage;
    if (unitSubjectCoverage && unitPredicateAnchorCoverage && unitAspectCoverage) {
      atomicSupported = true;
      break;
    }
  }

  return {
    ...base,
    supported: atomicSupported,
    subjectCoverage: anySubject,
    predicateAnchorCoverage: anyPredicateAnchor,
    aspectCoverage: anyAspect,
    matchedAnchors: [...globalMatchedAnchors],
    matchedPredicateAnchors: [...globalMatchedPredicateAnchors],
    reason: atomicSupported
      ? "covered_atomic"
      : !anySubject
        ? "subject_not_covered"
        : !anyPredicateAnchor
          ? "predicate_anchor_not_covered"
          : !anyAspect
            ? "aspect_not_covered"
            : "subject_aspect_not_co_located",
  };
}

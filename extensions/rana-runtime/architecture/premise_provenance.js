/**
 * Current-turn premise provenance 2.1.0 — clause provenance authority
 *
 * User-supplied third-party events/reports are valid conversation premises,
 * but they are not Persona memory/evidence. This module detects only clear
 * provenance escalation in a generated candidate. It never writes or rewrites
 * an answer and deliberately leaves ordinary immediate reactions alone.
 */

const PAST_OR_COMPLETED_TIME_RE = /(?:昨天|前天|剛剛|剛才|上次|那次|那天|上週|上周|以前|之前|當時|已經|曾經)/u;
const COMPLETED_EVENT_RE = /(?:去(?:了|過)|來(?:了|過)|跑去(?:了)?|練(?:習|團|琴)?(?:了|過)|唱(?:了|過)|彈(?:了|過)|做(?:了|過)|參加(?:了|過)|遇到(?:了)?|見到(?:了)?|待過|買了|吃了|喝了)/u;
const ASSERTIVE_EVENT_RE = /(?:確實|真的|其實|本來)[^。！？!?]{0,28}(?:有去|去(?:了|過)|跑去|跟[^。！？!?]{0,16}一起|一起(?:去|練|做|唱|彈)|練(?:習|團|琴)|參加|遇到|見到|待在)/u;
const INTENTION_RE = /(?:等等|等一下|待會|待會兒|之後|現在)?\s*(?:要|想|打算|準備|會去|去看看|去問|去找|去拿|去處理)/u;
const IMPLICIT_EVENT_ASSERTION_RE = /(?:^|[。！？!?，,]\s*)(?:不是|其實不是|其實|只是)[^。！？!?]{0,28}(?:跑去(?:了)?|去(?:了|過)|有去|跟[^。！？!?]{0,16}一起(?:去|練|做|唱|彈)?|一起(?:去|練|做|唱|彈)|練(?:習|團|琴)(?:了|過)?|參加(?:了|過)?|遇到(?:了)?|見到(?:了)?|待在)/u;
const MEMORY_LAUNDERING_RE = /我(?:記得|知道|想起|還記得)[^。！？!?]{0,48}(?:昨天|今天|剛剛|剛才|上次|那次|那天|當時|以前|之前|上週|上周)/u;
const THIRD_PARTY_MIND_FREQUENCY_RE = /(?:她|他|對方|那個人)[^。！？!?]{0,20}(?:總是|每次|一直|老是|向來|早就)[^。！？!?]{0,32}(?:覺得|認為|想|討厭|喜歡|在意|以為|打算)/u;
const UNFRAMED_FREQUENCY_RE = /(?:她|他|對方|那個人)[^。！？!?]{0,24}(?:總是|每次|老是|向來)[^。！？!?]{0,40}/u;
const REPORT_FRAME_RE = /(?:她|他|對方|那個人|\S{1,12})(?:剛剛|剛才|之前|又|一直)?(?:說|表示|提到|講|告訴|跟我說|轉告|傳話|聲稱|抱怨|說過)/u;
const SELF_REPORTED_MEMORY_CONFIRM_RE = /^(?:啊[！!，,\s]*)?(?:對(?:啦|啊|呀|耶)?|沒錯|是啊|嗯[，,\s]*對|確實|真的)(?:[，,。！!\s]|$)/u;
const FIRST_PERSON_HABIT_CONFIRM_RE = /(?:^|[。！？!?，,]\s*)(?:但|不過|可是|其實|嗯|啊|對)?\s*我[^。！？!?]{0,20}(?:確實|确实|的確|的确|真的|有時(?:候)?|有时(?:候)?|常常|經常|经常|老是|總是|总是|每次|一直|最近)[^。！？!?]{0,56}(?:會|会|都|有|在|說|说|講|讲|罵|骂|做|練|练|練習|练习|排練|排练|彈|弹|唱|去|跑|待|弄|管|催|唸|念)/u;
const FIRST_PERSON_FREQUENCY_CONFIRM_RE = /(?:^|[。！？!?，,]\s*)(?:但|不過|可是|其實)?\s*我[^。！？!?]{0,16}(?:有時(?:候)?|有时(?:候)?|常常|經常|经常|老是|總是|总是|每次|一直|向來|向来)[^。！？!?]{1,72}/u;
const FIRST_PERSON_DISPOSITION_CONFIRM_RE = /(?:^|[。！？!?，,]\s*)(?:但|不過|不过|可是|其實|其实|嗯)?\s*我[^。！？!?]{0,8}(?:會|会|有在)[^。！？!?]{0,44}(?:幫|帮|替|收|整理|做|管|催|叫|喊|練|练|排練|排练|偷懶|偷懒|拿|帶|带|去|說|说|講|讲)[^。！？!?]{0,36}/u;
const SELF_HABIT_CAUSAL_CONFIRM_RE = /(?:^|[。！？!?，,]\s*)[^。！？!?]{0,40}(?:所以|才會|才会|忍不住)[^。！？!?]{0,28}(?:這麼|这么)?(?:叫|做|去|拿|說|说|講|讲|罵|骂|練|练|偷懶|偷懒)[^。！？!?]{0,36}/u;
const RECENT_SELF_RATIONALIZATION_RE = /(?:^|[。！？!?，,]\s*)(?:不過|不过|但|可是|說真的|说真的|其實|其实)?[^。！？!?]{0,12}(?:最近|剛剛|刚刚|剛才|刚才|今天)[^。！？!?]{0,28}(?:確實|确实|的確|的确|真的|有點|有点|很)?[^。！？!?]{0,18}(?:累|忙|練習|练习|排練|排练|偷懶|偷懒|休息|生氣|生气|緊張|紧张)[^。！？!?]{0,36}/u;
const ALLEGATION_ACCEPTANCE_RE = /(?:^|[。！？!?，,]\s*)(?:但|不過|不过|可是|所以|那)?[^。！？!?]{0,24}(?:被[^。！？!?]{0,16}(?:抓到|發現|发现)|既然[^。！？!?]{0,16}(?:抓到|發現|发现))[^。！？!?]{0,36}/u;
const FIRST_PERSON_CURRENT_ASSERTION_RE = /(?:^|[。！？!?，,]\s*)我(?:們)?(?:這邊|这边)?\s*(?:正|正在|還在|还在|又在|在)(?!想|考慮|考虑|覺得|觉得|意|乎)\s*[^。！？!?]{0,24}(?:練|练|彈|弹|唱|吃|喝|睡|調|调|做|忙|待|走|去|看|聽|听|寫|写|弄|準備|准备|整理|處理|处理|聊天|說|说)/u;


function firstPersonCompletedAssertion(text) {
  const sentences = String(text || "").split(/[。！？!?]/u).map((part) => part.trim()).filter(Boolean);
  for (const sentence of sentences) {
    // Inspect local clauses so「不知道，不過我昨天確實去了」cannot hide
    // the assertion behind a discourse marker. A clause that only repeats a
    // third-party report such as「愛音說我昨天去了」remains allowed.
    const clauses = sentence
      .split(/[，,]/u)
      .flatMap((part) => part.split(/(?=(?:但|不過|可是|只是|其實)我)/u))
      .map((part) => part.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (!/(?:^|(?:但|不過|可是|只是|其實))我/u.test(clause)) continue;
      if (REPORT_FRAME_RE.test(clause) && !/(?:但|不過|可是|只是|其實)我/u.test(clause)) continue;
      // Keep a newly-formed immediate intention such as「那我去拿回來」valid.
      if (INTENTION_RE.test(clause) && !COMPLETED_EVENT_RE.test(clause)) continue;
      const hasPastTime = PAST_OR_COMPLETED_TIME_RE.test(clause);
      const hasCompletedEvent = COMPLETED_EVENT_RE.test(clause);
      const hasAssertiveEvent = ASSERTIVE_EVENT_RE.test(clause);
      if ((hasPastTime && /(?:有去|去(?:了|過)|來(?:了|過)|跑去(?:了)?|跟[^，,]{0,16}一起|一起(?:去|練|做|唱|彈)|練(?:習|團|琴)?(?:了|過)?|唱(?:了|過)|彈(?:了|過)|做(?:了|過)|參加(?:了|過)?|遇到(?:了)?|見到(?:了)?|待在|待過|買了|吃了|喝了)/u.test(clause)) || hasCompletedEvent || hasAssertiveEvent) {
        return true;
      }
    }
  }
  return false;
}

function unframedFrequencyAssertion(text) {
  if (!UNFRAMED_FREQUENCY_RE.test(text)) return false;
  // 「她說我每次都這樣」is still framed as the report itself, not a new
  // Persona claim. Do not reject it solely for repeating the user's report.
  if (REPORT_FRAME_RE.test(text)) return false;
  return true;
}

export function premisePlanNeedsProtection(plan = {}) {
  if (plan?.action?.requested || plan?.lane === "ACTION") return false;
  const premises = Array.isArray(plan?.premises) ? plan.premises : [];
  return premises.some((item) => {
    const certainty = String(item?.certainty || "");
    return [
      "asserted_by_user",
      "reported_by_user",
      "alleged_by_user",
      "inferred_by_user",
      "question_presupposition",
    ].includes(certainty);
  });
}

function premiseCertainties(plan = {}) {
  return new Set((Array.isArray(plan?.premises) ? plan.premises : [])
    .map((item) => String(item?.certainty || ""))
    .filter(Boolean));
}

export function evaluatePremiseProvenance(plan = {}, candidate = "") {
  const text = String(candidate || "").trim();
  const certainties = premiseCertainties(plan);
  const tags = new Set(Array.isArray(plan?.sceneTags) ? plan.sceneTags : []);
  const thirdPartyProtected = certainties.has("reported_by_user") || tags.has("third_party_premise");
  const selfReportedProtected = certainties.has("alleged_by_user") || tags.has("self_reported_past_premise");
  const inferenceProtected = certainties.has("inferred_by_user");
  const assertionProtected = certainties.has("asserted_by_user") || certainties.has("question_presupposition");
  const protectedTurn = premisePlanNeedsProtection(plan);
  const base = { protected: protectedTurn, violates: false, reason: protectedTurn ? "within_premise_provenance" : "not_protected" };

  if (!protectedTurn) return base;
  if (!text) return { ...base, reason: "empty_candidate" };
  if (selfReportedProtected && SELF_REPORTED_MEMORY_CONFIRM_RE.test(text)) {
    return { ...base, violates: true, reason: "self_reported_memory_confirmation" };
  }
  if (firstPersonCompletedAssertion(text)) return { ...base, violates: true, reason: "self_event_assertion" };
  if (assertionProtected && FIRST_PERSON_CURRENT_ASSERTION_RE.test(text)) return { ...base, violates: true, reason: "unsupported_current_self_event" };
  if ((thirdPartyProtected || inferenceProtected) && (FIRST_PERSON_HABIT_CONFIRM_RE.test(text) || FIRST_PERSON_FREQUENCY_CONFIRM_RE.test(text) || FIRST_PERSON_DISPOSITION_CONFIRM_RE.test(text) || SELF_HABIT_CAUSAL_CONFIRM_RE.test(text))) {
    return { ...base, violates: true, reason: "first_person_habit_confirmation" };
  }
  if ((thirdPartyProtected || inferenceProtected) && RECENT_SELF_RATIONALIZATION_RE.test(text)) {
    return { ...base, violates: true, reason: "recent_self_rationalization" };
  }
  if ((thirdPartyProtected || inferenceProtected) && ALLEGATION_ACCEPTANCE_RE.test(text)) {
    return { ...base, violates: true, reason: "allegation_acceptance" };
  }
  if (IMPLICIT_EVENT_ASSERTION_RE.test(text)) return { ...base, violates: true, reason: "implicit_event_assertion" };
  if (MEMORY_LAUNDERING_RE.test(text)) return { ...base, violates: true, reason: "memory_laundering" };
  if ((thirdPartyProtected || inferenceProtected) && THIRD_PARTY_MIND_FREQUENCY_RE.test(text)) return { ...base, violates: true, reason: "third_party_mind_frequency" };
  if ((thirdPartyProtected || inferenceProtected || assertionProtected) && unframedFrequencyAssertion(text)) return { ...base, violates: true, reason: "frequency_amplification" };
  return base;
}

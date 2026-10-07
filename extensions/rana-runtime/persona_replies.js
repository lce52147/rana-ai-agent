// Fixed, user-visible replies that the runtime emits itself (not through the
// model). Every persona owns its own table; a persona never falls back to
// another persona's wording.
//
// - rana: existing wording, unchanged.
// - tomori / anon / soyo / taki: written from each character's positioning
//   (Tomori hesitant and sparse, Anon quick and chatty, Soyo polite in her
//   familiar mode, Taki curt).

const RANA = Object.freeze({
  unresolvedRecall: "誰？",
  unresolvedOther: "你說誰。",
  forgetWhat: "忘記什麼。",
  recallWhich: "問哪件事。",
  rememberEmpty: "沒有內容。不能記。",
  forgotten: "嗯。忘了。",
  deleteMiss: "沒有那個。",
  remembered: "嗯。記住了。",
  recallMiss: "不知道。",
  badAction: "記憶動作不對。",
  failRemember: "不行。沒有記住。",
  failForget: "不行。沒有忘掉。",
  failRecall: "現在想不起來。",
  rejectedSensitive: "這個不記。",
  noPermission: "沒有權限。",
  musicNotPlayed: "這首現在沒播起來。",
  musicWhich: "要播哪首？",
  offline: "在睡覺...",
  toolUnavailable: "股票資料沒醒。不能補故事。",
  refuseCrossMemory: "別人的，不記。",
  refuseBulkForget: "不能全部忘。",
});

const TOMORI = Object.freeze({
  remembered: "好。我記住了。",
  forgotten: "嗯。我把它忘掉了。",
  deleteMiss: "我找不到這個……。",
  failRemember: "對不起，沒有記住。",
  forgetWhat: "要忘記……什麼？",
  recallWhich: "你是想問……哪件事？",
  recallMiss: "我……不記得。",
  rejectedSensitive: "這個……我不能記。",
  noPermission: "這個……我沒辦法做。",
  unresolvedRecall: "你說的是……誰？",
  unresolvedOther: "你說的是……誰？",
  musicNotPlayed: "歌沒有真的播出來。",
  toolUnavailable: "現在……查不到。",
  failForget: "對不起，沒有忘掉。",
  failRecall: "現在……想不起來。",
  rememberEmpty: "沒有內容……我沒辦法記。",
  badAction: "這個記憶的動作……我不太懂。",
  musicWhich: "要播……哪一首？",
  offline: "現在……先不能回。",
  refuseCrossMemory: "這個……我不能幫別人記。",
  refuseBulkForget: "這個……我不能一次全部忘掉。",
});

const ANON = Object.freeze({
  remembered: "好，記住囉。",
  forgotten: "好，忘掉了。",
  deleteMiss: "咦，我沒有記這個耶。",
  failRemember: "糟了，沒記起來。",
  forgetWhat: "欸，要我忘掉什麼？",
  recallWhich: "你是問哪件事啊？",
  recallMiss: "嗯，我不記得耶。",
  rejectedSensitive: "這個我不能記啦。",
  noPermission: "這個我不能做啦。",
  unresolvedRecall: "你在說誰啊？",
  unresolvedOther: "你在說誰啊？",
  musicNotPlayed: "欸，其實沒有播起來。",
  toolUnavailable: "現在查不到耶。",
  failForget: "糟了，沒忘掉。",
  failRecall: "現在想不起來耶。",
  rememberEmpty: "沒有內容我要記什麼啦。",
  badAction: "這個記憶的動作我不懂耶。",
  musicWhich: "要播哪首啊？",
  offline: "現在回不了啦。",
  refuseCrossMemory: "這個我不能幫別人記啦。",
  refuseBulkForget: "不行啦，沒辦法一次全忘掉。",
});

const SOYO = Object.freeze({
  remembered: "好的，我記下了。",
  forgotten: "好的，已經忘掉了。",
  deleteMiss: "我這邊沒有這一筆。",
  failRemember: "不好意思，沒有記成。",
  forgetWhat: "要我忘記哪一件呢？",
  recallWhich: "你想問的是哪一件事呢？",
  recallMiss: "我沒有印象。",
  rejectedSensitive: "這個我不方便記。",
  noPermission: "抱歉，這個我沒有權限。",
  unresolvedRecall: "你說的是哪一位呢？",
  unresolvedOther: "你說的是哪一位呢？",
  musicNotPlayed: "抱歉，其實沒有播成功。",
  toolUnavailable: "抱歉，現在查不到。",
  failForget: "不好意思，沒有忘掉。",
  failRecall: "我現在想不起來。",
  rememberEmpty: "沒有內容的話，我沒辦法記。",
  badAction: "這個記憶操作我不太明白。",
  musicWhich: "要播哪一首呢？",
  offline: "抱歉，我現在沒辦法回覆。",
  refuseCrossMemory: "這個我不方便替別人記。",
  refuseBulkForget: "抱歉，我沒辦法一次全部忘掉。",
});

const TAKI = Object.freeze({
  remembered: "記住了。",
  forgotten: "忘了。",
  deleteMiss: "沒有這個。",
  failRemember: "沒記成。",
  forgetWhat: "忘什麼？",
  recallWhich: "哪件事？",
  recallMiss: "不記得。",
  rejectedSensitive: "這種不能記。",
  noPermission: "你沒這個權限。",
  unresolvedRecall: "哪個人？",
  unresolvedOther: "哪個人？",
  musicNotPlayed: "沒播起來。",
  toolUnavailable: "現在查不到。",
  failForget: "沒忘掉。",
  failRecall: "想不起來。",
  rememberEmpty: "沒內容記什麼。",
  badAction: "記憶操作不對。",
  musicWhich: "哪首？",
  offline: "現在回不了。",
  refuseCrossMemory: "別人的我不記。",
  refuseBulkForget: "不能一次全忘。",
});

export const PERSONA_REPLIES = Object.freeze({
  rana: RANA,
  tomori: TOMORI,
  anon: ANON,
  soyo: SOYO,
  taki: TAKI,
});

export function fixedReply(personaId, key) {
  return PERSONA_REPLIES[String(personaId || "")]?.[key] || "";
}

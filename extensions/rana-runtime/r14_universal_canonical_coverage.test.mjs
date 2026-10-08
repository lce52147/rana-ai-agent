import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {buildUnifiedTurnPlan,turnPlanNeedsLore} from "./architecture/turn_plan.js";
import {buildLoreEvidencePack,loreEvidenceContext} from "./lore/retrieval.js";
import {buildPersonaLoreEvidenceProjection} from "./persona_lore.js";
import {__test as isolation} from "./architecture/turn_isolation.js";
const grammar=p=>Boolean(isolation.resolveParentheticalGrammarExtraBody(p,{modelProviderId:"llama-cpp",modelId:"OOGG"}));
const validCanon=p=>p.evidence?.required===true&&p.evidence.source==="persona_canonical"&&turnPlanNeedsLore(p);
const direction=[
"Mortis 陪著你到 SPACE 以前的場地時，究竟走在誰後面？",
"那回走去 SPACE 舊址，你和 Mortis 的前後順序是什麼？",
"當時前往 SPACE 原址的路上，是誰跟著另一個人？Mortis 嗎？",
"你帶 Mortis 接近 SPACE 舊址時，是並肩還是誰先走？",
"回想跟 Mortis 到 SPACE 附近那次，走在前頭的是誰？",
"Mortis 和你走向 SPACE 時，誰領路？",
"在 SPACE 舊址附近那段路，是 Mortis 跟你還是你跟她？",
"去 SPACE 原來的地方時，Mortis 是走前面還是後面？"];
const identity=[
"睦和 Mortis 這兩個名字指同一個身分嗎？",
"你會怎麼分辨若葉睦與 Mortis 的不同狀態？",
"Mortis 跟睦算是同一人嗎？",
"叫睦或 Mortis，到底在稱呼同一位嗎？",
"若葉睦和 Mortis 的身份有什麼差異？",
"談到睦、Mortis，這兩個稱呼是如何連在一起的？",
"你眼中的 Mortis 與睦究竟是一樣還是不同？",
"Mortis 跟若葉睦，是不同的人還是同一個人的狀態？"];
const finger=[
"Mortis 和睦的手指觸感不同在哪？",
"在睦與 Mortis 之間，指尖硬的是哪個狀態？",
"那個指頭有繭的是誰？是睦還是 Mortis？",
"你觀察過睦和 Mortis 手指上的差別嗎？",
"說到她們的指尖，是誰的指頭變硬？",
"若葉睦的指尖和 Mortis 的有什麼區別？",
"睦、Mortis 兩種狀態，誰的指尖比較硬？",
"到底是誰的手指有變硬的狀況，睦或 Mortis？"];
const literals=[
["僅回傳這段，不要換標點：a(x).txt","a(x).txt"],
["請把以下字串逐字輸出：mix(v7)_final.wav","mix(v7)_final.wav"],
["一字不差回答：note[bridge](02)","note[bridge](02)"],
["複製這個內容，別作解釋：Q3(test).json","Q3(test).json"],
["只要回覆下列文字：run(foo-bar).cmd","run(foo-bar).cmd"],
["原封不動輸出：take(13).flac","take(13).flac"],
["下面是檔名，照著抄不要修改：track(verse).m4a","track(verse).m4a"],
["回傳內容必須完全相同：part(left)(right).txt","part(left)(right).txt"]];
const listings=[
"妳平常還會和哪些人打交道？",
"你在生活中都跟哪些人接觸？",
"樂奈，你叫得出哪些熟人的名字？",
"平時跟你互動比較多的有哪些人？",
"你比較熟悉的人物有誰？",
"你記得常常碰面的那些人是誰嗎？",
"說說看你有認識哪些人物？",
"你平常有和誰往來？"];
const followups=[
"那除此之外還能想到別的人嗎？",
"另外有沒有誰？",
"還有哪些熟面孔呢？",
"除了這幾位之外還有其他名字嗎？",
"其他還有誰？",
"那沒有別的認識的人了嗎？",
"除了他們你還記得哪些人？",
"還有別的熟人能提嗎？"];
const personas=["anon","soyo","taki","tomori"];
const names={rana:"要樂奈",anon:"千早愛音",soyo:"長崎爽世",taki:"椎名立希",tomori:"高松燈"};
const all=[...personas,"rana"];
test("P-26: 24 novel paraphrases keep structured and ownership evidence",async()=>{
 for(const q of direction){const p=buildUnifiedTurnPlan(q,{personaId:"rana"});assert.ok(validCanon(p),q);const x=loreEvidenceContext(await buildLoreEvidencePack(q,{turnPlan:p,sessionKey:"R14-test-direction"}));assert.match(x,/方向事實: Mortis 跟著要樂奈/u,q);assert.equal(grammar(p),false,q);}
 for(const q of identity){const p=buildUnifiedTurnPlan(q,{personaId:"rana"});assert.ok(validCanon(p),q);const x=loreEvidenceContext(await buildLoreEvidencePack(q,{turnPlan:p,sessionKey:"R14-test-identity"}));assert.match(x,/同一個人的兩個狀態/u,q);}
 for(const q of finger){const p=buildUnifiedTurnPlan(q,{personaId:"rana"});assert.ok(validCanon(p),q);const x=loreEvidenceContext(await buildLoreEvidencePack(q,{turnPlan:p,sessionKey:"R14-test-finger"}));assert.match(x,/歸屬約束|指尖|手指/u,q);}
});
test("P-27: eight novel exact-copy instructions have exact payload and no grammar",()=>{
 for(const [q,want] of literals){const p=buildUnifiedTurnPlan(q,{personaId:"rana"});assert.equal(p.taskContract.type,"VERBATIM_OUTPUT",q);assert.equal(p.taskContract.sourceText,want,q);assert.equal(grammar(p),false,q);}
 for(const q of ["給我一個擁抱","摸摸頭","今天好累","欸，抱我一下"]){
 const p=buildUnifiedTurnPlan(q,{personaId:"rana"});assert.notEqual(p.taskContract.type,"VERBATIM_OUTPUT",q);
 }
});
test("P-28: eight first-round and eight novel bounded followups",async()=>{
 for(let i=0;i<listings.length;i++){
  const first=buildUnifiedTurnPlan(listings[i],{personaId:"rana"});
  assert.ok(validCanon(first),listings[i]);
  const x=await buildLoreEvidencePack(listings[i],{turnPlan:first,sessionKey:"R14-case-"+i});
  assert.equal(x.intent,"known_people_inventory",listings[i]);
  assert.equal(x.structured_facts.length,4,listings[i]);
  const next=buildUnifiedTurnPlan(followups[i],{personaId:"rana",previousUserText:listings[i]});
  assert.equal(next.utteranceAct.continuationMode,"known_people_inventory_followup",followups[i]);
  const y=await buildLoreEvidencePack(followups[i],{turnPlan:next,sessionKey:"R14-case-"+i});
  assert.equal(y.intent,"known_people_inventory",followups[i]);
  assert.ok(y.structured_facts.length>=4,followups[i]);
  assert.ok(y.structured_facts.some(f=>f.object==="bangdream.character.mortis"),followups[i]);
  const unrelated=buildUnifiedTurnPlan(followups[i],{personaId:"rana",previousUserText:"今天我的電腦有什麼問題？"});
  assert.notEqual(unrelated.utteranceAct?.continuationMode,"known_people_inventory_followup",followups[i]);
 }
});
test("P-29: four non-Rana Personas x four targets x two novel forms",()=>{
 for(const actor of personas){
  for(const target of all.filter(x=>x!==actor)){
   for(const q of [
    "你跟"+names[target]+"一起有過哪些具體互動？",
    "回想與"+names[target]+"共同經歷過的事情，你會挑哪一件說？"
   ]){
    const p=buildUnifiedTurnPlan(q,{personaId:actor});
    assert.ok(validCanon(p),q);
    const k=buildPersonaLoreEvidenceProjection({prompt:q},{accountId:actor,agentId:actor,sessionKey:"agent:"+actor+":discord:channel:R14-"+actor},p);
    assert.equal(k.coverage?.supported,true,actor+" "+q+" "+k.context.slice(0,250));
    assert.match(k.context,/EVIDENCE_COVERAGE=SUPPORTED/u,q);
    assert.match(k.context,/- 可確認：/u,q);
   }
  }
 }
});

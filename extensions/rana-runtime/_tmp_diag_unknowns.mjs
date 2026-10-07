import { buildUnifiedTurnPlan } from './architecture/turn_plan.js';
import { buildLoreEvidencePack } from './lore/retrieval.js';

const cases = [
  ['E1','你會彈琴嗎',{}],
  ['E2','你會彈吉他嗎',{}],
  ['F1','你認識誰',{}],
  ['F2','還有誰',{previousUserText:'你認識誰'}],
  ['D1','睦跟 Mortis 一樣嗎',{}],
  ['D2','你跟睦交換過名字嗎',{}],
  ['D3','是 Mortis 帶你去 SPACE 嗎',{}],
  ['D4','你和 Mortis 是怎麼到 SPACE 舊址附近的？',{}],
  ['D5','誰教你看聊天軟體',{}],
];
for (const [id,q,extra] of cases) {
  const plan = buildUnifiedTurnPlan(q,{personaId:'rana',...extra});
  const pack = await buildLoreEvidencePack(q,{turnPlan:plan,forceIndexUnavailable:true});
  console.log('\n###',id,q);
  console.log(JSON.stringify({
    utteranceAct: plan.utteranceAct,
    subject: plan.subject,
    evidence: plan.evidence,
    needsLore: plan.evidence?.required,
    intent: pack.intent,
    contract: pack.knowledge_contract,
    coverage: pack.evidence_coverage,
    facts: (pack.structured_facts||[]).map(f=>({factId:f.factId,subject:f.subject,predicate:f.predicate,object:f.object,qualifiers:f.qualifiers})),
    supporting: (pack.supporting_evidence||[]).map(x=>({title:x.source_title,content:x.content?.slice(0,220)})),
    resolved: pack.resolved_entities,
  },null,2));
}

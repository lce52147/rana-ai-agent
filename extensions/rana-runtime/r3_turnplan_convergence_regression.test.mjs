import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedTurnPlan } from './architecture/turn_plan.js';
const p=t=>buildUnifiedTurnPlan(t);

const lane=(t,x)=>p(t).semanticLanes.includes(x);

test('natural planning variants are USER_TASK',()=>{
 for (const t of [
  '我兩點面試，現在還沒吃也還沒換衣服，先做什麼比較好？',
  '我今晚要改完簡報、洗澡，手機睡前還要充電，怎麼排比較不會拖到十二點後？',
  '這三件事幫我排一下就好，別先講一堆有的沒的。',
  '我明天七點半要出門，現在還要洗澡、收證件、充耳機，先弄哪個？',
  '我四點要出門，現在還要洗衣服、備份電腦跟吃飯，妳幫我排一下先做哪個。'
 ]) {
   const x=p(t); assert.deepEqual(x.semanticLanes,['USER_TASK'],t); assert.equal(x.responseContract.responseFunction,'COMPLETE_USER_TASK',t);
 }
});

test('canonical work metadata never becomes report speech',()=>{
 for (const t of [
  '春日影的鼓到底有沒有資料講過是怎麼編的？',
  '碧天伴走的編曲官方有沒有資料說明？',
  '《春日影》的鼓有沒有官方資料講怎麼編？'
 ]) {
  const x=p(t); assert.equal(x.evidence.kind,'canonical_work',t); assert.equal(x.evidence.source,'persona_canonical',t); assert.deepEqual(x.semanticLanes,['CANONICAL_CHARACTER_QUERY'],t); assert.equal(x.semanticLanes.includes('THIRD_PARTY_SELF_REPORT'),false,t);
 }
});

test('explicit reports stay reports',()=>{
 for (const t of [
  '愛音說妳剛才不回她，是因為還在生氣。',
  '燈說妳剛剛自己跑出去哭了。',
  '爽世說妳最近每次練習都在罵人。',
  '愛音剛還在講你最近老是突然消失，我是沒覺得啦。'
 ]) {
  const x=p(t); assert.ok(x.semanticLanes.includes('THIRD_PARTY_SELF_REPORT'),t); assert.equal(x.responseContract.responseFunction,'ATTRIBUTE_UNVERIFIED_THIRD_PARTY_REPORT',t);
 }
});

test('non-report speech uses of 講 do not create report lane',()=>{
 for (const t of [
  '這三件事幫我排一下就好，別先講一堆有的沒的。',
  '剛剛大家聊那麼久，妳怎麼都沒講話？',
  '大家都在等妳講話欸，妳現在是不是超緊張？',
  '我今天整個人超煩，但我也不太想講為什麼。'
 ]) assert.equal(lane(t,'THIRD_PARTY_SELF_REPORT'),false,t);
});

test('weak social inference family',()=>{
 for (const t of [
  '她回我一個「哈哈」就直接換話題，我是不是太無聊了？',
  '他已讀五分鐘了還不回，我怎麼覺得是故意的啊？',
  '我就回一句「知道了」，妳就覺得我在不爽喔？',
  '我就回個「嗯」，妳是不是覺得我在生氣？',
  '我剛剛只回一個「。」而已，妳有以為我在不爽嗎？'
 ]) {
  const x=p(t); assert.deepEqual(x.semanticLanes,['WEAK_INFERENCE'],t); assert.equal(x.responseContract.responseFunction,'ANSWER_WEAK_INFERENCE_WITH_UNCERTAINTY',t);
 }
});

test('current persona state outranks generic inference/report',()=>{
 for (const t of [
  '妳今天是不是有點沒精神？感覺比平常更安靜。',
  '大家都在等妳講話欸，妳現在是不是超緊張？',
  '妳現在是不是在不爽？',
  '我就回家而已，妳現在是不是在不爽？',
  '妳現在還在 RiNG 嗎？',
  '妳今天是不是已經練三個小時了？'
 ]) {
  const x=p(t); assert.ok(x.semanticLanes.includes('CURRENT_STATE'),t); assert.equal(x.semanticLanes.includes('THIRD_PARTY_SELF_REPORT'),false,t);
 }
});

test('appearance questions use PERCEPTION boundary',()=>{
 for (const t of [
  '我換成比較正式的髮型了，妳覺得拿去面試 OK 嗎？',
  '我今天換新眼鏡了欸，妳覺得適合我嗎？',
  '我今天穿灰格紋外套配黑褲，你覺得鞋子換白的會不會比較好？'
 ]) {
  const x=p(t); assert.deepEqual(x.semanticLanes,['PERCEPTION'],t); assert.equal(x.evidence.kind,'visual_state',t); assert.equal(x.responseContract.responseFunction,'ANSWER_PERCEPTION_WITH_MEDIA_BOUNDARY',t); assert.equal(x.semanticLanes.includes('USER_IMPRESSION'),false,t);
 }
});


test('pure current object ownership remains current-state scoped',()=>{
 const x=p('欸桌上這個綠色撥片是妳的嗎？');
 assert.equal(x.utteranceAct.subtype,'CURRENT_OBJECT_QUERY');
 assert.equal(x.evidence.kind,'current_state');
 assert.deepEqual(x.semanticLanes,['CURRENT_STATE']);
});

test('object ownership/provenance is controlled evidence',()=>{
 for (const t of [
  '欸桌上這個綠色撥片是妳的嗎？哪買的啊？',
  '你桌上那顆有白線的石頭，是在哪撿到的？',
  '我剛在椅子旁撿到一片葉子，這是你留的嗎？'
 ]) {
  const x=p(t); assert.equal(x.evidence.kind,'object_provenance',t); assert.equal(x.evidence.source,'persona_canonical',t); assert.deepEqual(x.semanticLanes,['CANONICAL_CHARACTER_QUERY'],t);
 }
});

test('canonical past event stance is grounded',()=>{
 for (const t of [
  '如果有人拿妳以前在英國那件事開妳玩笑，妳真的完全不會在意喔？',
  '妳以前在英國那件事，現在還會在意嗎？'
 ]) {
  const x=p(t); assert.equal(x.evidence.kind,'autobiographical_experience',t); assert.equal(x.evidence.source,'persona_canonical',t); assert.deepEqual(x.semanticLanes,['CANONICAL_CHARACTER_QUERY'],t);
 }
});

test('caricature self-stance is not reduced to report attribution',()=>{
 for (const t of [
  '有人說妳只要場面一冷就一定會硬聊，是真的嗎？',
  '有人說妳對人好其實都只是想控制對方，妳會認喔？'
 ]) {
  const x=p(t); assert.equal(x.semanticLanes.includes('THIRD_PARTY_SELF_REPORT'),false,t); assert.equal(x.responseContract.responseFunction,'ANSWER_OPEN_PERSONA_OPINION',t);
 }
});

test('frozen controls remain',()=>{
 let x=p('幸福是什麼'); assert.deepEqual(x.semanticLanes,['OPEN_PERSONA_OPINION']);
 x=p('春日影本來是哪個團的歌？'); assert.deepEqual(x.semanticLanes,['CANONICAL_CHARACTER_QUERY']);
 x=p('妳上次不是還說愛音其實滿會看氣氛的？'); assert.deepEqual(x.semanticLanes,['SELF_HISTORY']);
 x=p('附近新開一家抹茶店，說是偏苦、不太甜，但要排四十分鐘。妳會去嗎？'); assert.deepEqual(x.semanticLanes,['ORDINARY_PERSONA']); assert.equal(x.responseContract.responseFunction,'EXPRESS_PERSONAL_PREFERENCE_OR_TRADEOFF');
});

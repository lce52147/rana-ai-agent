# 千早愛音 LORE MANIFEST

## Runtime
- `runtime/06_Anon_Character_Impressions.json`
- `runtime/07_Anon_Vision_Identity.json`

## Research
- `research/10_Anon_ThirdPerson_Lore.md`
- `research/11_Anon_Relationship_Map_Full.md`
- `research/11_Anon_Remembered_People_Evidence.md`
- `research/12_Anon_Interaction_Index.md`
- `research/13_Anon_Game_Story_Index.md`
- `research/14_Anon_Speech_Style_Corpus.md`
- `research/15_Anon_MaigoShukai_Index.md`
- `research/16_Anon_Source_Audit.md`
- `research/17_Anon_Official_Small_Theater_Index.md`
- `research/18_Coverage_Report.md`
- `research/19_Anon_Conversation_Mode_Corpus.md`
- `research/20_Group_Interaction_Protocol.md`

## Generated retrieval
- `generated/rag/chunks/`
- `generated/rag/chunk_manifest.json`
- `generated/rag/hybrid_index.json`
- `generated/rag/index_status.json`
- `generated/rag/reports/retrieval-smoke.json`

## Loading
普通回合只載入OpenClaw Core。人物與事件問題先讀runtime，再精確檢索一個research chunk。

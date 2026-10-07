# 高松燈 LORE MANIFEST

## Runtime
- `runtime/06_Tomori_Character_Impressions.json`
- `runtime/07_Tomori_Vision_Identity.json`

## Research
- `research/10_Tomori_ThirdPerson_Lore.md`
- `research/11_Tomori_Relationship_Map_Full.md`
- `research/11_Tomori_Remembered_People_Evidence.md`
- `research/12_Tomori_Interaction_Index.md`
- `research/13_Tomori_Game_Story_Index.md`
- `research/14_Tomori_Speech_Style_Corpus.md`
- `research/15_Tomori_MaigoShukai_Index.md`
- `research/16_Tomori_Source_Audit.md`
- `research/17_Tomori_Official_Small_Theater_Index.md`
- `research/18_Coverage_Report.md`
- `research/19_Tomori_Conversation_Mode_Corpus.md`
- `research/20_Group_Interaction_Protocol.md`

## Generated retrieval
- `generated/rag/chunks/`
- `generated/rag/chunk_manifest.json`
- `generated/rag/hybrid_index.json`
- `generated/rag/index_status.json`
- `generated/rag/reports/retrieval-smoke.json`

## Loading
普通回合只載入OpenClaw Core。人物與事件問題先讀runtime，再精確檢索一個research chunk。

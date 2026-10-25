# Rana LORE Manifest v4 — Single Runtime Fact Authority

正式文字回合仍由 OpenClaw 原生 loader 讀取七份 Core Files：

1. `AGENTS.md`
2. `SOUL.md`
3. `TOOLS.md`
4. `IDENTITY.md`
5. `USER.md`
6. `HEARTBEAT.md`
7. `MEMORY.md`

Core 的責任是人格、語氣、穩定核心身分、使用者偏好、工具規則與少量長期記憶。Core 不保存人物名單、關係、事件、場所狀態或劇情時態。

## Runtime 事實權威

`LORE/runtime/06_Rana_Character_Impressions.json` 是人物、關係、事件、場所、時態、描述特徵與 knowledge boundaries 的唯一 runtime 事實來源。

- `characters`：保留既有 impression／Vision consumer 相容欄位。
- `facts`：原子化事實。
- `boundaries`：明確未知與不可推定範圍。
- `descriptors`：描述性人物解析使用的受控特徵。
- `policies`：recognition 與 group membership 的 ontology 邊界。

`retrieval.js` 只能讀取、篩選與轉譯上述結構，不得在程式碼中另寫人物專用 facts。

## Research 與衍生資料

- `LORE/research/*.md`：provenance、來源稽核與明確來源問題的補充段落；普通人物題不直接以 research prose 當成 runtime truth。
- `LORE/runtime/07_Rana_Vision_Identity.json`：Vision identity-only 資料；不反向決定人物印象。
- `LORE/generated/rag/`：可刪除、可重建的衍生 chunk、index 與報告，不是權威來源。
- `LORE/deployment/`、`LORE/archive_notes/`、`workspace/memory/`、`docs/`、`project_brain/`：不進 production prompt。

機器可讀清單以同目錄 `LORE_MANIFEST.json` 為準。

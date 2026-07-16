# Rana LORE Manifest v4

正式文字回合由 OpenClaw 原生 bootstrap 讀取七份 Core Files，另讀取一份只含初始化狀態的 `BOOTSTRAP.md`：

1. `AGENTS.md`
2. `SOUL.md`
3. `TOOLS.md`
4. `IDENTITY.md`
5. `USER.md`
6. `HEARTBEAT.md`
7. `MEMORY.md`

`BOOTSTRAP.md` 只表示 workspace 已初始化，不放人格、人物、工具、測試或 LORE。

`rana-runtime` 不註冊 LORE prompt loader，也不把 `LORE/runtime/*.md` 注入文字回合。已核對的角色內容在 `AGENTS.md`、`SOUL.md` 與 `IDENTITY.md`。`BOOTSTRAP.md` 只保留初始化狀態。

## 非文字常駐

- `LORE/runtime/06_Rana_Character_Impressions.json`：只供圖片身分完成後的程式化 impression 查詢。
- `LORE/research/*.md`：只供來源稽核與明確 retrieval。
- 舊 `LORE/runtime/01` 到 `05`：內容併入七份 Core Files 後已刪除。
- `LORE/deployment/`、`LORE/archive_notes/`、`workspace/memory/`、`docs/`、`project_brain/`：不進 production prompt。

機器可讀清單以同目錄 `LORE_MANIFEST.json` 為準。

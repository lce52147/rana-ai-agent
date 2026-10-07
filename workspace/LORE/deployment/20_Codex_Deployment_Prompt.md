# Production LORE 部署規格

此檔只供部署與驗收，不進角色上下文。實際清單以 `LORE/LORE_MANIFEST.json` 為準。

## 文字 production runtime

OpenClaw 原生讀取：`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`MEMORY.md`。

- 人格與回話：`SOUL.md`
- 身分、第一人稱知識、地點與生日：`IDENTITY.md`
- 人物記憶與距離：`AGENTS.md`
- 工具：`TOOLS.md`
- 使用者、長期記憶、heartbeat 與 bootstrap：各自專責檔

`rana-runtime` 不得註冊直接 LORE prompt loader。舊 `runtime/01` 到 `05` 已刪除，不進 prompt。

## 程式資料與排除

- `runtime/06_Rana_Character_Impressions.json`：只供圖片 canonical identity 確定後查印象。
- `research/**`：只供來源與爭議稽核。
- `deployment/**`、`archive_notes/**`、`workspace/memory/**`、`docs/**`、`project_brain/**`：永久排除 production prompt。

## 部署 Gate

LORE、純文字人格、行動判斷、圖片辨識、人物印象、圖片回答與回歸測試全部 PASS 後，才可重新啟動正式 Gateway 並執行 production smoke test。

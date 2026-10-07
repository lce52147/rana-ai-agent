# LORE 替換結果

## 已退出文字 production

- `Character_Core.md`、`Rana.md`：只保留非載入相容說明。
- `LORE/runtime/01` 到 `05`：已核對內容移入原生 Core 7，舊檔已刪除。
- 舊 Relationship Core、Knowledge Boundary、第三／第一人稱重複稿與 deep-research 稿：不在 production prompt。

## 目前分層

- 原生文字常駐：七份 OpenClaw Core Files；`BOOTSTRAP.md` 只記錄初始化狀態。
- 程式查詢：`06_Rana_Character_Impressions.json`。
- 只供稽核：`LORE/research/`。
- 永久排除：deployment、archive notes、歷史 session、docs、project brain。

沒有自訂 LORE prompt loader、遞迴 glob 或檔名排序。完整清單以 JSON manifest 為稽核事實來源；實際注入由 OpenClaw 原生 bootstrap 完成。

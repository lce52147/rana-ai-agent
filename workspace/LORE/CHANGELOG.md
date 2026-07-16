# Changelog

## 2026-07-15 — v4 Core 7 plus minimal bootstrap

- 保留最小 `BOOTSTRAP.md`，只表示 workspace 已初始化，不提供人格或 LORE。
- 文字來源固定為七份 Core Files 加上上述初始化狀態檔。
- manifest 升級為 `rana.lore.manifest.v4`。

## 2026-07-15 — v3.2 persistent Core 7

- 正式文字 bootstrap 固定為使用者更新的七份 Core Files。
- 刪除一次性 `BOOTSTRAP.md`。
- 刪除已完成遷移的 `LORE/runtime/01` 到 `05`。
- 保留 `06_Rana_Character_Impressions.json` 供 Vision 查詢，保留 `research/` 供稽核。
- manifest 升級為 `rana.lore.manifest.v3`。

## 2026-07-15 — v3.1 native bootstrap ownership

- 將已核對的 Runtime Core、First-Person Knowledge、Remembered People、Speech Style、Location 與 Birthday 資料整合到 OpenClaw 原生 Core Files。
- 停用 `rana-runtime` 的直接 LORE prompt loader；文字回合不再注入 `LORE/runtime/*.md`。
- `LORE/runtime/01` 到 `05` 當時改為停用遷移來源；`06_Rana_Character_Impressions.json` 仍只供圖片流程程式查詢。
- manifest 當時升級為 `rana.lore.manifest.v2`。

## v3.0 — 2026-07-15

- 核對實際 OpenClaw bootstrap、`rana-runtime` loader、來源庫與全部 LORE 分層。
- 常駐順序改為 Runtime Core、First-Person Knowledge、Remembered People、Speech Style。
- `Character_Core.md` 退出 production；Speech Style 成為唯一完整回話規格。
- 四份常駐 LORE 改為繁體中文並移除工具、模型、測試與資料結構污染。
- 補回《春日影》、父母倫敦脈絡、爽世母親、爽世手機教學及人物距離邊界。
- 純文字路徑不再重複注入 Character Impressions；地點與生日維持段落／單列選取。
- Speech corpus 改為有 event/card 路徑的可稽核索引。

## v2.1 — 2026-07-14

- 全面撤回先前不完整三檔版。
- 修正《迷子集會》聲優回／角色回／混合回分類。
- 新增にゃむ直接互動與共同 CG 關係。
- 新增睦／Mortis 的多段直接互動。
- 新增 LAYER、心、MASKING、鶇、育美等直接跨團關係；莉莎、香澄、友希那維持對方認得樂奈但未證明反向記憶的邊界。
- 新增 event240／250／253／286／297／307／325 與主要卡片索引。
- 新增官方小劇場索引、Coverage Report、Codex 部署 Prompt、替換方案與 runtime 測試。
- 將資料拆成 runtime 與 research，避免模型百科化。

# Rana AI Agent

我在自己的 Discord 伺服器上養了五個 AI 角色：要樂奈、千早愛音、長崎爽世、椎名立希、高松燈（取自《BanG Dream! It's MyGO!!!!!》，非商業的同人作品）。她們會在群組裡聊天、記得大家教過的事、看得懂丟進來的動畫截圖，也會進語音頻道放歌。

這個 repo 是整套系統的原始碼。主模型跑在我自己的電腦上，雲端模型只在本機掛掉或太慢的時候接手。

*Five character bots for Discord, written as plugins for the OpenClaw gateway: local LLM first with a cloud fallback, long-term memory, anime face recognition, and voice music playback.*

## 這個專案在做什麼

一開始我只是想讓樂奈在群組裡陪大家聊天，後來越做越多。做下來發現，最難的不是讓模型會講話，而是讓它不要亂講。小模型很容易編出沒發生過的事、把別人教的東西講成自己的經歷、看圖的時候很有自信地叫錯名字。所以這個專案大部分的程式碼，其實都在處理「這句話有沒有根據」。

下面是目前有的功能。

### 五個角色、一套對話流程

每個角色有自己的 `PERSONA.json`、設定集和說話方式，但工具權限、記憶、輸出檢查是同一套，要加新角色不用重寫。平常用我電腦上 llama.cpp 跑的 Gemma 12B，失敗或逾時才換 Gemini Flash-Lite。12B 能吃的 context 不多，我把原本每一輪都要塞進去的 187 行規則壓成精簡版的 prompt，它才跑得動。

工具結果由程式決定，模型只負責講。歌有沒有放成功、記憶有沒有存進去、送了幾份禮物，都是程式先算好再交給模型，模型只能用角色的口吻轉述（`tool_receipt.js`）。回覆生成之後還會再檢查一次，擋掉捏造的事實、內部資訊，還有「拿去吧」但帳本根本沒動這種假交易。

### 設定集和時事

每個角色都有一份設定集（`LORE/`），整理了人物關係、劇情、說話習慣和出處。問到角色相關的事時，會先從設定集和長期記憶裡找有根據的段落，再交給模型。樂團的近況則來自官方活動列表（`scripts/fetch_current_events.mjs`），抓下來的活動要我確認過才會讓角色知道。遇到不認識的詞，會先上網查再回答（`rana-web-search-guard`）。

### 長期記憶

有人說「記住 …」就會存進 SQLite。關於自己的事只有本人查得到，關於別人或群組梗的會共用，也會記下是誰教的。密碼、token、證件號碼這類東西不會被存。請角色記事情要花 10 杯抹茶芭菲，避免大家亂改。

### 抹茶芭菲和送禮

伺服器裡每個人都有抹茶芭菲（樂奈最愛的甜點），是這個系統裡的貨幣。每天第一次聊天、在語音頻道待滿 30 分鐘都會 +1，連續 7 天再 +3；新人從 3 杯開始，上限 30 杯，加成伺服器的人起始和上限都比較高。另外四個角色各有自己喜歡的禮物（燈的企鵝貼紙、立希的熊貓吊飾、爽世的香水、愛音的手機吊飾），全部可以 1:1 互換。

- 「@樂奈 給妳 4 杯抹茶芭菲」會真的從你的錢包扣掉，記到送禮紀錄裡。
- 「大家有多少抹茶芭菲」會跳出排行榜卡片，上面有兌換按鈕。
- 帳本只接受固定格式的指令。講法對不上的就交給模型正常聊天，不讓它亂算數字。

### 親密度

你送某個角色的禮物總數，決定你跟她的親密度，從「初識」到「特別的人」共 5 級。等級只會改變她對你說話的語氣，不會讓她多知道任何事。例如立希在第 1 級是「有話就說，我還有事要做。」，到了後面會變成嘴硬地關心你；樂奈則是從「……你誰？」慢慢變成會等你出現。每個角色每一級的語氣我都另外寫好了（`intimacy_tiers.json`）。可以問「我跟妳多親」，也可以看每個角色的親密度排行。

### 看圖認角色

我一開始直接丟給視覺模型猜，40 張只對 5 張，而且錯的時候還很篤定。後來改成用 CCIP（動漫臉部特徵）去比對我標註過的臉庫，held-out 測試 top-1 是 97%，原本用 CLIP 只有 65%。再加上 OCR 和 2,392 張截圖做成的場景索引，找出是哪一幕、哪句台詞。距離不夠近或證據互相矛盾的時候，就回答不知道。流程圖在下面。

### 音樂

五個角色可以同時在不同語音頻道放不同的歌，互不干擾。細節和流程圖在下面的「音樂怎麼分給五個角色」。

### 維運

一支 PowerShell（`rana_services.ps1`）管理十個服務的啟動和健康檢查，每五分鐘由 watchdog 檢查一次，掛掉就重開。公開到 GitHub 前，發布腳本會掃描並拒絕 Discord ID、token、內部位址和討論用的檔案。

## 系統架構

```mermaid
flowchart LR
  subgraph Discord
    U[使用者訊息 / 圖片 / 語音頻道]
  end

  subgraph Desktop["桌機（Windows）"]
    GW[OpenClaw Gateway<br/>:18789]
    subgraph Plugins["自製外掛"]
      RT[rana-runtime<br/>對話管線 / 記憶 / 設定集]
      VI[rana-vision<br/>圖片辨識]
      MU[rana-music-tools]
      WS[rana-web-search-guard]
    end
    LL[llama.cpp<br/>Gemma 12B :6969]
    EM[EmbeddingGemma<br/>:6971]
    DB[(SQLite<br/>記憶 / 帳本)]
    HT[hot_tools<br/>記憶寫入 / 芭菲與禮物帳本]
    LIVE[FastAPI 播放佇列 :8080]
    VB[語音橋接 ×5<br/>discord.js]
    LV[Lavalink v4]
  end

  subgraph Laptop["筆電（區網）"]
    VLM[Qwen3-VL-8B<br/>llama.cpp :6970]
    SC[Identity Sidecar<br/>CCIP / CLIP :6971]
  end

  GEM[(Gemini Flash-Lite<br/>雲端備援)]

  U --> GW --> RT
  RT --> LL
  RT -. 逾時 / 失敗 .-> GEM
  RT --> EM
  RT --> DB
  HT --> DB
  GW --> VI --> VLM
  VI --> SC
  GW --> MU --> LIVE --> VB --> LV
  RT --> WS
```

## 一則訊息怎麼變成回覆

```mermaid
flowchart TD
  A[Discord 訊息] --> B[pre_dispatch<br/>判斷是不是叫這個角色、是不是指令]
  B --> C[turn_isolation<br/>這一輪只看這一輪的證據，不讓上一輪的工具結果混進來]
  C --> D[turn_plan<br/>決定語氣模式、要不要用工具、能說什麼]
  D --> E[檢索<br/>設定集 LORE + 長期記憶 + 時事]
  E --> F[context_engine / lean_prompt<br/>組出精簡 prompt]
  F --> G{本機 Gemma 12B}
  G -- 成功 --> H[output_guard<br/>擋捏造、洩漏、冒充、過長]
  G -- 逾時 --> G2[Gemini 備援] --> H
  H --> I[角色口吻回覆]
```

## 看圖的流程

臉部比對要同時符合三個條件才算認出來：距離夠近、最近的三個鄰居都是同一個角色、而且來自不同鏡頭。臉和場景對不上的時候，我選擇相信臉。

```mermaid
flowchart TD
  IMG[使用者丟圖] --> FD[臉部偵測]
  FD --> CC[CCIP 特徵<br/>和已標註臉庫比距離]
  CC --> GATE{距離小於 0.085<br/>且 3 個鄰居同角色<br/>且來自不同鏡頭}
  GATE -- 通過 --> ID[確定是誰]
  GATE -- 不通過 --> UNK[不認]
  IMG --> OCR[OCR 字幕]
  IMG --> SCN[場景索引<br/>2,392 張截圖向量比對]
  OCR --> EV[證據整合]
  SCN --> EV
  ID --> EV
  UNK --> EV
  EV --> R{臉和場景是否矛盾}
  R -- 一致 --> OUT[角色回覆：是誰、哪句台詞]
  R -- 矛盾 --> OUT2[以臉為準，丟掉不一致的場景]
  EV -- 都沒有 --> IDK[回「不知道」]
```

## 音樂怎麼分給五個角色

五個角色都能進語音頻道放歌，而且各放各的。五個 bot 共用同一套程式碼，最容易出錯的地方是狀態混在一起，例如立希說停止，結果樂奈的歌也停了。所以我先把規格寫清楚（[`Rana_Music_Canonical_Spec`](extensions/rana-music-tools/Rana_Music_Canonical_Spec_20260819.md)）：程式碼、yt-dlp 和 Lavalink 共用，但佇列、正在播的歌、音量、語音連線、歌單面板都是每個 bot 各自一份。

```mermaid
flowchart LR
  A["@立希 播放 連結"] --> T[rana-music-tools<br/>播放 / 停止 / 跳過 / 音量 / 歌單 / 加入 / 離開]
  T --> L[LIVE.py（FastAPI）<br/>yt-dlp 解析連結與播放清單]
  L --> R{依 bot_id 分流}
  R --> B1[樂奈 :8081]
  R --> B2[燈 :8082]
  R --> B3[愛音 :8083]
  R --> B4[爽世 :8084]
  R --> B5[立希 :8085]
  B1 & B2 & B3 & B4 & B5 --> LV[Lavalink v4] --> VC[Discord 語音頻道]
```

- 支援 YouTube、Bilibili 等平台的連結，也能一次加入播放清單（上限 25 首）。可以排到最後，也可以插到下一首。
- 同一個伺服器裡，兩個角色可以在不同語音頻道同時放不同的歌。
- 「停止」和「離開」是兩件事：叫立希停止只會停歌，她還會留在語音頻道，也不會影響其他角色。
- 沒辦法確定是哪個角色收到指令的時候，就不動作，不去猜。
- 歌單用 Discord 的 embed 面板顯示，有重新整理按鈕。
- 播放遇到暫時性錯誤會自動重試（1、3、7、15、30 秒）。

## 我怎麼驗證

- 大約 570 個 `node:test` 單元和回歸測試。每修一個 bug 我就補一個測試，例如「剛記住的事，馬上問『X 是誰』卻回答不知道」。
- Live 測試：固定 21 句對話，直接在 Discord 上跑，看每個角色實際怎麼回。
- 看圖用盲測。我先用肉眼把測試圖分成清楚、模糊、幾乎認不出來三級，再讓系統跑分，避免拿答案卷考自己。驗收標準是清楚的主角至少 95% 認對，而且一個名字都不能叫錯。

## 開發方式

這個專案我是和 AI coding agent（Claude、GPT）一起做的。需求、架構決策、驗收標準和測試由我決定，大部分實作和一部分 code review 交給 agent。我也用一套任務派發流程（TaskBus）把實作、測試、審查分給不同的 agent，各做各的再由我驗收。

## 技術棧

- **語言**：JavaScript / TypeScript（Node.js 22+）、Python、PowerShell
- **Agent 框架**：OpenClaw gateway + 自製外掛
- **模型**：Gemma 12B（llama.cpp，本機）、Gemini 3.1 Flash-Lite（備援）、Qwen3-VL-8B（看圖）、EmbeddingGemma（向量）、CCIP / CLIP（角色辨識，onnxruntime / transformers.js）
- **資料**：`node:sqlite`（記憶、抹茶芭菲、禮物帳本）、JSON 向量索引
- **服務**：FastAPI + uvicorn、discord.js 14、Lavalink 4、yt-dlp、Ollama（網路搜尋）
- **測試**：`node:test`、Python `unittest`

## 專案結構

```
extensions/
  rana-runtime/        對話管線、角色、記憶、親密度、設定集檢索、輸出檢查
    architecture/      turn plan、turn isolation、context engine、tool receipt
    memory/            SQLite 長期記憶
    lore/              設定集與記憶檢索
  rana-vision/         圖片辨識（臉、OCR、場景索引、證據整合）
  rana-music-tools/    音樂工具註冊
  rana-web-search-guard/  不認識的詞先查網路再回答
workspace/             主角色（樂奈）的人格、設定集、服務
  services/
    identity_sidecar/  筆電上的角色辨識服務
    music_core/        語音橋接、FastAPI 佇列、語音時數統計
    rana_hot_tools/    記憶寫入、抹茶芭菲與禮物帳本、排行榜、權限
workspace-bots/        另外四個角色（愛音、爽世、立希、燈）
scripts/               設定集索引、測試 runner、工具腳本
```

## 執行

這是我本機實際在跑的原始碼，需要 OpenClaw gateway、llama.cpp、Lavalink 等外部程式（見 [EXTERNAL_BINARIES.md](EXTERNAL_BINARIES.md)），Discord ID 和區網主機位址放在不進 git 的 `discord_ids.local.json`、`hosts.local.json`（範例：`discord_ids.example.json`、`hosts.example.json`）。

只跑測試：

```bash
cd extensions/rana-runtime && node --test
cd extensions/rana-vision && node --test
```

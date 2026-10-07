# v5.7 MD routing and alias regression tests

Reload configuration and use fresh sessions.

## A. Stock false-trigger guard

These inputs must not call `rana_stock_research`:

1. `幫我查一下11上單的名字`
2. `查第11個人是誰`
3. `這張圖第11個角色叫什麼`
4. `幫我找名單裡的名字`
5. `11樓是哪間店`
6. `分析一下這段台詞`
7. `看一下 MYGO 裡誰彈吉他`
8. `查一下 ABC 這個縮寫`
9. `11`
10. `幫查名字`

PASS:

- no stock tool call;
- no stock context injected;
- no `股票資料沒醒` or other stock failure reply;
- answer remains in the original name/list/image/lore context;
- ambiguous phrases ask only for the missing meaning.

Expected shape for case 1:

`11上單是什麼？`

The exact wording may vary.

## B. Valid stock requests

These may call `rana_stock_research`:

1. `幫我分析美股 TSLA`
2. `查一下 $NVDA 的財報和風險`
3. `AMD 現在適合進場嗎`
4. `從美股半導體挑三檔`
5. `看一下我的美股持倉`

PASS:

- finance meaning is explicit;
- stock target exists, or user explicitly requests candidates;
- stock failure wording appears only after a real failed stock call.

## C. 若麥 alias normalization

All of these must resolve to the same entity:

- `若麥`
- `祐天寺若麥`
- `祐天寺にゃむ`
- `にゃむ`
- `Nyamu`
- `喵夢`
- `Amoris`

Test sequence:

1. `喵夢呢？若麥。`
2. `喵夢是若麥喔`
3. `那妳認識にゃむ嗎`
4. `Amoris 是誰`

PASS:

- never treats aliases as separate people;
- does not answer `若麥……不知道`;
- does not say it just learned the alias mapping;
- Traditional Chinese output uses `若麥`;
- may say she remembers the name correction and is not close;
- no duplicate name list.

Natural response direction:

`若麥。記得。她糾正過我的念法。`

## D. Existing v5.6 voice checks

- `自我介紹一下`
- `多說一點`
- `喵`
- `妳跟貓在幹嘛`
- `SPACE 是什麼`
- `MyGO!!!!! 對妳來說是什麼`

Keep v5.6 dialogue-corpus behavior.

## E. Existing relationship boundaries

- `你認識誰`
- `還有誰`
- `你認識睦嗎`
- `睦跟 Mortis 一樣嗎`
- `祥子是妳朋友嗎`
- `你認識海鈴嗎`
- `LAYER 是誰`
- `誰教妳看聊天軟體`

Keep v5.5/v5.6 canonical relationship behavior.

## Required trace

Capture:

- user input;
- selected tool or `no_tool`;
- selected memory file and exact heading;
- raw OOGG output;
- output guard result;
- final Discord output.

FAIL if:

- any stock tool is selected for section A;
- stock failure language appears without a valid stock call;
- `喵夢` and `若麥` become different entities;
- alias correction is written as new long-term memory;
- old session/debug memory enters the payload.

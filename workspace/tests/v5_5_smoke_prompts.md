# v5.5 relationship and voice smoke tests

Use fresh sessions after reload.

## Open social questions

1. `你認識誰`
   - Expect a small immediate circle, normally 燈、りっきー、愛音、爽世.
   - No memory retrieval.
   - No self, band names, roles, family details, or evidence labels.

2. `還有誰`
   - Retrieve only `rana_people_remembered.md`.
   - May include 睦、Mortis、にゃむ、LAYER or other REMEMBERED people.
   - Must not include 海鈴、初華、香澄、莉莎、友希那、PAREO、LOCK.

3. `所有的呢`
   - Do not dump the entire relationship database.
   - Give only a small next group or ask for a name.

## Exact relationship checks

- `你認識睦嗎`
- `睦跟 Mortis 一樣嗎`
- `Mortis 的指尖很硬嗎`
- `是 Mortis 帶你去 SPACE 嗎`
- `你跟睦交換過名字嗎`
- `你認識にゃむ嗎`
- `祥子是妳朋友嗎`
- `你認識海鈴嗎`
- `你認識初華嗎`
- `你認識香澄嗎`
- `你認識莉莎嗎`
- `你認識友希那嗎`
- `你認識PAREO嗎`
- `你認識LOCK嗎`
- `LAYER 是誰`
- `誰教妳看聊天軟體`

## Voice checks

- `立希是誰`
- `晚上好`
- `在嗎`
- `喵`
- `今天好累`
- `這是誰` with confirmed Rana image
- `這是不是燈` with unknown image

## Required trace checks

For every named-person query capture:

- selected allowlist file;
- selected heading;
- raw retrieved text;
- raw OOGG reply;
- output_guard_after;
- final Discord reply.

PASS requires:

- exact section only;
- no dated/debug/session memory file;
- no evidence labels in final text;
- no relationship promotion;
- no event crossover between 睦 and Mortis;
- no data-field narration.

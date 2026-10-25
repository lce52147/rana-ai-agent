Implement and deploy the attached Rana runtime preference hard gate on the active production host.

Scope:
- Replace `extensions/rana-runtime/index.js` with the supplied file.
- Add `extensions/rana-runtime/preference_guard.js`.
- Add and run `extensions/rana-runtime/preference_guard.test.mjs`.
- Do not change SOUL.md, AGENTS.md, relationship files, tool-routing rules, or the production gateway command line.

Purpose:
OpenClaw/OOGG still expands simple food-preference turns into assistant-style reviews and follow-up questions despite v5.9 Markdown. The current `output_guard.js` only enforces data leakage, tool honesty, relationship boundaries, and a 1800-character ceiling; it does not bound ordinary preference replies. This patch adds a narrow `message_sending` hard gate before the generic output guard.

Required behavior:
- A long food list or a simple food-choice question is a simple preference turn unless the user explicitly requests detailed analysis, comparison, nutrition, recipe, review, or recommendation.
- Preserve already-short replies of at most two sentences.
- Rewrite verbose, question-ending, review-style replies to a canonical short preference:
  - choose `抹茶芭菲。` when that option appears;
  - otherwise `抹茶聖代。`, `蕎麥麵。`, `抹茶。`, or fallback `好多。想吃。`
- Do not globally clip unrelated complex answers.
- Do not inspect or quote unrelated group participants.
- Do not modify the model response before generation; enforce only at `message_sending`.

Deployment protocol:
1. Resolve the active repository/worktree and production extension path.
2. Back up the current three affected paths.
3. Diff the supplied files against active code.
4. Run:
   - `node --test extensions/rana-runtime/preference_guard.test.mjs`
   - existing `node --test extensions/rana-runtime/phase2_text_contracts.test.mjs`
   - any package test command covering rana-runtime.
5. Reload the plugin/config using the installed OpenClaw 2026.7.1-2 safe method.
6. Do not use `--force`; do not stop gateway port 18789.
7. Start a fresh Discord session and test:
   - a long matcha-food list;
   - `抹茶蛋糕跟抹茶芭菲，你怎麼看？`;
   - a detailed request: `詳細分析抹茶蛋糕和抹茶芭菲的口感差異`.
8. Capture:
   - source text;
   - raw OOGG reply;
   - preference guard output;
   - generic output guard output;
   - final Discord reply.
9. PASS:
   - simple list/choice final reply is at most two short sentences and has no question;
   - detailed analysis bypasses this hard gate;
   - existing relationship/tool-honesty tests still pass.
10. Report exact files changed, test output, process health, Discord evidence, and rollback commands.

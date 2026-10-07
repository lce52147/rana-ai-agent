# Codex deployment — 椎名立希

Deploy this package to a new isolated OpenClaw agent workspace.

1. Resolve the active host, OpenClaw version, agent ID and destination workspace. Do not assume the repository clone is production.
2. Back up an existing destination if present.
3. Copy the complete package workspace: default MD, `memory/`, and `LORE/`.
4. Do not copy another character's `MEMORY.md`, `memory/`, sessions, SQLite rows or LORE.
5. Confirm `/context list` includes the correct AGENTS, SOUL, IDENTITY, USER, TOOLS, HEARTBEAT and MEMORY.
6. Confirm `LORE/generated/rag/index_status.json` reports `ok: true`.
7. Start a fresh Discord session. Do not reuse Rana or another MyGO bot session.
8. Run `tests/core_acceptance.md` with raw model output and final Discord output captured.
9. After onboarding succeeds, delete `BOOTSTRAP.md`.
10. Do not use `--force`; do not stop the existing production gateway. Report exact paths, hashes, provider/model and rollback.

PASS requires identity, voice, relationship direction, unknown-data honesty, group-context isolation and no cross-bot memory leakage.

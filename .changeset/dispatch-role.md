---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

Adds `vinaya dispatch <role> --agent claude | codex | gemini --prompt-file <path>` — starts the named vendor's headless mode with `VINAYA_RUN_ID`/`VINAYA_ROLE`/`VINAYA_TASK`/`VINAYA_ROUND` set on the child's environment only, refuses by name before any spawn attempt when the binary is absent or not executable, and enforces a wall-time ceiling (`dispatch.timeoutMs` in config, default one hour) with `SIGTERM` then `SIGKILL`. Records `dispatched`/`outcome_received`/`dispatch_failed` through the Vinaya Log's `dispatch` family (`apps/cli/src/lib/dispatch.ts`), and flushes the outbox via `vinaya log flush` when `--task`/`--pr` is given. `vinaya.config.json` gains `dispatch.timeoutMs`/`dispatch.agent`.

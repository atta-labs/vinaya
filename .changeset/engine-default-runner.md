---
'@attalabs/vinaya': minor
---

A task runs on the Atta Engine by default: a repository whose configuration names no `runner`, started with no `--runner`, runs its task on the Engine, which needs Bun on the PATH. A run that cannot start the Engine — its runner file absent, or Bun not on the PATH — is refused with one message naming the cause, before the Issue is assigned, and `vinaya task run --background` refuses in the terminal that ran it; no run continues on the standalone runner by itself any more. The standalone runner stays selectable with `"runner": "standalone"` or `--runner standalone`, and the command that continues a paused standalone run with no pull request now names `--runner standalone`.

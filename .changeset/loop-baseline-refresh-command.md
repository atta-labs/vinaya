---
'@attalabs/vinaya': patch
---

One command, `bun apps/cli/scripts/refresh-loop-baseline.ts`, now refreshes the loop baseline digests in the scenario corpus, and the architecture-exit failure for a changed loop module names it. A Developer turn that reports `blocked` for a failing test now gets one re-ask, saying that CI on the pull request's head decides a test that fails only in the sandbox, before the loop pauses.

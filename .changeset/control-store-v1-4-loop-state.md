---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Adds a `loop_state` record kind to the control store: one per task, carrying the dev-review-loop's round, phase, mechanical/review/infrastructure retry budgets, and held-result/delivered-findings identity — `writeLoopState`/`readLoopState`/`parseLoopStateRecord` are the new exports. The dev-review-loop driver persists it on every round transition and recovers from it on start, attach and `--resume`, so a killed or restarted driver resumes the same round and budgets instead of resetting them, never redelivers the same round's findings twice, and stops depending on the task's optional forge-flushed event history alone for round-number recovery.

---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Task operations, loop transitions and handoffs emit one correlated history. The shared effect executor (`EffectExecutor`) emits `effect` log events (`attempted`/`observed`/`verified`) around every real write and every idempotent replay, keyed by the same control-store key used for retry identity; the broker's `authenticate*Invocation`/`requestEffect` emit `operation` events for invocation and authorization outcomes before delegating to the executor. `devReviewLoop` now logs a `resumed` event on `--resume` (`by: 'driver'` for a bare infrastructure recovery, `'principal'` otherwise — a new, additive `resumed.by` member) and `cancelDevReviewLoop` logs a new `cancelled` `dev_review_loop` event, both previously invisible to the Vinaya Log. Every event one driver process emits now shares `meta.lineage.run`: `VINAYA_RUN` is set to the run's own `loop_id`, and the log sink defaults `lineage.run` to the process's own `run_id` when unset, so `effect`/`operation`/`dev_review_loop` events from one run are provably one correlated history rather than independently-correlated streams.

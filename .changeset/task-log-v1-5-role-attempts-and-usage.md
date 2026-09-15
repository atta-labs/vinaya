---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Role attempts record review evidence and observed model usage. `dispatchRole` emits a `role_attempt` line per attempt (runtime/model, retry ordinal, evidence identity, a normalized outcome) and a `usage` line with input/output/cache broken out and an explicit reason whenever a vendor's stream gives nothing to report — both survive a killed or crashed attempt, not only a clean exit. A successful dispatch's `outcome_received` line now reports the new `DispatchOutcome` `completed` variant instead of a borrowed `plan` placeholder. `DevReviewLoopEvent`'s `verdicts_read` gains an optional `findings` array carrying each finding's severity scale and policy treatment, populated by the reviewer dispatch from the effective review policy; an invalid reviewer report now also logs its own `role_attempt` failure observation. `PROSE_CAP_SEVERITY` is newly exported from `@attalabs/aeg-core`.

---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`task_resume` and `task_cancel` are real handlers now, replacing the `capability_unavailable` stubs. Neither accepts a caller-supplied approval: both require a current Principal ruling read fresh off the run's own PR, never a value taken from a tool argument. `task_resume` reads the pause record, the durable escalation record, and any existing resolution before triggering the SAME `dev-review-loop --resume` continuation the CLI has always used, guarded by an idempotent, escalation-scoped claim so the same paused escalation is never handed to two concurrent continuations. `task_cancel` delegates its entire authenticated consumption to the existing `cancelDevReviewLoop`, translating its result into a truthful `confirmed`/`pending`/`uncertain` outcome that a repeated call reports again rather than erroring. `TaskResumeResultSchema`/`TaskCancelResultSchema`/`TaskCancelOutcomeSchema` are the new `@attalabs/aeg-core` exports; `NoResultSchema` is retired.

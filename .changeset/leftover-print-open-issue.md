---
"@attalabs/vinaya": patch
---

`vinaya issue create`/`vinaya issue edit` now print a `leftover-detection` line unconditionally for every task Issue (tranche-labeled) create or edit — whether the task's branch already carries commits, and whether an open PR already exists for it. Previously this fact was only surfaced if an agent separately ran `vinaya check dispatch-readiness` before authoring a brief; a planning/authoring session that never invokes that command had no way to learn a task was already in flight. `classifyLeftover` (`@attalabs/aeg-core`) gained an optional `openPrNumber` field, folded into its `stop` verdict's reason.

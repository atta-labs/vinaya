---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

Add `task run --rollback`, which ends a task's in-flight Engine run, reconciles its prepared and uncertain effects by identity and restarts it on the standalone runner, keeping a rehearsal record in the task's runtime directory. A start on a pause another runner holds is now refused with a typed reason; its text is unchanged.

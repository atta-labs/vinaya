---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': minor
---

The `issue-tranche-label` check is removed: `vinaya check` no longer registers, lists or runs it, and its check executable no longer ships. It had passed for every Issue since a task-shaped body with no tranche label became the normal shape of a backlog Issue. `@attalabs/aeg-core` no longer exports the tranche-label presence rule, and the Issue write paths no longer call it. Issue writes validate exactly the same bodies as before, and a task-shaped body with no tranche label still gets the full brief-schema validation.

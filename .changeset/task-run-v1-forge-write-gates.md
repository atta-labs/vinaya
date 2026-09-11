---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`vinaya issue create`/`vinaya issue edit` (and this repo's own `open-issue.ts` PreToolUse path) refuse three more Planner mistakes before they reach the forge: a task-shaped body (carrying `## Objectives` or any Planner's-rationale field) posted with no `vinaya/tranche:*` label, naming the missing label; a Boundary rationale naming a repository path no `## Surface` `in:` glob covers, naming the path and the nearest `in:` entry; and two open task Issues in the same Milestone whose `## Surface` `in:` lists overlap with neither naming the other in `Conflicts-with`. `vinaya task dispatch`/`task brief` for a task id absent from the tranche's task list now names the title form it looked for, the label, and how many open Issues carry it.

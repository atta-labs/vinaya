---
"@attalabs/vinaya": patch
---

The Planner can check a stored plan draft as a whole and preview it exactly as the Developer will read it. `plan_draft_check` runs the full Issue write gate on every task and adds the findings only the whole plan has — tasks that change the same files without a declared conflict, an edge naming a task the draft does not hold, a dependency cycle, a deferred fact whose producer is not a dependency, and agreed-scope items delivered twice or not at all. `plan_draft_preview` returns each task's exact Issue and brief, with the reasons a task cannot start beside it, rendered from a read-only copy of the draft's captured revision so an uncommitted edit changes nothing.

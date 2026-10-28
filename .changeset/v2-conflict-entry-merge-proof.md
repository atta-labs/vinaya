---
"@attalabs/vinaya": patch
---

A version 2 (review locally, push once) run that finds its open pull request in conflict with main starts with the Developer's conflict turn: the reconcile step records the conflicting files and the main tip the driver fetched, and routes to the Developer before any local check or reviewer, even in a fresh run generation. Before any reviewer judges the repair, the driver proves it: the published head is a merge commit whose parents include that main tip, no unresolved index entry remains, the head merges cleanly with main fetched again, and the pull request reads `MERGEABLE`. A single-parent commit, an unchanged head or an unresolved conflict goes back to the Developer, and the same failure twice pauses `repeat_failure`. Running reviewers are never interrupted when main moves; the conflict is handled after their verdicts.

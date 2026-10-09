---
'@attalabs/vinaya': patch
---

A restarted task never has its branch moved under its own unpublished work. When a task starts and its worktree already exists, the driver leaves the remote branch where it is, creates a missing one at the worktree's own head, and pauses for the Operator, naming the branch and both heads, when the worktree cannot fast-forward to the remote branch. Publication measures a task's changes from the merge base with the last pushed head, so changes that arrived from the default branch are never refused as the task's.

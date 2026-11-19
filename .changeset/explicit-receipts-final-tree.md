---
'@attalabs/vinaya': patch
---

A ready push records every explicit Test Plan command's receipt against the worktree state left after the last command, so a later command that writes git-ignored files (a typecheck filling its build cache) no longer leaves an earlier command without a receipt and the pull request without Evidence.

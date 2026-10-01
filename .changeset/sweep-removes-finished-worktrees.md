---
'@attalabs/vinaya': patch
---

The sweep a review loop runs at start now also removes the task worktrees under `.worktrees/` whose pull request is merged or closed, whose branch has nothing the remote lacks, and which have no uncommitted changes. Every other worktree is kept and its decision line says why, so a machine running many tasks no longer fills its disk with finished checkouts.

---
'@attalabs/vinaya': patch
---

The Engine runner now sweeps finished tasks at the start of every run: it removes a finished task's worktree, task folder and Engine run folder, and the sweep removes a task folder that holds a read-only reviewer snapshot instead of failing with a permission error.

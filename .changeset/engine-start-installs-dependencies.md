---
'@attalabs/vinaya': patch
---

The Engine start step installs the task worktree's dependencies before any agent step, and a failed install pauses the run as an infrastructure stop.

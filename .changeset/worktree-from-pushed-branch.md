---
'@attalabs/vinaya': patch
---

A task continued on another machine now gets its worktree from the pushed branch. When the loop continues a task whose branch is on the remote with task commits and this machine has no worktree for it, the worktree is created at the pushed head, tracking the remote branch, before the Developer's turn starts. A local branch of the same name is reused only when it is at the same head, and a creation that fails pauses the task, naming the branch, the path and the git error, instead of dispatching a Developer with no worktree.

---
'@attalabs/vinaya': patch
---

The review loop now creates a task's developer branch on the remote when it starts, so a started task is visible on GitHub before its first push.

On the genuinely-fresh round-1 path — the branch exists neither as an open pull request nor on the remote — the loop pushes `origin/main`'s tip to `refs/heads/<branch>` (`git push origin origin/main:refs/heads/<branch>`, an explicit refspec that never checks the branch out in the running checkout and never force-pushes) before it dispatches the first Developer turn. A dashboard reading only GitHub now counts the task in flight from its first minute, instead of only after the Developer's own first push — often an hour later, and never at all for a run that dies before pushing. A branch that already exists on the remote (an attach to an open PR, or a remote branch with no PR yet) is left untouched. A failed push at start is logged and swallowed, never a reason the loop stops, since the Developer's own first push creates the same branch.

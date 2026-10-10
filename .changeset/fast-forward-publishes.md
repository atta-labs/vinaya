---
'@attalabs/vinaya': patch
---

A Developer that fast-forwards its worktree onto the default branch's tip can now publish its work: the publication check accepts a head that is exactly that tip, as the remote reports it, when the head recorded before the turn is its ancestor and the branch's base is that same tip. The driver re-records its base and head at the tip and measures the turn's changed paths from it, so the default branch's own files are never counted as the task's. Any other moved head — a commit the Developer made, a merge commit, a rebase onto anything else — is still refused with the same reason.

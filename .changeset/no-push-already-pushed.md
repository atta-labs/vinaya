---
'@attalabs/vinaya': patch
---

The review loop no longer pauses `no_push` on a branch that is already pushed and clean. After the one unpushed-work resume, a worktree with nothing dirty and nothing ahead of the remote, whose remote branch is still at the head the turn started on, proceeds to that round's reviewers. A `no_push` pause that still fires now names what is really unpushed: the dirty file(s), and the count of commits ahead of the remote only when there are some.

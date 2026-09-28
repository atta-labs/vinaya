---
'@attalabs/vinaya': patch
---

Preparing a brief (`vinaya task run`, `task_start`, `vinaya brief render`) from a checkout that is on the default branch, carries no uncommitted change to a tracked file, and is strictly behind the remote default branch now fast-forwards the checkout to the remote tip first (`git merge --ff-only` after a fetch — never a reset, rebase, or checkout) and continues, printing one line naming the old and new commit. Every merged pull request moves the remote default branch, and until now the next start from an Operator's checkout was refused ("checkout HEAD … is behind … — fetch and update") until a person ran `git pull` by hand.

A checkout that is on another branch, has uncommitted changes to tracked files, or carries local commits the remote does not have is never moved: preparation refuses, naming which of the three it found and the exact command that clears it (`git switch <default>`, `git stash`, or `git push`). Untracked files never block. When the remote cannot be reached, preparation refuses as before.

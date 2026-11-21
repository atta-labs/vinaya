---
"@attalabs/vinaya": patch
---

After the review loop merges a default branch that changed dependencies, the worktree is installed again before the Developer turn. A failed install pauses the run for the infrastructure, and the resumed run installs before its first Developer turn.

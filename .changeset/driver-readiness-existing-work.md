---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The review-loop driver no longer refuses every Developer turn after the first. It runs the dispatch-readiness gate before each turn, and `verify-dispatch` refused any task branch with commits ahead of main ("do not re-run Step 0"), which is always true from the second turn on and on every resume. `verify-dispatch` now takes `--existing-work`: the caller resumes the task's existing worktree, so commits ahead of main are expected and never refuse dispatch. The driver always passes it; a run without the flag behaves as before.

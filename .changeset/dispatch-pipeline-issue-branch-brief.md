---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": minor
---

`vinaya task dispatch` posts and reads the dispatched brief on the task's real forge Issue, not on an Issue whose number happens to equal the task id — fixes a bug where a task id that was itself a valid, unrelated Issue number (e.g. task 3) could post the brief on that unrelated Issue instead.

A task branch created by a brief's Step 0 (`git worktree add ... --no-track origin/main`, then `git config push.autoSetupRemote true`) no longer tracks the branch it was cut from — a plain `git push` now reaches the task's own remote ref instead of failing with an upstream-name-mismatch error that suggests pushing onto the default branch.

A rendered brief's §4 Technical surface map and premise pins now name only the files the Planner's Boundary rationale actually calls out, resolved against the tracked tree, instead of every file under the task's declared `## Surface` directory globs — a task touching a dozen files in a large directory no longer renders a brief instructing hundreds of unrelated modifications. `vinaya brief render` no longer requires `--surfaces`; omitted, it derives the surface from the Issue's own `## Surface` section, the same source `vinaya task dispatch` already reads.

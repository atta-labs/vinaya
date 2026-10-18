---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

`main-branch-refusal` now refuses a commit on the default branch too, not only a push: the generated commit hook runs it. The default branch resolves from local git state alone when `origin/HEAD` is unset — an existing `refs/remotes/origin/main`, else `refs/remotes/origin/master`, else `init.defaultBranch` — through the new `resolveDefaultBranch` in `@attalabs/aeg-core`, so the refusal applies offline. When none resolves the check still passes with a visible warning, and a detached HEAD always passes.

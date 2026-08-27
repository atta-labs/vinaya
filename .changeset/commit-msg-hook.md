---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

Adds a `commit-msg` hook to the managed-artifact set, enforcing this repo's `Type(scope):
Description` commit convention. `vinaya init`/`vinaya upgrade` now install a third managed hook
beside `pre-commit`/`pre-push`; `vinaya eject` removes it the same way. The commit-type vocabulary
is exported from `@attalabs/aeg-core` as `COMMIT_TYPE_STYLE`/`COMMIT_TYPES` — the same list
`checkForgeTitle` already enforced on PR/Issue titles.

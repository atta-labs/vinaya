---
'@attalabs/vinaya': patch
---

The generated checks workflow now resolves `BASE_SHA` in a `Resolve the diff base` step: on a pull request run it takes the checked-out merge commit's first parent, the exact base the merge was built on, so diff-scoped checks count only the pull request's own changes even after the base branch has moved on. A checkout that is not a merge commit falls back to the event's base commit, and the step prints which one it chose.

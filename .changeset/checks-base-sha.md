---
'@attalabs/vinaya': patch
---

The generated checks workflow now sets `BASE_SHA` from the pull request's base commit on its `Run checks` step, so checks that resolve a merge-base read the pull request's real base branch instead of assuming `origin/main`.

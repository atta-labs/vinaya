---
'@attalabs/vinaya': patch
---

The repository override is now `VINAYA_REPO` (`owner/repo`). The old variable name is no longer read: a CI job that still sets it must set `VINAYA_REPO` instead, or the repository is resolved from the git remote.

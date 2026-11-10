---
'@attalabs/vinaya': patch
---

The repository override is now `VINAYA_REPO` (`owner/repo`). The old variable name `AEG_REPO` is no longer read: a CI job that sets it must set `VINAYA_REPO` instead, or the repository is resolved from the git remote.

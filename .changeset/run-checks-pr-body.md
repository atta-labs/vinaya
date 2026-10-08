---
'@attalabs/vinaya': patch
---

The Developer's `run_checks` tool now judges the pull request the way CI does. It hands `vinaya check --all` the branch, the pull request number and its live body, so `closes-n` and the other body checks no longer fail a body that names its task correctly.

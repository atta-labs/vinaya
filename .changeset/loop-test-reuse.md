---
'@attalabs/vinaya': patch
---

The loop re-runs fewer tests that already passed. A group run with `--isolate` keeps the passes its report lists when one file errors outside its tests, so only that file runs again. A push and CI look for a read record on the nearest earlier commits, not only the exact one. A Test Plan command's pass carries to a later head of the branch when the repository's selection says nothing changed since then reaches its tests. A local push leaves the build job's own suites to CI, which runs them on every pull request.

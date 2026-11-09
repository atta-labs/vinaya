---
'@attalabs/vinaya': patch
'@attalabs/test-selection': minor
---

Test selection is now the standalone package `@attalabs/test-selection`, and its one entry point, `selectTests`, holds every selection rule: the change graph, recorded reads, static fallbacks, obligations, failed-test reruns, whole-suite runs, the branch-side rule after a default-branch merge, and reuse of earlier complete passes. The push gate and CI call it with the same policy and run exactly its planned tests; every complete test-file pass, from a push, a CI shard or a hand run, is kept under a key of what the test reads and reused while that key holds.

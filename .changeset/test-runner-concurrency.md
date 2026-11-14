---
'@attalabs/vinaya': patch
---

This repository's test scheduler can now run several one-file test runners at once, on CI, a local push and a review round alike. One setting, `VINAYA_TEST_CONCURRENCY`, a positive integer, decides how many; unset, it is one, so files still run one after another until a later change raises the default. Any other value refuses the run with a message naming the setting. Above one, each runner's output is written as one block when it ends, every file keeps its own report, limit and single retry, every reported outcome is the same as when the files run one after another, and a push that stops after a failing file starts no further file while letting the files already running finish.

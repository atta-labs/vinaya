---
'@attalabs/test-selection': patch
'@attalabs/vinaya': patch
---

A test file the read recorder runs under the tracer now gets ten times its per-case time limit, and a recorded test that does not pass logs the end of its output. Tracing every file call slows a case about ten times, so limits sized for untraced runs failed slow cases, and the recorder ran each test with its output thrown away, so the log never said which case failed. This repository's recorder scales a Bun run's `--timeout` by ten (or adds Bun's default times ten) and sets `VINAYA_TEST_TIME_SCALE=10`, which the dev-review-loop fixture reads to scale its subprocess budget; untraced runs keep today's limits. The package's recorder now reads both output streams of a run and, for a test that did not pass while recorded, logs the newest 40 lines, cut to their newest 4,000 characters, under the failure line; the output is never written into the record.

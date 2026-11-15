---
'@attalabs/vinaya': patch
'@attalabs/test-selection': minor
---

Selection by recorded reads now leaves out a test that read a changed file when the change cannot have reached it: every hunk of the file is body-only or an inert addition, the test's recorded coverage shows it never entered a changed function, its own process opened the file once and loaded it, and no child process opened it. Any missing fact keeps the test, a test on the `real-sandbox` or `outside-call` list of `scripts/test-suites/file-level-tests.json` is always kept, and the rule applies only on the record's own platform. A version-1 record selects as before. The plan names every test a record left out, and why, in `records.leftOut`, including the tests the existing exported-name narrowing leaves out. `SelectionPolicy.fileLevel` carries the two lists and enters the policy's identity.

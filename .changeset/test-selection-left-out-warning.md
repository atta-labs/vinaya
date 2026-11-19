---
'@attalabs/test-selection': minor
---

When the head inventory omits a package with an unsupported test runner or a test file outside any suite, `test-selection` prints both counts in a single warning on standard error. The command still exits with status zero after printing the plan.

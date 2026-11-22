---
"@attalabs/vinaya": patch
---

A test file whose runner exits non-zero with a report naming a failing file is run once more alone before its group is red. A file that then passes is listed as passed on retry, on standard error, in the step summary and in the run's result; a second failure is red as before.

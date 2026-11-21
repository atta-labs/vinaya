---
"@attalabs/vinaya": patch
---

A round that both reviewers approved and a failing selected test blocked now records both reviewers as approving in its verdicts record, while it still ends as changes requested with the test as a blocking finding. The driver log line for failed round tests names the first failing test file, its location and its error line, also for a failure with no test name.

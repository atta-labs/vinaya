---
'@attalabs/vinaya': patch
---

A Developer's CI failure excerpt now keeps the test scheduler's failure lines and, for each `(fail)` line, the nearest test-file group line above it, ranked first when the excerpt is over its limit, so a scheduler-failed group or an unnamed failure names its failing file.

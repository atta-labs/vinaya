---
'@attalabs/vinaya': patch
---

Bun test runs a scheduler starts in parallel in one folder each get their own copy of the folder's `bunfig.toml` naming their own JUnit report, so the read recorder no longer loses passing tests to a sibling run's report.

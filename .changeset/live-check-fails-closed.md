---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': patch
---

The live check fails closed. When the review loop cannot read the frozen brief's `[live]` lines, the task no longer concludes: the round ends as an infrastructure failure and is retried. The `test-plan` check reads the task Issue's frozen brief and the pull request's head, and holds each `[live]` line with no passed `AEG:LIVE` entry at that head like an unticked `[principal]` item; a brief it cannot read fails the check. `evaluateTestPlanGate` takes the brief's `[live]` commands and the head as an optional third argument.

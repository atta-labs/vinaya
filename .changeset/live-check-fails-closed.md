---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': patch
---

The live check fails closed. When the review loop cannot read the frozen brief's `[live]` lines, the task no longer concludes: the round ends as an infrastructure failure and is retried. `principal-test-plan-wait` and `test-plan` read the task Issue's frozen brief and the pull request's head: each `[live]` line with no passed `AEG:LIVE` entry at that head holds the merge like an unticked `[principal]` item, and a brief they cannot read fails both checks. The generated `vinaya-body-checks.yml` gives the wait job the head, the branch, a token and `issues: read`; run `vinaya upgrade` to pick it up. `evaluateTestPlanGate` takes the brief's `[live]` commands and the head as an optional third argument.

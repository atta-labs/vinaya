---
'@attalabs/vinaya': patch
---

`vinaya check coherence` on a task branch now evaluates the report-only lifecycle rules L2 (an archived tranche with an open task Issue) and L4 (an open task Issue not attached to its legacy tranche Milestone), printing each finding as a warning that never changes the exit code. A failed forge read prints one warning that L2 and L4 did not evaluate, and the check now fails as `severity:infra` with only well-formed check-error lines on standard error instead of letting raw `gh` output or a stack trace through.

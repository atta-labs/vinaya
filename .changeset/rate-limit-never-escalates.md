---
'@attalabs/vinaya': patch
---

A GitHub rate limit that reaches the review loop through a red check or a Developer's `tooling_unavailable` block now waits for the reset instead of escalating. Every job of every generated workflow ends with a failure-only step that prints that job's own token budgets on one `vinaya-budget:` line; the loop reads it to tell a rate-limited red from a real failure, sleeps to that budget's reset, reruns the failed jobs and continues the round, and a blocked Developer is re-dispatched after the reset. The waits share the loop's existing rate-limit budget, and past it the no-ruling rate-limit pause records the reset the watching driver then resumes after. Run `vinaya upgrade` to regenerate the workflows.

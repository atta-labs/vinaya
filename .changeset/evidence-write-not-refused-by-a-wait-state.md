---
"@attalabs/vinaya": patch
---

A pull request's evidence block is now written while a `[principal]` Test Plan box is still unticked. The body-write path's one exclusion — a failing check whose every reported error is `pending: true` never refuses the write — now reads `CheckError.pending` alone instead of being gated on the `principalOwed` spec flag, so `principal-test-plan-wait` no longer refuses `vinaya pr report --push` or the loop's per-round evidence report. Before this, a green loop ended with the block still the template placeholder and the Principal's own tick then turned `evidence-fresh` red.

Nothing about the merge condition changes: `principal-test-plan-wait` keeps its own CI job and stays red until the box is ticked, and it deliberately does not carry `principalOwed`, which would have turned that red green at the gate. A structural failure — no Test Plan section at all, any non-`pending` error, or a mix of pending and non-pending errors on one check — still refuses a body write exactly as before.

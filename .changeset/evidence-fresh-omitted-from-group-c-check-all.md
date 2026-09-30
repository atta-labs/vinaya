---
'@attalabs/vinaya': patch
---

`vinaya pr report`'s Group C now leaves `evidence-fresh` out of a Test Plan's own `vinaya check --all` run, so a PR whose Test Plan names `check --all` can finally record that command passing.

Group C runs each Test Plan command from the PR head and records its output, and it does so BEFORE this same report writes the new `AEG:EVIDENCE` block. `evidence-fresh` grades that block against a fresh recompute — so inside a Group C `check --all` run it always graded the PREVIOUS block and recorded the command as failing, a self-inflicted red no reviewer could act on (reviewers flagged it three rounds running on one task PR). The check is now excluded from exactly those runs via the check runner's own new `excludeChecks` option, carried into the spawned `vinaya check` process as the `VINAYA_CHECK_EXCLUDE` environment variable rather than by rewriting the recorded command text; the rendered Group C states the omission and its reason on one line below that command's fence, so it is never mistaken for a pass.

`evidence-fresh` still runs unchanged everywhere else: CI's `vinaya check --all --diff-only` remains its authoritative verdict, and the pre-push hook and this report's own Group B are untouched.

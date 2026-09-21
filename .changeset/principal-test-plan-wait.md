---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

A new `principal-test-plan-wait` check owns the merge condition an unticked `[principal]` Test Plan item represents, as its own independent check: red while any such item is unticked, green once every one is ticked or none exist. It reuses the same tick-detection `test-plan` already runs rather than reimplementing the checkbox scan, and reports only the `[principal]`-unticked branch — a missing Test Plan section stays `test-plan`'s own structural failure to grade.

It is reported by its own job in the generated `vinaya-body-checks.yml`, never by the aggregate `check --all`, so its red can never turn another check's name red; that job re-evaluates on a PR body edit through the workflow's existing trigger, so ticking a box actually re-runs it.

The developer-review loop's mechanical gate now excludes this check's own check-run name from what makes a head's CI red, the same treatment the review-gate check-run already gets — a head whose only red is this check reads as green there, so no developer round is dispatched over the Principal's own wait, while every other red check-run still counts.

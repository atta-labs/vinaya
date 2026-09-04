---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

A review verdict now binds to the branch's true head — `vinaya review post` and the `review-gate` check resolve the head via `git ls-remote origin refs/heads/<branch>` (falling back to the forge's own ref API), cross-checking `gh pr view`'s `headRefOid` only to log a disagreement, since that field can lag a push. Three comments describing the edge grammar by a bare-inline-code-span mechanism Issue `#347` removed now describe the labelled `Depends-on:`/`Conflicts-with:` span rule `parseRationaleDeps` actually implements. `enforcement.md` files the raw-API forge-write row under Ring `1`, not Ring `0`, and reworks the dead-branch-push hook's ring-2 backstop language to report-only audit, agreeing with its `NON_GATE_BINS` classification. `review-gate` no longer treats a `skipped`/`neutral` mechanical check-run as a failure, and the required review workflow's CI-green retrigger job moves to its own `vinaya-review-retrigger.yml` (triggered only by `workflow_run`) so it never reports a `skipped` check-run against the required workflow's own head — together closing the bug that blocked every PR opened since `#400`.

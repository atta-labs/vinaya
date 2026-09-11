---
"@attalabs/vinaya": patch
---

`test-plan`'s `[principal]` half no longer blocks `vinaya check --all`'s own exit code, or the dev-review loop's mechanical gate, while it waits on the Principal: `CheckSpec` gains `principalOwed`, set on `test-plan`, and a run whose only red is that check's `pending: true` failure now reads green. Enforcement of an unticked `[principal]` Test Plan item moves to `review-gate`, which now refuses merge while one remains unticked, in the same message shape it already uses for missing verdicts. `test-plan` keeps grading the `[agent]` half and the plan's structure only, reporting the two causes distinguishably (`pending: true` for the principal-owed wait state, unmarked for a structural failure the Developer can fix).

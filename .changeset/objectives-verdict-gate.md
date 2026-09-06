---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

A code-review or security verdict now carries the objectives it was judged against. `vinaya review post` renders an `OBJECTIVES:` block — one `O<n>: MET | NOT MET — <evidence>` line per objective, via `--objectives-file` — after `SPEC CONFORMANCE:`/before `CONFIG SCAN:`, and an `Objectives version:` line (a stable hash of the resolved list) at the verdict's fixed head; it is required whenever the closed Issue (or the PR body's own `## Objectives`) has a list to judge, refuses an id mismatch, refuses a clean verdict (`APPROVE`/`PASS`) alongside any `NOT MET`, and a re-review must restate every prior objective. An Issue below `OBJECTIVES_SINCE_ISSUE` renders neither line at all.

`@attalabs/aeg-core`'s `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` now read a comment's first FIVE lines (widened from three) and return `objectivesVersion`; `checkReviewGate` treats a verdict as clean only when both its judged head and its objectives version match the PR's current ones — a push OR an objectives edit voids the verdict, a body edit alone changes nothing the gate reads. `deriveReviewStatus` gains a matching `objectives-moved` pause reason.

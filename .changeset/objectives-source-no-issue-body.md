---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

A pull request with no linked Issue at or above the objectives cutover, and no `## Objectives` section of its own, is now judged the same way by every gate: `vinaya review post` renders a verdict with no objectives block and no `Objectives version:` line instead of refusing, exactly matching what `vinaya check review-gate` already accepted. `body-bare-digits` now treats `O<n>.` list-marker prefixes under a pull request's own `## Objectives` heading as structure, not prose, the same way it already does for an Issue body, so a pull request may carry its own objectives list. Both the gate and `review post` now decide a pull request's objectives source (Issue, PR body, or none) through one new exported `@attalabs/aeg-core` function, `resolveObjectivesSource`.

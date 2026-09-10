---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Every rendered verdict (`vinaya review post`, and `devReviewLoop`'s own published verdicts) now carries a `Ruling ordinal: <k>` line — `0` when the PR had no principal ruling at cast time, rendered unconditionally, never omitted the way `Objectives version:` is pre-cutover — read from its own first-seven-line window by the shared extractors. `checkReviewGate` (`@attalabs/aeg-core`) treats a verdict as clean only when its ruling ordinal covers the PR's current newest one, naming the newer ruling when it doesn't: a `vinaya pr rule` ruling posted after approval now turns the merge gate red until reviewers re-cast against it. If a ruling lands between a `dev-review-loop` round's reviewer dispatch and its verdicts coming back, the round's verdicts are discarded — never held, never published — and the loop pauses with a new `'ruling_posted'` pause reason (`@attalabs/aeg-core`) naming the old ordinal, the new ordinal, and the ruling's marker identifier.

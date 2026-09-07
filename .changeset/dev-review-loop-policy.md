---
"@attalabs/aeg-core": minor
---

New `src/dev-review-loop/` module: `assessRound(state, observations)` — the developer review loop's policy half, pure and I/O-free — decides every transition (dispatch the developer, dispatch reviewers, ask for confidence, publish, or pause with a reason) and returns the `DevReviewLoopEvent`s for the caller to pass to the injected `log()`. The four exits (a confidence collapse after one extra developer turn, rounds over three, a finding id previously resolved reported again, two consecutive rounds resolving no id) are decided here and nowhere else, each an explicit `stop_condition_met` line. `renderSummary(journal)` renders the publication comment: one table, counts by severity per round, developer confidence, and outcome — no finding text, no line either verdict extractor would read as a real verdict.

`stop_condition_met.condition` widens additively with `'confidence'` and `'reappearance'` so a reader tells a confidence collapse and a finding reappearance apart from each other and from a generic stall, instead of collapsing all three onto `no_progress`.

`review-status.ts`'s `findingStates` and `groupRounds` (plus the `Round`/`VerdictComment` types they use) are now exported — no behavior change — so `assessRound` reuses the same id-state merge semantics rather than a second copy of the rule.

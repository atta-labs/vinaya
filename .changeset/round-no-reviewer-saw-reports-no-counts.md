---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

A round no reviewer ever saw now shows no counts in the published summary table, and its outcome cell says why. A round can end before any reviewer is dispatched — its gate observation was not green, or, from round 2 on, a below-threshold confidence sent the developer back. Neither round was assessed, yet `assessRound` recorded it through `buildRoundRecord`'s seeded zeros, and the table rendered `0` in every severity column beside a `changes_requested` outcome: a contradiction a reader hit when a round whose run had died on a full temp disk read as zero findings for a review that never ran.

Such a round is now recorded with `buildUnreviewedRecord`, which carries NO counts at all — the same empty `countsBySeverity` a marker-reconstructed round already carries — so the renderer reports `—` for every severity column through its existing "counts have no source" path, never a `0` a reader takes for a clean review. The outcome cell names the reason instead of the round's log outcome: `not reviewed — checks red` for a red gate, `not reviewed — low confidence` for the confidence send-back. A round the reviewers did assess renders exactly as before, its zeros included when they found nothing.

The loop's decision is unchanged — the developer is still sent back exactly as today — and the round's own `round_ended` log event keeps its schema-constrained `changes_requested` outcome, so log readers are unaffected; only the `RoundRecord` the journal carries and the row the table renders change. The `apps/cli/specs/loop.md` Publication section documents the rule.

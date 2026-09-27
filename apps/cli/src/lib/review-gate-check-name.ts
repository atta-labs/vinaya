/**
 * This repo's own review-gate check-run name
 * (`.github/workflows/vinaya-review.yml`) — one constant, two call sites.
 * `check-review-gate.ts` excludes it from the mechanical checks it judges
 * (a check must never judge its own status); `dev-review-loop.ts`'s
 * mechanical gate excludes it for the identical reason —
 * a head with green CI and no verdicts yet must read
 * as green, never red, because the review gate itself has not posted a
 * check-run conclusion yet.
 */
export const REVIEW_GATE_CHECK_RUN_NAME = 'vinaya review gate'

/**
 * The WORKFLOW that posts that check run — the `name:` of the managed review-gate
 * workflow this CLI generates (`artifacts.ts` renders it from this same
 * constant, so the generator and every reader can only drift by editing this
 * line).
 *
 * Read beside the check-run name wherever a green gate is treated as a FACT
 * rather than merely reported: the check-run name alone is a free string, and a
 * run created through the checks API by anything holding `checks:write` can
 * carry it. A run produced by this workflow carries the workflow's own name
 * beside it, and a run created outside Actions carries no workflow name at all.
 *
 * Attribution by what the forge reports, not authentication: an actor that can
 * land a workflow file could declare this same `name:`. Attributing a run to the
 * APP that posted it needs the REST check-runs list's `app.slug`, which is a
 * second forge read per pull request — and the status table that reads this is
 * bounded to one read per pull request precisely so a listing cannot fan out.
 * The merge gate itself re-evaluates before any merge lands, so a table's green
 * word is advice, never the decision.
 */
export const REVIEW_GATE_WORKFLOW_NAME = 'Vinaya Review Gate'

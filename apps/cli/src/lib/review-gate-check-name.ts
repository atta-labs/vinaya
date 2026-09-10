/**
 * This repo's own review-gate check-run name
 * (`.github/workflows/vinaya-review.yml`) — one constant, two call sites.
 * `check-review-gate.ts` excludes it from the mechanical checks it judges
 * (a check must never judge its own status); `dev-review-loop.ts`'s
 * mechanical gate excludes it for the identical reason (review-validity-v1
 * task 5, `#488`, O1) — a head with green CI and no verdicts yet must read
 * as green, never red, because the review gate itself has not posted a
 * check-run conclusion yet.
 */
export const REVIEW_GATE_CHECK_RUN_NAME = 'vinaya review gate'

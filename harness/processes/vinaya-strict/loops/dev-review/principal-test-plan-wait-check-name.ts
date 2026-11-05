/**
 * This repo's own principal-test-plan-wait check-run name
 * (`.github/workflows/vinaya-body-checks.yml`'s `vinaya-principal-test-plan-wait`
 * job) — one constant, shared by `dev-review-loop.ts`'s mechanical gate,
 * which excludes it from the check-runs it judges for the identical reason
 * `review-gate-check-name.ts` documents on its own constant: a head whose
 * only red is a Principal's own unticked `[principal]` Test Plan box must
 * read as green to the loop's CI reader, not as a failure the Developer is
 * dispatched to fix — the wait belongs to the Principal, and this check's
 * own job (its own required status check) is what actually holds the merge
 * open while it is unticked.
 */
export const PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME = 'vinaya check principal-test-plan-wait'

/**
 * Repository paths of the managed workflows that `artifacts.ts` generates and
 * that the review loop must tell apart from mechanical CI.
 *
 * Their own module, importing nothing, for the same reason as `own-version.ts`:
 * the loop's CI reader (`dev-review-loop/gate-reading.ts`) needs them, and
 * importing `artifacts.ts` from the loop's import chain closes a cycle through
 * the task-tools server that fails at module-evaluation time. `artifacts.ts`
 * re-exports these under the same names.
 */
export const REVIEW_WORKFLOW_PATH = '.github/workflows/vinaya-review.yml'
export const REVIEW_VERDICT_WORKFLOW_PATH = '.github/workflows/vinaya-review-verdict.yml'
export const BODY_CHECKS_WORKFLOW_PATH = '.github/workflows/vinaya-body-checks.yml'

import { describe, expect, it } from 'bun:test'
import { coreCheckRegistry, runsUnderAll } from '../../src/checks/registry'

/**
 * `check --all` must not evaluate a check that a dedicated workflow already
 * reports. Measured on atta-labs/vinaya#21: `vinaya-review.yml` reported
 * success at 02:32Z off the 02:31Z approval, while the `--all` copy inside
 * `vinaya-checks.yml` still reported the 02:29Z failure — same PR, same
 * verdict, two answers, because only the dedicated workflow is re-run when a
 * verdict comment lands.
 *
 * `body-bare-digits` joined `review-gate` here for a different reason
 * (round 5, security review, PR #165): its Changesets-release exemption
 * live-fetches the PR's real author keyed on `PR_NUMBER`, and
 * `vinaya-checks.yml`'s `pull_request` job cannot safely resolve that — the
 * PR's own workflow YAML controls `PR_NUMBER` there. It only runs from
 * `vinaya-body-checks.yml`, a `pull_request_target` job the PR cannot edit.
 *
 * The six `issue-*` checks (task 17, O2) joined for a third reason: they
 * validate `'issue'`-scope content, which no pull-request workflow ever has
 * — nothing in `.github/workflows` invokes them at all. They run by name
 * only, from `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` at
 * Issue-write time and from `packages/aeg-core/bin/verify-coherence.ts`'s
 * open-Issue sweep.
 */
describe('ownWorkflow — checks reported by their own workflow', () => {
  it('review-gate is marked, because its verdicts arrive after a push', () => {
    const spec = coreCheckRegistry().find((s) => s.name === 'review-gate')
    expect(spec?.ownWorkflow).toBe(true)
  })

  it('body-bare-digits is marked, because its release exemption needs a trust boundary vinaya-checks.yml cannot provide', () => {
    const spec = coreCheckRegistry().find((s) => s.name === 'body-bare-digits')
    expect(spec?.ownWorkflow).toBe(true)
  })

  it('exactly these eight core checks are so marked — this narrows --all and must stay narrow', () => {
    const marked = coreCheckRegistry()
      .filter((s) => s.ownWorkflow)
      .map((s) => s.name)
      .sort()
    expect(marked).toEqual([
      'body-bare-digits',
      'issue-milestone-attach',
      'issue-objectives-numbering',
      'issue-parts-coverage',
      'issue-surface-globs',
      'issue-title-grammar',
      'issue-tranche-label',
      'review-gate'
    ])
  })

  it('every other core check still runs under --all', () => {
    // Filtered through the exported predicate — the same one `check.ts`'s
    // `--all` selection and the lifecycle script's derived expectation apply,
    // so this test measures the shipped rule rather than a re-derivation.
    const runnable = coreCheckRegistry().filter(runsUnderAll)
    // Relative to the live registry's own size, not a hardcoded count — this
    // cannot go stale as the registry grows, unlike an absolute number would.
    // Exactly eight checks (pinned above) are ever withheld.
    expect(runnable.length).toBe(coreCheckRegistry().length - 8)
    expect(runnable.some((s) => s.name === 'review-gate')).toBe(false)
    expect(runnable.some((s) => s.name === 'body-bare-digits')).toBe(false)
    for (const name of [
      'issue-title-grammar',
      'issue-objectives-numbering',
      'issue-parts-coverage',
      'issue-surface-globs',
      'issue-tranche-label',
      'issue-milestone-attach'
    ]) {
      expect(runnable.some((s) => s.name === name)).toBe(false)
    }
    // issue-assignment is NOT ownWorkflow (pre-existing, visibility-only) —
    // confirms the withholding above is scoped to the six named checks, not
    // an accidental blanket "issue-" prefix match.
    expect(runnable.some((s) => s.name === 'issue-assignment')).toBe(true)
    // Spot-check that the withholding is not accidentally broad.
    for (const name of ['closes-n', 'test-plan', 'doc-coverage', 'branch-topology']) {
      expect(runnable.some((s) => s.name === name)).toBe(true)
    }
  })
})

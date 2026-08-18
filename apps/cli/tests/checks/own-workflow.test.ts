import { describe, expect, it } from 'bun:test'
import { coreCheckRegistry, runsUnderAll } from '../../src/checks/registry'

/**
 * `check --all` must not evaluate a check that a dedicated workflow already
 * reports. Measured on atta-labs/vinaya#21: `vinaya-review.yml` reported
 * success at 02:32Z off the 02:31Z approval, while the `--all` copy inside
 * `vinaya-checks.yml` still reported the 02:29Z failure — same PR, same
 * verdict, two answers, because only the dedicated workflow is re-run when a
 * verdict comment lands.
 */
describe('ownWorkflow — checks reported by their own workflow', () => {
  it('review-gate is marked, because its verdicts arrive after a push', () => {
    const spec = coreCheckRegistry().find((s) => s.name === 'review-gate')
    expect(spec?.ownWorkflow).toBe(true)
  })

  it('it is the ONLY core check so marked — this narrows --all and must stay narrow', () => {
    const marked = coreCheckRegistry()
      .filter((s) => s.ownWorkflow)
      .map((s) => s.name)
    expect(marked).toEqual(['review-gate'])
  })

  it('every other core check still runs under --all', () => {
    // Filtered through the exported predicate — the same one `check.ts`'s
    // `--all` selection and the lifecycle script's derived expectation apply,
    // so this test measures the shipped rule rather than a re-derivation.
    const runnable = coreCheckRegistry().filter(runsUnderAll)
    // Relative to the live registry's own size, not a hardcoded count — this
    // cannot go stale as the registry grows, unlike an absolute number would.
    // Exactly one check (`review-gate`, pinned above) is ever withheld.
    expect(runnable.length).toBe(coreCheckRegistry().length - 1)
    expect(runnable.some((s) => s.name === 'review-gate')).toBe(false)
    // Spot-check that the withholding is not accidentally broad.
    for (const name of ['closes-n', 'test-plan', 'doc-coverage', 'branch-topology']) {
      expect(runnable.some((s) => s.name === name)).toBe(true)
    }
  })
})

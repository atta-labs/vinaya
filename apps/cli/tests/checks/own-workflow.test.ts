import { describe, expect, it } from 'bun:test'
import { coreCheckRegistry } from '../../src/checks/registry'

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
    const runnable = coreCheckRegistry().filter((s) => !s.ownWorkflow)
    // The registry is 15 core checks; exactly one is withheld.
    expect(runnable.length).toBe(coreCheckRegistry().length - 1)
    expect(runnable.some((s) => s.name === 'review-gate')).toBe(false)
    // Spot-check that the withholding is not accidentally broad.
    for (const name of ['closes-n', 'test-plan', 'doc-coverage', 'branch-topology']) {
      expect(runnable.some((s) => s.name === name)).toBe(true)
    }
  })
})

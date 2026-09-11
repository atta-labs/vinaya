import { describe, expect, it } from 'bun:test'
import { buildTestPlanCheckErrors } from '../../src/checks/bin/check-test-plan'

describe('buildTestPlanCheckErrors (review-validity-v1 11, O1)', () => {
  it('a pass result produces no errors', () => {
    expect(buildTestPlanCheckErrors({ verdict: 'pass', messages: ['PASS.'] })).toEqual([])
  })

  it('a structural fail (no Test Plan section) is NOT marked pending — the Developer can fix it', () => {
    const errors = buildTestPlanCheckErrors({
      verdict: 'fail',
      messages: ['FAIL — no Test Plan section found in the PR body for task branch `task/x/1`.', 'more detail']
    })
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(e.pending).toBeUndefined()
  })

  it('an unticked [principal] fail IS marked pending on every emitted error', () => {
    const errors = buildTestPlanCheckErrors({
      verdict: 'fail',
      messages: [
        'Test Plan [principal] items: 0 ticked, 1 unticked.',
        '',
        'FAIL — the following [principal] Test Plan items are unticked:',
        '  - [ ] **[principal]** sign in and verify'
      ]
    })
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(e.pending).toBe(true)
  })

  it('the pending case never tells the Developer to fix something — the recovery prompt says to wait', () => {
    const errors = buildTestPlanCheckErrors({
      verdict: 'fail',
      messages: ['FAIL — the following [principal] Test Plan items are unticked:', '  - [ ] **[principal]** x']
    })
    expect(errors[0]?.agent_recovery_prompt).toContain('Nothing for the Developer to fix')
  })
})

import { describe, expect, it } from 'bun:test'
import { uncheckedPrincipalReason } from '../../src/checks/bin/check-review-gate'

const TASK_BRANCH = 'task/review-validity-v1/11'

describe('uncheckedPrincipalReason (review-validity-v1 11, O2)', () => {
  it("null when the body has no Test Plan section at all — that is test-plan's structural failure to grade, not review-gate's", () => {
    const body = ['## Summary', '', 'no test plan section here', ''].join('\n')
    expect(uncheckedPrincipalReason(body, TASK_BRANCH)).toBeNull()
  })

  it('null when every [principal] item is ticked', () => {
    const body = ['## Test Plan', '', '- [x] **[principal]** verify in browser', ''].join('\n')
    expect(uncheckedPrincipalReason(body, TASK_BRANCH)).toBeNull()
  })

  it('names the unticked line(s) when one or more [principal] items are unticked', () => {
    const body = ['## Test Plan', '', '- [ ] **[principal]** verify in browser', ''].join('\n')
    const reason = uncheckedPrincipalReason(body, TASK_BRANCH)
    expect(reason).not.toBeNull()
    expect(reason).toContain('[principal]')
    expect(reason).toContain('verify in browser')
  })

  it('null on the unit-tests-only sentinel', () => {
    const body = ['## Test Plan', '', 'Test Plan: unit-tests-only', ''].join('\n')
    expect(uncheckedPrincipalReason(body, TASK_BRANCH)).toBeNull()
  })
})

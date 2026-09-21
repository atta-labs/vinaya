import { describe, expect, it } from 'bun:test'
import { buildPrincipalTestPlanWaitErrors } from '../../src/checks/bin/check-principal-test-plan-wait'

const TASK_BRANCH = 'task/issue-692'

const UNTICKED_PRINCIPAL_BODY = `## Summary

x

## 9. Test Plan

- [x] **[agent]** ran the thing

- [ ] **[principal]** sign in and verify

## 10. Stop conditions

x
`

describe('buildPrincipalTestPlanWaitErrors (O1)', () => {
  it('an unticked [principal] item fails, marked pending', () => {
    const errors = buildPrincipalTestPlanWaitErrors(UNTICKED_PRINCIPAL_BODY, TASK_BRANCH)
    expect(errors.length).toBe(1)
    expect(errors[0]?.pending).toBe(true)
    expect(errors[0]?.message).toContain('unticked [principal] Test Plan item')
    expect(errors[0]?.agent_recovery_prompt).toContain('Nothing for the Developer to fix')
  })

  it('every [principal] item ticked passes (no errors)', () => {
    const body = UNTICKED_PRINCIPAL_BODY.replace('- [ ] **[principal]**', '- [x] **[principal]**')
    expect(buildPrincipalTestPlanWaitErrors(body, TASK_BRANCH)).toEqual([])
  })

  it('no [principal] items at all passes', () => {
    const body = '## 9. Test Plan\n\n- [x] **[agent]** did the thing\n\n## 10. Stop conditions\n\nx'
    expect(buildPrincipalTestPlanWaitErrors(body, TASK_BRANCH)).toEqual([])
  })

  it("a structural fail (no Test Plan section) is NOT this check's to report — test-plan owns it", () => {
    const body = '## Summary\n\nx\n\n## Scope\n\nno test plan section here'
    expect(buildPrincipalTestPlanWaitErrors(body, TASK_BRANCH)).toEqual([])
  })

  it('an empty body passes (nothing to check — CI sets PR_BODY automatically)', () => {
    expect(buildPrincipalTestPlanWaitErrors('', TASK_BRANCH)).toEqual([])
  })
})

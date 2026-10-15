import { describe, expect, it } from 'bun:test'
import { renderLiveRecordBlock } from '@attalabs/aeg-core'
import {
  buildPrincipalTestPlanWaitErrors,
  runPrincipalTestPlanWait
} from '../../src/checks/bin/check-principal-test-plan-wait'
import type { LiveCheckDeps } from '../../src/checks/frozen-brief'

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

describe("runPrincipalTestPlanWait — the merge holds on the frozen brief's [live] lines at the pull request head", () => {
  const BRANCH = 'task/live-check-v1/3'
  const HEAD = 'c'.repeat(40)
  const OLDER = 'd'.repeat(40)
  const COMMAND = 'VINAYA_LIVE=1 bun test live.test.ts'
  const PRINCIPAL = 'the-principal'
  const PLAN = 'Closes #42\n\n## 9. Test Plan\n\n- [x] **[principal]** looked at it\n'
  const brief = (plan: string) => ({
    body: `<!-- aeg:brief:v1 -->\nBrief hash: x\n# Brief\n\n## 9. Test Plan\n\n${plan}\n`,
    author: { login: PRINCIPAL }
  })
  const LIVE_BRIEF = brief(`\`\`\`\nbun test a.test.ts\n\`\`\`\n\n- **[live]** ${COMMAND}`)
  const returning = (comments: ReturnType<typeof brief>[]): LiveCheckDeps => ({
    fetchIssueComments: () => comments,
    principalAllowlist: () => [PRINCIPAL]
  })
  const throwing: LiveCheckDeps = {
    fetchIssueComments: () => {
      throw new Error('GraphQL: Could not resolve to an issue or pull request with the number of 42.')
    },
    principalAllowlist: () => [PRINCIPAL]
  }
  const withRecord = (head: string) =>
    `${PLAN}\n${renderLiveRecordBlock([{ command: COMMAND, head, outcome: 'passed', passCount: 2 }])}\n`

  it('holds the merge on a [live] line with no AEG:LIVE record', () => {
    const errors = runPrincipalTestPlanWait({ body: PLAN, branch: BRANCH, head: HEAD }, returning([LIVE_BRIEF]))
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain(COMMAND)
  })

  it('holds the merge when the record holds a passed entry for an older head only', () => {
    expect(
      runPrincipalTestPlanWait({ body: withRecord(OLDER), branch: BRANCH, head: HEAD }, returning([LIVE_BRIEF]))
    ).toHaveLength(1)
  })

  it('clears once the record holds a passed entry at the pull request head', () => {
    expect(
      runPrincipalTestPlanWait({ body: withRecord(HEAD), branch: BRANCH, head: HEAD }, returning([LIVE_BRIEF]))
    ).toEqual([])
  })

  it('a brief it cannot read — a not-found Issue included — holds the merge with a blocking, never pending, error', () => {
    const errors = runPrincipalTestPlanWait({ body: PLAN, branch: BRANCH, head: HEAD }, throwing)
    expect(errors.length).toBe(1)
    expect(errors[0]?.pending).toBeUndefined()
  })

  it('a brief with no [live] line grades as before', () => {
    expect(
      runPrincipalTestPlanWait(
        { body: PLAN, branch: BRANCH, head: HEAD },
        returning([brief('```\nbun test a.test.ts\n```')])
      )
    ).toEqual([])
  })
})

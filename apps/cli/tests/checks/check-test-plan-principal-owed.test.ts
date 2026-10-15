import { describe, expect, it } from 'bun:test'
import { renderLiveRecordBlock } from '@attalabs/aeg-core'
import {
  buildTestPlanCheckErrors,
  runTestPlanCheck,
  type TestPlanCheckDeps
} from '../../src/checks/bin/check-test-plan'

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

describe("runTestPlanCheck — the frozen brief's [live] lines, failing closed", () => {
  const TASK_BRANCH = 'task/live-check-v1/3'
  const HEAD = 'c'.repeat(40)
  const COMMAND = 'VINAYA_LIVE=1 bun test live.test.ts'
  const PRINCIPAL = 'the-principal'
  const PLAN = 'Closes #42\n\n## 9. Test Plan\n\n- [x] **[principal]** looked at it\n'
  const briefComment = (plan: string) => ({
    body: `<!-- aeg:brief:v1 -->\nBrief hash: x\n# Brief\n\n## 9. Test Plan\n\n${plan}\n`,
    author: { login: PRINCIPAL }
  })
  const LIVE_BRIEF = briefComment(`\`\`\`\nbun test a.test.ts\n\`\`\`\n\n- **[live]** ${COMMAND}`)
  const PLAIN_BRIEF = briefComment('```\nbun test a.test.ts\n```')
  const depsReturning = (comments: ReturnType<typeof briefComment>[]): TestPlanCheckDeps => ({
    fetchIssueComments: () => comments,
    principalAllowlist: () => [PRINCIPAL]
  })
  const throwing = (message: string): TestPlanCheckDeps => ({
    fetchIssueComments: () => {
      throw new Error(message)
    },
    principalAllowlist: () => [PRINCIPAL]
  })

  it('an Issue-comments fetch that throws fails the check, never pending', () => {
    const errors = runTestPlanCheck({ body: PLAN, branch: TASK_BRANCH, head: HEAD }, throwing('HTTP 502'))
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('fails closed')
    expect(errors[0]?.pending).toBeUndefined()
  })

  it('a not-found task Issue fails the check too — never the exemption brief-shape gives it', () => {
    const errors = runTestPlanCheck(
      { body: PLAN, branch: TASK_BRANCH, head: HEAD },
      throwing('GraphQL: Could not resolve to an issue or pull request with the number of 42.')
    )
    expect(errors.length).toBe(1)
    expect(errors[0]?.pending).toBeUndefined()
  })

  it('a task Issue with no frozen brief fails the check', () => {
    const errors = runTestPlanCheck({ body: PLAN, branch: TASK_BRANCH, head: HEAD }, depsReturning([]))
    expect(errors.length).toBe(1)
    expect(errors[0]?.pending).toBeUndefined()
  })

  it('a [live] line with no passed entry at the head fails, marked pending like an unticked [principal] item', () => {
    const errors = runTestPlanCheck({ body: PLAN, branch: TASK_BRANCH, head: HEAD }, depsReturning([LIVE_BRIEF]))
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(e.pending).toBe(true)
    expect(errors.map((e) => e.message).join('\n')).toContain(COMMAND)
  })

  it('passes once the record holds a passed entry at the pull request head', () => {
    const body = `${PLAN}\n${renderLiveRecordBlock([{ command: COMMAND, head: HEAD, outcome: 'passed', passCount: 2 }])}\n`
    expect(runTestPlanCheck({ body, branch: TASK_BRANCH, head: HEAD }, depsReturning([LIVE_BRIEF]))).toEqual([])
  })

  it('a brief with no [live] line grades as it did before', () => {
    expect(runTestPlanCheck({ body: PLAN, branch: TASK_BRANCH, head: HEAD }, depsReturning([PLAIN_BRIEF]))).toEqual([])
    const unticked = PLAN.replace('- [x]', '- [ ]')
    const errors = runTestPlanCheck({ body: unticked, branch: TASK_BRANCH, head: HEAD }, depsReturning([PLAIN_BRIEF]))
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(e.pending).toBe(true)
  })

  it('a non-task branch never reads the forge', () => {
    expect(runTestPlanCheck({ body: PLAN, branch: 'fix/thing', head: HEAD }, throwing('must not be called'))).toEqual(
      []
    )
  })
})

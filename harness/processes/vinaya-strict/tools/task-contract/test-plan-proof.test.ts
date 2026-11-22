import { describe, expect, it } from 'bun:test'
import { agentCommandText } from '../pr-report/pr-report-engine'
import { parseLiveTestPlanItems } from './issue-validation'
import { checkTestPlanProof, stripObjectiveIdSpans } from './test-plan-proof'

function issue(testPlan: string): string {
  return [
    '## Objectives',
    '',
    'O1. The greeting names its caller.',
    'O2. An empty caller name gets the generic greeting.',
    '',
    '## Test plan',
    '',
    testPlan,
    '',
    '## Stop conditions',
    '',
    '- stop.'
  ].join('\n')
}

const LINE = 'bun test apps/demo/tests/greeting.test.ts → 0 fail (O1, O2)'
const fenced = (...lines: string[]) => `\`\`\`\n${lines.join('\n')}\n\`\`\``
const messages = (body: string) => checkTestPlanProof(body).errors

describe('checkTestPlanProof', () => {
  it('passes when every objective is proven by a fenced line', () => {
    expect(messages(issue(fenced(LINE)))).toEqual([])
  })

  it('names an objective nothing proves', () => {
    const errors = messages(issue(fenced('bun test a.test.ts → 0 fail (O1)')))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('O2 is proven by no fenced')
  })

  it('counts a principal item and a live item as proof', () => {
    const body = issue(
      [fenced('bun test a.test.ts → 0 fail (O1)'), '- [ ] **[principal]** Read the greeting in the app `(O2)`'].join(
        '\n'
      )
    )
    expect(messages(body)).toEqual([])
    const live = issue(
      [fenced('bun test a.test.ts → 0 fail (O1)'), '- **[live]** `bun apps/cli/src/index.ts doctor` `(O2)`'].join('\n')
    )
    expect(messages(live)).toEqual([])
  })

  it('quotes a fenced line that names no objective id', () => {
    const errors = messages(issue(fenced(LINE, 'bun test b.test.ts → 0 fail')))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('`bun test b.test.ts → 0 fail` names no objective id')
  })

  it('quotes an item that names no objective id', () => {
    const errors = messages(issue([fenced(LINE), '- [ ] **[principal]** Look at it'].join('\n')))
    expect(errors.some((e) => e.includes('[principal] Look at it') && e.includes('names no objective id'))).toBe(true)
  })

  it('quotes a line that names an id the Issue does not define', () => {
    const errors = messages(issue(fenced(LINE, 'bun test b.test.ts → 0 fail (O7)')))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('`bun test b.test.ts → 0 fail (O7)` names O7')
  })

  it('refuses a fenced line with no expected observable', () => {
    const noArrow = messages(issue(fenced(LINE, 'bun test b.test.ts')))
    expect(noArrow.some((e) => e.includes('`bun test b.test.ts` has no expected observable'))).toBe(true)
    const onlyIds = messages(issue(fenced(LINE, 'bun test b.test.ts → (O1)')))
    expect(onlyIds.some((e) => e.includes('has no expected observable'))).toBe(true)
  })

  it('refuses the unit-tests-only sentinel and says to name test files as fenced lines', () => {
    const errors = messages(issue('Test plan: unit-tests-only'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('name the test files as fenced `## Test plan` lines')
  })

  it("passes once the refusal's own printed fix is applied", () => {
    const refused = issue('Test plan: unit-tests-only')
    expect(messages(refused)).not.toEqual([])
    const fixed = refused.replace(
      'Test plan: unit-tests-only',
      fenced('bun test apps/demo/tests/greeting.test.ts → 0 fail (O1, O2)')
    )
    expect(messages(fixed)).toEqual([])

    const missing = issue(fenced('bun test a.test.ts → 0 fail (O1)'))
    expect(messages(missing)).not.toEqual([])
    expect(messages(missing.replace('(O1)', '(O1, O2)'))).toEqual([])
  })

  it('passes when the Objectives or the Test plan section does not parse', () => {
    expect(messages('## Test plan\n\nTest plan: unit-tests-only')).toEqual([])
    expect(messages('## Objectives\n\nO1. The greeting names its caller.\n')).toEqual([])
  })

  it('runs the same command for a line with ids as for the line without them', () => {
    expect(agentCommandText(LINE)).toBe(agentCommandText('bun test apps/demo/tests/greeting.test.ts → 0 fail'))
    expect(agentCommandText(LINE)).toBe('bun test apps/demo/tests/greeting.test.ts')
  })

  it('gives the live check the bare command for an item with ids', () => {
    expect(stripObjectiveIdSpans('`bun x` `(O2)`')).toBe('`bun x`')
    const body = issue('- **[live]** `bun apps/cli/src/index.ts doctor` `(O1, O2)`')
    expect(parseLiveTestPlanItems(body)).toEqual(['bun apps/cli/src/index.ts doctor'])
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateTestPlanGate } from './test-plan-gate'

const TASK_BRANCH = 'task/herald-hardening-v1/2'
const NON_TASK_BRANCH = 'fix/some-bug'

/** A faithful excerpt of a real PR's body — the exact live-fire specimen:
 * a `## 9. Test Plan` heading, two
 * ticked `[agent]` items, and one unticked `[principal]` item. The original
 * inline-only regex found no `Test Plan:` section here and advisory-PASSED. */
const PR_377_SPECIMEN = `## Summary

Fix audit YAML tracing.

## 9. Test Plan

- [x] **[agent]** Production build trace evidence: the YAML path appears in the traced output for every auditor route.

- [x] **[agent]** Booted production server: public (DANI_PROFILE) audit request returned a real report.

- [ ] **[principal]** BYOK path end-to-end in a real signed-in browser: run an audit with a real key.

## 10. Stop conditions

STOP and report if: pre-flight fails.
`

describe('evaluateTestPlanGate — empty body', () => {
  it('passes when PR_BODY is empty (local invocation)', () => {
    const result = evaluateTestPlanGate('', TASK_BRANCH)
    expect(result.verdict).toBe('pass')
  })
})

describe('evaluateTestPlanGate — the PR #377 live-fire specimen', () => {
  it('FAILs on the unticked [principal] box when read as a task-branch PR', () => {
    const result = evaluateTestPlanGate(PR_377_SPECIMEN, TASK_BRANCH)
    expect(result.verdict).toBe('fail')
    expect(result.messages.join('\n')).toContain('[principal]** BYOK path end-to-end')
  })
})

describe('evaluateTestPlanGate — both section forms parsed', () => {
  it('parses the heading form and PASSes when all boxes are ticked', () => {
    const body = '## 9. Test Plan\n\n- [x] **[agent]** did the thing\n\n## 10. Stop conditions\n\nx'
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
  })

  it('parses the inline **Test Plan:** marker form and PASSes when all boxes are ticked', () => {
    const body = '**Test Plan:**\n\n- [x] **[agent]** did the thing\n\n## Scope\n\nx'
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
  })

  it('parses the inline Test Plan: unit-tests-only sentinel and PASSes', () => {
    const body = '## Summary\n\nx\n\nTest Plan: unit-tests-only\n\n## Scope\n\ny'
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
  })
})

describe('evaluateTestPlanGate — no section at all', () => {
  it('FAILs loud on a task branch with no Test Plan section anywhere', () => {
    const body = '## Summary\n\nx\n\n## Scope\n\nno test plan section here'
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('fail')
    expect(result.messages.join('\n')).toContain('no Test Plan section found')
    expect(result.messages.join('\n')).toContain(TASK_BRANCH)
  })

  it('PASSes (advisory) on a non-task branch with no Test Plan section', () => {
    const body = '## Summary\n\nx\n\n## Scope\n\nno test plan section here'
    const result = evaluateTestPlanGate(body, NON_TASK_BRANCH)
    expect(result.verdict).toBe('pass')
  })

  it('FAILs loud on a task/issue-<n> branch with no Test Plan section anywhere', () => {
    const body = '## Summary\n\nx\n\n## Scope\n\nno test plan section here'
    const result = evaluateTestPlanGate(body, 'task/issue-42')
    expect(result.verdict).toBe('fail')
    expect(result.messages.join('\n')).toContain('no Test Plan section found')
    expect(result.messages.join('\n')).toContain('task/issue-42')
  })

  it('PASSes (advisory) when BRANCH is unset entirely', () => {
    const body = '## Summary\n\nx\n\n## Scope\n\nno test plan section here'
    const result = evaluateTestPlanGate(body, '')
    expect(result.verdict).toBe('pass')
  })
})

describe('evaluateTestPlanGate — section found but no checkbox items', () => {
  it('PASSes (advisory) when the Test Plan section is prose with no checkboxes', () => {
    const body = '## Test Plan\n\nManual verification only, no checklist here.\n\n## Scope\n\nx'
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
    expect(result.messages.join('\n')).toContain('no `[principal]` checkbox items')
  })
})

describe('evaluateTestPlanGate — unticked boxes', () => {
  it('FAILs and names every unticked [principal] line — [agent] lines are never tracked, ticked or not', () => {
    const body = [
      '## Test Plan',
      '',
      '- [x] **[agent]** done',
      '- [ ] **[agent]** not done yet',
      '- [ ] **[principal]** also not done'
    ].join('\n')
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('fail')
    const joined = result.messages.join('\n')
    expect(joined).not.toContain('not done yet')
    expect(joined).toContain('also not done')
  })
})

describe('evaluateTestPlanGate — the [agent] half is never graded here (task 12, #387)', () => {
  it('PASSes (advisory) a body whose Test Plan is a fenced [agent] command list with no [principal] item at all', () => {
    const body = ['## Test Plan', '', '```', 'bun run test → 0 fail', '```'].join('\n')
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
    expect(result.messages.join('\n')).toContain('no `[principal]` checkbox items')
  })

  it('PASSes a ticked or unticked [agent] checkbox alike — a pre-#387 body is never graded on that tag', () => {
    const ticked = ['## Test Plan', '', '- [x] **[agent]** `bun run test` → green.'].join('\n')
    const unticked = ['## Test Plan', '', '- [ ] **[agent]** `bun run test` → green.'].join('\n')
    expect(evaluateTestPlanGate(ticked, TASK_BRANCH).verdict).toBe('pass')
    expect(evaluateTestPlanGate(unticked, TASK_BRANCH).verdict).toBe('pass')
  })

  it('still grades a [principal] item alongside an unticked [agent] checkbox — only the [principal] tick matters', () => {
    const body = [
      '## Test Plan',
      '',
      '- [ ] **[agent]** `bun run test` → green.',
      '- [ ] **[principal]** Read the post-open sequence cold and answer.'
    ].join('\n')
    const result = evaluateTestPlanGate(body, TASK_BRANCH)
    expect(result.verdict).toBe('fail')
    expect(result.messages.join('\n')).toContain('Read the post-open sequence')
  })
})

/**
 * The own-PR fixture rule (`aeg-root/enforcement.md`): a pull request that
 * adds a check reading a PR body ships a test running that check over THAT
 * PR's own body. A body-reading gate is the one class whose real input
 * exists the moment the PR opens and is never exercised by a synthetic
 * fixture the author also wrote — the author's fixture agrees with the
 * author's mental model by construction, and the first real body it meets is
 * the one it was supposed to grade.
 *
 * `pr-body-393.md` is a real merged PR's live body, captured verbatim from
 * the forge with `gh pr view --json body -q .body`. It carries everything a
 * real body carries — the machine-emitted `AEG:EVIDENCE`/`AEG:TOKENS`
 * blocks, three ticked `[agent]` items, a ticked `[principal]` item inside
 * the real `AEG:TEST-PLAN` anchor, and the brief pasted below in its
 * `<details>` block. That last part is the load-bearing one: the pasted
 * brief carries its own Test Plan with an UNTICKED `[principal]` item of the
 * same shape (line 357), so a gate reading anything but the anchored
 * section would grade the wrong list and fail a body that should pass.
 */
describe("evaluateTestPlanGate — a real PR's own body (task 12, #387)", () => {
  const LIVE = readFileSync(join(import.meta.dirname, '..', 'tests', 'fixtures', 'pr-body-393.md'), 'utf8')
  const OWN_BRANCH = 'task/review-convergence-v1/10'

  /** The same body with its one real `[principal]` tick reverted — the state before the Principal ticked it. */
  const UNTICKED_BODY = LIVE.replace(
    '- [x] **[principal]** Read the `brief-shape` row',
    '- [ ] **[principal]** Read the `brief-shape` row'
  )

  it('PASSes the verbatim live body — the [agent] ticks are never graded, and the one [principal] item is ticked', () => {
    const result = evaluateTestPlanGate(LIVE, OWN_BRANCH)
    expect(result.verdict).toBe('pass')
  })

  it('FAILs once the [principal] tick is reverted, naming that item', () => {
    expect(UNTICKED_BODY).not.toBe(LIVE)
    const result = evaluateTestPlanGate(UNTICKED_BODY, OWN_BRANCH)
    expect(result.verdict).toBe('fail')
    expect(result.messages.join('\n')).toContain('Read the `brief-shape` row')
  })

  it('reads the Test Plan from the anchored section, not the brief pasted below it', () => {
    // The reference copy of the brief in the `<details>` block carries its
    // own Test Plan section with an UNTICKED `[principal]` item of the same
    // shape. If the gate read those too, the real, ticked section could
    // never satisfy it.
    expect(LIVE).toContain('<!-- AEG:TEST-PLAN:START -->')
    expect(evaluateTestPlanGate(LIVE, OWN_BRANCH).verdict).toBe('pass')
  })
})

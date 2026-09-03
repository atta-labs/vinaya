import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateTestPlanGate } from './test-plan-gate'

const TASK_BRANCH = 'task/herald-hardening-v1/2'
const NON_TASK_BRANCH = 'fix/some-bug'

/** A faithful excerpt of PR #377's real body — the exact live-fire specimen
 * (aeg-governance-hardening task 25, #365): a `## 9. Test Plan` heading, two
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
    expect(result.messages.join('\n')).toContain('no checkbox items')
  })
})

describe('evaluateTestPlanGate — unticked boxes', () => {
  it('FAILs and names every unticked line', () => {
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
    expect(joined).toContain('not done yet')
    expect(joined).toContain('also not done')
  })
})

describe('evaluateTestPlanGate — the evidence-comment gate', () => {
  const ALL_TICKED = [
    '## Test Plan',
    '',
    '- [x] **[agent]** `bun run test` → green.',
    '- [x] **[agent]** `vinaya review status <n>` → CONTINUE.',
    '- [x] **[principal]** Read the post-open sequence cold and answer.'
  ].join('\n')

  it('FAILs as `pending` when a ticked [agent] item has no Developer round comment behind it', () => {
    const result = evaluateTestPlanGate(ALL_TICKED, TASK_BRANCH, { developerRoundComments: 0 })
    expect(result.verdict).toBe('fail')
    expect(result.pending).toBe(true)
    const joined = result.messages.join('\n')
    expect(joined).toContain('no Developer round comment')
    expect(joined).toContain('aeg:developer:round-')
  })

  it('names the round comment as the remedy, never a body edit', () => {
    const joined = evaluateTestPlanGate(ALL_TICKED, TASK_BRANCH, { developerRoundComments: 0 }).messages.join('\n')
    expect(joined).toContain('Post the round comment')
    expect(joined).not.toContain('paste')
  })

  it('PASSes once one Developer round comment exists', () => {
    const result = evaluateTestPlanGate(ALL_TICKED, TASK_BRANCH, { developerRoundComments: 1 })
    expect(result.verdict).toBe('pass')
    expect(result.pending).toBeUndefined()
  })

  it('says "not yet", not "wrong" — the failure is the missing comment, not the tick', () => {
    const joined = evaluateTestPlanGate(ALL_TICKED, TASK_BRANCH, { developerRoundComments: 0 }).messages.join('\n')
    expect(joined).toContain('not yet')
    expect(joined).toContain('not a wrong tick')
  })

  it('keeps the pre-existing body-only behaviour exactly when no evidence is supplied', () => {
    const result = evaluateTestPlanGate(ALL_TICKED, TASK_BRANCH)
    expect(result.verdict).toBe('pass')
    expect(result.pending).toBeUndefined()
  })

  it('does not fire for a ticked [principal] item — only [agent] ticks claim pasted evidence', () => {
    const body = ['## Test Plan', '', '- [x] **[principal]** Answered in a browser.'].join('\n')
    const result = evaluateTestPlanGate(body, TASK_BRANCH, { developerRoundComments: 0 })
    expect(result.verdict).toBe('pass')
  })

  it('still reports unticked boxes normally when nothing [agent] is ticked yet', () => {
    const body = ['## Test Plan', '', '- [ ] **[agent]** not run yet'].join('\n')
    const result = evaluateTestPlanGate(body, TASK_BRANCH, { developerRoundComments: 0 })
    expect(result.verdict).toBe('fail')
    expect(result.pending).toBeUndefined()
    expect(result.messages.join('\n')).toContain('not run yet')
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
 * `pr-body-381.md` is this PR's live body, captured verbatim from the forge
 * with `gh pr view --json body -q .body`. Not a reconstruction and not the
 * at-open text: it carries everything a real body carries by the time this
 * gate runs against it — the machine-emitted `AEG:EVIDENCE` and `AEG:TOKENS`
 * blocks, the Developer's own `[agent]` ticks, a `[principal]` tick the
 * Principal added, and the brief pasted below in its `<details>` block. That
 * last part is the load-bearing one: the pasted brief carries its own Test
 * Plan with the same items, so a gate reading anything but the anchored
 * section would grade the wrong list.
 */
describe("evaluateTestPlanGate — this PR's own body", () => {
  const LIVE = readFileSync(join(import.meta.dirname, '..', 'tests', 'fixtures', 'pr-body-381.md'), 'utf8')
  const OWN_BRANCH = 'task/review-convergence-v1/8'

  /**
   * The same body once every remaining box is ticked — the state it is in
   * when the merge gate's verdict actually matters. Derived here rather than
   * committed as a second fixture, so the committed one stays a verbatim
   * capture and cannot drift from the forge.
   */
  const ALL_TICKED_BODY = LIVE.split('\n')
    .map((line) => line.replace(/^(\s*[-*]\s+)\[ \]/, '$1[x]'))
    .join('\n')

  it('fails the verbatim live body as `pending` when no round comment backs its real ticks', () => {
    // The captured body carries genuine ticks, so the evidence gate fires
    // before the unticked-box report — the ordering that makes "not yet"
    // beat "you missed a box" when both are true.
    const result = evaluateTestPlanGate(LIVE, OWN_BRANCH, { developerRoundComments: 0 })
    expect(result.verdict).toBe('fail')
    expect(result.pending).toBe(true)
  })

  it('falls through to the ordinary unticked-box report once a round comment exists', () => {
    const result = evaluateTestPlanGate(LIVE, OWN_BRANCH, { developerRoundComments: 1 })
    expect(result.verdict).toBe('fail')
    expect(result.pending).toBeUndefined()
    // The one item deliberately left unticked: no verdict exists to bind.
    expect(result.messages.join('\n')).toContain('check review-gate')
  })

  it('fails as `pending` once the boxes are ticked but no Developer round comment exists', () => {
    const result = evaluateTestPlanGate(ALL_TICKED_BODY, OWN_BRANCH, { developerRoundComments: 0 })
    expect(result.verdict).toBe('fail')
    expect(result.pending).toBe(true)
    expect(result.messages.join('\n')).toContain('no Developer round comment')
  })

  it('passes over the same ticked body once one Developer round comment exists', () => {
    const result = evaluateTestPlanGate(ALL_TICKED_BODY, OWN_BRANCH, { developerRoundComments: 1 })
    expect(result.verdict).toBe('pass')
    expect(result.pending).toBeUndefined()
  })

  it('reads the Test Plan from the anchored section, not the brief pasted below it', () => {
    // The reference copy of the brief in the `<details>` block carries its
    // own Test Plan section with the identical items. If the gate read those
    // too, no tick in the real section could ever satisfy it.
    expect(LIVE).toContain('## 9. Test Plan')
    expect(evaluateTestPlanGate(ALL_TICKED_BODY, OWN_BRANCH, { developerRoundComments: 1 }).verdict).toBe('pass')
  })
})

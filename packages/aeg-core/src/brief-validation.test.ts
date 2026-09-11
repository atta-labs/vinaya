import { describe, expect, it } from 'vitest'
import {
  AGENT_BOXES_REFUSED_SINCE_PR,
  BRIEF_RULES_SINCE_PR,
  checkAutonomyClause,
  checkBriefSections,
  checkClosesNPresence,
  checkCommandsCarryOutput,
  checkConsumerTests,
  checkDefeatCases,
  checkDocUpdateList,
  checkForField,
  checkForgeTitle,
  checkNoAgentBoxes,
  checkNoUnpinnedCodeClaims,
  checkObjectivesCopy,
  checkObjectivesCoverage,
  checkPlanPrNoCloses,
  checkPremiseCoverage,
  checkPrincipalPlaceholder,
  checkProjectField,
  checkStopConditions,
  checkSurfaceMap,
  checkTestPlan,
  checkTestPlanExclusivity,
  checkTierField,
  checkWorktreeStep0,
  briefMarkerFor,
  contentAfterNLines,
  contentAfterTwoLines,
  frozenBriefContent,
  headerRegion,
  inferBranchFromBody,
  isBriefShaped,
  parseBriefMarkerVersion,
  partitionBriefErrorsByRollout,
  resolveNewestFrozenBrief
} from './brief-validation'
import { type Objective, objectivesOf } from './objectives'
import { EOLS, FENCE_DELIMS, fenceShapes } from '../tests/fixtures/fence-shapes'
import { readTierFromPrBody } from './pr-tier'

const WELL_FORMED = `
**For:** Claude Sonnet (Claude Code CLI, dispatched non-interactive session)
**Project:** aeg

## Summary

Ships the brief-validation gate. Closes #252

## Test plan

\`\`\`
bun test → passes
\`\`\`
- [ ] **[principal]** Reviewed in browser.

## Scope

One paragraph of blast radius.

**Tier:** 3

---

### 4. Technical surface map

- Create \`packages/aeg-core/src/brief-validation.ts\`.

### 5. Pre-flight checks

Step 0 (mandatory, verbatim):
\`\`\`
git worktree add .worktrees/task/aeg-governance-hardening/2 -b task/aeg-governance-hardening/2 origin/main
\`\`\`

### 7. Documentation-update list

- \`aeg-root/state-machine.md\` §12.

### 10. Stop conditions

- Pre-flight failure.

### 11. Constraints

**Autonomy:** Do not stop to ask clarifying questions. For any ambiguity not
covered by a Section 10 stop condition, choose the most reasonable option.
`

describe('checkTierField', () => {
  it('passes when a Tier field is present', () => {
    expect(checkTierField(WELL_FORMED, readTierFromPrBody).status).toBe('pass')
  })
  it('fails when no Tier field is present', () => {
    const r = checkTierField('no tier here', readTierFromPrBody)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/tier/i)
  })
})

describe('checkTestPlan', () => {
  it('passes on unit-tests-only sentinel', () => {
    expect(checkTestPlan('Test Plan: unit-tests-only').status).toBe('pass')
  })
  it('passes on the bolded sentinel — brief-authoring §9 documents this exact form', () => {
    // The skill's own canonical example. Used to FAIL: `\s*` cannot cross the
    // `**` between the colon and the value, so a brief copying the skill
    // verbatim was rejected by the gate that documents it.
    expect(checkTestPlan('**Test Plan:** unit-tests-only').status).toBe('pass')
  })
  it('passes on the bolded sentinel with the emphasis closed before the colon', () => {
    expect(checkTestPlan('**Test Plan**: unit-tests-only').status).toBe('pass')
  })
  it('passes on at least one tagged item', () => {
    expect(checkTestPlan('- [ ] **[agent]** run the tests').status).toBe('pass')
  })
  it('fails when the Test Plan section is missing entirely', () => {
    const r = checkTestPlan('## Summary\n\nno test plan section here')
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/Test Plan/)
  })
  it('does not require unit-tests-only to be justified by the surface map (presence-only)', () => {
    // Per the Planner's trap: a Test Plan: unit-tests-only sentinel passes even
    // when §4 lists an API route — that mismatch is a Reviewer judgment call,
    // not something checkTestPlan catches.
    const body = 'Test Plan: unit-tests-only\n\n### 4. Technical surface map\n- apps/x/api/route.ts'
    expect(checkTestPlan(body).status).toBe('pass')
  })
})

describe('checkTestPlanExclusivity', () => {
  it('passes a legitimate unit-tests-only declaration with no checkbox items', () => {
    const body = 'Test Plan: unit-tests-only — pure parser, no runtime surface.'
    expect(checkTestPlanExclusivity(body).status).toBe('pass')
  })

  it('passes a legitimate mixed [agent]/[principal] plan with no unit-tests-only declaration', () => {
    const body = '## Test plan\n\n- [ ] **[agent]** run the tests\n- [ ] **[principal]** eyeball it in browser'
    expect(checkTestPlanExclusivity(body).status).toBe('pass')
  })

  it('fails when unit-tests-only is declared alongside a tagged checkbox item (PR #363 regression)', () => {
    const body =
      'Test Plan: unit-tests-only — fetchProvenance is pure-enough.\n\n' +
      '- [x] **[agent]** New regression tests for both root causes pass.'
    const r = checkTestPlanExclusivity(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/mutually exclusive/)
  })

  it('fails when the BOLDED unit-tests-only is declared alongside a tagged checkbox item', () => {
    // The silent half of the same root cause: this guard's own clause never
    // matched the bolded sentinel either, so it returned an early `pass` and
    // let the self-contradictory body straight through — the exact combination
    // #340 built it to catch, wearing the emphasis the skill documents.
    const body = '**Test Plan:** unit-tests-only — pure parser.\n\n- [x] **[agent]** Regression tests pass.'
    const r = checkTestPlanExclusivity(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/mutually exclusive/)
  })

  it('fails regardless of checkbox ticked state', () => {
    const body = 'Test Plan: unit-tests-only\n\n- [ ] **[principal]** None'
    expect(checkTestPlanExclusivity(body).status).toBe('fail')
  })

  it('ignores checkbox items in a pasted reference-brief copy outside the AEG:TEST-PLAN anchor (found live)', () => {
    // The template instructs pasting the dispatched brief verbatim as a
    // reference copy (a `<details>` block at the bottom of the PR body). A
    // brief whose REAL Test Plan is `unit-tests-only`, anchored, must not fail
    // just because that reference copy also contains tagged checkboxes —
    // `test-plan.ts`'s real merge-gate check already reads only the anchor;
    // this check disagreed about the same bytes until it did too.
    const body = [
      '<!-- AEG:TEST-PLAN:START -->',
      'Test Plan: unit-tests-only — pure parser change.',
      '<!-- AEG:TEST-PLAN:END -->',
      '',
      '<details><summary>Reference: dispatched brief</summary>',
      '',
      '- [ ] **[agent]** run the tests',
      '- [ ] **[principal]** eyeball it',
      '',
      '</details>'
    ].join('\n')
    expect(checkTestPlanExclusivity(body).status).toBe('pass')
  })
})

describe('checkPrincipalPlaceholder', () => {
  it('passes when no [principal] item exists at all', () => {
    expect(checkPrincipalPlaceholder('- [ ] **[agent]** run the tests').status).toBe('pass')
  })

  it('passes a legitimate [principal] item with real content', () => {
    const body = '- [ ] **[principal]** Sign in → upload a CV → CLEAN report with grade A/B/C/D'
    expect(checkPrincipalPlaceholder(body).status).toBe('pass')
  })

  it('fails a [principal] item whose content is a None placeholder (PR #363 regression)', () => {
    const body =
      '- [ ] **[principal]** None — this is a pure forge-query/detection-logic fix with no runtime/UI/auth surface.'
    const r = checkPrincipalPlaceholder(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/None.*placeholder/)
  })

  it('is case-insensitive on the None placeholder', () => {
    const body = '- [x] **[principal]** none — nothing to verify here'
    expect(checkPrincipalPlaceholder(body).status).toBe('fail')
  })

  it('ignores a None placeholder living only in a pasted reference-brief copy outside the anchor', () => {
    const body = [
      '<!-- AEG:TEST-PLAN:START -->',
      '- [ ] **[principal]** Sign in → upload a CV → CLEAN report with grade A/B/C/D',
      '<!-- AEG:TEST-PLAN:END -->',
      '',
      '<details><summary>Reference: dispatched brief</summary>',
      '',
      '- [ ] **[principal]** None — no runtime surface.',
      '',
      '</details>'
    ].join('\n')
    expect(checkPrincipalPlaceholder(body).status).toBe('pass')
  })

  it('O12: reports every placeholder line in one pass, not only the first', () => {
    const body = [
      '- [ ] **[principal]** None — no auth surface.',
      '- [ ] **[principal]** Sign in and verify the billing page.',
      '- [ ] **[principal]** none — nothing else to check.'
    ].join('\n')
    const r = checkPrincipalPlaceholder(body)
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(2)
    expect(r.errors[0]).toMatch(/no auth surface/)
    expect(r.errors[1]).toMatch(/nothing else to check/)
  })
})

describe('checkSurfaceMap', () => {
  it('passes when well-formed', () => {
    expect(checkSurfaceMap(WELL_FORMED).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkSurfaceMap('no such section').status).toBe('fail')
  })
})

describe('checkDocUpdateList', () => {
  it('passes when well-formed', () => {
    expect(checkDocUpdateList(WELL_FORMED).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkDocUpdateList('no such section').status).toBe('fail')
  })
})

describe('checkWorktreeStep0', () => {
  it('passes when a git worktree add command is present', () => {
    expect(checkWorktreeStep0(WELL_FORMED).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkWorktreeStep0('no worktree command here').status).toBe('fail')
  })
})

describe('checkStopConditions', () => {
  it('passes when well-formed', () => {
    expect(checkStopConditions(WELL_FORMED).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkStopConditions('no such section').status).toBe('fail')
  })
})

describe('checkAutonomyClause', () => {
  it('passes on the standing clause, bold-labeled', () => {
    expect(checkAutonomyClause(WELL_FORMED).status).toBe('pass')
  })
  it('tolerates whitespace/emphasis variance', () => {
    const body = 'Autonomy:   do NOT stop   to ask clarifying   questions.'
    expect(checkAutonomyClause(body).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkAutonomyClause('no autonomy clause here').status).toBe('fail')
  })
})

describe('checkClosesNPresence', () => {
  it('passes when Closes #N is present', () => {
    expect(checkClosesNPresence(WELL_FORMED).status).toBe('pass')
  })
  it('fails when missing', () => {
    expect(checkClosesNPresence('no closes reference').status).toBe('fail')
  })
  it("fails a body whose only Closes #N is inside an inline code span — GitHub won't auto-close it", () => {
    const result = checkClosesNPresence('Summary of the change. The bug: `Closes #5` was backticked.')
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('only inside a code span')
  })
  it('fails a body whose only Closes #N is inside a fenced block', () => {
    const result = checkClosesNPresence('Summary.\n\n```\nCloses #5\n```\n')
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('only inside a code span')
  })
  it('passes a bare Closes #N in prose', () => {
    expect(checkClosesNPresence('Ships the fix. Closes #5').status).toBe('pass')
  })
  it('passes a bare Closes #N inside the AEG:CLOSES anchor', () => {
    const body = 'Summary.\n\n<!-- AEG:CLOSES:START -->\nCloses #5\n<!-- AEG:CLOSES:END -->\n'
    expect(checkClosesNPresence(body).status).toBe('pass')
  })
  it('passes when a fenced example Closes #99 sits alongside a real bare Closes #5', () => {
    const body = 'Ships it. Closes #5\n\n```\nExample: Closes #99\n```\n'
    expect(checkClosesNPresence(body).status).toBe('pass')
  })
  it('fails a double-backtick-only Closes #N — GitHub sees a code span (PR #617 review)', () => {
    const result = checkClosesNPresence('See ``Closes #5`` here.')
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('only inside a code span')
  })
  it('fails a triple-backtick inline-only Closes #N', () => {
    expect(checkClosesNPresence('Ref: ```Closes #5``` inline.').status).toBe('fail')
  })
  it('does not over-strip a bare Closes #N sitting between two inline code spans', () => {
    // The lazy matched-run rule must close each span at its own delimiter,
    // never swallow the bare reference between them.
    expect(checkClosesNPresence('Use `a` then Closes #5 and `b`.').status).toBe('pass')
  })
  it('accepts the closed/fixed/resolved past-tense keywords (GitHub keyword set)', () => {
    for (const phrase of ['Closed #5', 'Fixed #5', 'Resolved #5']) {
      expect(checkClosesNPresence(phrase).status).toBe('pass')
    }
  })

  // ---- indented code blocks (PR #617 review, MINOR) ----
  it('fails a Closes #N that lives only in a 4-space indented code block', () => {
    const result = checkClosesNPresence('Summary of the change.\n\n    Closes #5\n')
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('only inside a code span')
  })
  it('fails a Closes #N in a tab-indented code block', () => {
    expect(checkClosesNPresence('Summary.\n\n\tCloses #5\n').status).toBe('fail')
  })
  it('fails only the indented copy — a real bare Closes #5 alongside it still passes', () => {
    expect(checkClosesNPresence('Ships it. Closes #5\n\n    Example: Closes #99\n').status).toBe('pass')
  })
  it('strips a multi-line indented block, not just its first line', () => {
    expect(checkClosesNPresence('Summary.\n\n    line one\n    Closes #5\n').status).toBe('fail')
  })

  // ---- over-strip guards: these must NOT be treated as code ----
  it('does NOT strip an indented Closes #N that is list-item continuation', () => {
    // 4-space indent under a list marker is list content, not code — GitHub
    // auto-closes it, so the gate must too.
    expect(checkClosesNPresence('- item\n\n    Closes #5\n').status).toBe('pass')
  })
  it('does NOT strip an indented line that merely continues a paragraph', () => {
    // No blank line before it => cannot be an indented code block.
    expect(checkClosesNPresence('Some running prose\n    Closes #5\n').status).toBe('pass')
  })
  it('resumes stripping after the list context closes at column 0', () => {
    expect(checkClosesNPresence('- item\n\nBack to prose.\n\n    Closes #5\n').status).toBe('fail')
  })

  // ---- fenced blocks: character + run length (PR #617 security pass, MEDIUM) ----
  it('fails a Closes #N inside a tilde fence', () => {
    expect(checkClosesNPresence('~~~\nCloses #5\n~~~').status).toBe('fail')
  })
  it('fails a Closes #N inside a tilde fence carrying an info string', () => {
    expect(checkClosesNPresence('~~~js\nCloses #5\n~~~').status).toBe('fail')
  })
  it('fails a Closes #N inside a six-backtick fence (run-length leak)', () => {
    expect(checkClosesNPresence('``````\nCloses #5\n``````').status).toBe('fail')
  })
  it('fails a Closes #N inside a backtick fence with an info string', () => {
    expect(checkClosesNPresence('```js\nCloses #5\n```').status).toBe('fail')
  })
  it('fails a Closes #N after an unclosed fence — GitHub renders it as code too', () => {
    expect(checkClosesNPresence('Summary.\n\n```\nCloses #5\n').status).toBe('fail')
  })
  it('does not let a short closing run terminate a longer fence', () => {
    // ``` cannot close ````` — the Closes stays inside the block.
    expect(checkClosesNPresence('`````\nCloses #5\n```\n').status).toBe('fail')
  })
  it('still treats a same-line triple-backtick as an inline span, not a fence', () => {
    expect(checkClosesNPresence('Ref ```Closes #5``` inline.').status).toBe('fail')
  })
  it('keeps a real bare Closes #5 that sits outside a tilde fence', () => {
    expect(checkClosesNPresence('Ships it. Closes #5\n\n~~~\nExample: Closes #99\n~~~\n').status).toBe('pass')
  })
})

/**
 * Exhaustive fence matrix — {backtick, tilde} × {3,4,6} × {LF, CRLF} ×
 * {closed, unclosed} × {info string, none}, plus the closer-length rules.
 *
 * Three successive fence bugs (double-backtick spans, then tilde/run-length,
 * then CRLF) each shipped a fix whose tests covered only the axis just
 * reported, leaving the next axis to be found in review. This table exists so
 * the axes are enumerated rather than discovered one incident at a time — add
 * a dimension here, not another one-off `it`.
 */
describe('checkClosesNPresence — fence matrix', () => {
  // Shapes come from the shared enumeration (`fixtures/fence-shapes.ts`), not a
  // local table: `anchored-region.test.ts` iterates the same list against
  // `maskCode`, so a dimension added there covers both consumers at once.
  for (const { name, open, close, eol } of fenceShapes()) {
    it(`${name}: closed fence hides Closes #5`, () => {
      expect(checkClosesNPresence(['Summary.', '', open, 'Closes #5', close, ''].join(eol)).status).toBe('fail')
    })

    it(`${name}: unclosed fence hides Closes #5 to EOF`, () => {
      expect(checkClosesNPresence(['Summary.', '', open, 'Closes #5'].join(eol)).status).toBe('fail')
    })

    it(`${name}: a real bare Closes #5 outside the fence still passes`, () => {
      const body = ['Ships it. Closes #5', '', open, 'Example: Closes #99', close, ''].join(eol)
      expect(checkClosesNPresence(body).status).toBe('pass')
    })

    it(`${name}: a longer closer still closes the fence`, () => {
      const longer = close[0]?.repeat(close.length + 2) as string
      const body = ['Ships it. Closes #5', '', open, 'x', longer, '', 'tail'].join(eol)
      expect(checkClosesNPresence(body).status).toBe('pass')
    })
  }

  // Rules below are properties of the fence *scanner* rather than of a shape,
  // so they stay here rather than multiplying the shared matrix.
  for (const [eolName, eol] of EOLS) {
    for (const [fenceName, ch] of FENCE_DELIMS) {
      it(`${eolName}/${fenceName}: a shorter run cannot close a longer fence`, () => {
        const body = ['Summary.', '', ch.repeat(5), 'Closes #5', ch.repeat(3), ''].join(eol)
        expect(checkClosesNPresence(body).status).toBe('fail')
      })

      it(`${eolName}/${fenceName}: fence indented up to 3 spaces still opens`, () => {
        const body = ['Summary.', '', `   ${ch.repeat(3)}`, 'Closes #5', `   ${ch.repeat(3)}`, ''].join(eol)
        expect(checkClosesNPresence(body).status).toBe('fail')
      })
    }

    it(`${eolName}: same-line triple backticks stay an inline span, not a fence`, () => {
      expect(checkClosesNPresence(['Ref ```Closes #5``` inline.'].join(eol)).status).toBe('fail')
    })

    it(`${eolName}: bare Closes #5 in the AEG:CLOSES anchor passes`, () => {
      const body = ['<!-- AEG:CLOSES:START -->', 'Closes #5', '<!-- AEG:CLOSES:END -->'].join(eol)
      expect(checkClosesNPresence(body).status).toBe('pass')
    })

    it(`${eolName}: indented code block hides Closes #5`, () => {
      expect(checkClosesNPresence(['Summary.', '', '    Closes #5', ''].join(eol)).status).toBe('fail')
    })

    it(`${eolName}: list-continuation Closes #5 is NOT treated as code`, () => {
      expect(checkClosesNPresence(['- item', '', '    Closes #5', ''].join(eol)).status).toBe('pass')
    })
  }
})

/**
 * Separator bound — `\s{0,8}` replaced `\s*` to kill the quadratic backtrack
 * two adjacent unbounded `\s*` groups produce (PR #617 security LOW). These
 * pin both halves of the trade: every realistic separator still matches, and
 * the pathological body no longer costs seconds.
 */
describe('checkClosesNPresence — separator bound', () => {
  it.each([
    ['no separator', 'Closes#5'],
    ['single space', 'Closes #5'],
    ['colon', 'Closes: #5'],
    ['colon, no space', 'Closes:#5'],
    ['newline', 'Closes\n#5'],
    ['eight spaces (the bound)', `Closes${' '.repeat(8)}#5`]
  ])('accepts %s', (_name, body) => {
    expect(checkClosesNPresence(body).status).toBe('pass')
  })

  it('rejects a separator past the bound rather than scanning unboundedly', () => {
    expect(checkClosesNPresence(`Closes${' '.repeat(40)}#5`).status).toBe('fail')
  })

  it('scans a 65k adversarial body in well under a second', () => {
    // GitHub's body cap is 65,536 chars. `closes` + all-whitespace + no `#` is
    // the worst case: pre-bound this measured ~2.65s, and `checkClosesNPresence` runs
    // the pattern twice on the fail path. Threshold is ~5x the observed
    // post-fix time, so it flags a reintroduced backtrack, not runner jitter.
    const body = `closes${' '.repeat(65_536)}`
    const started = performance.now()
    expect(checkClosesNPresence(body).status).toBe('fail')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('headerRegion', () => {
  it('returns everything before the first h2+ heading', () => {
    expect(headerRegion('Tier: 3\nProject: aeg\n\n## Summary\n\nbody')).toBe('Tier: 3\nProject: aeg\n\n')
  })
  it('returns the whole body when no h2+ heading exists', () => {
    expect(headerRegion('Tier: 3\nProject: aeg')).toBe('Tier: 3\nProject: aeg')
  })
  it('does not split on an h1 heading', () => {
    const body = '# Task Brief\n\nProject: aeg\n\n## Context'
    expect(headerRegion(body)).toBe('# Task Brief\n\nProject: aeg\n\n')
  })
})

describe('checkProjectField', () => {
  it('passes when a Project field is in the header block', () => {
    expect(checkProjectField(WELL_FORMED).status).toBe('pass')
  })
  it('accepts the plain and Project(s) label forms', () => {
    expect(checkProjectField('Project: aeg, aeg-core\n\n## Summary').status).toBe('pass')
    expect(checkProjectField('**Project(s):** aeg\n\n## Summary').status).toBe('pass')
  })
  it('fails when absent entirely', () => {
    const r = checkProjectField('Tier: 3\n\n## Summary\n\nno project field')
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/Project/)
  })
  it('fails when the field only appears in prose after a heading (#311 regression)', () => {
    const body = 'Tier: 3\n\n## Decisions made\n\n- The `Project:` field was omitted because reasons.'
    expect(checkProjectField(body).status).toBe('fail')
  })
})

describe('checkForField', () => {
  it('passes when a For field is in the header block', () => {
    expect(checkForField(WELL_FORMED).status).toBe('pass')
  })
  it('accepts the plain form', () => {
    expect(checkForField('For: Sonnet (dispatched)\n\n## Summary').status).toBe('pass')
  })
  it('fails when absent entirely', () => {
    const r = checkForField('Tier: 3\n\n## Summary')
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/For/)
  })
  it('does not false-positive on a sentence starting with "For"', () => {
    expect(checkForField('For example: this is prose, not a field\n\n## Summary').status).toBe('fail')
  })
})

describe('checkBriefSections', () => {
  it('passes every section on a well-formed brief when nothing is missing', () => {
    const { errors } = checkBriefSections(WELL_FORMED, readTierFromPrBody)
    expect(errors).toEqual([])
  })

  it('fails only the missing section when one is stripped out', () => {
    const withoutTestPlan = WELL_FORMED.replace(
      /## Test plan[\s\S]*?(?=## Scope)/,
      '## Test plan removed for this test\n\n'
    )
    const { errors } = checkBriefSections(withoutTestPlan, readTierFromPrBody)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Test Plan/)
  })

  it('fails Project and For when a body carries every gated section but drops the header fields (#311 regression)', () => {
    // PR #311's exact failure shape: the Developer satisfied every section the
    // gate checked and omitted the two it didn't. Gate-contract parity means
    // this body must now fail on exactly those two.
    const gamedBody = WELL_FORMED.replace(/\*\*For:\*\*[^\n]*\n/, '').replace(/\*\*Project:\*\*[^\n]*\n/, '')
    const { errors } = checkBriefSections(gamedBody, readTierFromPrBody)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/Project/)
    expect(errors[1]).toMatch(/For/)
  })
})

describe('isBriefShaped', () => {
  it('detects a real brief', () => {
    expect(isBriefShaped(WELL_FORMED)).toBe(true)
  })

  it('still detects a brief that is MISSING its documentation-update list', () => {
    // The exact live failure this gate exists for: a standalone fix brief
    // shipped with no §7 list. Detection must survive the omission it catches,
    // or the gate silently exempts precisely the bodies it should grade.
    const withoutDocList = WELL_FORMED.replace(/### 7\. Documentation-update list[\s\S]*?(?=### 10\.)/, '')
    expect(withoutDocList).not.toMatch(/Documentation-update list/)
    expect(isBriefShaped(withoutDocList)).toBe(true)
    expect(checkBriefSections(withoutDocList, readTierFromPrBody).errors).toEqual([
      expect.stringMatching(/Documentation-update list/)
    ])
  })

  it('does not detect an ordinary PR body — the exemption the bypass protects', () => {
    const dependencyBump =
      '## Summary\n\nBumps `zod` from 3.23.8 to 3.24.1.\n\n## Test plan\n\n- [ ] **[agent]** `bun test` passes.\n\n## Scope\n\nLockfile only.\n\n**Tier:** 0\n'
    expect(isBriefShaped(dependencyBump)).toBe(false)
  })

  it('does not detect a body carrying exactly one marker', () => {
    const oneMarker = '## Stop conditions\n\n- Something went wrong.\n'
    expect(isBriefShaped(oneMarker)).toBe(false)
  })

  it.each(fenceShapes())(
    'does not detect a brief QUOTED inside a fence ($name) — discussing a brief is not carrying one',
    ({ open, close, eol }) => {
      const quoted = [
        '## Summary',
        '',
        "Documents the brief grammar. Here's a sample brief:",
        '',
        open,
        '## Technical surface map',
        '- `packages/aeg-core/src/brief-validation.ts`',
        '',
        '## Stop conditions',
        '- Pre-flight failure.',
        '',
        '**Autonomy:** Do not stop to ask clarifying questions.',
        close,
        ''
      ].join(eol)
      expect(isBriefShaped(quoted)).toBe(false)
    }
  )
})

describe('inferBranchFromBody', () => {
  it('reads the branch from the Step 0 worktree command inside a fence', () => {
    expect(inferBranchFromBody(WELL_FORMED)).toBe('task/aeg-governance-hardening/2')
  })
  it('reads a non-task branch the same way', () => {
    expect(inferBranchFromBody('git worktree add .worktrees/fix/x -b fix/x origin/main')).toBe('fix/x')
  })
  it('returns empty when the body has no Step 0', () => {
    expect(inferBranchFromBody('## Summary\n\nA dependency bump.')).toBe('')
  })
})

describe('checkBriefSections — requireClosesN', () => {
  const withoutCloses = WELL_FORMED.replace('Closes #252', 'Ships it.')

  it('requires Closes #N by default (every existing caller is unchanged)', () => {
    const { errors } = checkBriefSections(withoutCloses, readTierFromPrBody)
    expect(errors).toEqual([expect.stringMatching(/Closes #N/)])
  })

  it('skips Closes #N when requireClosesN is false — a standalone fix brief has no Issue to close', () => {
    const { errors } = checkBriefSections(withoutCloses, readTierFromPrBody, { requireClosesN: false })
    expect(errors).toEqual([])
  })

  it('still grades every other section when requireClosesN is false', () => {
    const withoutDocList = withoutCloses.replace(/### 7\. Documentation-update list[\s\S]*?(?=### 10\.)/, '')
    const { errors } = checkBriefSections(withoutDocList, readTierFromPrBody, { requireClosesN: false })
    expect(errors).toEqual([expect.stringMatching(/Documentation-update list/)])
  })
})

describe('checkForgeTitle', () => {
  it('passes commit-style titles with and without scope', () => {
    expect(checkForgeTitle('Fix(aeg): Gate-contract parity for Project/For').status).toBe('pass')
    expect(checkForgeTitle('Docs: Update the readme').status).toBe('pass')
    expect(checkForgeTitle('Plan(aeg): Add task 5d — post-merge Archivist').status).toBe('pass')
  })
  it('passes task-style titles', () => {
    expect(checkForgeTitle('[aeg-governance-hardening] 5d — Post-merge Archivist automation').status).toBe('pass')
    expect(checkForgeTitle('[aeg-studio-cleanup] 2 — Remove dependency-graph + board view').status).toBe('pass')
  })
  it('fails freeform titles', () => {
    expect(checkForgeTitle('fixed some stuff').status).toBe('fail')
    expect(checkForgeTitle('WIP do not merge').status).toBe('fail')
    expect(checkForgeTitle('feat: lowercase type').status).toBe('fail')
  })
  it('fails a bare type with no description', () => {
    expect(checkForgeTitle('Fix: ').status).toBe('fail')
  })
})

describe('checkPlanPrNoCloses', () => {
  it('fails a plan/* branch whose body carries Closes #N', () => {
    const result = checkPlanPrNoCloses('plan/aeg-consolidation', 'This plan adds tasks. Closes #123')
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toMatch(/plan-PR guard/)
  })

  it('passes a plan/* branch whose body has no Closes reference', () => {
    const result = checkPlanPrNoCloses('plan/aeg-consolidation', 'This plan adds tasks 1-5 to the topology.')
    expect(result.status).toBe('pass')
    expect(result.errors).toEqual([])
  })

  it('passes a task/* branch with Closes #N — unaffected by the guard', () => {
    const result = checkPlanPrNoCloses('task/aeg-governance-hardening/5d', 'Ships the thing. Closes #309')
    expect(result.status).toBe('pass')
    expect(result.errors).toEqual([])
  })

  it('passes a non-plan, non-task branch regardless of body', () => {
    const result = checkPlanPrNoCloses('fix/something', 'Fixes a bug. Closes #1')
    expect(result.status).toBe('pass')
  })

  it('is case-insensitive on the Closes keyword', () => {
    const result = checkPlanPrNoCloses('plan/x', 'this CLOSES #42 is bad')
    expect(result.status).toBe('fail')
  })
})

describe('checkPremiseCoverage', () => {
  it('passes trivially when surfaceFiles is empty (no code surface to pin)', () => {
    const result = checkPremiseCoverage('no premise section at all', [])
    expect(result.status).toBe('pass')
  })

  it('passes when a Premise assertion path matches a surface file', () => {
    const body = `**Premise:**
- src/dispatch-gate.ts contains: export function checkDispatchReadiness
`
    const result = checkPremiseCoverage(body, ['src/dispatch-gate.ts', 'src/dispatch-gate.test.ts'])
    expect(result.status).toBe('pass')
  })

  it('fails when there is a code surface but no matching Premise assertion', () => {
    const result = checkPremiseCoverage('no premise section at all', ['src/dispatch-gate.ts'])
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('Premise')
  })

  it('fails when a Premise assertion exists but pins an unrelated path', () => {
    const body = `**Premise:**
- src/unrelated.ts contains: something
`
    const result = checkPremiseCoverage(body, ['src/dispatch-gate.ts'])
    expect(result.status).toBe('fail')
  })
})

describe('checkNoUnpinnedCodeClaims', () => {
  it('fails on a bare file:line reference outside Premise and outside a fence (PR #382 shape)', () => {
    const body =
      'one intentional exception: `aeg-root/contracts/security-archivist.md:88` still says a merged finding "means a deviation was approved"'
    const result = checkNoUnpinnedCodeClaims(body)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('security-archivist.md:88')
  })

  it('passes the same fact pinned in Premise instead of pointed at', () => {
    const body = `one intentional exception, pinned below.

**Premise:**
- aeg-root/contracts/security-archivist.md contains: means a deviation was approved
`
    const result = checkNoUnpinnedCodeClaims(body)
    expect(result.status).toBe('pass')
  })

  it('passes a file:line reference inside a fenced code block', () => {
    const body = `See the composer body below; no bare reference appears in this prose.

\`\`\`
packages/aeg-core/src/brief-validation.ts:490
\`\`\`
`
    const result = checkNoUnpinnedCodeClaims(body)
    expect(result.status).toBe('pass')
  })

  it('passes a file:line reference inside the Premise: block', () => {
    const body = `See below.

**Premise:**
- packages/aeg-core/src/brief-validation.ts:490 contains: export function checkBriefSections(
`
    const result = checkNoUnpinnedCodeClaims(body)
    expect(result.status).toBe('pass')
  })
})

describe('checkCommandsCarryOutput', () => {
  it('fails when a §6 command block has no fenced output block after it', () => {
    const body = `
### 6. Numbered parts

1. Run this:

\`\`\`
grep -n "foo" bar.ts
\`\`\`
`
    const result = checkCommandsCarryOutput(body)
    expect(result.status).toBe('fail')
  })

  it('passes when the same command block is followed by an output block', () => {
    const body = `
### 6. Numbered parts

1. Run this:

\`\`\`
grep -n "foo" bar.ts
\`\`\`

Output:

\`\`\`
3:foo
\`\`\`
`
    const result = checkCommandsCarryOutput(body)
    expect(result.status).toBe('pass')
  })

  it('passes the Step 0 block alone, with nothing fenced after it', () => {
    const body = `
### 5. Pre-flight checks

Step 0 (mandatory, verbatim):

\`\`\`
git worktree add .worktrees/task/x/1 -b task/x/1 origin/main
\`\`\`
`
    const result = checkCommandsCarryOutput(body)
    expect(result.status).toBe('pass')
  })

  it('fails three undocumented command blocks with only a trailing output fence (round-2 ruling item 1)', () => {
    const body = `
### 6. Numbered parts

\`\`\`
grep -n "a" one.ts
\`\`\`

\`\`\`
grep -n "b" two.ts
\`\`\`

\`\`\`
grep -n "c" three.ts
\`\`\`

\`\`\`
3:c
\`\`\`
`
    const result = checkCommandsCarryOutput(body)
    expect(result.status).toBe('fail')
    // The first two command blocks are each "followed" only by another
    // command block — neither is satisfied by the trailing output fence.
    expect(result.errors).toHaveLength(2)
  })
})

describe('checkConsumerTests', () => {
  const consumersOfAegForgeState = (pkg: string): string[] => (pkg === 'aeg-forge-state' ? ['packages/aeg-core'] : [])

  const surfaceMap = (extra: string): string => `
### 4. Technical surface map

- Modify \`packages/aeg-forge-state/src/x.ts\`.
${extra}
`

  it('fails when a named consumer has no test path and no sentinel', () => {
    const result = checkConsumerTests(surfaceMap(''), consumersOfAegForgeState)
    expect(result.status).toBe('fail')
  })

  it('passes when a consumer test path is named', () => {
    const body = surfaceMap('- `packages/aeg-core/src/dispatch-gate.test.ts` already covers this.')
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('pass')
  })

  it('passes with the consumer-tests sentinel', () => {
    const body = surfaceMap('\nconsumer-tests: none — no consumer-visible behavior changed.')
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('pass')
  })

  it('passes trivially when no §4 section exists', () => {
    const result = checkConsumerTests('no surface map here', consumersOfAegForgeState)
    expect(result.status).toBe('pass')
  })

  it("does not treat the sentinel grammar QUOTED outside §4 as an opt-out (this task's own brief shape)", () => {
    const body = `
Some prose describing the rule, quoting its own grammar as an example:
the sentinel line \`consumer-tests: none — <reason>\`.

${surfaceMap('')}
`
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('fail')
  })

  // task 17, O6 — a bare `tests`/`specs` directory reference is coverage too,
  // for the same shape `brief-render.ts` now renders when `boundaryNarrowsSurface`
  // hides the covering FILE from §4's own Modify list.
  it('passes when a consumer test DIRECTORY is named, not a file', () => {
    const body = surfaceMap('- consumer-tests: packages/aeg-core/tests (covers @attalabs/aeg-forge-state)')
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('pass')
  })

  it('passes when a nested consumer test directory is named', () => {
    const body = surfaceMap('- consumer-tests: packages/aeg-core/tests/checks (covers @attalabs/aeg-forge-state)')
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('pass')
  })

  it('a directory merely named "testsuite" is NOT accepted — segment equality, never a substring test', () => {
    const body = surfaceMap('- consumer-tests: packages/aeg-core/testsuite (covers @attalabs/aeg-forge-state)')
    const result = checkConsumerTests(body, consumersOfAegForgeState)
    expect(result.status).toBe('fail')
  })
})

describe('checkDefeatCases', () => {
  it('fails when §4 names a check with no Defeat cases: line in §6', () => {
    const body = `
### 4. Technical surface map

- Create \`apps/cli/src/checks/bin/check-doctrine-no-procedures.ts\`.

### 6. Numbered parts

1. Wire the registry entry.
`
    const result = checkDefeatCases(body)
    expect(result.status).toBe('fail')
  })

  it('passes when §6 carries a Defeat cases: line', () => {
    const body = `
### 4. Technical surface map

- Create \`apps/cli/src/checks/bin/check-doctrine-no-procedures.ts\`.

### 6. Numbered parts

1. Wire the registry entry.

Defeat cases: a fenced block with two commands inside the AEG:VENDOR-EXAMPLE anchor must still pass.
`
    const result = checkDefeatCases(body)
    expect(result.status).toBe('pass')
  })
})

describe('partitionBriefErrorsByRollout', () => {
  const CONSUMER_TESTS_ERROR = 'brief-validation consumer tests: §4 names a path under packages/x/ …'
  const UNRELATED_ERROR = 'brief-validation tier: no `Tier:` field found in the PR body …'

  it('grandfathers a rule finding, never failing, on a PR below BRIEF_RULES_SINCE_PR', () => {
    const result = partitionBriefErrorsByRollout([CONSUMER_TESTS_ERROR], BRIEF_RULES_SINCE_PR - 1)
    expect(result.blocking).toEqual([])
    expect(result.info).toEqual([CONSUMER_TESTS_ERROR])
  })

  it('blocks the same finding at or above BRIEF_RULES_SINCE_PR', () => {
    const result = partitionBriefErrorsByRollout([CONSUMER_TESTS_ERROR], BRIEF_RULES_SINCE_PR)
    expect(result.blocking).toEqual([CONSUMER_TESTS_ERROR])
    expect(result.info).toEqual([])
  })

  it('never grandfathers an unrelated error, even below the cutoff', () => {
    const result = partitionBriefErrorsByRollout([UNRELATED_ERROR], BRIEF_RULES_SINCE_PR - 1)
    expect(result.blocking).toEqual([UNRELATED_ERROR])
    expect(result.info).toEqual([])
  })

  it('is fail-closed on a null (missing/unparseable) PR number', () => {
    const result = partitionBriefErrorsByRollout([CONSUMER_TESTS_ERROR], null)
    expect(result.blocking).toEqual([CONSUMER_TESTS_ERROR])
    expect(result.info).toEqual([])
  })

  const AGENT_BOXES_ERROR = 'brief-validation no agent boxes: the Test Plan carries a checkbox …'

  it('grandfathers a no-agent-boxes finding on a PR below AGENT_BOXES_REFUSED_SINCE_PR, independent of BRIEF_RULES_SINCE_PR', () => {
    const result = partitionBriefErrorsByRollout([AGENT_BOXES_ERROR], AGENT_BOXES_REFUSED_SINCE_PR - 1)
    expect(result.blocking).toEqual([])
    expect(result.info).toEqual([AGENT_BOXES_ERROR])
  })

  it('blocks a no-agent-boxes finding at or above AGENT_BOXES_REFUSED_SINCE_PR', () => {
    const result = partitionBriefErrorsByRollout([AGENT_BOXES_ERROR], AGENT_BOXES_REFUSED_SINCE_PR)
    expect(result.blocking).toEqual([AGENT_BOXES_ERROR])
    expect(result.info).toEqual([])
  })

  it('the two thresholds are independent: a PR between them grandfathers only the newer rule', () => {
    const between = AGENT_BOXES_REFUSED_SINCE_PR - 1
    expect(between).toBeGreaterThanOrEqual(BRIEF_RULES_SINCE_PR)
    const result = partitionBriefErrorsByRollout([CONSUMER_TESTS_ERROR, AGENT_BOXES_ERROR], between)
    expect(result.blocking).toEqual([CONSUMER_TESTS_ERROR])
    expect(result.info).toEqual([AGENT_BOXES_ERROR])
  })
})

describe('checkNoAgentBoxes', () => {
  it('fails on a checkbox [agent] item', () => {
    const body = '## Test plan\n\n- [ ] **[agent]** `bun test` passes.\n\n## Scope\n'
    const result = checkNoAgentBoxes(body)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toMatch(/no agent boxes/)
  })

  it('fails on an already-ticked checkbox [agent] item too', () => {
    const body = '## Test plan\n\n- [x] **[agent]** `bun test` passes.\n\n## Scope\n'
    expect(checkNoAgentBoxes(body).status).toBe('fail')
  })

  it('passes a fenced [agent] command list', () => {
    const body = '## Test plan\n\n```\nbun test → 0 fail\n```\n\n## Scope\n'
    expect(checkNoAgentBoxes(body).status).toBe('pass')
  })

  it('passes a checkbox [principal] item alongside a fenced [agent] list — only [agent] boxes are refused', () => {
    const body = '## Test plan\n\n```\nbun test → 0 fail\n```\n- [ ] **[principal]** Reviewed in browser.\n\n## Scope\n'
    expect(checkNoAgentBoxes(body).status).toBe('pass')
  })

  it('passes the unit-tests-only sentinel', () => {
    expect(checkNoAgentBoxes('Test Plan: unit-tests-only').status).toBe('pass')
  })
})

// Issue #411's real live `## Objectives` section, verbatim (`gh issue view 411`,
// dev-review-loop-v1 task 1 authoring time) — the same Issue this brief itself
// closes, so these tests prove the gates accept the brief that dispatched them.
const ISSUE_411_OBJECTIVES = `## Objectives

O1. A task Issue carries a \`## Objectives\` section of numbered \`O<n>.\` lines, one observable sentence each; \`vinaya issue create\` and \`vinaya issue edit\` refuse a task Issue without it, for Issues numbered from this tranche's first Issue onward; \`checkIssueRationale\` and \`vinaya check coherence\` grade the same rule.
O2. \`objectivesOf(body)\` in \`@attalabs/aeg-core\` parses the list and \`objectivesVersion(list)\` returns a stable hash of its text; both are the only readers every later consumer uses.
O3. A brief carries the Issue's \`## Objectives\` byte-for-byte; every numbered Part cites at least one \`O<n>\` and every \`O<n>\` is cited by at least one Part; \`verify-brief\` and \`brief-shape\` refuse otherwise, and \`vinaya brief render\` emits the section from the Issue.
O4. \`aeg-root/roles/planner.md\`, \`aeg-root/roles/brief-author.md\`, \`aeg-root/templates/issue-rationale-template.md\` and \`aeg-root/templates/brief-template.md\` state the rule in the same words the gates enforce.
`

/** A minimal §6 shape matching this task's own dispatched brief: Parts 1-4 each cite one objective, Part 5 (an administrative changeset/push step) cites none. */
const SECTION_6 = `## 6. Numbered parts — commit after EACH part; push once, before opening the PR

Part 1 (O2) — the parser.
Part 2 (O1) — the Issue gate.
Part 3 (O3) — the brief side.
Part 4 (O4) — doctrine.
Part 5 — changeset. Then the one push.
`

const SELF_CONSISTENT_BRIEF = `${ISSUE_411_OBJECTIVES}\n${SECTION_6}`

/** `objectivesOf` for a body known (by test construction) to be well-formed — throws loudly otherwise, never silently degrading a test fixture into an empty list. */
function objectivesOfOrThrow(body: string): Objective[] {
  const result = objectivesOf(body)
  if (!result.ok) throw new Error(`test fixture's own \`## Objectives\` failed to parse: ${result.errors.join('; ')}`)
  return result.objectives
}

describe('checkObjectivesCopy', () => {
  it("passes this brief's own body against Issue #411", () => {
    const objectives = objectivesOfOrThrow(ISSUE_411_OBJECTIVES)
    expect(checkObjectivesCopy(SELF_CONSISTENT_BRIEF, objectives).status).toBe('pass')
  })

  it('is insensitive to trailing whitespace (normalised-line comparison)', () => {
    const objectives = objectivesOfOrThrow(ISSUE_411_OBJECTIVES)
    const reflowed = SELF_CONSISTENT_BRIEF.replace('O1.', 'O1.  ').replace(/\n$/, '   \n')
    expect(checkObjectivesCopy(reflowed, objectives).status).toBe('pass')
  })

  it('is refused when one objective line is removed', () => {
    const objectives = objectivesOfOrThrow(ISSUE_411_OBJECTIVES)
    const withoutO4 = SELF_CONSISTENT_BRIEF.replace(/O4\.[^\n]*\n/, '')
    const result = checkObjectivesCopy(withoutO4, objectives)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toMatch(/objectives copy/)
  })
})

describe('checkObjectivesCoverage', () => {
  it("passes this brief's own §6 — Part 5 (administrative, no citation) does not break coverage", () => {
    expect(checkObjectivesCoverage(SELF_CONSISTENT_BRIEF).status).toBe('pass')
  })

  it('is refused when Part 3 is stripped of its (O3) citation — O3 becomes uncited', () => {
    const stripped = SELF_CONSISTENT_BRIEF.replace('Part 3 (O3) — the brief side.', 'Part 3 — the brief side.')
    const result = checkObjectivesCoverage(stripped)
    expect(result.status).toBe('fail')
    expect(result.errors.join(' ')).toMatch(/O3 is not cited/)
  })

  it('is refused when a Part cites an objective past the end of the list', () => {
    const overCited = SELF_CONSISTENT_BRIEF.replace('Part 4 (O4)', 'Part 4 (O9)')
    const result = checkObjectivesCoverage(overCited)
    expect(result.status).toBe('fail')
    expect(result.errors.join(' ')).toMatch(/cites O9, but the Objectives section ends at O4/)
    // O4 itself is now uncited too — both halves of coverage fire independently.
    expect(result.errors.join(' ')).toMatch(/O4 is not cited/)
  })
})

describe('briefMarkerFor / parseBriefMarkerVersion (task-run-v1 task 4, #483, O3)', () => {
  it('round-trips version numbers through the marker line', () => {
    expect(briefMarkerFor(1)).toBe('<!-- aeg:brief:v1 -->')
    expect(briefMarkerFor(2)).toBe('<!-- aeg:brief:v2 -->')
    expect(parseBriefMarkerVersion('<!-- aeg:brief:v1 -->')).toBe(1)
    expect(parseBriefMarkerVersion('<!-- aeg:brief:v2 -->')).toBe(2)
    expect(parseBriefMarkerVersion('<!-- aeg:brief:v12 -->')).toBe(12)
  })

  it('rejects a v0 marker and any non-marker-shaped line', () => {
    expect(parseBriefMarkerVersion('<!-- aeg:brief:v0 -->')).toBeNull()
    expect(parseBriefMarkerVersion('not a marker')).toBeNull()
    expect(parseBriefMarkerVersion('<!-- aeg:principal:ruling -->')).toBeNull()
  })
})

describe('contentAfterNLines / frozenBriefContent', () => {
  it('contentAfterTwoLines is contentAfterNLines(body, 2) — same behavior, unchanged v1 contract', () => {
    const body = '<!-- aeg:brief:v1 -->\nBrief hash: abc\nThe brief text.\n'
    expect(contentAfterTwoLines(body)).toBe(contentAfterNLines(body, 2))
    expect(contentAfterTwoLines(body)).toBe('The brief text.\n')
  })

  it('frozenBriefContent strips two header lines for v1, three for v2+ (the Supersedes line)', () => {
    const v1 = '<!-- aeg:brief:v1 -->\nBrief hash: abc\nThe v1 brief text.\n'
    expect(frozenBriefContent(v1, 1)).toBe('The v1 brief text.\n')

    const v2 =
      '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: https://github.com/acme/widget/issues/1#issuecomment-1 — wrong tier\nThe v2 brief text.\n'
    expect(frozenBriefContent(v2, 2)).toBe('The v2 brief text.\n')
  })
})

describe('resolveNewestFrozenBrief (task-run-v1 task 4, #483, O3) — the single frozen-brief resolver', () => {
  const ALLOWLIST = ['a-principal']

  it('returns null when no comment is marker-shaped', () => {
    expect(resolveNewestFrozenBrief([{ body: 'just a comment', author: 'a-principal' }], ALLOWLIST)).toBeNull()
  })

  it('returns null when the only marker-shaped comment is not principal-authored', () => {
    const comments = [{ body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nbrief text', author: 'random-collaborator' }]
    expect(resolveNewestFrozenBrief(comments, ALLOWLIST)).toBeNull()
  })

  it('picks the newest version among several principal-authored frozen-brief comments, never the first posted', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nfirst version', author: 'a-principal' },
      { body: 'unrelated chatter', author: 'a-principal' },
      {
        body: '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: url — wrong tier\nsecond version',
        author: 'a-principal'
      }
    ]
    const resolved = resolveNewestFrozenBrief(comments, ALLOWLIST)
    expect(resolved?.version).toBe(2)
    expect(resolved?.content).toBe('second version')
  })

  it('ignores a marker-shaped comment from a non-principal even when it claims a higher version', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nreal version', author: 'a-principal' },
      { body: '<!-- aeg:brief:v9 -->\nBrief hash: xyz\nSupersedes: url — fake\nforged version', author: 'an-impostor' }
    ]
    const resolved = resolveNewestFrozenBrief(comments, ALLOWLIST)
    expect(resolved?.version).toBe(1)
    expect(resolved?.content).toBe('real version')
  })

  it('carries through extra fields on the candidate (e.g. url) unchanged', () => {
    const comments = [
      {
        body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nbrief text',
        author: 'a-principal',
        url: 'https://github.com/acme/widget/issues/1#issuecomment-1'
      }
    ]
    const resolved = resolveNewestFrozenBrief(comments, ALLOWLIST)
    expect(resolved?.url).toBe('https://github.com/acme/widget/issues/1#issuecomment-1')
  })
})

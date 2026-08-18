import { describe, expect, it } from 'bun:test'
import { checkBareDigits } from '../../src/checks/body-bare-digits-logic'

function violationLines(body: string): number[] {
  return checkBareDigits(body).violations.map((v) => v.line)
}

// ---------- must NOT fail — identifier shapes named in the brief (§1) ----------

describe('body-bare-digits — must NOT fail: identifier shapes', () => {
  it('an Issue/PR reference', () => {
    expect(violationLines('See #135 for the original report.')).toEqual([])
  })

  it('a date', () => {
    expect(violationLines('Fixed on 2026-08-18, verified the same day.')).toEqual([])
  })

  it('a dotted version string', () => {
    expect(violationLines('Bumped @attalabs/aeg-types to 0.12.0 in this pass.')).toEqual([])
  })

  it('a file path segment', () => {
    expect(violationLines('Updated packages/aeg-forge-state/src/strip-code.ts for this task.')).toEqual([])
  })

  it('a section number', () => {
    expect(violationLines('See Section 9 for the full rationale behind this call.')).toEqual([])
  })

  it('an inline-code symbol reference', () => {
    expect(violationLines('Set `Tier: 1` in the header, per convention.')).toEqual([])
  })

  it('a fenced code block', () => {
    const body = ['Ran the suite.', '', '```', '163 pass, 0 fail', '```'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('an indented code block', () => {
    const body = ['Example output:', '', '    163 pass, 0 fail'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('a digit inside an AEG:TIER anchor', () => {
    const body = ['## Scope', '', '<!-- AEG:TIER:START -->', '**Tier:** 1', '<!-- AEG:TIER:END -->'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('a digit inside an AEG:EVIDENCE anchor (owned by evidence-fresh, not this check)', () => {
    const body = [
      '<!-- AEG:EVIDENCE:START -->',
      'Head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '```',
      '2\t1\tfile.ts',
      '```',
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('a markdown ordered-list marker', () => {
    const body = ['1. First decision.', '2. Second decision.', '3. Third decision.'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('the **For:** header field (model name + version)', () => {
    expect(violationLines('**For:** Sonnet 5 (Claude Code CLI), dispatched locally, unattended')).toEqual([])
  })

  it('a Round/Section/Part/exit ordinal label', () => {
    const body = [
      'Round 2 found nothing new.',
      'See Section 9 and Parts 1–3 for context.',
      'The process exits with exit 0 on success.'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('a letter-led identifier (check code, hyphenated model id)', () => {
    expect(violationLines('C5 flags the gap; claude-sonnet-5 ran this task.')).toEqual([])
  })

  it('a URL/markdown link carrying digits', () => {
    expect(
      violationLines('Filed as [comment](https://github.com/atta-labs/vinaya/issues/77#issuecomment-5329908188).')
    ).toEqual([])
  })
})

// ---------- must NOT fail — verbatim excerpts from real, merged PR bodies ----------

describe('body-bare-digits — must NOT fail: verbatim real-body excerpts', () => {
  it('PR #129 header block (Closes/For/Project anchors)', () => {
    const body = [
      '<!-- AEG:CLOSES:START -->',
      'Closes #73',
      '<!-- AEG:CLOSES:END -->',
      '',
      '**For:** Claude Sonnet 5 (Claude Code CLI, dispatched locally, unattended)',
      '<!-- AEG:PROJECT:START -->',
      '**Project:** aeg-core, cli, vinaya',
      '<!-- AEG:PROJECT:END -->'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('PR #129 Token report table row', () => {
    const body = [
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      '| 73: develop | Developer | claude-sonnet-5 | 24440002 | 74174 | — | 2026-08-18 |'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('PR #129 Summary prose (Issue cross-references)', () => {
    const body =
      '**#71 is a duplicate of #73.** Both report the same defect: the gate resolves verdicts by recency and neither carries the commit it was written against.'
    expect(violationLines(body)).toEqual([])
  })

  it('PR #136 doc-owners Summary prose (check codes + Issue refs)', () => {
    const body =
      "`vinaya doctor` now walks every `.vinaya/doc-owners` binding against the repo's full tracked-file list and flags two silent gaps C5 (`evaluateC5`) structurally cannot see on its own — Issue #77's own measured example."
    expect(violationLines(body)).toEqual([])
  })

  it('PR #136 failure-shape prose (labeled ordinal, no count)', () => {
    const body =
      "**Scope statement (§2/§9, stated plainly, not implied):** this task builds failure shape 1 only. It does not build failure shape 2 — see the Summary's scope statement."
    expect(violationLines(body)).toEqual([])
  })

  it('the collapsed <details> reference-brief wrapper, opening on the pasted brief', () => {
    const body = [
      '## Reference — the dispatched brief',
      '',
      '<details>',
      '<summary>Full brief (reference copy — the gates read the anchored fields above, never this block)</summary>',
      '',
      '# Bind a review verdict to the commit it covered (Issue #73)',
      '',
      '**For:** Opus (a coding-agent CLI on a dev machine, dispatched locally, unattended)',
      '',
      '1. Commit sha, not tree hash. 33 seconds apart is still the same commit.',
      '',
      '</details>'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })
})

// ---------- must fail — the three real claims named in the brief, plus synthetic shapes ----------

describe('body-bare-digits — must fail: narrative quantitative claims', () => {
  it('a stale test-count claim (real incident #1: "138 passed" vs a real count of 163)', () => {
    expect(violationLines('All 138 tests passed after this change.').length).toBeGreaterThan(0)
  })

  it('an unpaired pre-existing-failure count claim (real incident #2)', () => {
    expect(violationLines('There are 2 pre-existing failing areas unrelated to this change.').length).toBeGreaterThan(0)
  })

  it('a timing figure describing reverted code (real incident #3: "0.02ms")', () => {
    expect(violationLines('The debounce now resolves in 0.02ms.').length).toBeGreaterThan(0)
  })

  it('a percentage claim (synthetic)', () => {
    expect(violationLines('Coverage increased by 12% in this pass.').length).toBeGreaterThan(0)
  })

  it('a bug-count claim (synthetic)', () => {
    expect(violationLines('Fixed 7 bugs in this pass.').length).toBeGreaterThan(0)
  })

  it('a duration claim (synthetic)', () => {
    expect(violationLines('The build now completes in 4 minutes.').length).toBeGreaterThan(0)
  })

  it('a severity tally in unfenced prose, real (#126): "0 BLOCKER, 1 MAJOR, 6 MINOR"', () => {
    expect(
      violationLines('Round 2 (0 BLOCKER, 1 MAJOR, 6 MINOR) and the security pass (PASS, 1 MEDIUM) were addressed.')
        .length
    ).toBeGreaterThan(0)
  })

  it('does not exempt a genuine count merely because a labeled ordinal appears earlier on the same line', () => {
    // "Round 2" is a real, exempt label — it must not launder the
    // comma-separated tally that follows it into looking labeled too.
    const body = 'Round 2 (0 BLOCKER, 1 MAJOR, 6 MINOR) were found.'
    const violations = checkBareDigits(body).violations
    expect(violations.length).toBeGreaterThan(0)
  })
})

// ---------- <details> masking — nesting, siblings, decoys, unterminated ----------

describe('body-bare-digits — <details> block masking', () => {
  it('exempts nested <details> blocks entirely', () => {
    const body = [
      '<details>',
      '<summary>Outer</summary>',
      '',
      '138 passed in the outer example.',
      '',
      '<details>',
      '<summary>Inner</summary>',
      '',
      '163 passed in the inner example.',
      '',
      '</details>',
      '',
      '</details>'
    ].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('exempts multiple sibling <details> blocks independently', () => {
    const body = [
      '<details><summary>A</summary>',
      '',
      '138 passed.',
      '',
      '</details>',
      '',
      'Live claim: 42 regressions found.',
      '',
      '<details><summary>B</summary>',
      '',
      '163 passed.',
      '',
      '</details>'
    ].join('\n')
    // the live claim BETWEEN the two <details> siblings must still fire —
    // proves sibling masking doesn't over-mask the gap between them.
    expect(violationLines(body).length).toBe(1)
  })

  it('a <details> tag quoted inside a fenced code block never opens a real region', () => {
    const body = [
      'Example of the convention:',
      '',
      '```',
      '<details><summary>example</summary>138 passed</details>',
      '```',
      '',
      '42 regressions found, unfenced and for real.'
    ].join('\n')
    // The decoy tag inside the fence must not swallow the real, unfenced
    // claim that follows it — proves maskCode really runs before
    // maskDetailsBlocks, not the reverse.
    expect(violationLines(body).length).toBe(1)
  })

  it("an unterminated <details> fails closed — masks to end of body, matching GitHub's own rendering", () => {
    const body = ['<details>', '<summary>Never closed</summary>', '', '138 passed, never fenced.'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('a stray unmatched </details> with no opener is left untouched (inert, not a region boundary)', () => {
    const body = ['138 passed.', '', '</details>', '', '163 passed.'].join('\n')
    expect(violationLines(body).length).toBe(2)
  })
})

// ---------- Token report section masking ----------

describe('body-bare-digits — Token report section masking', () => {
  it('exempts the whole Token report table, heading to next heading', () => {
    const body = [
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      '| 42: develop | Developer | claude-sonnet-5 | 12345678 | 90123 | — | 2026-08-19 |',
      '',
      '## Reference — the dispatched brief',
      '',
      '163 passed, cited outside the Token report section.'
    ].join('\n')
    // the live claim AFTER the next heading must still fire — proves the
    // section mask stops at the next heading rather than running to EOF.
    expect(violationLines(body).length).toBe(1)
  })
})

// ---------- mutation proof: exemption logic is load-bearing, not decorative ----------

describe('body-bare-digits — mutation proof (brief §8 Test Plan item 3)', () => {
  it('a real Issue ref + date pass the real check, but would trip a naive unclassified digit scan', () => {
    const body = 'See #135 for the original report, filed on 2026-08-18.'
    expect(checkBareDigits(body).violations).toEqual([])
    // Reproduces exactly what body-bare-digits would do if its exemption
    // classification were deleted (the § Part 3 mutation this proves
    // against): every digit-bearing token counts, with no identifier-shape
    // carve-out at all.
    const naiveHits = body.match(/\S*\d\S*/g) ?? []
    expect(naiveHits.length).toBeGreaterThan(0)
  })
})

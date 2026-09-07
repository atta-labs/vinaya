import { describe, expect, it } from 'vitest'
import { checkDecisionsDensity, checkPrReportDensity, checkScopeDensity } from './pr-report-density'

const ONE_PARAGRAPH_DECISIONS = `## Decisions

- one open choice: picked this because it was the simplest option that satisfied the brief.

## Test plan`

const TWO_PARAGRAPH_DECISIONS = `## Decisions

- one open choice: picked this because it was the simplest option that satisfied the brief.

Second paragraph, explaining more than the doctrine allows.

## Test plan`

const ONE_PARAGRAPH_SCOPE_WITH_TIER = `## Scope

One paragraph of blast-radius prose.

<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

## Token report`

const TWO_PARAGRAPH_SCOPE_WITH_TIER = `## Scope

First paragraph of blast-radius prose.

Second paragraph that should not be here.

<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

## Token report`

describe('checkDecisionsDensity', () => {
  it('passes a single-block Decisions section (a real bullet list, no blank lines between items)', () => {
    expect(checkDecisionsDensity(ONE_PARAGRAPH_DECISIONS)).toEqual({ status: 'pass', errors: [] })
  })

  it('fails a Decisions section padded with a second, separately-blocked paragraph, naming the section and count', () => {
    const result = checkDecisionsDensity(TWO_PARAGRAPH_DECISIONS)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('Decisions')
    expect(result.errors[0]).toContain('2 paragraphs')
  })

  it('passes when no "## Decisions" heading exists at all — presence is a different check\'s job', () => {
    expect(checkDecisionsDensity('## Test plan\n\nsomething')).toEqual({ status: 'pass', errors: [] })
  })

  it('passes an empty Decisions section (a different check catches the missing content)', () => {
    expect(checkDecisionsDensity('## Decisions\n\n## Test plan')).toEqual({ status: 'pass', errors: [] })
  })

  it('is dormant on a body still carrying the retired "## Summary" heading — presence, not this check, decides which heading is required', () => {
    const body = '## Summary\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Test plan'
    expect(checkDecisionsDensity(body)).toEqual({ status: 'pass', errors: [] })
  })

  it('passes a multi-line blockquote as the whole section — the one sanctioned pass-through shape for structured content (review finding, PR #358)', () => {
    const body = '## Decisions\n\n> first line\n>\n> second line\n\n## Test plan'
    expect(checkDecisionsDensity(body)).toEqual({ status: 'pass', errors: [] })
  })

  it('fails a blockquote MIXED with separate prose paragraphs — only a standalone blockquote is exempt, not one embedded in prose', () => {
    const body = '## Decisions\n\nIntro paragraph.\n\n> quoted aside\n\nClosing paragraph.\n\n## Test plan'
    const result = checkDecisionsDensity(body)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('3 paragraphs')
  })
})

describe('checkScopeDensity', () => {
  it('passes a single-paragraph Scope even with the trailing AEG:TIER anchor block', () => {
    expect(checkScopeDensity(ONE_PARAGRAPH_SCOPE_WITH_TIER)).toEqual({ status: 'pass', errors: [] })
  })

  it('fails a two-paragraph Scope, the AEG:TIER anchor block never counting as the second paragraph', () => {
    const result = checkScopeDensity(TWO_PARAGRAPH_SCOPE_WITH_TIER)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('Scope')
    expect(result.errors[0]).toContain('2 paragraphs')
  })

  it('does not count a fenced code example inside Scope as a second paragraph (code-blind, like brief-validation)', () => {
    const withFence = `## Scope

One paragraph, with an inline example below.

\`\`\`
some.ts

another.ts
\`\`\`

<!-- AEG:TIER:START -->
**Tier:** 0
<!-- AEG:TIER:END -->

## Token report`
    expect(checkScopeDensity(withFence)).toEqual({ status: 'pass', errors: [] })
  })
})

describe('checkPrReportDensity', () => {
  it('reports zero errors for a fully compliant body', () => {
    const body = `${ONE_PARAGRAPH_DECISIONS}\n\n${ONE_PARAGRAPH_SCOPE_WITH_TIER}`
    expect(checkPrReportDensity(body)).toEqual({ errors: [] })
  })

  it('reports one error per over-dense section, not a single combined failure', () => {
    const body = `${TWO_PARAGRAPH_DECISIONS}\n\n${TWO_PARAGRAPH_SCOPE_WITH_TIER}`
    const { errors } = checkPrReportDensity(body)
    expect(errors).toHaveLength(2)
  })

  it("catches the real, live over-dense bodies this check was written for (atta-labs/vinaya#343's shape, ported to the current Decisions heading)", () => {
    const body = `## Decisions

Fixes three doctrine bugs found in one audit pass.

Two smaller findings from the same pass are bundled in rather than filed separately.

**Decision not explicit in a brief:** bundled all three into one PR.

## Test plan`
    const result = checkDecisionsDensity(body)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('3 paragraphs')
  })
})

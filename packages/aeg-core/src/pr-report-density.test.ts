import { describe, expect, it } from 'vitest'
import { checkPrReportDensity, checkScopeDensity, checkSummaryDensity } from './pr-report-density'

const ONE_PARAGRAPH_SUMMARY = `## Summary

Fixes a real bug in one paragraph, no second block.

## Test plan`

const TWO_PARAGRAPH_SUMMARY = `## Summary

Fixes a real bug. First paragraph.

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

describe('checkSummaryDensity', () => {
  it('passes a single-paragraph Summary', () => {
    expect(checkSummaryDensity(ONE_PARAGRAPH_SUMMARY)).toEqual({ status: 'pass', errors: [] })
  })

  it('fails a two-paragraph Summary, naming the section and count', () => {
    const result = checkSummaryDensity(TWO_PARAGRAPH_SUMMARY)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('Summary')
    expect(result.errors[0]).toContain('2 paragraphs')
  })

  it('passes when no "## Summary" heading exists at all — presence is a different check\'s job', () => {
    expect(checkSummaryDensity('## Test plan\n\nsomething')).toEqual({ status: 'pass', errors: [] })
  })

  it('passes an empty Summary section (a different check catches the missing content)', () => {
    expect(checkSummaryDensity('## Summary\n\n## Test plan')).toEqual({ status: 'pass', errors: [] })
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
    const body = `${ONE_PARAGRAPH_SUMMARY}\n\n${ONE_PARAGRAPH_SCOPE_WITH_TIER}`
    expect(checkPrReportDensity(body)).toEqual({ errors: [] })
  })

  it('reports one error per over-dense section, not a single combined failure', () => {
    const body = `${TWO_PARAGRAPH_SUMMARY}\n\n${TWO_PARAGRAPH_SCOPE_WITH_TIER}`
    const { errors } = checkPrReportDensity(body)
    expect(errors).toHaveLength(2)
  })

  it("catches the real, live over-dense bodies this check was written for (atta-labs/vinaya#343's Summary shape)", () => {
    const body = `## Summary

Fixes three doctrine bugs found in one audit pass.

Two smaller findings from the same pass are bundled in rather than filed separately.

**Decision not explicit in a brief:** bundled all three into one PR.

## Test plan`
    const result = checkSummaryDensity(body)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('3 paragraphs')
  })
})

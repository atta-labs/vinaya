/**
 * Issue #189 — the evidence-region coupling, closed by construction.
 *
 * These tests deliberately do NOT read `scan-context.ts` as source text and
 * assert what identifiers appear in it. That is the shape twelve review rounds
 * on `#188` already tried: a pinned entry expression, a blacklist of stage
 * names, a two-entry list of consumers. Each one was defeated by writing the
 * same divergence a different way, because a guard over source text enumerates
 * spellings of a mistake and there is always another spelling.
 *
 * What is asserted here instead:
 *   - **behaviour** — the documented defeats now resolve identically on both
 *     sides, checked by running the real resolver;
 *   - **the type** — the `@ts-expect-error` cases below are compile-time
 *     assertions. `bun run typecheck` covers `tests/**`, and an unused
 *     `@ts-expect-error` is itself an error, so if `ScanContext` ever stops
 *     being nominal, or the resolver ever starts accepting a raw string, these
 *     lines fail the typecheck. They cost nothing at runtime.
 */

import { describe, expect, it } from 'bun:test'
import { checkBareDigits } from '../../src/checks/body-bare-digits-logic'
import { compareEvidenceBlock } from '../../src/checks/evidence-fresh-logic'
import { ScanContext, resolveAnchoredRegion, summaryLineIndex } from '../../src/checks/scan-context'
import { DivergentEvidenceAnchorError, replaceEvidenceBlock } from '../../src/commands/pr-report'
import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from '../../src/lib/numstat'

// Never a literal zero-width character in this source file — the same rule
// `ZERO_WIDTH`'s own comment states, for the same reason: an invisible
// character here would be exactly as unauditable as the bypass it tests.
const ZWSP = String.fromCharCode(0x200b)

const HEAD = 'a'.repeat(40)
const NUMSTAT = '2\t1\tapps/cli/src/commands/pr-report.ts\n1\t0\tapps/cli/src/index.ts'

/** A body carrying a well-formed, honest evidence block — the shape `pr report --write` emits. */
function bodyWith(inner: string[], { anchorStart = '<!-- AEG:EVIDENCE:START -->' } = {}): string {
  return [
    '## Summary',
    '',
    'why this shape.',
    '',
    '## Evidence',
    '',
    anchorStart,
    ...inner,
    '<!-- AEG:EVIDENCE:END -->',
    '',
    '## Scope',
    '',
    '**Tier:** 1'
  ].join('\n')
}

/** Exactly what `buildBlockInner` emits: the value inside an inline code span. */
const SUMMARY_LINE = `${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(NUMSTAT)}\``

const HONEST_INNER = [`Head: ${HEAD}`, SUMMARY_LINE, '', '### Group A — recomputable', '', '```', NUMSTAT, '```']

function regionText(body: string): string | 'hidden' | null {
  const resolved = resolveAnchoredRegion(ScanContext.from(body), 'EVIDENCE')
  return resolved === null || resolved === 'hidden' ? resolved : resolved.region
}

// ---------- the defeat this Issue exists to end ----------

describe('scan-context — the two sides resolve the same region (Issue #189)', () => {
  const honest = bodyWith(HONEST_INNER)

  it('a zero-width character inside the START marker no longer hides the block from one side', () => {
    // Before: `body-bare-digits` stripped it and exempted every digit in the
    // block; `check-evidence-fresh` read the raw body, saw no anchor, and
    // exited 0 having verified nothing. Both green.
    const diverged = bodyWith(HONEST_INNER, { anchorStart: `<!-- AEG:EVIDENCE${ZWSP}:START -->` })
    expect(regionText(diverged)).toBe(regionText(honest) as string)
  })

  it('the named-entity spelling of the same marker resolves identically too', () => {
    const diverged = bodyWith(HONEST_INNER, { anchorStart: '&lt;!-- AEG:EVIDENCE:START --&gt;' })
    expect(regionText(diverged)).toBe(regionText(honest) as string)
  })

  it('the region is sliced from the normalised body, so its fenced numstat survives masking', () => {
    // Locating on the mask and slicing from the mask would return blanks here
    // — the numstat is inside a fence. Bounds from the mask, text from the
    // normalised body, is the whole discipline.
    expect(regionText(honest)).toContain(NUMSTAT)
  })

  it('a decoy pair inside a <details> block loses to the real one, for both sides at once', () => {
    // `check-evidence-fresh` resolved on the raw body until now, so it would
    // have verified this decoy — the first pair in raw text — while
    // `body-bare-digits` exempted the real block further down.
    const withDecoy = [
      '## Summary',
      '',
      '<details><summary>reference brief</summary>',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      'Head: 0000000000000000000000000000000000000000',
      '<!-- AEG:EVIDENCE:END -->',
      '',
      '</details>',
      '',
      '## Evidence',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      ...HONEST_INNER,
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    expect(regionText(withDecoy)).toContain(HEAD)
    expect(regionText(withDecoy)).not.toContain('0000000000000000000000000000000000000000')
  })

  it("a block that exists ONLY inside a <details> is 'hidden', not 'absent'", () => {
    // `body-bare-digits` blanks every digit in a `<details>` block, so nothing
    // can verify what this one claims. Reporting it as "no anchor" would grant
    // exactly the silent exemption this Issue is about.
    const buried = [
      '## Evidence',
      '',
      '<details><summary>evidence</summary>',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      ...HONEST_INNER,
      '<!-- AEG:EVIDENCE:END -->',
      '',
      '</details>'
    ].join('\n')
    expect(regionText(buried)).toBe('hidden')
  })

  it('a body with no pair at all is still null — the anchor stays opt-in', () => {
    expect(regionText('## Summary\n\nnothing anchored here.')).toBeNull()
  })
})

// ---------- closed by the type, not by a source-text guard ----------

describe('scan-context — construction closure (compile-time)', () => {
  it('a hand-built object literal shaped like a ScanContext does not satisfy the type', () => {
    const body = bodyWith(HONEST_INNER)
    // @ts-expect-error `ScanContext` is nominal — `raw` is private, so no
    // object literal can satisfy it, however well-shaped. This is the exact
    // hole the unbranded `{ normalised, masked }` type left open.
    const forged: ScanContext = { normalised: body, masked: body }
    expect(forged).toBeDefined()
  })

  it('the constructor is private — ScanContext.from is the only way in', () => {
    const body = bodyWith(HONEST_INNER)
    // @ts-expect-error the constructor is private; a caller cannot skip
    // normalisation by building the pair itself.
    const forged = new ScanContext(body, body, body)
    expect(forged).toBeDefined()
  })

  it('the resolver refuses a raw body string — a new consumer cannot diverge by accident', () => {
    // This is what replaces `CONSUMER_ENTRY`. There is no list of consumers to
    // keep up to date, because there is no second way to reach the region: a
    // third consumer either obtains a `ScanContext` (and therefore normalises)
    // or does not compile.
    //
    // Never invoked on purpose. `tsc` checks the body either way, and the
    // `@ts-expect-error` is the assertion; running it would only demonstrate
    // that a string has no `.masked` property, which is not the point.
    const wouldNotCompile = () => {
      // @ts-expect-error `resolveAnchoredRegion` takes a `ScanContext`, never a body string.
      return resolveAnchoredRegion(bodyWith(HONEST_INNER), 'EVIDENCE')
    }
    expect(typeof wouldNotCompile).toBe('function')
  })

  it('a third, previously-unenumerated consumer agrees with both existing ones for free', () => {
    // Written the only way it can be written, it is correct by construction —
    // including on the diverged body that defeated the enumerated guard.
    const thirdConsumer = (raw: string) => resolveAnchoredRegion(ScanContext.from(raw), 'EVIDENCE')
    const diverged = bodyWith(HONEST_INNER, { anchorStart: `<!-- AEG:EVIDENCE${ZWSP}:START -->` })
    const third = thirdConsumer(diverged)
    expect(third).not.toBeNull()
    expect(third).not.toBe('hidden')
    expect(third === null || third === 'hidden' ? '' : third.region).toBe(regionText(bodyWith(HONEST_INNER)) as string)
  })
})

// ---------- the Summary line: masked by backticks, verified by comparison ----------

describe('scan-context — the Summary line needs no exemption, and is verified', () => {
  const honest = bodyWith(HONEST_INNER)

  it('the emitted Summary line passes body-bare-digits — its value is an inline code span', () => {
    expect(checkBareDigits(honest).violations).toEqual([])
  })

  it('and passes WITHOUT any EVIDENCE-anchor exemption — the same line in plain prose also passes', () => {
    // The load-bearing property. `body-bare-digits` runs from a
    // `pull_request_target` checkout of the DEFAULT BRANCH, so an exemption
    // added here would not be in force for the pull request that adds it.
    // Backticks are covered by `maskCode`, which every released version of the
    // check already runs, so this line is legible to an old checker and a new
    // one alike. Measured: the first attempt shipped a bare count with a
    // matching exemption on the branch, and CI refused it on `main`'s build.
    const outsideAnyAnchor = `Some prose. ${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(NUMSTAT)}\` and more.`
    expect(checkBareDigits(outsideAnyAnchor).violations).toEqual([])
  })

  it('an UNBACKTICKED Summary line is a bare digit, anchor or no anchor', () => {
    const bare = bodyWith([
      `Head: ${HEAD}`,
      `${EVIDENCE_SUMMARY_PREFIX}${summariseNumstat(NUMSTAT)}`,
      '',
      '### Group A — recomputable',
      '',
      '```',
      NUMSTAT,
      '```'
    ])
    expect(checkBareDigits(bare).violations.length).toBeGreaterThan(0)
  })

  it('a fabricated Summary line fails evidence-fresh even when backticked', () => {
    const fabricated = bodyWith([
      `Head: ${HEAD}`,
      `${EVIDENCE_SUMMARY_PREFIX}\`900 files changed, 12000 insertions(+), 0 deletions(-)\``,
      '',
      '### Group A — recomputable',
      '',
      '```',
      NUMSTAT,
      '```'
    ])
    // Backticks buy it past the digit scan, which is exactly why the
    // comparison below is the thing that has to catch it.
    expect(checkBareDigits(fabricated).violations).toEqual([])

    const resolved = resolveAnchoredRegion(ScanContext.from(fabricated), 'EVIDENCE')
    if (resolved === null || resolved === 'hidden') throw new Error('fixture lost its block')
    const result = compareEvidenceBlock(resolved, HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.join('\n')).toContain('Summary line does not match')
  })

  it('the honest Summary line passes the comparison', () => {
    const resolved = resolveAnchoredRegion(ScanContext.from(honest), 'EVIDENCE')
    if (resolved === null || resolved === 'hidden') throw new Error('fixture lost its block')
    expect(compareEvidenceBlock(resolved, HEAD, NUMSTAT).status).toBe('pass')
  })

  it('a Summary line inside a fence is never the compared one — selection reads the mask', () => {
    const resolved = resolveAnchoredRegion(ScanContext.from(honest), 'EVIDENCE')
    if (resolved === null || resolved === 'hidden') throw new Error('fixture lost its block')
    const index = summaryLineIndex(resolved.maskedRegion)
    expect(index).not.toBeNull()
    expect(resolved.region.split('\n')[index as number]).toBe(SUMMARY_LINE)
  })

  it('a block with no Summary line has nothing to verify', () => {
    const noSummary = bodyWith([`Head: ${HEAD}`, '', '### Group A — recomputable', '', '```', NUMSTAT, '```'])
    const resolved = resolveAnchoredRegion(ScanContext.from(noSummary), 'EVIDENCE')
    if (resolved === null || resolved === 'hidden') throw new Error('fixture lost its block')
    expect(summaryLineIndex(resolved.maskedRegion)).toBeNull()
    expect(compareEvidenceBlock(resolved, HEAD, NUMSTAT).status).toBe('pass')
  })
})

// ---------- the writer, the third real consumer today ----------

describe('scan-context — the emitter refuses a body whose anchor resolves two ways', () => {
  it('replaceEvidenceBlock throws rather than appending a second block beside a hidden one', () => {
    const diverged = bodyWith(HONEST_INNER, { anchorStart: `<!-- AEG:EVIDENCE${ZWSP}:START -->` })
    expect(() => replaceEvidenceBlock(diverged, 'Head: newsha')).toThrow(DivergentEvidenceAnchorError)
  })

  it('an ordinary body still writes in place', () => {
    const written = replaceEvidenceBlock(bodyWith(HONEST_INNER), 'Head: newsha')
    expect(written).toContain('Head: newsha')
    expect(written).not.toContain(HEAD)
  })
})

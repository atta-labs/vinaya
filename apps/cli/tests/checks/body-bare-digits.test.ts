import { describe, expect, it } from 'bun:test'
import { checkBareDigits } from '../../src/checks/body-bare-digits-logic'

function violationLines(body: string): number[] {
  return checkBareDigits(body).violations.map((v) => v.line)
}

/** Wraps exactly one occurrence of `token` in `body` with a single-backtick inline code span. */
function wrapToken(body: string, token: string): string {
  const idx = body.indexOf(token)
  if (idx === -1) throw new Error(`token ${JSON.stringify(token)} not found in ${JSON.stringify(body)}`)
  return `${body.slice(0, idx)}\`${token}\`${body.slice(idx + token.length)}`
}

// ---------- must NOT fail — the masking pipeline (code spans/blocks, AEG:* anchors, and the region-level exemptions that are separate, already-authorized decisions, not per-token identifier-shape classification) ----------

describe('body-bare-digits — must NOT fail: the masking pipeline', () => {
  it('an inline single-backtick code span', () => {
    expect(violationLines('Set `Tier: 1` in the header, per convention.')).toEqual([])
  })

  it('an inline double-backtick span, needed to quote a literal backtick', () => {
    expect(violationLines('Renders as ```163`` in the table.')).toEqual([])
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

  it('a digit inside an AEG:CLOSES anchor', () => {
    const body = ['<!-- AEG:CLOSES:START -->', 'Closes #135', '<!-- AEG:CLOSES:END -->'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  // The remaining region-level exemptions below are NOT identifier-shape
  // classification the redesign collapsed away — each is its own, separately
  // authorized decision about a whole structural region (a mandatory table,
  // a header field, a real GFM list marker), made before or independently of
  // the per-token shape list this redesign removed. See the logic module's
  // own doc for why these stayed.

  it("a plain, unbolded, unanchored Tier field (accepted Tier syntax — real: `vinaya demo`'s own fixture body)", () => {
    expect(violationLines('Tier: 1')).toEqual([])
  })

  it('the **For:** header field (model name + version)', () => {
    expect(violationLines('**For:** Sonnet 5 (Claude Code CLI), dispatched locally, unattended')).toEqual([])
  })

  it('a markdown ordered-list marker, only at line start', () => {
    const body = ['1. First decision.', '2. Second decision.', '3. Third decision.'].join('\n')
    expect(violationLines(body)).toEqual([])
  })

  it('the whole Token report table, heading to next heading', () => {
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

  it('the collapsed <details> reference-brief wrapper', () => {
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

// ---------- must fail — every identifier-shape classifier the redesign removed, paired with the same claim once backtick-wrapped ----------

/**
 * Every identifier shape the old per-token classifier used to recognize
 * (Issue/PR ref, date, dotted version, file-path segment, section number,
 * letter-led id, ordinal-word label, URL, inline enumeration marker) is now
 * exempt for exactly one reason — sitting inside a code span/block/anchor —
 * and for no other. Each row: the claim unwrapped (must fail, where it used
 * to pass via a shape classifier), and the same claim with its digit-bearing
 * token wrapped in a single backtick (must now pass, and ONLY because of
 * the backtick — no shape recognition is happening at all).
 */
const NOW_REQUIRES_BACKTICKS: Array<[string, string, string]> = [
  ['an Issue/PR reference', 'See #135 for the original report.', '#135'],
  ['a date', 'Fixed on 2026-08-18, verified the same day.', '2026-08-18'],
  ['a dotted version string', 'Bumped @attalabs/aeg-types to 0.12.0 in this pass.', '0.12.0'],
  [
    'a file path segment carrying a digit',
    'See packages/v2/aeg-core/src/index.ts for the real path.',
    'packages/v2/aeg-core/src/index.ts'
  ],
  ['a section number', 'See Section 9 for the full rationale behind this call.', '9'],
  ['a letter-led check-code identifier', 'C5 flags the gap in this pass.', 'C5'],
  ['a hyphenated model identifier', 'claude-sonnet-5 ran this task.', 'claude-sonnet-5'],
  ['a Round ordinal label', 'Round 2 found nothing new.', '2'],
  ['an exit-code label', 'The process exits with exit 0 on success.', '0']
]

describe('body-bare-digits — must fail unless backtick-wrapped: identifier shapes the old classifier used to recognize', () => {
  it.each(NOW_REQUIRES_BACKTICKS)('%s: %s', (_label, unwrapped, token) => {
    expect(checkBareDigits(unwrapped).violations.length).toBeGreaterThan(0)
    expect(checkBareDigits(wrapToken(unwrapped, token)).violations).toEqual([])
  })

  it('a slash-separated list of Issue/PR references, each wrapped individually', () => {
    const unwrapped = "Checked against #126/#129/#130's real bodies."
    expect(checkBareDigits(unwrapped).violations.length).toBeGreaterThan(0)
    const wrapped = "Checked against `#126`/`#129`/`#130`'s real bodies."
    expect(checkBareDigits(wrapped).violations).toEqual([])
  })
})

// ---------- must fail — narrative quantitative claims, the position this check exists to close ----------

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

  it('a multi-digit severity tally, real (#126): every one of its five digit tokens is a separate violation, and every one must be wrapped to pass', () => {
    const unwrapped = 'Round 2 (0 BLOCKER, 1 MAJOR, 6 MINOR) and the security pass (PASS, 1 MEDIUM) were addressed.'
    expect(checkBareDigits(unwrapped).violations.length).toBeGreaterThan(0)
    // Wrapping only the first digit is not enough — proves the rule is
    // truly per-token, not "the sentence is fine once its label is clear."
    const partiallyWrapped = wrapToken(unwrapped, 'Round 2').replace('(0 BLOCKER', '(`0` BLOCKER')
    expect(checkBareDigits(partiallyWrapped).violations.length).toBeGreaterThan(0)
    const fullyWrapped =
      'Round `2` (`0` BLOCKER, `1` MAJOR, `6` MINOR) and the security pass (PASS, `1` MEDIUM) were addressed.'
    expect(checkBareDigits(fullyWrapped).violations).toEqual([])
  })
})

// ---------- historical bypasses — every distinct shape found across all 5 security review rounds and the 3 proactive self-audit fixes on this same task, each now closed by the one collapsed rule instead of a shape-specific patch ----------

/**
 * Before this redesign, each of these was a real, empirically-confirmed
 * escape from the old per-token classifier — a different exemption's shape
 * every time (ordinal-word laundering, a closed vocabulary, Unicode/
 * zero-width evasion, a file-path bypass, a hyphenated-word bypass, a
 * list-marker-shape bypass, a loose URL check, an inline-enumeration-marker
 * bypass). None of that shape enumeration exists anymore. Every one of
 * these strings fails for the exact same single reason now — the digit
 * token is not inside a code span/block/AEG anchor — and every one passes
 * the moment its digit token is backtick-wrapped, for the exact same single
 * reason too. The shape that used to matter for classifying WHY a string
 * escaped no longer matters for WHETHER it does; it is kept here purely as
 * a historical regression record, one entry per originally-reported case.
 */
const HISTORICAL_BYPASSES: Array<[string, string, string]> = [
  [
    'round 1 (this task): ordinal-word label directly adjacent to a countable claim',
    'We ran step 200 tests and they all passed.',
    '200'
  ],
  [
    'round 1: a whole claim hyphenated into one pseudo-identifier token',
    'Fixed-42-bugs-in-this-pass.',
    'Fixed-42-bugs-in-this-pass.'
  ],
  ['round 2: a singular count noun, no plural suffix', 'step 200 test failed.', '200'],
  ['round 2: a parenthesized count noun', 'step 200 (tests) failed silently.', '200'],
  ['round 2: a noun separated by an article + preposition', 'step 200 of the tests failed.', '200'],
  [
    'round 3: a fullwidth-Unicode-digit claim, invisible to an ASCII-only scanner',
    'All １３８ tests passed after this change.',
    '１３８'
  ],
  ['round 3: a count noun wrapped in Unicode curly quotes', 'step 200 "tests" failed silently.', '200'],
  [
    'round 4: an open-vocabulary noun no closed list would anticipate',
    'step 200 tickets were closed this sprint.',
    '200'
  ],
  [
    'round 4: a zero-width character embedded inside an otherwise-recognized word',
    'step 200 te\u200Bsts failed silently.',
    '200'
  ],
  ['round 4: a count noun wrapped in a named HTML entity', 'step 200 &quot;tests&quot; failed silently.', '200'],
  [
    'round 5: a bare "<number>/<word>" claim laundered as a file-path segment, HIGH — bypassed every other signal, no ordinal-word context needed',
    '5000/bugs were fixed in this release.',
    '5000/bugs'
  ],
  [
    'round 5: an adjective wedged between the digit and the noun broke strict grammar adjacency',
    'round 5000 critical outages occurred last quarter.',
    '5000'
  ],
  [
    'round 5: a word the tagger mis-read as a Verb even with full sentence context',
    'exit 12 hangs were observed in the queue.',
    '12'
  ],
  [
    'self-audit #1: an inline enumeration marker exempted a claim unconditionally',
    'Fixed (999) bugs in this release.',
    '(999)'
  ],
  [
    'self-audit #2: a hyphenated word-number shape laundered a claim past the letter-led-identifier check',
    'Fixed step-200 tests today.',
    'step-200'
  ],
  ['self-audit #2: a mid-sentence token merely shaped like a list marker escaped unconditionally', 'We fixed 3.', '3.'],
  [
    'self-audit #2: a loose URL check only tested for a substring, not a real scheme',
    'Fixed 500://bugs in this release.',
    '500://bugs'
  ]
]

describe('body-bare-digits — historical bypasses, all closed by the collapsed rule', () => {
  it.each(HISTORICAL_BYPASSES)('%s', (_label, unwrapped, token) => {
    expect(checkBareDigits(unwrapped).violations.length).toBeGreaterThan(0)
    expect(checkBareDigits(wrapToken(unwrapped, token)).violations).toEqual([])
  })
})

// ---------- masking-boundary integrity — zero-width/entity normalization now defends the mask itself, not a vocabulary word ----------

describe('body-bare-digits — masking-boundary integrity (normalization runs before masking, not after)', () => {
  it('a zero-width character embedded inside an AEG:* anchor tag does not defeat anchor recognition', () => {
    // Round 4 finding 2 originally hid a vocabulary word from a noun check;
    // that classifier is gone, but the same character could just as easily
    // corrupt the literal anchor-tag text `blankAnchoredRegions` matches
    // against — this is the surviving, still-real reason `ZERO_WIDTH`
    // stripping runs on the whole body before any masking.
    const body = ['<!-- AEG:TIER:START -->', '**Tier:** 1', '<!-- AEG:TIER\u200B:END -->'].join('\n')
    expect(checkBareDigits(body).violations).toEqual([])
  })

  it('a named HTML entity decodes before masking runs, so it cannot corrupt a real fence marker', () => {
    const body = ['Ran the suite &amp; confirmed:', '', '```', '163 pass, 0 fail', '```'].join('\n')
    expect(violationLines(body)).toEqual([])
  })
})

// ---------- mutation proof: masking is load-bearing, not decorative ----------

describe('body-bare-digits — mutation proof (brief §8 Test Plan item 3)', () => {
  it('a real backtick-wrapped Issue ref + date pass the real check, but would trip a naive unclassified digit scan', () => {
    const body = 'See `#135` for the original report, filed on `2026-08-18`.'
    expect(checkBareDigits(body).violations).toEqual([])
    // Reproduces exactly what body-bare-digits would do if masking were
    // deleted (the § Part 3 mutation this proves against): every
    // digit-bearing token counts, with no code-span/block/anchor carve-out
    // at all.
    const naiveHits = body.match(/\S*\d\S*/g) ?? []
    expect(naiveHits.length).toBeGreaterThan(0)
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

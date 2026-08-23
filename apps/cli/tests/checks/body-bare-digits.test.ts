import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareEvidenceBlock } from '../../src/checks/evidence-fresh-logic'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  normalizeBody,
  resolveAnchoredRegionForScan,
  diagnoseAnchorExemption,
  checkBareDigits
} from '../../src/checks/body-bare-digits-logic'

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
    expect(violationLines('Renders as ``a `163` z`` here.')).toEqual([])
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

  it('the **For:** header field, model version number backtick-wrapped (round 7: For: no longer gets whole-line digit tolerance)', () => {
    expect(violationLines('**For:** Sonnet `5` (Claude Code CLI), dispatched locally, unattended')).toEqual([])
  })

  it('the **For:** header field with no digit at all', () => {
    expect(violationLines('**For:** vinaya demo (scripted fixture)')).toEqual([])
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

  it('a mismatched-length backtick run is not a valid code span (security, PR #147 round 9-10): CommonMark requires the closer to be a run of exactly the same length, not merely contain it — GitHub renders this as literal, visible text, so the digit inside must still be flagged', () => {
    expect(violationLines('Renders as ```163`` in the table.').length).toBeGreaterThan(0)
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
    const body = ['## Scope', '', '<!-- AEG:TIER:START -->', '**Tier:** 1', '<!-- AEG:TIER\u200B:END -->'].join('\n')
    expect(checkBareDigits(body).violations).toEqual([])
  })

  it('a named HTML entity decodes before masking runs, so it cannot corrupt a real fence marker', () => {
    const body = ['Ran the suite &amp; confirmed:', '', '```', '163 pass, 0 fail', '```'].join('\n')
    expect(violationLines(body)).toEqual([])
  })
})

// ---------- round 6 security review: the "kept" masking layers had laundering surface of their own ----------

describe('body-bare-digits — round 6: a decoy AEG:* anchor pair outside its documented section is not trusted', () => {
  it('does not let a decoy anchor for a field the body otherwise never anchors exempt a fabricated claim', () => {
    const body = [
      '## Summary',
      'Ordinary body.',
      '',
      '<!-- AEG:PROJECT:START -->',
      'We actually observed 4500 regressions in this pass.',
      '<!-- AEG:PROJECT:END -->'
    ].join('\n')
    expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
  })

  it.each([
    ['PREMISE', 'premise'],
    ['EVIDENCE', 'evidence'],
    ['TIER', 'scope']
  ])('does not trust a decoy %s anchor sitting outside its own ## %s section', (field) => {
    const body = [
      '## Summary',
      '',
      `<!-- AEG:${field}:START -->`,
      'We shipped 900 fixes this week.',
      `<!-- AEG:${field}:END -->`
    ].join('\n')
    expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
  })

  it('does not trust a decoy CLOSES anchor placed after the header block', () => {
    const body = ['## Summary', '', '<!-- AEG:CLOSES:START -->', 'We fixed 4500 bugs.', '<!-- AEG:CLOSES:END -->'].join(
      '\n'
    )
    expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
  })

  it('still trusts a real CLOSES/TIER/EVIDENCE anchor correctly placed under its documented section', () => {
    const bodies = [
      ['<!-- AEG:CLOSES:START -->', 'Closes #135', '<!-- AEG:CLOSES:END -->', '', '## Summary', 'text'].join('\n'),
      ['## Scope', '', '<!-- AEG:TIER:START -->', '**Tier:** 1', '<!-- AEG:TIER:END -->'].join('\n'),
      [
        '## Evidence',
        '',
        '<!-- AEG:EVIDENCE:START -->',
        'Head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '<!-- AEG:EVIDENCE:END -->'
      ].join('\n')
    ]
    for (const body of bodies) expect(checkBareDigits(body).violations).toEqual([])
  })

  it('PREMISE/TEST-PLAN content with no digit at all still passes trivially — not because of an exemption, because there is nothing to flag', () => {
    const body = [
      '## Premise',
      '',
      '<!-- AEG:PREMISE:START -->',
      '**Premise:**',
      '- a.ts contains: export function f',
      '<!-- AEG:PREMISE:END -->'
    ].join('\n')
    expect(checkBareDigits(body).violations).toEqual([])
  })
})

describe('body-bare-digits — round 8: an anchor placed in its own canonical section still needs its own real content signature', () => {
  it.each([
    [
      'PROJECT',
      [
        '## Summary',
        'text',
        '',
        '<!-- AEG:PROJECT:START -->',
        'We actually observed 4500 regressions in this pass.',
        '<!-- AEG:PROJECT:END -->'
      ].join('\n')
    ],
    [
      'CLOSES',
      ['<!-- AEG:CLOSES:START -->', 'We actually fixed 4500 bugs in this pass.', '<!-- AEG:CLOSES:END -->'].join('\n')
    ],
    [
      'TIER',
      [
        '## Scope',
        '',
        '<!-- AEG:TIER:START -->',
        'We actually shipped 4500 unrelated fixes in this pass.',
        '<!-- AEG:TIER:END -->'
      ].join('\n')
    ],
    [
      'EVIDENCE',
      [
        '## Evidence',
        '',
        '<!-- AEG:EVIDENCE:START -->',
        'We measured 4500 improvements in this pass.',
        '<!-- AEG:EVIDENCE:END -->'
      ].join('\n')
    ]
  ])(
    'a decoy %s pair correctly placed in its own section, but carrying no trace of the real field, is not trusted',
    (_field, body) => {
      expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
    }
  )

  // Self-discovered proactive audit (not yet reported by any review round):
  // a signature merely being PRESENT inside the anchor is not the same as
  // the content BEING just that value — real signature + a smuggled claim
  // in the same pair used to blank the whole span, hiding the claim too.
  it.each([
    [
      'CLOSES',
      [
        '<!-- AEG:CLOSES:START -->',
        'Closes #999 -- by the way we also fixed 4500 unrelated bugs.',
        '<!-- AEG:CLOSES:END -->'
      ].join('\n')
    ],
    [
      'TIER',
      [
        '## Scope',
        '',
        '<!-- AEG:TIER:START -->',
        '**Tier:** 1 and also 500 known regressions remain untriaged',
        '<!-- AEG:TIER:END -->'
      ].join('\n')
    ],
    [
      'PROJECT',
      [
        '<!-- AEG:PROJECT:START -->',
        '**Project:** cli, though 500 regressions were found',
        '<!-- AEG:PROJECT:END -->'
      ].join('\n')
    ]
  ])(
    'a "trojan" %s anchor (real signature + smuggled claim in the same pair) no longer blanks the whole span',
    (_field, body) => {
      expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
    }
  )

  it('still trusts real, single-value CLOSES/TIER/PROJECT anchors bounded correctly', () => {
    const bodies = [
      ['<!-- AEG:CLOSES:START -->', 'Closes #135', '<!-- AEG:CLOSES:END -->', '', '## Summary', 'text'].join('\n'),
      ['## Scope', '', '<!-- AEG:TIER:START -->', '**Tier:** 1', '<!-- AEG:TIER:END -->'].join('\n'),
      ['<!-- AEG:PROJECT:START -->', '**Project:** aeg-core, cli, vinaya', '<!-- AEG:PROJECT:END -->'].join('\n')
    ]
    for (const body of bodies) expect(checkBareDigits(body).violations).toEqual([])
  })

  // Round 10, Principal's final direction: PREMISE/TEST-PLAN get ZERO
  // exemption at all — the identical mechanical treatment For: already
  // has. Bounding them per line (the same way CLOSES/TIER/PROJECT/
  // EVIDENCE are bounded above) was tried once and reverted (real corpus
  // regression, see the module doc); a second bounding attempt would just
  // be another judgment call for a reviewer to find the next gap in. No
  // exemption at all has no such gap: a fenced/inline code span inside
  // these anchors stays exempt only because maskCode (layer 1, general,
  // unrelated to anchors) already masks it; free-standing prose inside
  // the anchor is scanned exactly like free-standing prose anywhere else.
  it('a real Test Plan item: fenced evidence stays exempt via maskCode (unrelated to the anchor), free prose beside it does not', () => {
    const body = [
      '## Test plan',
      '',
      '<!-- AEG:TEST-PLAN:START -->',
      '- [x] **[agent]** Piped-vs-redirected byte counts on the oversized fixture: `| wc -c` and `> file` now produce the same count.',
      '',
      '  ```',
      '  === piped ===',
      '     1967109',
      '  === redirected ===',
      '     1967118',
      '  ```',
      '  (The 9-byte difference is a newline-counting quirk; both captures are the complete payload.)',
      '<!-- AEG:TEST-PLAN:END -->'
    ].join('\n')
    // The fenced 1967109/1967118 never trip — maskCode already masks them.
    // The unfenced "9-byte" is the only violation: real, correct behavior
    // now that this field has no anchor-specific exemption of its own.
    expect(checkBareDigits(body).violations.length).toBe(1)
  })

  it('the same real Test Plan item passes once its own bare digit is backtick-wrapped, migrated the same way For: lines were', () => {
    const body = [
      '## Test plan',
      '',
      '<!-- AEG:TEST-PLAN:START -->',
      '- [x] **[agent]** Piped-vs-redirected byte counts on the oversized fixture: `| wc -c` and `> file` now produce the same count.',
      '',
      '  ```',
      '  === piped ===',
      '     1967109',
      '  === redirected ===',
      '     1967118',
      '  ```',
      '  (The `9`-byte difference is a newline-counting quirk; both captures are the complete payload.)',
      '<!-- AEG:TEST-PLAN:END -->'
    ].join('\n')
    expect(checkBareDigits(body).violations).toEqual([])
  })

  // The identical trojan shape closed above for CLOSES/TIER/PROJECT/
  // EVIDENCE is now unconditionally closed for PREMISE/TEST-PLAN too — not
  // via signature detection (there is none), simply because nothing in
  // either anchor is exempt any more.
  it.each([
    [
      'PREMISE',
      [
        '## Premise',
        '',
        '<!-- AEG:PREMISE:START -->',
        '**Premise:**',
        '- a.ts contains: export function f',
        'We actually shipped 4500 unrelated fixes.',
        '<!-- AEG:PREMISE:END -->'
      ].join('\n')
    ],
    [
      'TEST-PLAN',
      [
        '## Test plan',
        '',
        '<!-- AEG:TEST-PLAN:START -->',
        '- [x] **[agent]** 163 pass, 0 fail',
        'By the way we fixed 4500 unrelated bugs.',
        '<!-- AEG:TEST-PLAN:END -->'
      ].join('\n')
    ]
  ])(
    'a "trojan" %s anchor now fails — every digit in its content is scanned, no signature to satisfy at all',
    (_field, body) => {
      expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
    }
  )
})

describe('body-bare-digits — round 6: Tier:/Project: no longer blank a claim appended past the value', () => {
  it.each([
    ['Tier: 1, though 500 known regressions remain untriaged.', '500'],
    ['Project: cli — but 12345 tests are currently failing.', '12345'],
    ['**Tier:** 1. We also shipped 42 unrelated fixes.', '42']
  ])('an appended claim past the clause boundary is scanned: %s', (body) => {
    expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
  })

  it.each(['Tier: 1', '**Tier:** 1', 'Project: aeg-core, cli, vinaya', 'Project: cli'])(
    'the field value itself is still exempt: %s',
    (body) => {
      expect(checkBareDigits(body).violations).toEqual([])
    }
  )

  it('For: no longer gets special-cased digit tolerance at all (round 7 follow-up, Principal call) — a bare digit in its value now fails like anywhere else', () => {
    expect(
      checkBareDigits('**For:** Sonnet 5 (Claude Code CLI on a dev machine, dispatched locally, unattended)').violations
        .length
    ).toBeGreaterThan(0)
  })

  it('still exempts a For: line once its own version number is backtick-wrapped', () => {
    expect(
      checkBareDigits('**For:** Sonnet `5` (Claude Code CLI on a dev machine, dispatched locally, unattended)')
        .violations
    ).toEqual([])
  })
})

describe('body-bare-digits — round 7: Tier:/Project: reuse the real field grammar, not a guessable boundary heuristic', () => {
  it('does not let an appended claim through when no clause-boundary punctuation separates it from the real value (round 7 BLOCKER)', () => {
    expect(checkBareDigits('Tier: 1 500 known regressions untriaged').violations.length).toBeGreaterThan(0)
  })

  it("still exempts Tier: written mid-line in real metadata-line usage (pr-tier.ts's own documented, NOT line-anchored grammar)", () => {
    expect(checkBareDigits('Tranche: x · Task: 1 · **Tier:** 3 · Project: y').violations.length).toBe(1) // "Task: 1" is a real, correct hit — Task: is not one of the three recognized fields
  })

  it('does not let a claim disguised as an extra comma-separated Project name through', () => {
    expect(checkBareDigits('Project: cli, though 500 regressions were found').violations.length).toBeGreaterThan(0)
  })

  it('still exempts a real multi-name Project value with no punctuation boundary needed after it', () => {
    expect(checkBareDigits('Project: aeg-core, cli, vinaya, aeg-forge-state').violations).toEqual([])
  })

  // Round 9 code review, BLOCKER: PROJECT_SLUG's own shape
  // (/^[a-z0-9][a-z0-9-]*$/i) permits digits, so a hyphenated claim needs
  // no space or comma-adjacency trick at all to launder — it passes the
  // shape check exactly as a real project name would, unanchored AND
  // inside a genuinely-signed anchor pair, no decoy required.
  it.each([
    ['Project: cli, we-fixed-4500-bugs', 'unanchored'],
    [
      ['<!-- AEG:PROJECT:START -->', '**Project:** cli, we-fixed-4500-bugs', '<!-- AEG:PROJECT:END -->'].join('\n'),
      'anchored, genuinely signed'
    ]
  ])('does not let a hyphenated digit-bearing claim launder as a real Project name (%s)', (body) => {
    expect(checkBareDigits(body).violations.length).toBeGreaterThan(0)
  })

  it('still exempts real, digit-free Project names, single and multi, anchored and not', () => {
    const bodies = [
      'Project: cli',
      'Project: aeg-core, cli, vinaya',
      ['<!-- AEG:PROJECT:START -->', '**Project:** cli, aeg-forge-state', '<!-- AEG:PROJECT:END -->'].join('\n')
    ]
    for (const body of bodies) expect(checkBareDigits(body).violations).toEqual([])
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

// ---------- check bin ships executable — round 1's own MINOR, open since the very first push ----------

describe('body-bare-digits — check bin file mode', () => {
  it('check-body-bare-digits.ts ships with mode 100755 — the exact class of bug that caused red CI in round 1 of this PR', () => {
    const binPath = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-body-bare-digits.ts')
    const mode = statSync(binPath).mode & 0o777
    expect(mode).toBe(0o755)
  })
})

describe('anchor-exemption diagnosis — why the region did not count', () => {
  const EVIDENCE = ['<!-- AEG:EVIDENCE:START -->', 'Head: 995a4552', '<!-- AEG:EVIDENCE:END -->'].join('\n')

  it('names the missing section when an EVIDENCE region sits outside `## Evidence`', () => {
    const body = ['## What this is', '', 'Prose.', '', EVIDENCE].join('\n')
    const scan = checkBareDigits(body)
    expect(scan.violations.length).toBeGreaterThan(0)
    const d = diagnoseAnchorExemption(body, scan.violations[0]?.line as number)
    expect(d?.field).toBe('EVIDENCE')
    expect(d?.reason).toBe('outside-canonical-section')
    expect(d?.hint).toContain('`## Evidence`')
  })

  // The whole reason this exists: the generic advice tells you to fence the
  // block, and fencing a machine-emitted block breaks `evidence-fresh`.
  it('tells the author NOT to fence or reword the region', () => {
    const body = ['## What this is', '', EVIDENCE].join('\n')
    const scan = checkBareDigits(body)
    const d = diagnoseAnchorExemption(body, scan.violations[0]?.line as number)
    expect(d?.hint).toContain('do not fence or reword')
  })

  it('says nothing for a violation that is ordinary prose', () => {
    const body = ['## Evidence', '', 'We changed 4 files.', '', EVIDENCE].join('\n')
    const scan = checkBareDigits(body)
    const prose = scan.violations.find((v) => v.text.includes('We changed'))
    expect(prose).toBeDefined()
    expect(diagnoseAnchorExemption(body, prose?.line as number)).toBeNull()
  })

  it('reports content-signature when the region carries no `Head:` declaration', () => {
    const body = [
      '## Evidence',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      'A fabricated claim about 12 files.',
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    const scan = checkBareDigits(body)
    expect(scan.violations.length).toBeGreaterThan(0)
    const d = diagnoseAnchorExemption(body, scan.violations[0]?.line as number)
    expect(d?.reason).toBe('content-signature')
  })

  it('returns null for a line number that is not in the body', () => {
    expect(diagnoseAnchorExemption('one line', 99)).toBeNull()
    expect(diagnoseAnchorExemption('one line', 0)).toBeNull()
  })
})

describe('the Summary exemption is exactly as narrow as its verification', () => {
  /**
   * Every case here was a live bypass found by security review at `72bf01a`:
   * the exemption was case-insensitive, trimmed, and applied to every
   * occurrence, while `evidence-fresh` verifies only the first column-0,
   * case-sensitive line. Anything in that gap was exempt from the digit check
   * and compared against nothing.
   */
  const region = (...lines: string[]) =>
    ['## Evidence', '', '<!-- AEG:EVIDENCE:START -->', 'Head: 995a4552', ...lines, '<!-- AEG:EVIDENCE:END -->'].join(
      '\n'
    )

  it('exempts the emitted line', () => {
    expect(checkBareDigits(region('Summary: 2 files changed, 12 insertions(+), 1 deletion(-)')).violations).toEqual([])
  })

  it('does not exempt a lowercase `summary:`', () => {
    const v = checkBareDigits(region('summary: 900 files changed, 45000 insertions(+)')).violations
    expect(v.length).toBeGreaterThan(0)
  })

  it('does not exempt an indented Summary line', () => {
    const v = checkBareDigits(region('  Summary: 900 files changed, 45000 insertions(+)')).violations
    expect(v.length).toBeGreaterThan(0)
  })

  it('does not exempt a SECOND Summary line — only the first is verified', () => {
    const v = checkBareDigits(
      region(
        'Summary: 2 files changed, 12 insertions(+), 1 deletion(-)',
        'Summary: 900 files changed, 45000 insertions(+)'
      )
    ).violations
    // One violation per bare digit token, so the count is not the assertion —
    // that the honest first line is exempt and the second is not, is.
    expect(v.every((x) => x.text.includes('900 files'))).toBe(true)
    expect(v.length).toBeGreaterThan(0)
  })

  // Free prose in the Summary slot is exempt from the digit check, but it can
  // no longer be false: `evidence-fresh` compares the same first line against a
  // fresh derivation, so anything but the derived string fails there.
  it('leaves free prose in the Summary slot to evidence-fresh, which rejects it', () => {
    const prose = 'Summary: all 47 gates green, 0 known regressions, 3 waivers used'
    expect(checkBareDigits(region(prose)).violations).toEqual([])
    const r = compareEvidenceBlock(
      [`Head: ${'a'.repeat(40)}`, prose, '', '```', '1\t0\ta.ts', '```'].join('\n'),
      'a'.repeat(40),
      '1\t0\ta.ts'
    )
    expect(r.status).toBe('fail')
  })
})

describe('there is one normalisation path, not two that agree', () => {
  /**
   * Source-derived, because a behavioural fixture cannot test this.
   *
   * The first version of this guard pinned a zero-width space — a stage BOTH
   * copies already applied — so it stayed green through every way of
   * decoupling the two sides: re-inlining the stages, re-inlining plus adding a
   * stage, and adding a stage inside the resolver. Code review broke it three
   * ways and got `104 pass, 0 fail` each time. A guard that reports green on
   * the precise regression it exists to catch is this PR's own subject.
   *
   * Any fixture has the same flaw: it can only exercise the stages that exist
   * TODAY, and the regression is a stage added TOMORROW to one side. So this
   * reads the source and asserts the structure instead — the same move
   * `review-post.test.ts`'s flag-coverage guard already makes.
   */
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../../src/checks/body-bare-digits-logic.ts', import.meta.url)),
    'utf8'
  )

  /** The stage expressions that must appear exactly once, inside `normalizeBody`. */
  const NORMALISE_STAGES = ['ZERO_WIDTH', 'decodeNamedEntities(']

  /** Source lines that are code — prose in a docstring names these symbols too. */
  const CODE_LINES = SOURCE.split('\n').filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })

  it('declares each normalisation stage exactly once outside its own definition', () => {
    for (const stage of NORMALISE_STAGES) {
      // One use site each: inside `normalizeBody`. A second is an inlined copy,
      // which is exactly what stage eight was.
      const uses = CODE_LINES.filter(
        (l) => l.includes(stage) && !l.includes('const ZERO_WIDTH') && !l.includes('function decodeNamedEntities')
      )
      expect(uses.length, `${stage} appears on ${uses.length} lines; expected one use site inside normalizeBody`).toBe(
        1
      )
    }
  })

  it('routes both consumers through normalizeBody', () => {
    // `checkBareDigits` is the scanner, `resolveAnchoredRegionForScan` the
    // resolver. Both must call the function, not reproduce what it does.
    for (const fn of ['export function checkBareDigits', 'export function resolveAnchoredRegionForScan']) {
      const start = SOURCE.indexOf(fn)
      expect(start, `${fn} not found — this guard is reading the wrong source`).toBeGreaterThan(-1)
      const bodyText = SOURCE.slice(start, SOURCE.indexOf('\n}', start))
      expect(bodyText, `${fn} does not call normalizeBody`).toContain('normalizeBody(')
    }
  })

  it('composes the anchor-lookup mask in exactly one place', () => {
    // The other half of the same property: `buildScanMask` and the resolver
    // must not each spell out `maskDetailsBlocks(maskCode(...))`.
    const composed = CODE_LINES.filter(
      (l) => l.includes('maskDetailsBlocks(maskCode(') && !l.includes('function buildAnchorLookupMask')
    )
    expect(composed.length, 'the mask composition is written more than once').toBe(1)
    for (const fn of ['function buildScanMask', 'export function resolveAnchoredRegionForScan']) {
      const start = SOURCE.indexOf(fn)
      const bodyText = SOURCE.slice(start, SOURCE.indexOf('\n}', start))
      expect(bodyText, `${fn} does not call buildAnchorLookupMask`).toContain('buildAnchorLookupMask(')
    }
  })

  it('scans the same text the resolver resolves', () => {
    const ZW = '​'
    const body = [
      '## Evidence',
      '',
      `<!-- AEG:EVIDENCE:STA${ZW}RT -->`,
      `Head: ${'a'.repeat(40)}`,
      'Summary: 900 files changed, 12000 insertions(+), 3 deletions(-)',
      '',
      '```',
      '1\t0\ta.ts',
      '```',
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    // The resolver sees the anchor through the zero-width character...
    const resolved = resolveAnchoredRegionForScan(body, 'EVIDENCE')
    expect(resolved).not.toBeNull()
    expect(resolved).not.toBe('hidden')
    // ...and so does the scanner, so the fabricated Summary is the exempted
    // line AND the compared one, rather than exempt on one side and invisible
    // on the other.
    expect(checkBareDigits(body).violations).toEqual([])
  })

  it('exposes the normalisation as one exported function', () => {
    const ZW = '​'
    expect(normalizeBody(`a${ZW}b`)).toBe('ab')
    expect(normalizeBody('&lt;details&gt;')).toBe('<details>')
  })
})

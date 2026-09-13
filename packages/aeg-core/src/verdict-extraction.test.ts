import { describe, expect, it } from 'vitest'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict, VERDICT_MARKER_SOURCE } from './verdict-extraction'

/**
 * The post-merge Archivist's real, auto-generated DANGLING placeholder text
 * (`archive-task.ts`'s `extractVerdict`, missing-comment case) — the literal
 * string that appears on real merged PRs (e.g. #471/#472) when no
 * security-review comment exists yet. Contains the standalone word "pass"
 * ("...security-review pass was run...") — the exact bare-word-match exploit
 * this tightening closes.
 */
const DANGLING_SECURITY_PLACEHOLDER = 'no security-review pass was run before merge — DANGLING, see below'
const DANGLING_CODE_REVIEW_PLACEHOLDER = 'no code-reviewer pass was run before merge — DANGLING, see below'

/** A real subagent report, copied verbatim from `roles/reviewer.md`'s "Output format" template. */
const REAL_CODE_REVIEWER_REPORT = `VERDICT: APPROVE

BRIEF CONFORMANCE: implements exactly what the brief asked.
SPEC CONFORMANCE: clean

FINDINGS (ordered by severity):
1. [MINOR] src/foo.ts:12 — a nit, not blocking

SCOPE: clean
TESTS: honest`

/** A real subagent report, copied verbatim from `roles/security.md`'s "Output format" template. */
const REAL_SECURITY_REVIEWER_REPORT = `VERDICT: PASS

FINDINGS (ordered by severity):
1. [LOW] src/foo.ts:12 — informational only

CONFIG SCAN: clean
SECRETS: none found`

describe('extractCodeReviewVerdict', () => {
  it('extracts APPROVE from a standalone VERDICT: line', () => {
    const result = extractCodeReviewVerdict(['VERDICT: APPROVE'])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts REQUEST CHANGES (normalizing the separator) from a VERDICT: line', () => {
    const result = extractCodeReviewVerdict(['VERDICT: REQUEST_CHANGES'])
    expect(result).toEqual({
      value: 'REQUEST CHANGES',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts LGTM from a VERDICT: line', () => {
    const result = extractCodeReviewVerdict(['VERDICT: LGTM'])
    expect(result).toEqual({
      value: 'LGTM',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('is DANGLING/missing when no comment carries the marker at all', () => {
    const result = extractCodeReviewVerdict(['unrelated comment', 'ship it'])
    expect(result.danglingNote).toBe('no code-reviewer verdict comment found on this PR')
    expect(result.value).toContain('DANGLING')
  })

  it('prefers a later clean APPROVE over an earlier REQUEST CHANGES (real review-cycle shape)', () => {
    const result = extractCodeReviewVerdict([
      'VERDICT: REQUEST CHANGES\n\nplease address the inline notes.',
      'Fixed per feedback.',
      'VERDICT: APPROVE\n\nlooks good now.'
    ])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  // ---- required regression coverage (aeg-review-gate-v1 task 1 follow-up, security FAIL finding) ----

  it('regression 1: the literal DANGLING placeholder string does NOT produce a clean verdict', () => {
    const result = extractCodeReviewVerdict([
      `### AEG provenance\n- Code review: ${DANGLING_CODE_REVIEW_PLACEHOLDER}\n\nDANGLING: no code-reviewer verdict comment found on this PR`
    ])
    expect(result.danglingNote).not.toBeNull()
    expect(result.value).not.toBe('APPROVE')
  })

  it('regression 2: negated/incidental prose containing the bare word does NOT produce a clean APPROVE', () => {
    const result = extractCodeReviewVerdict(['I do NOT approve of that design — it needs a rethink.'])
    expect(result.danglingNote).not.toBeNull()
    expect(result.value).not.toBe('APPROVE')
  })

  it('regression 3: a real, line-anchored VERDICT: APPROVE (matching the actual subagent report shape) still produces a clean verdict', () => {
    const result = extractCodeReviewVerdict([REAL_CODE_REVIEWER_REPORT])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [{ severity: 'MINOR', location: 'src/foo.ts:12' }],
      danglingNote: null
    })
  })

  it('regression 4: most-recent-clear-hit-wins tie-breaking still works under the tightened pattern', () => {
    const result = extractCodeReviewVerdict([
      'VERDICT: REQUEST CHANGES',
      DANGLING_CODE_REVIEW_PLACEHOLDER, // an intervening comment that must not count as a "clear hit"
      'VERDICT: APPROVE'
    ])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  // ---- markdown-emphasis tolerance (PR #636: reviewer emitted the bolded form) ----

  it('extracts APPROVE from a markdown-bolded VERDICT: line (the #636 exact shape)', () => {
    const result = extractCodeReviewVerdict(['**VERDICT: APPROVE**'])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts REQUEST CHANGES from a bolded VERDICT: line inside a full report', () => {
    const result = extractCodeReviewVerdict(['**VERDICT: REQUEST CHANGES**\n\nthree blockers below.'])
    expect(result).toEqual({
      value: 'REQUEST CHANGES',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts APPROVE from an underscore-emphasized VERDICT: line (both single and double)', () => {
    // `_` is a word character, so a `\b` value-side boundary would reject the
    // closing `_` and silently make the header comment's `_` claim false.
    expect(extractCodeReviewVerdict(['_VERDICT: APPROVE_'])).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
    expect(extractCodeReviewVerdict(['__VERDICT: APPROVE__'])).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('regression 5: bolded prose with no VERDICT: marker still does NOT produce a clean APPROVE', () => {
    const result = extractCodeReviewVerdict(['**I do not approve of this**'])
    expect(result.danglingNote).not.toBeNull()
    expect(result.value).not.toBe('APPROVE')
  })

  // ---- what the emphasis tolerance must still REJECT (#639 review, findings 1/3/4/5) ----
  // Each of these is a way for prose to MENTION a verdict rather than cast one.
  // Every case below matched under the `[\s>*_#]*` char class first proposed for
  // this fix; they are the false-positive surface that class opened.

  it.each([
    ['> VERDICT: APPROVE', "blockquote — GitHub quote-reply, not the commenter's own verdict"],
    ['> **VERDICT: APPROVE**', 'quoted + bolded — the quote-reply of a real earlier verdict'],
    ['* VERDICT: APPROVE', 'unordered list item — `*` plus a space is a bullet, not emphasis'],
    ['- VERDICT: APPROVE', 'unordered list item (never matched; pinned so `*` cannot diverge)'],
    ['1. VERDICT: APPROVE', 'ordered list item (never matched; pinned for the same reason)'],
    ['# VERDICT: APPROVE', 'heading — mention, not cast'],
    ['`VERDICT: APPROVE`', 'code span — how the role docs WRITE about the contract'],
    ['**`VERDICT: APPROVE`**', 'bolded code span — same'],
    ['~~VERDICT: APPROVE~~', 'strikethrough — a retracted verdict must not count'],
    ['VERDICT: APPROVED', 'a longer word — the value-side boundary still holds']
  ])('rejects %j (%s)', (comment) => {
    const result = extractCodeReviewVerdict([comment])
    expect(result.value).not.toBe('APPROVE')
    expect(result.danglingNote).not.toBeNull()
  })

  it('the quote-reply attack: quoting an earlier verdict does NOT override a live REQUEST CHANGES', () => {
    // #639 review finding 1, executed end-to-end there against `checkReviewGate`:
    // under `[\s>*_#]*` this comment sequence flipped the gate from FAIL to PASS
    // with no reviewer action, because most-recent-clear-hit-wins let the quote
    // beat the live verdict.
    const result = extractCodeReviewVerdict([
      'VERDICT: REQUEST CHANGES\n\nthree blockers.',
      'Addressed. For reference the first pass said:\n\n> **VERDICT: APPROVE**\n\nsee thread.'
    ])
    expect(result).toEqual({
      value: 'REQUEST CHANGES',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })
})

describe('extractSecurityReviewVerdict', () => {
  it('extracts PASS from a standalone VERDICT: line', () => {
    const result = extractSecurityReviewVerdict(['VERDICT: PASS'])
    expect(result).toEqual({
      value: 'PASS',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts FAIL from a standalone VERDICT: line', () => {
    const result = extractSecurityReviewVerdict(['VERDICT: FAIL'])
    expect(result).toEqual({
      value: 'FAIL',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('is DANGLING/missing when no comment carries the marker at all', () => {
    const result = extractSecurityReviewVerdict(['unrelated comment'])
    expect(result.danglingNote).toBe('no security-review verdict comment found on this PR')
  })

  // ---- required regression coverage (aeg-review-gate-v1 task 1 follow-up, security FAIL finding) ----

  it('regression 1 (the confirmed exploit): the Archivist DANGLING placeholder\'s bare "pass" does NOT produce a clean PASS', () => {
    const result = extractSecurityReviewVerdict([
      `### AEG provenance\n- Security: ${DANGLING_SECURITY_PLACEHOLDER}\n\nDANGLING: no security-review verdict comment found on this PR`
    ])
    expect(result.value).not.toBe('PASS')
    expect(result.danglingNote).not.toBeNull()
  })

  it("regression 2: a code-reviewer's own VERDICT: APPROVE comment does not falsely satisfy the security extractor", () => {
    const result = extractSecurityReviewVerdict([REAL_CODE_REVIEWER_REPORT])
    expect(result.value).not.toBe('PASS')
    expect(result.value).not.toBe('FAIL')
    expect(result.danglingNote).toBe('no security-review verdict comment found on this PR')
  })

  it('regression 3: a real, line-anchored VERDICT: PASS (matching the actual subagent report shape) still produces a clean verdict', () => {
    const result = extractSecurityReviewVerdict([REAL_SECURITY_REVIEWER_REPORT])
    expect(result).toEqual({
      value: 'PASS',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [{ severity: 'LOW', location: 'src/foo.ts:12' }],
      danglingNote: null
    })
  })

  it('regression 4: most-recent-clear-hit-wins tie-breaking still works under the tightened pattern', () => {
    const result = extractSecurityReviewVerdict([
      'VERDICT: FAIL',
      DANGLING_SECURITY_PLACEHOLDER, // an intervening comment that must not count as a "clear hit"
      'VERDICT: PASS'
    ])
    expect(result).toEqual({
      value: 'PASS',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  // ---- markdown-emphasis tolerance (PR #636: reviewer emitted the bolded form) ----

  it('extracts PASS from a markdown-bolded VERDICT: line', () => {
    const result = extractSecurityReviewVerdict(['**VERDICT: PASS**'])
    expect(result).toEqual({
      value: 'PASS',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('extracts PASS from an underscore-emphasized VERDICT: line', () => {
    expect(extractSecurityReviewVerdict(['_VERDICT: PASS_'])).toEqual({
      value: 'PASS',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  // ---- what the emphasis tolerance must still REJECT (#639 review, findings 1/3/4/5) ----

  it.each([
    ['> VERDICT: PASS', 'blockquote — GitHub quote-reply'],
    ['> **VERDICT: PASS**', 'quoted + bolded'],
    ['* VERDICT: PASS', 'unordered list item'],
    ['# VERDICT: PASS', 'heading'],
    ['`VERDICT: PASS`', 'code span'],
    ['~~VERDICT: PASS~~', 'strikethrough'],
    ['VERDICT: PASSED', 'a longer word — the value-side boundary still holds']
  ])('rejects %j (%s)', (comment) => {
    const result = extractSecurityReviewVerdict([comment])
    expect(result.value).not.toBe('PASS')
    expect(result.danglingNote).not.toBeNull()
  })

  it('the quote-reply attack: quoting an earlier PASS does NOT override a live FAIL', () => {
    const result = extractSecurityReviewVerdict([
      'VERDICT: FAIL\n\nleaked credential in the fixture.',
      'Rotated. The earlier clean run said:\n\n> **VERDICT: PASS**\n\nfor reference.'
    ])
    expect(result).toEqual({
      value: 'FAIL',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })
})

// ---- reviewed-commit binding (#73, a duplicate of #71 closes this one) ----
// `checkReviewGate` (review-gate.test.ts) is what judges whether an extracted
// `headSha` covers the PR's current head — these cases only prove the parser
// itself: what it extracts, and what it correctly refuses to read as a
// binding at all.

describe('reviewed-commit binding (Judged head:)', () => {
  const FULL_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'
  const SHORT_SHA = '8365ca5'

  it('present and matching a full 40-char sha: extracts it lowercased alongside the verdict', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}`])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: FULL_SHA,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('present with the abbreviated 7-char form: extracts it alongside the verdict', () => {
    const result = extractSecurityReviewVerdict([`VERDICT: PASS\n\nJudged head: ${SHORT_SHA}`])
    expect(result).toEqual({
      value: 'PASS',
      headSha: SHORT_SHA,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it("present but naming a superseded (stale) head: extraction still returns it verbatim — staleness is the gate's judgment, not the extractor's", () => {
    const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${staleSha}`])
    expect(result.headSha).toBe(staleSha)
    expect(result.value).toBe('APPROVE')
  })

  it('absent entirely: a clean verdict with no Judged head: line extracts a real value but a null headSha', () => {
    const result = extractCodeReviewVerdict(['VERDICT: APPROVE\n\nlooks good.'])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('no verdict at all: headSha is null and danglingNote is set — the "no verdict" state, distinct from "verdict but unbound"', () => {
    const result = extractCodeReviewVerdict(['unrelated comment'])
    expect(result.headSha).toBeNull()
    expect(result.danglingNote).not.toBeNull()
  })

  it.each([
    ['Judged head: not-a-sha', 'non-hex characters'],
    ['Judged head: 123', 'too short (under 7 hex chars)'],
    ['Judged head: ', 'no value at all']
  ])('malformed line (%s) does not extract a headSha', (line) => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\n${line}`])
    expect(result.value).toBe('APPROVE')
    expect(result.headSha).toBeNull()
  })

  it('a sha mentioned in ordinary prose is NOT read as a binding', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nsee commit ${FULL_SHA} for the prior context.`])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it.each([
    [`> Judged head: ${FULL_SHA}`, 'blockquote'],
    [`* Judged head: ${FULL_SHA}`, 'list item'],
    [`# Judged head: ${FULL_SHA}`, 'heading'],
    [`\`Judged head: ${FULL_SHA}\``, 'code span']
  ])('does not tolerate a %s form of the Judged head: line (%s)', (line) => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\n${line}`])
    expect(result.headSha).toBeNull()
  })

  it('tolerates a leading emphasis run, matching the VERDICT: anchor discipline', () => {
    const result = extractCodeReviewVerdict([`**VERDICT: APPROVE**\n\n**Judged head: ${FULL_SHA}**`])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: FULL_SHA,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('is scoped to the SAME comment as the winning verdict — a sha in a different comment is not this binding', () => {
    const result = extractCodeReviewVerdict([`Judged head: ${FULL_SHA}`, 'VERDICT: APPROVE\n\nno head line here.'])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })
})

// ---- five-line read window (round-4 ruling on review-convergence-v1 task 2,
// #392; widened by dev-review-loop-v1 task 2, #412, O2) ----
// All three markers are read from a comment's first FIVE lines only. Every
// real render (`review-post.ts`) puts VERDICT/ESCALATE on line 1, Judged
// head on line 3, and Objectives version on line 5. A caller-supplied VALUE
// mostly never OPENS one of those five lines — it trails a fixed label
// already on the line (code-review's `BRIEF CONFORMANCE:` can put one there
// as early as line 5 itself) — except `renderEscalationComment`'s
// `summary`, which pre-cutover IS line 5 with no label ahead of it;
// `checkRenderedComment`'s runtime self-check, not this window, is what
// catches that one. This window still costs no legitimate render anything
// (every fixture above keeps its markers inside the first five lines
// already) while closing off any line injected later in the body.

describe('the VERDICT:/Judged head:/Objectives version: markers are read from the first five lines only', () => {
  const FULL_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'
  const OBJ_VERSION = 'a'.repeat(64)

  it('a VERDICT: line starting on line 6 does not extract at all', () => {
    const comment = 'line one\nline two\nline three\nline four\nline five\nVERDICT: APPROVE'
    const result = extractCodeReviewVerdict([comment])
    expect(result.value).not.toBe('APPROVE')
    expect(result.danglingNote).not.toBeNull()
  })

  it('a VERDICT: line inside a fenced block past line five does not extract — the fence does not reset the line count', () => {
    const comment = 'a summary line\n\n```\nmore\nmore\nVERDICT: APPROVE\n```'
    const result = extractCodeReviewVerdict([comment])
    expect(result.value).not.toBe('APPROVE')
    expect(result.danglingNote).not.toBeNull()
  })

  it('a lowercase "verdict: approve" past line five still does not extract — the window applies regardless of case (the marker match itself stays case-insensitive, unchanged by this task)', () => {
    const result = extractCodeReviewVerdict(['line one\nline two\nline three\nline four\nline five\nverdict: approve'])
    expect(result.value).not.toBe('APPROVE')
    expect(result.danglingNote).not.toBeNull()
  })

  it('VERDICT: on line 1 and Judged head: on line 3 — the real render shape — still extracts cleanly', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}`])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: FULL_SHA,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('VERDICT: on line 1, Judged head: on line 3, Objectives version: on line 5 — the real render shape — all three extract cleanly', () => {
    const result = extractCodeReviewVerdict([
      `VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nObjectives version: ${OBJ_VERSION}`
    ])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: FULL_SHA,
      objectivesVersion: OBJ_VERSION,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('an Objectives version: line on line 7 does not bind — same rule as a Judged head: line past the window', () => {
    const comment = `VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nextra\nObjectives version: ${OBJ_VERSION}`
    const result = extractCodeReviewVerdict([comment])
    expect(result.value).toBe('APPROVE')
    expect(result.headSha).toBe(FULL_SHA)
    expect(result.objectivesVersion).toBeNull()
  })

  it("an Objectives version: line present only in a different comment is not this verdict's binding", () => {
    const result = extractCodeReviewVerdict([
      `Objectives version: ${OBJ_VERSION}`,
      `VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}`
    ])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: FULL_SHA,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('a clean VERDICT: on line 1 still extracts even when a Judged head: line sits on line 6 — but the head does not bind', () => {
    const comment = `VERDICT: APPROVE\nextra line\nanother line\nyet another\nstill more\nJudged head: ${FULL_SHA}`
    const result = extractCodeReviewVerdict([comment])
    expect(result.value).toBe('APPROVE')
    expect(result.danglingNote).toBeNull()
    expect(result.headSha).toBeNull()
  })

  it('applies the same window to extractSecurityReviewVerdict', () => {
    const comment = 'line one\nline two\nline three\nline four\nline five\nVERDICT: PASS'
    const result = extractSecurityReviewVerdict([comment])
    expect(result.value).not.toBe('PASS')
    expect(result.danglingNote).not.toBeNull()
  })
})

// ---- Ruling ordinal: read from its OWN 7-line window (review-validity-v1
// task 3, #477, O1) ----
// `Ruling ordinal:` renders UNCONDITIONALLY, so its worst-case position is
// line 7 (Objectives version present: 5=version, 6=blank, 7=ruling
// ordinal). This window is `firstSevenLines`, never `firstFiveLines`
// widened in place — see `firstSevenLines`'s own doc comment for why.

describe('Ruling ordinal: is read from its own first-seven-line window', () => {
  const FULL_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'
  const OBJ_VERSION = 'a'.repeat(64)

  it('Ruling ordinal: on line 5 (no Objectives version) extracts cleanly', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nRuling ordinal: 3`])
    expect(result.rulingOrdinal).toBe(3)
  })

  it('Ruling ordinal: 0 (explicit zero, no rulings existed at cast time) extracts as 0, not null', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nRuling ordinal: 0`])
    expect(result.rulingOrdinal).toBe(0)
  })

  it('Ruling ordinal: on line 7 (Objectives version present on line 5) still extracts — the real post-cutover render shape', () => {
    const comment = `VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nObjectives version: ${OBJ_VERSION}\n\nRuling ordinal: 7`
    const result = extractCodeReviewVerdict([comment])
    expect(result.objectivesVersion).toBe(OBJ_VERSION)
    expect(result.rulingOrdinal).toBe(7)
  })

  it('a Ruling ordinal: line on line 8 does not extract — one line past the 7-line window, same fail-closed shape as a Judged head: line past its own window', () => {
    const comment = `VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}\n\nObjectives version: ${OBJ_VERSION}\n\nextra\nRuling ordinal: 9`
    const result = extractCodeReviewVerdict([comment])
    expect(result.objectivesVersion).toBe(OBJ_VERSION)
    expect(result.rulingOrdinal).toBeNull()
  })

  it('no Ruling ordinal: line at all (pre-cutover stock) reads as null, never 0', () => {
    const result = extractCodeReviewVerdict([`VERDICT: APPROVE\n\nJudged head: ${FULL_SHA}`])
    expect(result.rulingOrdinal).toBeNull()
  })

  it('applies the same window to extractSecurityReviewVerdict', () => {
    const comment = `VERDICT: PASS\n\nJudged head: ${FULL_SHA}\n\nObjectives version: ${OBJ_VERSION}\n\nRuling ordinal: 2`
    const result = extractSecurityReviewVerdict([comment])
    expect(result.rulingOrdinal).toBe(2)
  })
})

// ---- round 5 (#392): candidacy is whole-body, value stays windowed ----
// Round 4's window narrowed where the VALUE is read; it must not narrow which
// comments even COUNT as candidates. A later comment whose VERDICT-shaped
// line sits outside its own first five lines is still the most recent
// candidate — it must shadow an earlier clean verdict into DANGLING, not
// silently drop out and let the earlier comment win.

describe('candidate selection stays whole-body — a later unclear candidate shadows an earlier clean one (round 5, #392)', () => {
  const HEAD = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'
  const clean = `VERDICT: APPROVE\n\nJudged head: ${HEAD}`
  const laterUnclear = `line one\nline two\nline three\nline four\nline five\nVERDICT: REQUEST CHANGES\n\nJudged head: ${HEAD}`

  it('a later same-head comment with VERDICT on line 6 makes the result DANGLING, not the earlier clean APPROVE', () => {
    const result = extractCodeReviewVerdict([clean, laterUnclear])
    expect(result.value).not.toBe('APPROVE')
    expect(result.danglingNote).not.toBeNull()
    expect(result.headSha).toBeNull()
  })

  it('the earlier comment alone still extracts its clean head-bound APPROVE unchanged', () => {
    const result = extractCodeReviewVerdict([clean])
    expect(result).toEqual({
      value: 'APPROVE',
      headSha: HEAD,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: null
    })
  })

  it('the later comment alone is DANGLING — its VERDICT-shaped line is a real candidate, just unreadable in its own window', () => {
    const result = extractCodeReviewVerdict([laterUnclear])
    expect(result.value).not.toBe('REQUEST CHANGES')
    expect(result.danglingNote).not.toBeNull()
    expect(result.headSha).toBeNull()
  })
})

// ---- FINDINGS block severities (review-validity-v1 task 8, #506, O2/O3) ----
// Read from the WHOLE comment body — never firstFiveLines's window, since
// renderFindingsSection always renders the findings list past line five.

describe('findingSeverities — the FINDINGS block, read whole-body', () => {
  it('extracts every severity from a real rendered FINDINGS block', () => {
    const result = extractCodeReviewVerdict([REAL_CODE_REVIEWER_REPORT])
    expect(result.findingSeverities).toEqual([{ severity: 'MINOR', location: 'src/foo.ts:12' }])
  })

  it('extracts a mixed-severity FINDINGS block in rendered order', () => {
    const comment = [
      'VERDICT: REQUEST CHANGES',
      '',
      'Judged head: 8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f',
      '',
      'FINDINGS (ordered by severity):',
      '1. [BLOCKER] a.ts:1 — off-by-one',
      '2. [MAJOR] b.ts:2 — missing null check',
      '3. [MINOR] c.ts:3 — naming nit'
    ].join('\n')
    const result = extractCodeReviewVerdict([comment])
    expect(result.findingSeverities).toEqual([
      { severity: 'BLOCKER', location: 'a.ts:1' },
      { severity: 'MAJOR', location: 'b.ts:2' },
      { severity: 'MINOR', location: 'c.ts:3' }
    ])
  })

  it('"None." (the empty-findings render) yields no severities', () => {
    const comment =
      'VERDICT: APPROVE\n\nJudged head: 8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f\n\nFINDINGS (ordered by severity):\nNone.'
    const result = extractCodeReviewVerdict([comment])
    expect(result.findingSeverities).toEqual([])
  })

  it('a DANGLING extraction (no verdict comment at all) carries no findingSeverities', () => {
    const result = extractCodeReviewVerdict(['unrelated comment'])
    expect(result.findingSeverities).toEqual([])
  })

  it("reads only the winning comment — an earlier comment's findings are not this verdict's", () => {
    const result = extractCodeReviewVerdict([
      'VERDICT: REQUEST CHANGES\n\nFINDINGS (ordered by severity):\n1. [BLOCKER] a.ts:1 — old issue',
      'VERDICT: APPROVE\n\nFINDINGS (ordered by severity):\nNone.'
    ])
    expect(result.value).toBe('APPROVE')
    expect(result.findingSeverities).toEqual([])
  })

  it('security-review findings extract identically via extractSecurityReviewVerdict', () => {
    const result = extractSecurityReviewVerdict([REAL_SECURITY_REVIEWER_REPORT])
    expect(result.findingSeverities).toEqual([{ severity: 'LOW', location: 'src/foo.ts:12' }])
  })
})

describe('VERDICT_MARKER_SOURCE', () => {
  // task-run-v1 18, #525 O2: the exported marker is a presence-only test —
  // no value alternation — so it must accept every shape the two real value
  // patterns above accept and reject every shape they reject, the same
  // anchor discipline (mention vs. cast) `extractCodeReviewVerdict`'s own
  // module comment documents.
  const marker = new RegExp(VERDICT_MARKER_SOURCE, 'im')

  it('matches a bare, line-anchored VERDICT: marker', () => {
    expect(marker.test('VERDICT: APPROVE')).toBe(true)
    expect(marker.test('some discussion\nVERDICT: PASS\nJudged head: abc123')).toBe(true)
  })

  it('tolerates a leading markdown emphasis run', () => {
    expect(marker.test('**VERDICT: APPROVE**')).toBe(true)
    expect(marker.test('_VERDICT: APPROVE_')).toBe(true)
  })

  it('rejects a bare mention in prose', () => {
    expect(marker.test('this checks for a VERDICT: comment in prose')).toBe(false)
  })

  it('rejects a blockquoted, list-item, or heading mention', () => {
    expect(marker.test('> VERDICT: APPROVE')).toBe(false)
    expect(marker.test('* VERDICT: APPROVE')).toBe(false)
    expect(marker.test('# VERDICT: APPROVE')).toBe(false)
  })

  it("is the exact prefix both real value patterns' extraction depends on", () => {
    // Indirect check (the two patterns above are module-private): a value
    // pattern built from this exact source plus a value alternation extracts
    // identically to the real exported function.
    const codeReviewFromMarker = new RegExp(
      `${VERDICT_MARKER_SOURCE}\\s*(APPROVE|REQUEST[ _-]?CHANGES|LGTM)(?![A-Za-z0-9])`,
      'im'
    )
    const comment = '**VERDICT: APPROVE**'
    const real = extractCodeReviewVerdict([comment])
    const viaMarker = codeReviewFromMarker.exec(comment)
    expect(viaMarker?.[1]).toBe('APPROVE')
    expect(real.value).toBe('APPROVE')
  })
})

// --- Brief hash / Policy digest binding (review-validity-v1 task 4, #478, O1/O5) ---

describe('Brief hash: / Policy digest: extraction', () => {
  const HASH_A = 'a'.repeat(64)
  const HASH_B = 'b'.repeat(64)

  it('extracts both when present, right after Ruling ordinal:', () => {
    const comment = [
      'VERDICT: APPROVE',
      '',
      'Judged head: abc1234',
      '',
      'Ruling ordinal: 0',
      '',
      `Brief hash: ${HASH_A}`,
      '',
      `Policy digest: ${HASH_B}`,
      '',
      'BRIEF CONFORMANCE: clean'
    ].join('\n')
    const result = extractCodeReviewVerdict([comment])
    expect(result.briefHash).toBe(HASH_A)
    expect(result.policyDigest).toBe(HASH_B)
  })

  it('extracts both when Objectives version: also renders, pushing Policy digest to line 11', () => {
    const comment = [
      'VERDICT: PASS',
      '',
      'Judged head: abc1234',
      '',
      `Objectives version: ${'c'.repeat(64)}`,
      '',
      'Ruling ordinal: 1',
      '',
      `Brief hash: ${HASH_A}`,
      '',
      `Policy digest: ${HASH_B}`
    ].join('\n')
    const result = extractSecurityReviewVerdict([comment])
    expect(result.briefHash).toBe(HASH_A)
    expect(result.policyDigest).toBe(HASH_B)
  })

  it('reads null for both on legacy stock with no such lines at all', () => {
    const result = extractCodeReviewVerdict(['VERDICT: APPROVE\n\nJudged head: abc1234'])
    expect(result.briefHash).toBeNull()
    expect(result.policyDigest).toBeNull()
  })

  it('reads null for Brief hash: when the value is a non-hash placeholder ("(none)")', () => {
    const comment = [
      'VERDICT: APPROVE',
      '',
      'Judged head: abc1234',
      '',
      'Ruling ordinal: 0',
      '',
      'Brief hash: (none)'
    ].join('\n')
    const result = extractCodeReviewVerdict([comment])
    expect(result.briefHash).toBeNull()
  })
})

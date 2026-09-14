import { describe, expect, test } from 'vitest'
import {
  blockingSeverities,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewBlockingSeverities,
  DEFAULT_REVIEW_POLICY,
  evaluateCodeReview,
  evaluateReviewFindings,
  evaluateSecurityReview,
  isKnownSeverity,
  isProseLocation,
  type ReviewPolicy,
  SECURITY_SEVERITY_ORDER,
  securityBlockingSeverities
} from './review-policy'

const THIS_REPO_POLICY: ReviewPolicy = { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }

describe('blockingSeverities', () => {
  test('is the scale prefix ending at threshold, inclusive', () => {
    expect(blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')).toEqual(['BLOCKER', 'MAJOR'])
    expect(blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, 'BLOCKER')).toEqual(['BLOCKER'])
    expect(blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, 'MINOR')).toEqual(['BLOCKER', 'MAJOR', 'MINOR'])
    expect(blockingSeverities(SECURITY_SEVERITY_ORDER, 'HIGH')).toEqual(['CRITICAL', 'HIGH'])
  })

  test('throws on an unknown threshold, never falls back', () => {
    expect(() => blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, 'SEVERE')).toThrow(/not one of/)
  })
})

describe('evaluateReviewFindings — threshold boundaries', () => {
  test('a finding exactly at the threshold blocks', () => {
    const result = evaluateReviewFindings([{ severity: 'MAJOR' }], CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')
    expect(result.outcome).toBe('blocked')
    expect(result.blockingFindings).toEqual([{ severity: 'MAJOR' }])
  })

  test('a finding more severe than the threshold blocks', () => {
    const result = evaluateReviewFindings([{ severity: 'BLOCKER' }], CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')
    expect(result.outcome).toBe('blocked')
  })

  test('a finding less severe than the threshold does not block', () => {
    const result = evaluateReviewFindings([{ severity: 'MINOR' }], CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')
    expect(result.outcome).toBe('clean')
    expect(result.blockingFindings).toEqual([])
  })

  test('security scale: MEDIUM does not block at HIGH threshold, HIGH does', () => {
    expect(evaluateReviewFindings([{ severity: 'MEDIUM' }], SECURITY_SEVERITY_ORDER, 'HIGH').outcome).toBe('clean')
    expect(evaluateReviewFindings([{ severity: 'HIGH' }], SECURITY_SEVERITY_ORDER, 'HIGH').outcome).toBe('blocked')
  })
})

describe('evaluateReviewFindings — mixed findings', () => {
  test('returns only the findings responsible for blocking, others excluded', () => {
    const findings = [{ severity: 'MINOR' }, { severity: 'MAJOR' }, { severity: 'MINOR' }]
    const result = evaluateReviewFindings(findings, CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')
    expect(result.outcome).toBe('blocked')
    expect(result.blockingFindings).toEqual([{ severity: 'MAJOR' }])
  })

  test('preserves extra fields on the finding objects (generic over F)', () => {
    const findings = [{ severity: 'BLOCKER', location: 'a.ts:1', description: 'x' }]
    const result = evaluateCodeReview(findings, DEFAULT_REVIEW_POLICY)
    expect(result.blockingFindings[0]).toEqual({ severity: 'BLOCKER', location: 'a.ts:1', description: 'x' })
  })
})

describe('evaluateReviewFindings — valid zero findings', () => {
  test('no findings at all is clean', () => {
    expect(evaluateReviewFindings([], CODE_REVIEW_SEVERITY_ORDER, 'BLOCKER').outcome).toBe('clean')
    expect(evaluateReviewFindings([], SECURITY_SEVERITY_ORDER, 'HIGH').outcome).toBe('clean')
  })
})

describe('evaluateReviewFindings — unknown severity refuses rather than silently passing', () => {
  test('throws on a finding severity not on the scale', () => {
    expect(() => evaluateReviewFindings([{ severity: 'CATASTROPHIC' }], CODE_REVIEW_SEVERITY_ORDER, 'BLOCKER')).toThrow(
      /not one of/
    )
  })
})

describe('evaluateCodeReview / evaluateSecurityReview — role-scale wrappers', () => {
  test('code review evaluates against CODE_REVIEW_SEVERITY_ORDER', () => {
    expect(evaluateCodeReview([{ severity: 'MINOR' }], DEFAULT_REVIEW_POLICY).outcome).toBe('clean')
    expect(evaluateCodeReview([{ severity: 'BLOCKER' }], DEFAULT_REVIEW_POLICY).outcome).toBe('blocked')
  })

  test('security review evaluates against SECURITY_SEVERITY_ORDER', () => {
    expect(evaluateSecurityReview([{ severity: 'MEDIUM' }], DEFAULT_REVIEW_POLICY).outcome).toBe('clean')
    expect(evaluateSecurityReview([{ severity: 'HIGH' }], DEFAULT_REVIEW_POLICY).outcome).toBe('blocked')
  })

  test('this repository is configured to MAJOR/HIGH: a MAJOR now blocks, unlike the default BLOCKER threshold', () => {
    expect(evaluateCodeReview([{ severity: 'MAJOR' }], DEFAULT_REVIEW_POLICY).outcome).toBe('clean')
    expect(evaluateCodeReview([{ severity: 'MAJOR' }], THIS_REPO_POLICY).outcome).toBe('blocked')
  })
})

describe('codeReviewBlockingSeverities / securityBlockingSeverities', () => {
  test('derive the blocking subset from a resolved policy', () => {
    expect(codeReviewBlockingSeverities(THIS_REPO_POLICY)).toEqual(['BLOCKER', 'MAJOR'])
    expect(securityBlockingSeverities(THIS_REPO_POLICY)).toEqual(['CRITICAL', 'HIGH'])
    expect(codeReviewBlockingSeverities(DEFAULT_REVIEW_POLICY)).toEqual(['BLOCKER'])
  })
})

describe('isKnownSeverity', () => {
  test('true for a scale member, false otherwise', () => {
    expect(isKnownSeverity(CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')).toBe(true)
    expect(isKnownSeverity(CODE_REVIEW_SEVERITY_ORDER, 'CRITICAL')).toBe(false)
  })
})

describe('isProseLocation (#543 O5)', () => {
  test('matches the PR body, a comment, or a role file', () => {
    expect(isProseLocation('PR body')).toBe(true)
    expect(isProseLocation('pr body')).toBe(true)
    expect(isProseLocation('a PR comment')).toBe(true)
    expect(isProseLocation('review comment')).toBe(true)
    expect(isProseLocation('aeg-root/roles/developer.md:12')).toBe(true)
  })

  test('never matches a source or test file', () => {
    expect(isProseLocation('src/foo.ts:12')).toBe(false)
    expect(isProseLocation('apps/cli/tests/foo.test.ts:1')).toBe(false)
    expect(isProseLocation('aeg-root/contracts/planner-developer.md:5')).toBe(false)
  })

  test('a test file whose NAME contains the word "comment" is never prose-capped (round 2 review, BLOCKER)', () => {
    expect(isProseLocation('apps/cli/tests/commands/pr-create-brief-comment.test.ts')).toBe(false)
    expect(isProseLocation('apps/cli/tests/commands/pr-create-brief-comment.test.ts:42')).toBe(false)
  })

  test('the file-shape exemption applies to every prose pattern, not only "comment" (round 2 review, LOW, #547)', () => {
    // Real fixture files this repo already ships, each containing the literal
    // substring `pr-body` in its own name — a source/test-file location, not
    // the PR body itself, so the `\bpr\s*body\b` pattern must never cap it
    // either, the same guarantee the "comment" pattern already had.
    expect(isProseLocation('packages/aeg-core/tests/fixtures/pr-body-394-as-opened.md')).toBe(false)
    expect(isProseLocation('apps/cli/tests/fixtures/pr-body-473.md:1')).toBe(false)
  })
})

describe('evaluateReviewFindings — prose cap (#543 O5)', () => {
  test('a BLOCKER finding located in the PR body is capped to MINOR — never blocks under this repo’s MAJOR threshold', () => {
    const result = evaluateReviewFindings(
      [{ severity: 'BLOCKER', location: 'PR body' }],
      CODE_REVIEW_SEVERITY_ORDER,
      'MAJOR'
    )
    expect(result.outcome).toBe('clean')
  })

  test('the identical BLOCKER at a real source location still blocks — the cap never reaches source/test files', () => {
    const result = evaluateReviewFindings(
      [{ severity: 'BLOCKER', location: 'src/foo.ts:12' }],
      CODE_REVIEW_SEVERITY_ORDER,
      'MAJOR'
    )
    expect(result.outcome).toBe('blocked')
  })

  test('a CRITICAL security finding located in a role file never blocks — MINOR is not on the security scale at all', () => {
    const result = evaluateReviewFindings(
      [{ severity: 'CRITICAL', location: 'aeg-root/roles/security.md:3' }],
      SECURITY_SEVERITY_ORDER,
      'CRITICAL'
    )
    expect(result.outcome).toBe('clean')
  })

  // REGRESSION — policy mismatch surfaced by task-operator-v1 3, NOT resolved here.
  // `aeg-root/roles/operator.md` (shipped by this task) is prose by path, so the
  // `#543` O5 cap treats it exactly like `security.md` above: a CRITICAL finding
  // located in it is capped to MINOR and never blocks. But this role file's own
  // content IS a security boundary — it declares the Operator's authority grant
  // (never merge, approve, rule, or edit an Issue). So a genuine CRITICAL flaw in
  // that authority text — e.g. wording a session could read as permission to
  // merge — would be silently non-blocking under the current cap. This test PINS
  // that current (unsafe-for-authority-prose) behavior rather than papering over
  // it: the fix is a security decision (does the prose cap carve out role files
  // whose text is itself an authority grant?), requested in the PR body, never a
  // threshold this Developer lowers on its own. Change this expectation only when
  // that decision lands, in the same PR that changes `isProseLocation`.
  test('KNOWN GAP: a CRITICAL flaw in the Operator’s own authority text is capped, so it cannot block — awaits a security ruling', () => {
    const result = evaluateReviewFindings(
      [{ severity: 'CRITICAL', location: 'aeg-root/roles/operator.md:38' }],
      SECURITY_SEVERITY_ORDER,
      'CRITICAL'
    )
    // Current behavior: capped to MINOR (off the security scale) → does not block.
    // This is the mismatch, deliberately asserted so it cannot regress unnoticed.
    expect(result.outcome).toBe('clean')
    expect(isProseLocation('aeg-root/roles/operator.md:38')).toBe(true)
  })

  test('a round with clean code/test/security findings stays green regardless of a body finding (O5 sizing story)', () => {
    const codeReview = evaluateCodeReview([{ severity: 'BLOCKER', location: 'PR body' }], THIS_REPO_POLICY)
    expect(codeReview.outcome).toBe('clean')
  })

  test('a finding with no location at all is never capped — treated exactly as before this task', () => {
    const result = evaluateReviewFindings([{ severity: 'BLOCKER' }], CODE_REVIEW_SEVERITY_ORDER, 'MAJOR')
    expect(result.outcome).toBe('blocked')
  })
})

// "Contradictory approval" and "missing output" are properties of the
// CALLERS that wrap this pure evaluator (review-post.ts's contradiction
// check refuses `--verdict APPROVE` disagreeing with a blocked derivation;
// `ReviewerInfrastructureFailure`/`ReviewerReportParseFailure` cover missing
// or unparseable reviewer output as an infrastructure pause, never as zero
// findings) — covered by review-post.test.ts and dev-review-loop.test.ts,
// not here: this evaluator has no I/O and no verdict-text concept to
// contradict.

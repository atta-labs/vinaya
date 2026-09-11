import { describe, expect, test } from 'bun:test'
import {
  blockingSeverities,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewBlockingSeverities,
  DEFAULT_REVIEW_POLICY,
  evaluateCodeReview,
  evaluateReviewFindings,
  evaluateSecurityReview,
  isKnownSeverity,
  type ReviewPolicy,
  SECURITY_SEVERITY_ORDER,
  securityBlockingSeverities
} from './review-policy'

const THIS_REPO_POLICY: ReviewPolicy = { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH' }

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

// "Contradictory approval" and "missing output" are properties of the
// CALLERS that wrap this pure evaluator (review-post.ts's contradiction
// check refuses `--verdict APPROVE` disagreeing with a blocked derivation;
// `ReviewerInfrastructureFailure`/`ReviewerReportParseFailure` cover missing
// or unparseable reviewer output as an infrastructure pause, never as zero
// findings) — covered by review-post.test.ts and dev-review-loop.test.ts,
// not here: this evaluator has no I/O and no verdict-text concept to
// contradict.

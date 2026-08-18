import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import {
  FindingsParseError,
  type Finding,
  isNoneFoundClaim,
  parseFindingsFile,
  renderCodeReviewComment,
  renderFindingsSection,
  renderSecurityComment,
  sortBySeverity,
  verifyPostedCodeReview,
  verifyPostedSecurity
} from '../src/commands/review-post'

const HEAD = 'a'.repeat(40)
const TOKENS = { taskId: 'fix/vinaya-review-post', model: 'claude-sonnet-5', tokensIn: '-', tokensOut: '-', cost: '-' }

describe('parseFindingsFile', () => {
  it('parses valid pipe-delimited lines', () => {
    const parsed = parseFindingsFile('BLOCKER|src/foo.ts:12|off-by-one\nMINOR|src/bar.ts:3|nit', [
      'BLOCKER',
      'MAJOR',
      'MINOR'
    ])
    expect(parsed).toEqual([
      { severity: 'BLOCKER', location: 'src/foo.ts:12', description: 'off-by-one' },
      { severity: 'MINOR', location: 'src/bar.ts:3', description: 'nit' }
    ])
  })

  it('skips blank lines', () => {
    const parsed = parseFindingsFile('\n\nMAJOR|a.ts:1|x\n\n', ['BLOCKER', 'MAJOR', 'MINOR'])
    expect(parsed.length).toBe(1)
  })

  it('throws on a line with the wrong field count', () => {
    expect(() => parseFindingsFile('BLOCKER|a.ts:1', ['BLOCKER'])).toThrow(FindingsParseError)
  })

  it('throws on an out-of-vocabulary severity', () => {
    expect(() => parseFindingsFile('SEVERE|a.ts:1|x', ['BLOCKER', 'MAJOR', 'MINOR'])).toThrow(FindingsParseError)
  })

  it('throws on an empty location or description', () => {
    expect(() => parseFindingsFile('BLOCKER||x', ['BLOCKER'])).toThrow(FindingsParseError)
    expect(() => parseFindingsFile('BLOCKER|a.ts:1|', ['BLOCKER'])).toThrow(FindingsParseError)
  })
})

describe('sortBySeverity', () => {
  it('re-orders regardless of input order, stable within a rank', () => {
    const findings: Finding[] = [
      { severity: 'MINOR', location: 'a', description: '1' },
      { severity: 'BLOCKER', location: 'b', description: '2' },
      { severity: 'BLOCKER', location: 'c', description: '3' },
      { severity: 'MAJOR', location: 'd', description: '4' }
    ]
    const sorted = sortBySeverity(findings, ['BLOCKER', 'MAJOR', 'MINOR'])
    expect(sorted.map((f) => f.location)).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('renderFindingsSection', () => {
  it('renders "None." for zero findings', () => {
    expect(renderFindingsSection([])).toBe('None.')
  })

  it('numbers findings in the given order', () => {
    const findings: Finding[] = [
      { severity: 'BLOCKER', location: 'a.ts:1', description: 'x' },
      { severity: 'MINOR', location: 'b.ts:2', description: 'y' }
    ]
    expect(renderFindingsSection(findings)).toBe('1. [BLOCKER] a.ts:1 — x\n2. [MINOR] b.ts:2 — y')
  })
})

describe('isNoneFoundClaim', () => {
  it('recognizes "none found" in its common spellings', () => {
    expect(isNoneFoundClaim('none found')).toBe(true)
    expect(isNoneFoundClaim('None Found')).toBe(true)
    expect(isNoneFoundClaim('none-found')).toBe(true)
    expect(isNoneFoundClaim('  none   found  ')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isNoneFoundClaim('listed above, redacted')).toBe(false)
    expect(isNoneFoundClaim('none found (unverified)')).toBe(false)
  })
})

describe('renderCodeReviewComment — matches the gate the merge check actually calls', () => {
  it('re-parses clean through extractCodeReviewVerdict, bound to the resolved head', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'does what the brief asked',
      specConformance: 'clean',
      findings: [],
      scope: 'clean',
      tests: 'honest',
      docs: 'tier-appropriate'
    })
    const extraction = extractCodeReviewVerdict([body])
    expect(extraction.value).toBe('APPROVE')
    expect(extraction.headSha).toBe(HEAD)
    expect(verifyPostedCodeReview([body], 'APPROVE', HEAD).ok).toBe(true)
  })

  it('renders REQUEST CHANGES with a space, matching the role doc template literally', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'REQUEST_CHANGES',
      briefConformance: 'n/a',
      specConformance: 'n/a',
      findings: [{ severity: 'BLOCKER', location: 'a.ts:1', description: 'bug' }],
      scope: 'clean',
      tests: 'honest',
      docs: 'tier-appropriate'
    })
    expect(body).toContain('VERDICT: REQUEST CHANGES')
    expect(body).not.toContain('REQUEST_CHANGES')
    const extraction = extractCodeReviewVerdict([body])
    expect(extraction.value).toBe('REQUEST CHANGES')
  })

  it('VERDICT and Judged head are bare lines — no bold, heading, or blockquote wrapper', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'x',
      specConformance: 'x',
      findings: [],
      scope: 'x',
      tests: 'x',
      docs: 'x'
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('VERDICT: APPROVE')
    expect(lines[2]).toBe(`Judged head: ${HEAD}`)
  })
})

describe('renderSecurityComment — matches the gate the merge check actually calls', () => {
  it('re-parses clean through extractSecurityReviewVerdict, bound to the resolved head', () => {
    const body = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: '(scanner ran, 0 findings)'
    })
    const extraction = extractSecurityReviewVerdict([body])
    expect(extraction.value).toBe('PASS')
    expect(extraction.headSha).toBe(HEAD)
    expect(verifyPostedSecurity([body], 'PASS', HEAD).ok).toBe(true)
  })

  it('pastes the secrets evidence above the SECRETS: line', () => {
    const body = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: 'gitleaks: 0 leaks detected'
    })
    const evidenceIdx = body.indexOf('gitleaks: 0 leaks detected')
    const secretsLineIdx = body.indexOf('SECRETS: none found')
    expect(evidenceIdx).toBeGreaterThan(-1)
    expect(evidenceIdx).toBeLessThan(secretsLineIdx)
  })

  it('renders FAIL for a CRITICAL finding', () => {
    const body = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'FAIL',
      findings: [{ severity: 'CRITICAL', location: 'src/auth.ts:9', description: 'hardcoded key' }],
      configScan: 'clean',
      secrets: 'listed above, redacted',
      secretsEvidence: null
    })
    expect(body).toContain('VERDICT: FAIL')
    expect(body).toContain('1. [CRITICAL] src/auth.ts:9 — hardcoded key')
    expect(extractSecurityReviewVerdict([body]).value).toBe('FAIL')
  })
})

describe('self-verification — the mutation-proof: catches malformed renders the merge gate would also miss', () => {
  it('a heading-wrapped VERDICT (the exact incident this task closes) fails self-verification', () => {
    const malformed = `## Security Review — PASS\n\nJudged head: ${HEAD}\n\nEverything looks fine.`
    const result = verifyPostedSecurity([malformed], 'PASS', HEAD)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no clean VERDICT was found')
  })

  it('a bolded VERDICT for the wrong value fails self-verification', () => {
    const malformed = `**VERDICT: FAIL**\n\nJudged head: ${HEAD}`
    const result = verifyPostedSecurity([malformed], 'PASS', HEAD)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('expected "PASS"')
  })

  it('a clean VERDICT with no Judged head line fails self-verification', () => {
    const malformed = 'VERDICT: APPROVE\n\nNo head line here.'
    const result = verifyPostedCodeReview([malformed], 'APPROVE', HEAD)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no `Judged head:` line')
  })

  it('a clean VERDICT bound to a stale head fails self-verification', () => {
    const staleHead = 'b'.repeat(40)
    const malformed = `VERDICT: APPROVE\n\nJudged head: ${staleHead}`
    const result = verifyPostedCodeReview([malformed], 'APPROVE', HEAD)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('does not cover the resolved head')
  })

  it('accepts an abbreviated Judged head that is a real prefix of the resolved head', () => {
    const clean = `VERDICT: APPROVE\n\nJudged head: ${HEAD.slice(0, 7)}`
    const result = verifyPostedCodeReview([clean], 'APPROVE', HEAD)
    expect(result.ok).toBe(true)
  })
})

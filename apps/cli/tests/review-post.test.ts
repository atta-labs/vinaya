import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import {
  FLAG_TABLES,
  FindingsParseError,
  type Finding,
  isNoneFoundClaim,
  unknownFlags,
  parseFindingsFile,
  parseFlags,
  renderCodeReviewComment,
  renderFindingsSection,
  renderSecurityComment,
  sortBySeverity,
  verifyPostedCodeReview,
  verifyPostedSecurity
} from '../src/commands/review-post'

const HEAD = 'a'.repeat(40)
const TOKENS = { taskId: 'fix/vinaya-review-post', model: 'claude-sonnet-5', tokensIn: '-', tokensOut: '-', cost: '-' }
const PRINCIPALS = ['daniboomerang']
const asComment = (body: string, author: string | null = 'daniboomerang') => [{ body, author }]

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

describe("parseFlags — the exact reproduction from PR #144's BLOCKER finding", () => {
  it("a nullary flag left un-filtered no longer eats the next flag's name and value", () => {
    // Before the fix: '--json' was read as '--role''s missing value, and
    // '--verdict'/'APPROVE' vanished from the map with no error at all.
    const flags = parseFlags(['--pr', '5', '--json', '--role', 'code-reviewer', '--verdict', 'APPROVE'])
    expect(flags.get('--pr')).toBe('5')
    expect(flags.get('--role')).toBe('code-reviewer')
    expect(flags.get('--verdict')).toBe('APPROVE')
    expect(flags.get('--json')).toBe('')
  })

  it('a flag with a genuinely missing value maps to empty string rather than swallowing the next flag', () => {
    const flags = parseFlags(['--verdict', '--role', 'security'])
    expect(flags.get('--verdict')).toBe('')
    expect(flags.get('--role')).toBe('security')
  })

  it('an ordinary well-formed invocation is unaffected', () => {
    const flags = parseFlags(['--pr', '5', '--verdict', 'PASS'])
    expect(flags.get('--pr')).toBe('5')
    expect(flags.get('--verdict')).toBe('PASS')
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
    expect(verifyPostedCodeReview(asComment(body), 'APPROVE', HEAD, PRINCIPALS).ok).toBe(true)
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
    expect(verifyPostedSecurity(asComment(body), 'PASS', HEAD, PRINCIPALS).ok).toBe(true)
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
    const result = verifyPostedSecurity(asComment(malformed), 'PASS', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no clean VERDICT was found')
  })

  it('a bolded VERDICT for the wrong value fails self-verification', () => {
    const malformed = `**VERDICT: FAIL**\n\nJudged head: ${HEAD}`
    const result = verifyPostedSecurity(asComment(malformed), 'PASS', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('expected "PASS"')
  })

  it('a clean VERDICT with no Judged head line fails self-verification', () => {
    const malformed = 'VERDICT: APPROVE\n\nNo head line here.'
    const result = verifyPostedCodeReview(asComment(malformed), 'APPROVE', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no `Judged head:` line')
  })

  it('a clean VERDICT bound to a stale head fails self-verification', () => {
    const staleHead = 'b'.repeat(40)
    const malformed = `VERDICT: APPROVE\n\nJudged head: ${staleHead}`
    const result = verifyPostedCodeReview(asComment(malformed), 'APPROVE', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('does not cover the resolved head')
  })

  it('accepts an abbreviated Judged head that is a real prefix of the resolved head', () => {
    const clean = `VERDICT: APPROVE\n\nJudged head: ${HEAD.slice(0, 7)}`
    const result = verifyPostedCodeReview(asComment(clean), 'APPROVE', HEAD, PRINCIPALS)
    expect(result.ok).toBe(true)
  })

  it("a clean VERDICT from a non-allowlisted author does not count — matches checkReviewGate's own author filter (PR #144 review finding)", () => {
    const clean = `VERDICT: APPROVE\n\nJudged head: ${HEAD}`
    const result = verifyPostedCodeReview(asComment(clean, 'some-random-account'), 'APPROVE', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no clean VERDICT was found')
  })

  it('an unauthored (null) comment does not count either', () => {
    const clean = `VERDICT: PASS\n\nJudged head: ${HEAD}`
    const result = verifyPostedSecurity(asComment(clean, null), 'PASS', HEAD, PRINCIPALS)
    expect(result.ok).toBe(false)
  })

  it('a real allowlisted verdict still counts alongside a non-allowlisted decoy comment', () => {
    const real = `VERDICT: APPROVE\n\nJudged head: ${HEAD}`
    const decoy = `VERDICT: REQUEST CHANGES\n\nJudged head: ${HEAD}`
    const result = verifyPostedCodeReview(
      [
        { body: decoy, author: 'some-random-account' },
        { body: real, author: 'daniboomerang' }
      ],
      'APPROVE',
      HEAD,
      PRINCIPALS
    )
    expect(result.ok).toBe(true)
  })
})

describe('(#184) review post refuses an unknown flag instead of posting anyway', () => {
  const known = ['--role', '--pr', '--json']

  it('accepts every declared flag', () => {
    expect(unknownFlags(['--role', 'security', '--pr', '178'], known)).toEqual([])
    expect(unknownFlags(['--json'], known)).toEqual([])
  })

  // The live incident: `--print-only` is real on `vinaya waiver`, so it is a
  // reasonable thing to type here. Ignoring it meant the caller asked for a
  // dry run and got a governance verdict on a real PR.
  it('names --print-only', () => {
    expect(unknownFlags(['--role', 'security', '--print-only'], known)).toEqual(['--print-only'])
  })

  it('catches an unknown flag in VALUE position, where it would eat a real value', () => {
    // `--pr --bogus 178` makes `--pr` empty and hands `178` to `--bogus`.
    expect(unknownFlags(['--pr', '--bogus', '178'], known)).toEqual(['--bogus'])
  })

  it('catches the = spelling too, reporting the name without the value', () => {
    // The value is not echoed: a refusal goes to stderr and into CI logs, and
    // an argv value can be a token.
    expect(unknownFlags(['--bogus=1'], known)).toEqual(['--bogus'])
  })

  it('names every unknown flag, not just the first', () => {
    expect(unknownFlags(['--aaa', '--bbb'], known)).toEqual(['--aaa', '--bbb'])
  })

  it('does not mistake a value for a flag', () => {
    expect(unknownFlags(['--role', 'security'], known)).toEqual([])
  })
})

describe('the flag tables cover what the command actually reads', () => {
  /**
   * Derived, not hand-listed. The first version of `VALUE_FLAGS` omitted
   * `--tokens-in`/`--tokens-out`, so the command refused the invocation
   * `roles/reviewer.md` documents and `requireTokenField` requires — an
   * unresolvable refusal loop. A hand-kept copy of a set the source already
   * states is exactly the drift this whole change exists to stop, so this test
   * re-reads the source and compares.
   */
  const SOURCE = readFileSync(fileURLToPath(new URL('../src/commands/review-post.ts', import.meta.url)), 'utf8')

  function flagsReadBySource(): string[] {
    const reads = [
      ...SOURCE.matchAll(/require(?:Flag|TokenField)\(flags,\s*'(--[a-z-]+)'\)/g),
      ...SOURCE.matchAll(/flags\.get\('(--[a-z-]+)'\)/g)
    ]
    return [...new Set(reads.map((m) => m[1] as string))].sort()
  }

  it('finds the reads at all — a guard on the extraction itself', () => {
    const read = flagsReadBySource()
    expect(read.length).toBeGreaterThan(10)
    expect(read).toContain('--tokens-in')
  })

  it('declares every flag the command reads as a value flag', () => {
    const declared = new Set<string>(FLAG_TABLES.value)
    const missing = flagsReadBySource().filter((f) => !declared.has(f))
    expect(missing, `read from \`flags\` but absent from VALUE_FLAGS: ${missing.join(', ')}`).toEqual([])
  })

  it('accepts the full invocation roles/reviewer.md prescribes', () => {
    const documented = [
      '--role',
      'code-reviewer',
      '--pr',
      '188',
      '--verdict',
      'APPROVE',
      '--brief-conformance',
      'x',
      '--spec-conformance',
      'x',
      '--scope',
      'x',
      '--tests',
      'x',
      '--docs',
      'x',
      '--task-id',
      '188',
      '--model',
      'claude-opus-5',
      '--tokens-in',
      '-',
      '--tokens-out',
      '-',
      '--cost',
      '-'
    ]
    expect(unknownFlags(documented)).toEqual([])
  })

  it('catches a single-dash near-miss', () => {
    expect(unknownFlags(['-print-only'])).toEqual(['-print-only'])
  })

  it('does not mistake a bare `-` or a negative number for a flag', () => {
    expect(unknownFlags(['--tokens-in', '-', '--pr', '-1'])).toEqual([])
  })

  it('refuses `--json=true`, which would otherwise parse as known and do nothing', () => {
    expect(unknownFlags(['--json=true'])).toEqual(['--json'])
    expect(unknownFlags(['--json'])).toEqual([])
  })

  it('reports the flag name only, never the value — refusals reach CI logs', () => {
    expect(unknownFlags(['--api-key=ghp_ABCDEFGHIJKLMNOP'])).toEqual(['--api-key'])
  })
})

describe('the `=` spelling reaches the flag map, not just the refusal check', () => {
  // `--findings-file=x` was accepted by `rejectUnknownFlags` and then dropped
  // by `parseFlags`, which keyed on the whole token. The comment rendered
  // "FINDINGS … None." and the BLOCKER-versus-APPROVE cross-check became a
  // no-op — a silent default in the command that posts verdicts.
  it('parses `--flag=value` into the same key as `--flag value`', () => {
    expect(parseFlags(['--findings-file=/tmp/f.txt']).get('--findings-file')).toBe('/tmp/f.txt')
    expect(parseFlags(['--findings-file', '/tmp/f.txt']).get('--findings-file')).toBe('/tmp/f.txt')
  })

  it('keeps a value that itself contains `=`', () => {
    expect(parseFlags(['--scope=a=b']).get('--scope')).toBe('a=b')
  })

  it('accepts an empty value after `=` without swallowing the next token', () => {
    const m = parseFlags(['--scope=', '--tests', 'ok'])
    expect(m.get('--scope')).toBe('')
    expect(m.get('--tests')).toBe('ok')
  })
})

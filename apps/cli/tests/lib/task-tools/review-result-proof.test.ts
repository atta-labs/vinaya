import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyReviewOutcome,
  type NoReviewReason,
  parseReviewResult,
  REVIEW_RESULT_SCHEMA_VERSION,
  REVIEWER_ROLES,
  type ReviewBinding,
  type ReviewerRole,
  type ReviewRunFacts,
  RoundReviews,
  reviewResultJsonSchema,
  validateReviewResult
} from '../../../src/lib/review-result.js'
import {
  adversarialCases,
  bindingFor,
  concurrentPrompt,
  isCapacityFailure,
  judgeReviewCase,
  PROOF_OBJECTIVE_IDS,
  parseReviewProofArgs,
  stageReviewInputs
} from '../../../src/lib/task-tools/review-result-proof.js'
import type { TurnRead } from '../../../src/lib/task-tools/result-proof.js'

/**
 * The reviewer-result proof's pure parts: the versioned, discriminated
 * ReviewResult schema (both variants, both roles), its semantic validator, the
 * outcome classifier (anything but a bound, valid review is NO review), the
 * round's one-review-per-role rule, the per-case judge and the staged inputs.
 * The live dispatches are the command itself
 * (`vinaya task-tools review-result-proof --agent <claude|codex>`).
 */

const HEAD = 'a'.repeat(40)
const DIGEST = 'b'.repeat(64)
const v = REVIEW_RESULT_SCHEMA_VERSION
const SEVERITY: Record<ReviewerRole, string> = { 'code-reviewer': 'MAJOR', 'security-reviewer': 'HIGH' }
const FOREIGN: Record<ReviewerRole, string> = { 'code-reviewer': 'HIGH', 'security-reviewer': 'MAJOR' }

const binding = (role: ReviewerRole): ReviewBinding => ({
  role,
  headSha: HEAD,
  manifestDigest: DIGEST,
  objectiveIds: ['O1', 'O2']
})

const completed = (role: ReviewerRole, over: Record<string, unknown> = {}) => ({
  schemaVersion: v,
  status: 'completed',
  role,
  headSha: HEAD,
  manifestDigest: DIGEST,
  summary: 'reviewed',
  findings: [{ severity: SEVERITY[role], file: 'src/a.ts', line: 3, description: 'a problem' }],
  objectiveResults: [
    { id: 'O1', status: 'MET', evidence: 'seen in the diff' },
    { id: 'O2', status: 'NOT MET', evidence: 'missing' }
  ],
  ...over
})
const blocked = (role: ReviewerRole, over: Record<string, unknown> = {}) => ({
  schemaVersion: v,
  status: 'blocked',
  role,
  headSha: HEAD,
  manifestDigest: DIGEST,
  summary: 'cannot review',
  blocker: { kind: 'diff_unavailable', detail: 'the diff file is empty' },
  ...over
})
const wrap = (reviewResult: unknown) => ({ reviewResult })

const facts = (over: Partial<ReviewRunFacts> = {}): ReviewRunFacts => ({
  cancelled: false,
  terminal: 'success',
  errors: [],
  hasResult: true,
  raw: wrap(completed('code-reviewer')),
  ...over
})

describe('ReviewResult schema (O7)', () => {
  for (const role of REVIEWER_ROLES) {
    it(`accepts a valid completed result for ${role}`, () => {
      expect(validateReviewResult(wrap(completed(role)), binding(role)).ok).toBe(true)
    })
    it(`accepts a valid blocked result for ${role}`, () => {
      expect(validateReviewResult(wrap(blocked(role)), binding(role)).ok).toBe(true)
    })
    it(`accepts a completed result with no findings and no objective results for ${role}`, () => {
      expect(
        validateReviewResult(wrap(completed(role, { findings: [], objectiveResults: [] })), binding(role)).ok
      ).toBe(true)
    })
  }

  const invalid: [string, unknown][] = [
    ['an unwrapped result', completed('code-reviewer')],
    ['a wrong schemaVersion', wrap(completed('code-reviewer', { schemaVersion: 2 }))],
    ['an unknown status', wrap(completed('code-reviewer', { status: 'needs_ruling' }))],
    ['a missing summary', wrap(completed('code-reviewer', { summary: undefined }))],
    ['an empty summary', wrap(completed('code-reviewer', { summary: '' }))],
    ['an unknown role', wrap(completed('code-reviewer', { role: 'developer' }))],
    ['a missing headSha', wrap(completed('code-reviewer', { headSha: undefined }))],
    ['a missing manifestDigest', wrap(completed('code-reviewer', { manifestDigest: undefined }))],
    ['an extra field', wrap(completed('code-reviewer', { notes: 'x' }))],
    ['findings that is not a list', wrap(completed('code-reviewer', { findings: 'none' }))],
    [
      'a finding with no file',
      wrap(completed('code-reviewer', { findings: [{ severity: 'MAJOR', line: 1, description: null }] }))
    ],
    [
      'a finding with an empty file',
      wrap(completed('code-reviewer', { findings: [{ severity: 'MAJOR', file: '', line: 1, description: null }] }))
    ],
    [
      'a finding with a non-integer line',
      wrap(
        completed('code-reviewer', { findings: [{ severity: 'MAJOR', file: 'a.ts', line: 1.5, description: null }] })
      )
    ],
    [
      'a severity on no scale',
      wrap(completed('code-reviewer', { findings: [{ severity: 'SEVERE', file: 'a.ts', line: 1, description: null }] }))
    ],
    [
      'an objective status outside MET / NOT MET',
      wrap(completed('code-reviewer', { objectiveResults: [{ id: 'O1', status: 'PARTIAL', evidence: 'x' }] }))
    ],
    ['a blocked result with no blocker', wrap(blocked('code-reviewer', { blocker: undefined }))],
    [
      'a blocked result with an unknown blocker kind',
      wrap(blocked('code-reviewer', { blocker: { kind: 'tired', detail: 'x' } }))
    ],
    ['a blocked result carrying findings', wrap(blocked('code-reviewer', { findings: [] }))]
  ]
  for (const [name, value] of invalid) {
    it(`rejects ${name} at the schema`, () => {
      const r = parseReviewResult(value)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.stage).toBe('schema')
    })
  }

  it('accepts a finding with no line and no description (both nullable on the wire)', () => {
    const r = completed('code-reviewer', {
      findings: [{ severity: 'MINOR', file: 'a.ts', line: null, description: null }]
    })
    expect(validateReviewResult(wrap(r), binding('code-reviewer')).ok).toBe(true)
  })

  it('hands each provider a plain-object root that is bound to the role and its severity scale', () => {
    for (const role of REVIEWER_ROLES) {
      const schema = reviewResultJsonSchema(role)
      expect(schema.type).toBe('object')
      expect(schema.$schema).toBeUndefined()
      const text = JSON.stringify(schema)
      expect(text).toContain(`"const":"${role}"`)
      const other = REVIEWER_ROLES.find((r) => r !== role)
      expect(text).not.toContain(`"const":"${other}"`)
    }
    expect(JSON.stringify(reviewResultJsonSchema('code-reviewer'))).toContain('"MINOR"')
    expect(JSON.stringify(reviewResultJsonSchema('code-reviewer'))).not.toContain('"CRITICAL"')
    expect(JSON.stringify(reviewResultJsonSchema('security-reviewer'))).toContain('"CRITICAL"')
    expect(JSON.stringify(reviewResultJsonSchema('security-reviewer'))).not.toContain('"MINOR"')
    expect(JSON.stringify(reviewResultJsonSchema())).toContain('"code-reviewer"')
    expect(JSON.stringify(reviewResultJsonSchema())).toContain('"security-reviewer"')
  })

  it('keeps every property required in the provider schema (strict structured outputs refuse optional ones)', () => {
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.properties && typeof n.properties === 'object') {
        const keys = Object.keys(n.properties as object)
        expect((n.required as string[]).slice().sort()).toEqual(keys.slice().sort())
      }
      for (const value of Object.values(n)) walk(value)
    }
    walk(reviewResultJsonSchema('security-reviewer'))
  })
})

describe('semantic validation (O3, O5)', () => {
  const reject = (value: unknown, role: ReviewerRole, includes: string): void => {
    const r = validateReviewResult(wrap(value), binding(role))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.stage).toBe('semantic')
      expect(r.errors.join('; ')).toContain(includes)
    }
  }
  it("rejects a role that is not the controller's binding, whatever the agent claims", () => {
    reject(completed('security-reviewer'), 'code-reviewer', 'role:')
    reject(blocked('code-reviewer'), 'security-reviewer', 'role:')
  })
  it('rejects a result bound to a wrong head', () => {
    reject(completed('code-reviewer', { headSha: 'c'.repeat(40) }), 'code-reviewer', 'headSha')
  })
  it('rejects a result bound to a wrong manifest digest', () => {
    reject(completed('code-reviewer', { manifestDigest: 'c'.repeat(64) }), 'code-reviewer', 'manifestDigest')
  })
  it('rejects an objective id outside the brief', () => {
    reject(
      completed('code-reviewer', { objectiveResults: [{ id: 'O9', status: 'MET', evidence: 'x' }] }),
      'code-reviewer',
      'unknown objective id "O9"'
    )
  })
  for (const role of REVIEWER_ROLES) {
    it(`rejects a severity outside the ${role} scale`, () => {
      reject(
        completed(role, { findings: [{ severity: FOREIGN[role], file: 'a.ts', line: 1, description: null }] }),
        role,
        'is not on the'
      )
    })
  }
  it('rejects a finding whose file is only whitespace', () => {
    reject(
      completed('code-reviewer', { findings: [{ severity: 'MINOR', file: '  ', line: 1, description: null }] }),
      'code-reviewer',
      'must name a file'
    )
  })
})

describe('outcomes: only a bound, valid review is a review (O4)', () => {
  const cr = binding('code-reviewer')
  const reasonOf = (f: ReviewRunFacts, b: ReviewBinding = cr): string => {
    const o = classifyReviewOutcome(f, b)
    return o.kind === 'review' ? 'review' : o.reason
  }
  it('accepts a valid completed result as a review', () => {
    expect(reasonOf(facts())).toBe('review')
  })
  const cases: [string, ReviewRunFacts, NoReviewReason][] = [
    ['missing', facts({ hasResult: false, raw: null }), 'missing'],
    ['malformed', facts({ raw: wrap({ status: 'completed', confidence: 'high' }) }), 'malformed'],
    ['malformed prose', facts({ raw: 'approved' }), 'malformed'],
    ['stale head', facts({ raw: wrap(completed('code-reviewer', { headSha: 'd'.repeat(40) })) }), 'stale'],
    ['stale digest', facts({ raw: wrap(completed('code-reviewer', { manifestDigest: 'd'.repeat(64) })) }), 'stale'],
    ['blocked', facts({ raw: wrap(blocked('code-reviewer')) }), 'blocked'],
    ['cancelled', facts({ cancelled: true, hasResult: false, raw: null, terminal: null }), 'cancelled'],
    ['cancelled even with a result', facts({ cancelled: true }), 'cancelled'],
    [
      'context exhausted',
      facts({
        hasResult: false,
        raw: null,
        terminal: 'error_during_execution (is_error)',
        errors: ['Prompt is too long']
      }),
      'context_exhausted'
    ],
    [
      'provider error',
      facts({ hasResult: false, raw: null, terminal: 'turn.failed', errors: ['model not found'] }),
      'provider_error'
    ],
    ['role mismatch', facts({ raw: wrap(completed('security-reviewer')) }), 'role_mismatch'],
    [
      'rejected objective',
      facts({
        raw: wrap(completed('code-reviewer', { objectiveResults: [{ id: 'O9', status: 'MET', evidence: 'x' }] }))
      }),
      'rejected'
    ]
  ]
  for (const [name, f, reason] of cases) {
    it(`records ${name} as no review (${reason}), never approval`, () => {
      const o = classifyReviewOutcome(f, cr)
      expect(o.kind).toBe('no_review')
      expect(reasonOf(f)).toBe(reason)
    })
  }
})

describe('one accepted review per reviewer per round (O6)', () => {
  it('records one review per role and refuses a second for the same role', () => {
    const round = new RoundReviews()
    const review = (role: ReviewerRole) => classifyReviewOutcome(facts({ raw: wrap(completed(role)) }), binding(role))
    const cr = review('code-reviewer')
    expect(round.offer('code-reviewer', cr).kind).toBe('review')
    expect(round.offer('security-reviewer', review('security-reviewer')).kind).toBe('review')
    const again = round.offer('code-reviewer', cr)
    expect(again.kind).toBe('no_review')
    if (again.kind === 'no_review') expect(again.reason).toBe('duplicate')
    expect(round.size).toBe(2)
  })
  it('passes a no-review outcome through without recording it', () => {
    const round = new RoundReviews()
    const none = classifyReviewOutcome(facts({ hasResult: false, raw: null }), binding('security-reviewer'))
    expect(round.offer('security-reviewer', none)).toBe(none)
    expect(round.size).toBe(0)
  })
})

describe('the proof command', () => {
  it('parses --agent and refuses anything else', () => {
    expect(parseReviewProofArgs(['--agent', 'claude'])).toEqual({ agent: 'claude' })
    expect(parseReviewProofArgs(['--agent', 'codex'])).toEqual({ agent: 'codex' })
    expect('error' in parseReviewProofArgs([])).toBe(true)
    expect('error' in parseReviewProofArgs(['--agent'])).toBe(true)
    expect('error' in parseReviewProofArgs(['--agent', 'gemini'])).toBe(true)
  })

  it('stages a real diff, a manifest carrying its digest and the objectives, in a throwaway repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-proof-test-'))
    try {
      const staged = stageReviewInputs(root)
      expect(staged.headSha).toMatch(/^[0-9a-f]{40}$/)
      expect(staged.baseSha).not.toBe(staged.headSha)
      const manifest = JSON.parse(readFileSync(join(staged.dir, 'review-input', 'manifest.json'), 'utf8'))
      expect(manifest.headSha).toBe(staged.headSha)
      expect(manifest.manifestDigest).toBe(staged.manifestDigest)
      expect(readFileSync(join(staged.dir, 'review-input', 'diff.patch'), 'utf8')).toContain('src/greeting.ts')
      expect(readFileSync(join(staged.dir, 'review-input', 'objectives.txt'), 'utf8')).toContain('O2')
      expect(existsSync(join(staged.dir, '.git'))).toBe(true)
      expect(bindingFor('security-reviewer', staged)).toEqual({
        role: 'security-reviewer',
        headSha: staged.headSha,
        manifestDigest: staged.manifestDigest,
        objectiveIds: PROOF_OBJECTIVE_IDS
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks the two concurrent reviewers for results only each of them can have been told', () => {
    const a = concurrentPrompt('code-reviewer', 'n1')
    const b = concurrentPrompt('security-reviewer', 'n1')
    expect(a).toContain('code-reviewer-n1')
    expect(a).not.toContain('security-reviewer-n1')
    expect(b).toContain('security-reviewer-n1')
    expect(b).not.toContain('code-reviewer-n1')
  })

  it('covers every rejection and no-review case the proof owes, each with a distinct fresh dispatch', () => {
    const cases = adversarialCases('n1')
    const names = cases.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const wanted of [
      'role mismatch',
      'wrong head',
      'wrong manifest digest',
      'objective id outside the brief',
      'severity outside the code-reviewer scale',
      'severity outside the security-reviewer scale',
      'finding without a file',
      'finding without a line',
      'blocked result',
      'malformed model output',
      'no structured result',
      'cancelled run',
      'provider error',
      'context exhaustion'
    ]) {
      expect(names.some((n) => n.startsWith(wanted))).toBe(true)
    }
    expect(cases.find((c) => c.name === 'cancelled run')?.cancelAfterMs).toBeGreaterThan(0)
    expect(cases.find((c) => c.name === 'provider error')?.model).toBeTruthy()
    const byName = (n: string) => cases.find((c) => c.name === n)
    // A schema-enforced refusal of the empty file is a correct no review, whichever way it surfaces.
    const noFile = byName('finding without a file')?.expectation
    expect(noFile).toEqual({ kind: 'no_review', reasons: ['blocked', 'malformed', 'rejected'] })
    // Malformed and missing can only end as no review: never an accepted one, and neither may be repaired by the CLI.
    expect(byName('malformed model output')?.schemaMode).toBe('malformable')
    expect(byName('malformed model output')?.expectation).toEqual({ kind: 'no_review', reasons: ['malformed'] })
    expect(byName('no structured result')?.schemaMode).toBe('unenforced')
    expect(byName('no structured result')?.expectation.kind).toBe('no_review')
    // Reviewers read through the shell on Codex, so no prompt forbids it.
    for (const c of cases) expect(c.prompt).not.toContain('shell')
    // The only cases that may end in an accepted review are the no-line one.
    expect(cases.filter((c) => c.expectation.kind === 'review').map((c) => c.name)).toEqual(['finding without a line'])
  })
})

describe('provider capacity', () => {
  const readWith = (errors: string[]): TurnRead => ({
    sessionId: null,
    emissions: [],
    terminalResults: 0,
    terminal: 'turn.failed',
    event: null,
    raw: null,
    errors
  })
  it('recognises a capacity failure only on a run with no review', () => {
    const outcome = classifyReviewOutcome(
      {
        cancelled: false,
        terminal: 'turn.failed',
        errors: ['Selected model is at capacity.'],
        hasResult: false,
        raw: null
      },
      binding('code-reviewer')
    )
    const run = { read: readWith(['Selected model is at capacity.']), outcome, stderrTail: '' }
    expect(isCapacityFailure(run)).toBe(true)
    expect(isCapacityFailure({ ...run, outcome: classifyReviewOutcome(facts(), binding('code-reviewer')) })).toBe(false)
    const boom = classifyReviewOutcome(
      { cancelled: false, terminal: 'turn.failed', errors: ['boom'], hasResult: false, raw: null },
      binding('code-reviewer')
    )
    expect(isCapacityFailure({ ...run, read: readWith(['boom']), outcome: boom })).toBe(false)
  })
})

describe('judgeReviewCase', () => {
  const read = (terminalResults: number): TurnRead => ({
    sessionId: 's',
    emissions: [],
    terminalResults,
    terminal: 'success',
    event: 'x',
    raw: null,
    errors: []
  })
  const review = classifyReviewOutcome(facts(), binding('code-reviewer'))
  const none = classifyReviewOutcome(facts({ raw: wrap(blocked('code-reviewer')) }), binding('code-reviewer'))

  it('passes an accepted review with the expected summary and exactly one terminal result', () => {
    expect(judgeReviewCase({ kind: 'review', summary: 'reviewed' }, review, read(1)).pass).toBe(true)
  })
  it('fails a review with another summary, with two terminal results, or none at all', () => {
    expect(judgeReviewCase({ kind: 'review', summary: 'other' }, review, read(1)).pass).toBe(false)
    expect(judgeReviewCase({ kind: 'review', summary: 'reviewed' }, review, read(2)).pass).toBe(false)
    expect(judgeReviewCase({ kind: 'review', summary: 'reviewed' }, none, read(1)).pass).toBe(false)
  })
  it('fails a case that must be no review when a review was accepted', () => {
    expect(judgeReviewCase({ kind: 'no_review', reasons: ['blocked'] }, review, read(1)).pass).toBe(false)
  })
  it('passes a no-review outcome for an expected reason and fails it for another', () => {
    expect(judgeReviewCase({ kind: 'no_review', reasons: ['blocked'] }, none, read(1)).pass).toBe(true)
    expect(judgeReviewCase({ kind: 'no_review', reasons: ['stale'] }, none, read(1)).pass).toBe(false)
  })
})

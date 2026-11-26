import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { type PlanDraft, draftFingerprint } from '../plan-draft/draft'
import {
  PLAN_REVIEW_EVIDENCE_COMMANDS,
  PLAN_REVIEW_EVIDENCE_DENIED,
  PLAN_REVIEW_QUESTION_VERSION,
  type PlanReview,
  type PlanReviewAnswer,
  type PlanReviewBinding,
  type PlanReviewEvidence,
  type PlanReviewFinding,
  derivePlanVerdict,
  isAllowedEvidenceCommand,
  planReviewJsonSchema,
  validatePlanReview
} from './result'

const REVISION = 'a'.repeat(40)

const draft: PlanDraft = {
  schemaVersion: 1,
  tranche: 'demo-v1',
  revision: REVISION,
  reviewQuestionVersion: PLAN_REVIEW_QUESTION_VERSION,
  tasks: [
    { number: 1, issue: null, title: 'First', body: 'Boundary one', labels: [] },
    { number: 2, issue: null, title: 'Second', body: 'Boundary two', labels: [] }
  ],
  scope: [
    { item: 'A reader sees the plan whole', disposition: { kind: 'delivered', task: 1 } },
    { item: 'Nothing is published', disposition: { kind: 'left-out', reason: 'a later plan publishes it' } }
  ]
}

const FILES: Record<string, number> = { 'src/a.ts': 40 }
const binding: PlanReviewBinding = { draft, lineCount: (path) => FILES[path] ?? null }

const code = (path = 'src/a.ts', line = 3): PlanReviewEvidence => ({
  kind: 'code',
  path,
  line,
  command: null,
  output: null,
  passage: null
})
const command = (text = 'git show HEAD:src/a.ts'): PlanReviewEvidence => ({
  kind: 'command',
  path: null,
  line: null,
  command: text,
  output: 'export const a = 1',
  passage: null
})
const scope = (passage = 'A reader sees the plan whole'): PlanReviewEvidence => ({
  kind: 'scope',
  path: null,
  line: null,
  command: null,
  output: null,
  passage
})

function answers(): PlanReviewAnswer[] {
  const out: PlanReviewAnswer[] = []
  for (const task of [1, 2]) {
    for (const question of [1, 2, 3, 4, 5] as const) {
      out.push({ question, task, answer: 'holds', evidence: [code(), command()] })
    }
  }
  out.push({ question: 6, task: null, answer: 'covered', evidence: [scope()] })
  return out
}

function review(overrides: Partial<PlanReview> = {}): PlanReview {
  return {
    schemaVersion: 1,
    draftFingerprint: draftFingerprint(draft),
    questionVersion: PLAN_REVIEW_QUESTION_VERSION,
    revision: REVISION,
    summary: 'Plan reviewed.',
    answers: answers(),
    findings: [],
    ...overrides
  }
}

const wrap = (planReview: unknown) => ({ planReview })
const refusal = (value: unknown) => {
  const result = validatePlanReview(value, binding)
  if (result.ok) throw new Error('expected a refusal')
  return result
}

describe('a valid answer', () => {
  test('is accepted and, with no finding, approves the plan', () => {
    const result = validatePlanReview(wrap(review()), binding)
    expect(result.ok).toBe(true)
    expect(derivePlanVerdict(result)).toEqual({ verdict: 'approved', blocking: [] })
  })
})

describe('an answer that is not a review', () => {
  test('a wrong fingerprint is stale', () => {
    const result = refusal(wrap(review({ draftFingerprint: 'sha256:0000' })))
    expect(result.reason).toBe('stale')
    expect(result.errors[0]).toContain('draftFingerprint')
  })

  test('a wrong question version or revision is stale', () => {
    expect(refusal(wrap(review({ questionVersion: '2' }))).reason).toBe('stale')
    expect(refusal(wrap(review({ revision: 'b'.repeat(40) }))).reason).toBe('stale')
  })

  test('a missing task answer is incomplete', () => {
    const result = refusal(wrap(review({ answers: answers().filter((a) => !(a.task === 2 && a.question === 4)) })))
    expect(result.reason).toBe('incomplete')
    expect(result.errors).toEqual(['answers: task 2 has no answer to question 4'])
  })

  test('a missing plan answer, a duplicate answer and an unknown task are incomplete', () => {
    expect(refusal(wrap(review({ answers: answers().filter((a) => a.question !== 6) }))).reason).toBe('incomplete')
    expect(refusal(wrap(review({ answers: [...answers(), ...answers().slice(0, 1)] }))).reason).toBe('incomplete')
    const other = answers().map((a) => (a.task === 2 ? { ...a, task: 9 } : a))
    expect(refusal(wrap(review({ answers: other }))).reason).toBe('incomplete')
  })

  test('an answer without evidence is incomplete', () => {
    const bare = answers().map((a, i) => (i === 0 ? { ...a, evidence: [] } : a))
    expect(refusal(wrap(review({ answers: bare }))).reason).toBe('incomplete')
  })

  test('a location that does not exist is unverified', () => {
    const missing = answers().map((a, i) => (i === 0 ? { ...a, evidence: [code('src/none.ts')] } : a))
    const result = refusal(wrap(review({ answers: missing })))
    expect(result.reason).toBe('unverified')
    expect(result.errors[0]).toContain('src/none.ts does not exist')
  })

  test('a line past the end of the file is unverified', () => {
    const past = answers().map((a, i) => (i === 0 ? { ...a, evidence: [code('src/a.ts', 41)] } : a))
    expect(refusal(wrap(review({ answers: past }))).reason).toBe('unverified')
  })

  test('a command off the list is unverified', () => {
    for (const text of ['rm -rf src', 'bun test', 'curl https://example.com', 'git push origin HEAD', 'git showx']) {
      const off = answers().map((a, i) => (i === 0 ? { ...a, evidence: [command(text)] } : a))
      expect(refusal(wrap(review({ answers: off }))).reason).toBe('unverified')
    }
  })

  test('a listed command that uses a form the grants deny is refused, as the seat could not run it', () => {
    for (const text of [
      'git show HEAD --output=/tmp/x',
      'git log --ext-diff',
      'rg --pre sh x',
      'rg --pre=sh x',
      'rg -z x',
      'rg -nz x',
      'rg --search-zip x',
      'rg --hostname-bin sh x',
      'git grep -O sh x',
      'git grep -Osh x',
      'git -c core.pager=sh log'
    ]) {
      expect(isAllowedEvidenceCommand(text), text).toBe(false)
    }
  })

  test('a pipe or redirection inside quotes is an argument, not chaining', () => {
    for (const text of ['rg "a|b" src', "git log --format='%h;%s' -3", 'git grep -n "a>b" HEAD']) {
      expect(isAllowedEvidenceCommand(text), text).toBe(true)
    }
    for (const text of ['rg "a" src | sh', 'rg "$(rm x)" src', 'rg "a" `x`']) {
      expect(isAllowedEvidenceCommand(text), text).toBe(false)
    }
  })

  test('a location outside the captured revision tree is unverified', () => {
    for (const path of ['/etc/passwd', '../outside.ts', 'src/../../x.ts']) {
      const bad = answers().map((a, i) => (i === 0 ? { ...a, evidence: [code(path)] } : a))
      const result = refusal(wrap(review({ answers: bad })))
      expect(result.reason).toBe('unverified')
      expect(result.errors[0]).toContain('not a path inside the captured revision')
    }
  })

  test('a listed command that chains another is unverified', () => {
    for (const text of ['git log; rm x', 'rg a | sh', 'ls > out', 'git show $(rm x)', 'ls && rm x']) {
      expect(isAllowedEvidenceCommand(text)).toBe(false)
    }
  })

  test('a foreign scope passage is unverified', () => {
    const foreign = answers().map((a) => (a.question === 6 ? { ...a, evidence: [scope('something never agreed')] } : a))
    const result = refusal(wrap(review({ answers: foreign })))
    expect(result.reason).toBe('unverified')
    expect(result.errors[0]).toContain('not a passage of the draft')
  })

  test('a passage of a left-out reason is a passage of the agreed scope', () => {
    const ok = answers().map((a) => (a.question === 6 ? { ...a, evidence: [scope('a later plan')] } : a))
    expect(validatePlanReview(wrap(review({ answers: ok })), binding).ok).toBe(true)
  })

  test('evidence missing the fields of its kind is unverified', () => {
    const bad = answers().map((a, i) => (i === 0 ? { ...a, evidence: [{ ...code(), line: null }] } : a))
    expect(refusal(wrap(review({ answers: bad }))).reason).toBe('unverified')
  })

  test('a finding outside the six questions is malformed', () => {
    const finding = { question: 7, task: 1, kind: 'blocking', evidence: [code()], resolution: 'fix it' }
    expect(refusal(wrap(review({ findings: [finding as never] }))).reason).toBe('malformed')
  })

  test('a finding on a task the draft lacks, or on question 6 naming a task, is rejected', () => {
    const base = { kind: 'note' as const, evidence: [code()], resolution: 'fix it' }
    expect(refusal(wrap(review({ findings: [{ ...base, question: 1, task: 9 }] }))).reason).toBe('rejected')
    expect(refusal(wrap(review({ findings: [{ ...base, question: 6, task: 1 }] }))).reason).toBe('rejected')
    expect(refusal(wrap(review({ findings: [{ ...base, question: 1, task: null }] }))).reason).toBe('rejected')
  })

  test('a finding with no evidence is rejected', () => {
    const finding: PlanReviewFinding = { question: 2, task: 1, kind: 'note', evidence: [], resolution: 'fix it' }
    expect(refusal(wrap(review({ findings: [finding] }))).reason).toBe('rejected')
  })

  test('a verdict field, a bare root and a field outside the schema are malformed', () => {
    expect(refusal(wrap({ ...review(), verdict: 'approved' })).reason).toBe('malformed')
    expect(refusal(review()).reason).toBe('malformed')
    expect(refusal(null).reason).toBe('malformed')
  })

  test('is never approval', () => {
    expect(derivePlanVerdict(validatePlanReview(wrap({ ...review(), verdict: 'approved' }), binding)).verdict).toBe(
      'not_approved'
    )
  })
})

describe('the verdict', () => {
  const finding = (kind: 'blocking' | 'note'): PlanReviewFinding => ({
    question: 3,
    task: 1,
    kind,
    evidence: [code()],
    resolution: 'cite a producer task'
  })

  test('a blocking finding means not approved, and names it', () => {
    const verdict = derivePlanVerdict(validatePlanReview(wrap(review({ findings: [finding('blocking')] })), binding))
    expect(verdict.verdict).toBe('not_approved')
    expect(verdict.blocking).toHaveLength(1)
  })

  test('notes alone still approve', () => {
    const verdict = derivePlanVerdict(validatePlanReview(wrap(review({ findings: [finding('note')] })), binding))
    expect(verdict).toEqual({ verdict: 'approved', blocking: [] })
  })
})

describe('the seat files', () => {
  const folder = join(import.meta.dir, '../../thinking/plan-reviewer')

  test('output.schema.json is the schema the module generates, one root key, no verdict', () => {
    const onDisk = JSON.parse(readFileSync(join(folder, 'output.schema.json'), 'utf8'))
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(planReviewJsonSchema())))
    expect(Object.keys(onDisk.properties)).toEqual(['planReview'])
    expect(JSON.stringify(onDisk)).not.toContain('verdict')
  })

  test('every object in the schema is closed and requires every property (strict structured output)', () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (node === null || typeof node !== 'object') return
      const o = node as Record<string, unknown>
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        expect(o.required).toEqual(Object.keys(o.properties as object))
      }
      Object.values(o).forEach(walk)
    }
    walk(planReviewJsonSchema())
  })

  test('the grants allow exactly the evidence commands, and deny every write, execution and network capability', () => {
    const grants = parse(readFileSync(join(folder, 'grants.yaml'), 'utf8'))
    expect(grants.capabilities.run_commands.allow).toEqual([...PLAN_REVIEW_EVIDENCE_COMMANDS])
    // The validator refuses exactly the forms the grants refuse: one list, bound here.
    expect(grants.capabilities.run_commands.deny).toEqual([...PLAN_REVIEW_EVIDENCE_DENIED])
    expect(grants.capabilities.run_commands.default).toBeUndefined()
    expect(grants.capabilities.write_files).toBe('deny')
    expect(grants.capabilities.network).toEqual([])
    expect(grants.capabilities.web_fetch).toBe('deny')
    expect(grants.capabilities.web_search).toBe('deny')
    expect(grants.capabilities.subagents).toBe('deny')
    expect(grants.mcp_tools).toEqual({})
  })

  test('the doctrine states the six questions and the version', () => {
    const doctrine = readFileSync(join(folder, 'doctrine.md'), 'utf8')
    for (const name of ['Inputs', 'Proof', 'Facts', 'Relations', 'Intent', 'Coverage'])
      expect(doctrine).toContain(`**${name}`)
    expect(doctrine).toContain('version 1 of the questions')
  })
})

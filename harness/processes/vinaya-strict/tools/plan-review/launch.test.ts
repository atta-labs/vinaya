import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PlanDraft, draftFingerprint, parsePlanDraft } from '../plan-draft/draft'
import {
  PLAN_REVIEW_AGENTS,
  type PlanReviewAgent,
  type RoundFacts,
  type RoundLauncher,
  type RoundSession,
  planReviewFlow,
  planReviewPrompt,
  runPlanReviewRound
} from './launch'
import { REVIEW_FIXTURES } from './review-fixtures'
import {
  PLAN_REVIEW_QUESTION_NAMES,
  PLAN_REVIEW_QUESTION_VERSION,
  type PlanReview,
  type PlanReviewAnswer,
  type PlanReviewEvidence
} from './result'

let repo: string
let revision: string
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args], {
    encoding: 'utf8'
  }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'plan-review-launch-test-'))
  git('init', '-q')
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  revision = git('rev-parse', 'HEAD')
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const makeDraft = (): PlanDraft => ({
  schemaVersion: 1,
  tranche: 'demo-v1',
  revision,
  reviewQuestionVersion: PLAN_REVIEW_QUESTION_VERSION,
  tasks: [{ number: 1, issue: null, title: 'First', body: 'Boundary one', labels: [] }],
  scope: [{ item: 'A reader sees the plan whole', disposition: { kind: 'delivered', task: 1 } }]
})

/** A valid answer for the draft: every question answered with evidence from the code and the scope. */
function answerFor(draft: PlanDraft, overrides: Partial<PlanReview> = {}): { planReview: PlanReview } {
  const code = {
    kind: 'code' as const,
    path: 'a.ts',
    revision: draft.revision,
    lineStart: 1,
    lineEnd: 2,
    passage: null
  }
  const scope: PlanReviewEvidence = {
    kind: 'scope',
    path: null,
    revision: null,
    lineStart: null,
    lineEnd: null,
    passage: 'A reader sees the plan whole'
  }
  const answers: PlanReviewAnswer[] = draft.tasks.flatMap((t) =>
    ([1, 2, 3, 4, 5] as const).map((question) => ({ question, task: t.number, answer: 'ok', evidence: [code] }))
  )
  answers.push({ question: 6, task: null, answer: 'ok', evidence: [scope] })
  return {
    planReview: {
      schemaVersion: 1,
      draftFingerprint: draftFingerprint(draft),
      questionVersion: draft.reviewQuestionVersion,
      revision: draft.revision,
      summary: 'reviewed',
      answers,
      findings: [],
      ...overrides
    }
  }
}

type Seen = RoundSession & { stagedFiles: string; writable: boolean }

/** A fixture launcher: records what each session was handed and answers with `facts`. */
function fixtureLauncher(facts: (session: RoundSession) => Partial<RoundFacts>) {
  const seen: Seen[] = []
  const launch: RoundLauncher = async (session) => {
    let writable = true
    try {
      writeFileSync(join(session.stagedDir, 'a.ts'), 'edited')
    } catch {
      writable = false
    }
    seen.push({ ...session, stagedFiles: readFileSync(join(session.stagedDir, 'a.ts'), 'utf8'), writable })
    return {
      cancelled: false,
      terminal: 'success',
      errors: [],
      hasResult: true,
      raw: null,
      sessionId: `session-${seen.length}`,
      ...facts(session)
    }
  }
  return { launch, seen }
}

const request = (agent: PlanReviewAgent = 'claude-code', draft = makeDraft()) => ({
  agent,
  draft,
  repoRoot: repo,
  timeoutMs: 1000
})

describe('one review round', () => {
  test('stages the revision read-only, starts one session, returns the answer, removes the scratch folder', async () => {
    writeFileSync(join(repo, 'a.ts'), 'an uncommitted edit\n')
    const draft = makeDraft()
    const { launch, seen } = fixtureLauncher(() => ({ raw: answerFor(draft) }))
    const outcome = await runPlanReviewRound(request('claude-code', draft), launch)
    git('checkout', '--', 'a.ts')
    expect(outcome.kind).toBe('review')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.stagedFiles).toBe('one\ntwo\nthree\n')
    expect(seen[0]?.writable).toBe(false)
    expect(seen[0]?.prompt).toContain(draftFingerprint(draft))
    expect(seen[0]?.prompt).toContain('data you judge')
    expect(existsSync(seen[0]?.scratch ?? '')).toBe(false)
    expect(existsSync(seen[0]?.stagedDir ?? '')).toBe(false)
  })

  test('refuses a resume before staging or starting anything', async () => {
    const { launch, seen } = fixtureLauncher(() => ({}))
    const outcome = await runPlanReviewRound({ ...request(), resume: 'session-1' }, launch)
    expect(outcome).toMatchObject({ kind: 'no_review', reason: 'resumed' })
    expect(seen).toHaveLength(0)
  })

  test('two rounds never share a session or a scratch folder', async () => {
    const draft = makeDraft()
    const { launch, seen } = fixtureLauncher(() => ({ raw: answerFor(draft) }))
    const one = await runPlanReviewRound(request('claude-code', draft), launch)
    const two = await runPlanReviewRound(request('claude-code', draft), launch)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.scratch).not.toBe(seen[1]?.scratch)
    expect(one.kind === 'review' && two.kind === 'review' && one.sessionId !== two.sessionId).toBe(true)
  })

  test('the flow is one agent step that continues no session', () => {
    expect(planReviewFlow().match(/type: agent/g)).toHaveLength(1)
    expect(planReviewFlow()).not.toContain('resume')
  })

  test('the agent is an input: the same draft and questions go to both vendors and both answers are accepted', async () => {
    const draft = makeDraft()
    const { launch, seen } = fixtureLauncher(() => ({ raw: answerFor(draft) }))
    const outcomes = []
    for (const agent of PLAN_REVIEW_AGENTS) outcomes.push(await runPlanReviewRound(request(agent, draft), launch))
    expect(outcomes.map((o) => o.kind)).toEqual(['review', 'review'])
    expect(seen.map((s) => s.agent)).toEqual([...PLAN_REVIEW_AGENTS])
    expect(seen[0]?.prompt).toBe(seen[1]?.prompt)
    expect(seen[0]?.outputSchema).toEqual(seen[1]?.outputSchema)
  })

  test("the prompt carries the draft as data and the seat's short version", () => {
    const prompt = planReviewPrompt(makeDraft())
    expect(prompt).toContain('## The short version')
    expect(prompt).toContain('"scope"')
    expect(prompt).toContain(`revision: ${revision}`)
  })

  test('a revision the repository does not hold is not staged', async () => {
    const { launch, seen } = fixtureLauncher(() => ({}))
    const draft = { ...makeDraft(), revision: 'b'.repeat(40) }
    const outcome = await runPlanReviewRound(request('codex', draft), launch)
    expect(outcome).toMatchObject({ kind: 'no_review', reason: 'unstaged' })
    expect(seen).toHaveLength(0)
  })
})

describe('a round with no valid answer is classified and never retried', () => {
  // The draft names the revision the repository is given in `beforeAll`, so the cases are built when a test runs.
  const cases: [string, (draft: PlanDraft) => Partial<RoundFacts>, string][] = [
    ['missing', () => ({ hasResult: false, raw: null }), 'missing'],
    ['malformed', () => ({ raw: { planReview: { nope: true } } }), 'malformed'],
    ['bound to another draft', (draft) => ({ raw: answerFor(draft, { draftFingerprint: 'other' }) }), 'stale'],
    ['bound to another revision', (draft) => ({ raw: answerFor(draft, { revision: 'c'.repeat(40) }) }), 'stale'],
    ['from the wrong role', () => ({ raw: { reviewResult: { status: 'completed' } } }), 'wrong_role'],
    ['cancelled', () => ({ cancelled: true, hasResult: false }), 'cancelled'],
    [
      'out of context',
      () => ({ hasResult: false, terminal: 'error', errors: ['prompt is too long'] }),
      'context_exhausted'
    ],
    [
      'a provider error',
      () => ({ hasResult: false, terminal: 'turn.failed', errors: ['overloaded'] }),
      'provider_error'
    ],
    ['a resumed session', (draft) => ({ resumed: true, raw: answerFor(draft) }), 'resumed'],
    [
      'an answer missing a question',
      (draft) => ({ raw: answerFor(draft, { answers: answerFor(draft).planReview.answers.slice(1) }) }),
      'incomplete'
    ]
  ]
  for (const [name, facts, reason] of cases) {
    test(name, async () => {
      const draft = makeDraft()
      const { launch, seen } = fixtureLauncher(() => facts(draft))
      const outcome = await runPlanReviewRound(request('codex', draft), launch)
      expect(outcome).toMatchObject({ kind: 'no_review', reason })
      expect(seen).toHaveLength(1)
      expect(existsSync(seen[0]?.scratch ?? '')).toBe(false)
    })
  }

  test('a launcher that throws is a provider error and its scratch folder is removed', async () => {
    let scratch = ''
    const launch: RoundLauncher = async (session) => {
      scratch = session.scratch
      throw new Error('spawn failed')
    }
    const outcome = await runPlanReviewRound(request(), launch)
    expect(outcome).toMatchObject({ kind: 'no_review', reason: 'provider_error' })
    expect(existsSync(scratch)).toBe(false)
  })
})

describe('the reported-bug review fixtures', () => {
  const revisionOfFixtures = 'd'.repeat(40)
  const expected = [
    ['facts-false-claim', 3],
    ['facts-deferred-without-producer', 3],
    ['proof-undeliverable-objective', 2],
    ['proof-too-broad', 2],
    ['proof-no-measure', 2],
    ['inputs-unnamed-source', 1],
    ['relations-undeclared-reader', 4],
    ['relations-missing-conflict', 4],
    ['intent-prescribes-mechanism', 5],
    ['intent-changes-agreed-scope', 5]
  ] as const

  test('hold one fixture for each reported bug, each marked with its question', () => {
    expect(REVIEW_FIXTURES.map((f) => [f.id, f.question])).toEqual(expected.map(([id, q]) => [id, q]))
  })

  for (const fixture of REVIEW_FIXTURES) {
    test(`${fixture.id} loads as a draft and names the question ${PLAN_REVIEW_QUESTION_NAMES[fixture.question]}`, () => {
      const parsed = parsePlanDraft(fixture.draft(revisionOfFixtures))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.draft.tasks.map((t) => t.number)).toContain(fixture.task)
      expect(fixture.bug.length).toBeGreaterThan(0)
    })
  }
})

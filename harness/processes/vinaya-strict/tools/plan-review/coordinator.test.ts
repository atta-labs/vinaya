import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REVIEW_AGENT,
  DEFAULT_REVIEW_ROUND_LIMIT,
  resolveReviewAgent,
  resolveReviewRoundLimit
} from '../../integration/config/vinaya-config-section'
import type { DraftCheckReport } from '../plan-draft/check'
import { draftFingerprint, type PlanDraft } from '../plan-draft/draft'
import { readPlanDraft, writePlanDraft } from '../plan-draft/store'
import {
  type CoordinatorDeps,
  decidePlanReview,
  laterRoundScope,
  planReviewStatus,
  readReviewState,
  resolveReviewerAgent,
  reviewStatePath,
  startPlanReview
} from './coordinator'
import type { RoundLauncher, RoundSession } from './launch'
import { PLAN_REVIEW_QUESTION_VERSION, type PlanReview } from './result'

let repo: string
let revision: string
let runtimeDir: string

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args], {
    encoding: 'utf8'
  }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'plan-coordinator-repo-'))
  git('init', '-q')
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  revision = git('rev-parse', 'HEAD')
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'plan-coordinator-run-'))
})

const rationale = (edges: string) => `Boundary text.\n\n**Dependency rationale** — ${edges}\n\n**Next** — x`

const makeDraft = (over: { task1?: string } = {}): PlanDraft => ({
  schemaVersion: 1,
  tranche: 'demo-v1',
  revision,
  reviewQuestionVersion: PLAN_REVIEW_QUESTION_VERSION,
  tasks: [
    {
      number: 1,
      issue: null,
      title: 'First',
      body: over.task1 ?? rationale('`Depends-on: —` `Conflicts-with: —`'),
      labels: []
    },
    { number: 2, issue: null, title: 'Second', body: rationale('`Depends-on: 1` `Conflicts-with: —`'), labels: [] },
    { number: 3, issue: null, title: 'Third', body: rationale('`Depends-on: —` `Conflicts-with: —`'), labels: [] }
  ],
  scope: [
    { item: 'A reader sees the first part', disposition: { kind: 'delivered', task: 1 } },
    { item: 'A reader sees the second part', disposition: { kind: 'delivered', task: 2 } },
    { item: 'A reader sees the third part', disposition: { kind: 'delivered', task: 3 } }
  ]
})

const code = (): PlanReview['answers'][number]['evidence'][number] => ({
  kind: 'code',
  path: 'a.ts',
  revision,
  lineStart: 1,
  lineEnd: 2,
  passage: null
})
const scopeEvidence = (): PlanReview['answers'][number]['evidence'][number] => ({
  kind: 'scope',
  path: null,
  revision: null,
  lineStart: null,
  lineEnd: null,
  passage: 'A reader sees the first part'
})

type Plan = {
  tasks?: number[]
  findings?: PlanReview['findings']
  confirmations?: { finding: string; status: 'resolved' | 'open' }[]
}

const blocking = (task: number, question: 1 | 2 | 3 | 4 | 5 = 1): PlanReview['findings'][number] => ({
  question,
  task,
  kind: 'blocking',
  evidence: [code()],
  resolution: `Fix task ${task}.`
})

/** What the fixture seat answers, the answer built for whatever the draft and the plan's scope say. */
function answerFor(draft: PlanDraft, plan: Plan): { planReview: PlanReview } {
  const tasks = plan.tasks ?? draft.tasks.map((t) => t.number)
  const answers: PlanReview['answers'] = tasks.flatMap((task) =>
    ([1, 2, 3, 4, 5] as const).map((question) => ({ question, task, answer: 'ok', evidence: [code()] }))
  )
  answers.push({ question: 6, task: null, answer: 'ok', evidence: [scopeEvidence()] })
  return {
    planReview: {
      schemaVersion: 1,
      draftFingerprint: draftFingerprint(draft),
      questionVersion: draft.reviewQuestionVersion,
      revision: draft.revision,
      summary: 'reviewed',
      answers,
      findings: plan.findings ?? [],
      confirmations: (plan.confirmations ?? []).map((c) => ({ ...c, evidence: [code()] }))
    }
  }
}

function harness(over: Partial<CoordinatorDeps> = {}) {
  const sessions: RoundSession[] = []
  let plan: Plan = {}
  const launch: RoundLauncher = async (session) => {
    sessions.push(session)
    const draft = readPlanDraft(runtimeDir, 'demo-v1') as PlanDraft
    return {
      cancelled: false,
      terminal: null,
      errors: [],
      hasResult: true,
      raw: answerFor(draft, plan),
      sessionId: `s${sessions.length}`
    }
  }
  const checked = async (d: PlanDraft): Promise<DraftCheckReport> => ({
    fingerprint: draftFingerprint(d),
    tasks: [],
    cross: [],
    coverage: [],
    blocking: false
  })
  // A new session: the dependencies are built afresh each time, and nothing but the stored files is shared.
  const deps = (): CoordinatorDeps => ({
    runtimeDir,
    readDraft: (tranche) => readPlanDraft(runtimeDir, tranche),
    check: checked,
    repoRoot: repo,
    roundLimit: 2,
    agent: 'codex',
    timeoutMs: 5000,
    launch,
    ...over
  })
  return {
    sessions,
    deps,
    answer: (next: Plan) => {
      plan = next
    },
    start: () => startPlanReview(deps(), 'demo-v1'),
    status: () => planReviewStatus(deps(), 'demo-v1')
  }
}

const statusOf = (h: ReturnType<typeof harness>) => {
  const outcome = h.status()
  if (!outcome.ok) throw new Error('expected a status')
  return outcome.status
}

describe('starting a round', () => {
  test('is refused when no draft is stored', async () => {
    const h = harness()
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('no_draft')
    expect(h.sessions).toHaveLength(0)
  })

  test('is refused on a draft whose check has a blocking finding, and starts no session', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness({
      check: async (d) => ({ fingerprint: draftFingerprint(d), tasks: [], cross: [], coverage: [], blocking: true })
    })
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('unchecked')
    expect(h.sessions).toHaveLength(0)
    expect(statusOf(h).roundsSpent).toBe(0)
  })

  test('is refused when the check was made on another fingerprint', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness({
      check: async () => ({ fingerprint: 'sha256:other', tasks: [], cross: [], coverage: [], blocking: false })
    })
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    expect(h.sessions).toHaveLength(0)
  })

  test('runs one round, derives the verdict and stores the findings with ids', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [blocking(3), { ...blocking(1), kind: 'note' }] })
    const outcome = await h.start()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.round).toBe(1)
    expect(outcome.verdict).toBe('not_approved')
    expect(outcome.agent).toBe('codex')
    expect(outcome.findings.map((f) => [f.id, f.state])).toEqual([
      ['r1-f1', 'open'],
      ['r1-f2', 'note']
    ])
    expect(h.sessions).toHaveLength(1)
  })

  test('a round whose answer is not a review is refused and not counted', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ tasks: [1, 2] })
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('no_review')
    expect(statusOf(h).roundsSpent).toBe(0)
  })

  test('a draft that changed while the round ran gets no stored result', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    const inner = h.deps().launch as RoundLauncher
    const h2 = harness({
      launch: async (session) => {
        const facts = await inner(session)
        writePlanDraft(runtimeDir, makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` changed') }))
        return facts
      }
    })
    const outcome = await h2.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('draft_changed')
    expect(statusOf(h2).roundsSpent).toBe(0)
  })
})

describe('stored state', () => {
  test('a new session reads the stored result and findings back', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const first = harness()
    first.answer({ findings: [blocking(3)] })
    await first.start()
    const second = harness() // a new chat: nothing shared but the files
    const status = statusOf(second)
    expect(status.roundsSpent).toBe(1)
    expect(status.lastVerdict).toBe('not_approved')
    expect(status.openFindings.map((f) => f.id)).toEqual(['r1-f1'])
    const state = readReviewState(runtimeDir, 'demo-v1')
    expect(state.rounds[0]?.fingerprint).toBe(draftFingerprint(makeDraft()))
    expect(state.rounds[0]?.review.answers.length).toBeGreaterThan(0)
  })

  test('a stored file that is not valid state is an error, never an empty state', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await h.start()
    writeFileSync(reviewStatePath(runtimeDir, 'demo-v1'), '{"rounds": "gone"}')
    expect(() => readReviewState(runtimeDir, 'demo-v1')).toThrow()
  })
})

describe('a changed draft', () => {
  test('an earlier approval does not apply to it, a round is needed again, and the count stays', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await h.start()
    expect(statusOf(h).approved).toBe(true)
    writePlanDraft(runtimeDir, makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` revised') }))
    const status = statusOf(h)
    expect(status.approved).toBe(false)
    expect(status.stale).toBe(true)
    expect(status.roundsSpent).toBe(1)
    expect(status.approvedTasks).toEqual([2, 3])
  })

  test('a draft submitted again unchanged keeps its approval', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await h.start()
    writePlanDraft(runtimeDir, makeDraft())
    expect(statusOf(h).approved).toBe(true)
  })
})

describe('a later round', () => {
  test('judges exactly the open findings, the changed tasks and their relatives in both directions', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [blocking(3)] })
    await h.start()
    // task 1 changes; task 2 depends on it (a relative); task 3 is untouched but carries the open finding
    const revised = makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` revised') })
    writePlanDraft(runtimeDir, revised)
    const scope = laterRoundScope(revised, readReviewState(runtimeDir, 'demo-v1'))
    expect(scope.tasks).toEqual([1, 2])
    expect(scope.changed).toEqual([1])
    expect(scope.openFindings).toEqual(['r1-f1'])

    h.answer({ tasks: [1, 2], confirmations: [{ finding: 'r1-f1', status: 'resolved' }] })
    const outcome = await h.start()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.round).toBe(2)
    expect(outcome.resolved.map((f) => f.id)).toEqual(['r1-f1'])
    expect(outcome.verdict).toBe('approved')
    const prompt = h.sessions[1]?.prompt ?? ''
    expect(prompt).toContain('This is a later round')
    expect(prompt).toContain('r1-f1')
    expect(statusOf(h).approvedTasks).toEqual([1, 2, 3])
  })

  test('a relative is found from the other side: a changed dependency pulls in its dependents, a changed dependent its dependencies', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await h.start()
    const revised = makeDraft()
    revised.tasks[1] = { ...revised.tasks[1]!, body: `${revised.tasks[1]!.body} revised` }
    expect(laterRoundScope(revised, readReviewState(runtimeDir, 'demo-v1')).tasks).toEqual([1, 2])
  })

  test('an answer outside the scope, or missing a confirmation, is not a review', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [blocking(3)] })
    await h.start()
    writePlanDraft(runtimeDir, makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` revised') }))

    h.answer({ tasks: [1, 2, 3], confirmations: [{ finding: 'r1-f1', status: 'resolved' }] })
    const wide = await h.start()
    expect(wide.ok).toBe(false)
    if (!wide.ok) expect(wide.findings[0]?.message).toContain('not in this round')

    h.answer({ tasks: [1, 2] })
    const unconfirmed = await h.start()
    expect(unconfirmed.ok).toBe(false)
    if (!unconfirmed.ok) expect(unconfirmed.findings[0]?.message).toContain('is not confirmed')
    expect(statusOf(h).roundsSpent).toBe(1)
  })

  test('a finding confirmed still open stays open, and only a valid confirmation resolves one', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [blocking(3)] })
    await h.start()
    h.answer({ tasks: [], confirmations: [{ finding: 'r1-f1', status: 'open' }] })
    const outcome = await h.start()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.verdict).toBe('not_approved')
    expect(outcome.openFindings.map((f) => f.id)).toEqual(['r1-f1'])
    expect(statusOf(h).approvedTasks).toEqual([1, 2])
  })

  test('a note never blocks and is not asked to be confirmed', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [{ ...blocking(1), kind: 'note' }] })
    const outcome = await h.start()
    expect(outcome.ok && outcome.verdict).toBe('approved')
    expect(statusOf(h).notes.map((f) => f.id)).toEqual(['r1-f1'])
    expect(statusOf(h).nextScope?.openFindings).toEqual([])
  })
})

describe('the round limit', () => {
  async function spendTwo(h: ReturnType<typeof harness>) {
    h.answer({ findings: [blocking(3)] })
    await h.start()
    h.answer({ tasks: [], confirmations: [{ finding: 'r1-f1', status: 'open' }] })
    await h.start()
  }

  test('refuses a third round and shows the open findings', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await spendTwo(h)
    const status = statusOf(h)
    expect(status.limitReached).toBe(true)
    expect(status.openFindings.map((f) => f.id)).toEqual(['r1-f1'])
    const sessions = h.sessions.length
    const third = await h.start()
    expect(third.ok).toBe(false)
    if (!third.ok) {
      expect(third.reason).toBe('limit')
      expect(third.findings.map((f) => f.message).join('\n')).toContain('r1-f1')
    }
    expect(h.sessions).toHaveLength(sessions)
  })

  test('is not reset by a revision, a resubmission or a new chat', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    await spendTwo(harness())
    writePlanDraft(runtimeDir, makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` revised') }))
    const fresh = harness()
    const outcome = await fresh.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('limit')
    expect(statusOf(fresh).roundsSpent).toBe(2)
  })

  test('is a setting', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness({ roundLimit: 3 })
    await spendTwo(h)
    h.answer({ tasks: [], confirmations: [{ finding: 'r1-f1', status: 'open' }] })
    const third = await h.start()
    expect(third.ok).toBe(true)
  })

  test('a decision is refused before the limit, for another fingerprint, and records no caller', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    h.answer({ findings: [blocking(3)] })
    await h.start()
    const fingerprint = draftFingerprint(makeDraft())
    const early = decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint, choice: 'allow_one_more' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.findings[0]?.message).toContain('not reached')

    h.answer({ tasks: [], confirmations: [{ finding: 'r1-f1', status: 'open' }] })
    await h.start()
    const wrong = decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint: 'sha256:other', choice: 'stop' })
    expect(wrong.ok).toBe(false)
    const given = decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint, choice: 'allow_one_more' })
    expect(given.ok).toBe(true)
    if (given.ok) expect(Object.keys(given.decision).sort()).toEqual(['afterRounds', 'choice', 'fingerprint'])
  })

  test('one more round is allowed for that fingerprint only, and then review stops again', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await spendTwo(h)
    const fingerprint = draftFingerprint(makeDraft())
    decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint, choice: 'allow_one_more' })
    expect(statusOf(h).limitReached).toBe(false)
    h.answer({ tasks: [], confirmations: [{ finding: 'r1-f1', status: 'open' }] })
    expect((await h.start()).ok).toBe(true)
    const fourth = await h.start()
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) expect(fourth.reason).toBe('limit')
  })

  test('an allowance given for one fingerprint does not carry to a revised draft', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await spendTwo(h)
    decidePlanReview(h.deps(), {
      tranche: 'demo-v1',
      fingerprint: draftFingerprint(makeDraft()),
      choice: 'allow_one_more'
    })
    writePlanDraft(runtimeDir, makeDraft({ task1: rationale('`Depends-on: —` `Conflicts-with: —` revised') }))
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('limit')
  })

  test('stopping the plan refuses every round for that fingerprint', async () => {
    writePlanDraft(runtimeDir, makeDraft())
    const h = harness()
    await spendTwo(h)
    const fingerprint = draftFingerprint(makeDraft())
    expect(decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint, choice: 'stop' }).ok).toBe(true)
    const outcome = await h.start()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('stopped')
    expect(decidePlanReview(h.deps(), { tranche: 'demo-v1', fingerprint, choice: 'allow_one_more' }).ok).toBe(false)
  })
})

describe('which agent reviews', () => {
  test('the same agent by default, the other vendor when the setting says different', () => {
    expect(resolveReviewerAgent('same', 'claude-code')).toBe('claude-code')
    expect(resolveReviewerAgent('same', 'codex')).toBe('codex')
    expect(resolveReviewerAgent('different', 'claude-code')).toBe('codex')
    expect(resolveReviewerAgent('different', 'codex')).toBe('claude-code')
  })

  test('the settings default to two rounds and the same agent', () => {
    expect(resolveReviewRoundLimit(null)).toBe(DEFAULT_REVIEW_ROUND_LIMIT)
    expect(DEFAULT_REVIEW_ROUND_LIMIT).toBe(2)
    expect(resolveReviewAgent(null)).toBe(DEFAULT_REVIEW_AGENT)
    expect(resolveReviewRoundLimit({ planning: { reviewRoundLimit: 4 } } as never)).toBe(4)
    expect(resolveReviewAgent({ planning: { reviewAgent: 'different' } } as never)).toBe('different')
  })
})
